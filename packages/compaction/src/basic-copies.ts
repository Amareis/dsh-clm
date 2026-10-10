/**
 * Helpers copied verbatim-semantics from `@deepseek-ai/dsh-compaction-basic`
 * (harness build at link time — see scripts/link-harness.mjs). They are
 * module-private there, so the subclass cannot reach them through imports;
 * the CLM three-phase loop needs the exact same gate (threshold policy,
 * retained-tail selection, entry-state inspection) to decide WHEN to open a
 * self-edit transaction, while the commit machinery stays basic's own
 * (`super.compactRegion` / `super.compactIfNeeded` on the fallback path).
 *
 * Keep in sync with the linked harness build; the versions are pinned by the
 * symlink target, and behavior drift is covered by the loop tests.
 */

import { toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import type { Session, SessionSeq } from "@deepseek-ai/dsh-session";
import type { BasicCompactionConfig } from "@deepseek-ai/dsh-compaction-basic";

/** basic's `routedTarget`: the provider/model durably routed for the latest request. */
export function routedTarget(session: Session): { provider: string; model: string } | undefined {
  const config = (session.requestHeader() as { config?: { provider: string; model: string } } | null)?.config;
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined;
  return { provider: config.provider, model: config.model };
}

/** basic's `reservedCompletionTokens`: the effective cap wins, else the adapter default. */
export function reservedCompletionTokens(session: Session, defaultMaxTokens: number | undefined): number {
  const config = (session.requestHeader() as { config?: { maxTokens?: number } } | null)?.config;
  return config?.maxTokens ?? defaultMaxTokens ?? 0;
}

/** basic's resolved per-target policy (post `resolveConfig` defaults merge). */
export interface TargetPolicy {
  readonly thresholdRatio: number;
  readonly headroomTokens: number;
  readonly retainRatio?: number;
  readonly retainTokens?: number;
  readonly compactionRetries: number;
  readonly maxOverflowRetries: number;
}

/** Structural input for resolveTargetPolicy: satisfied by both
 *  BasicCompactionConfig and basic's resolved (readonly) config. */
export interface PolicySource {
  readonly thresholdRatio?: number;
  readonly headroomTokens?: number;
  readonly retainRatio?: number;
  readonly retainTokens?: number;
  readonly compactionRetries?: number;
  readonly maxOverflowRetries?: number;
  readonly modelPolicies?: readonly (PolicySource & { readonly provider: string; readonly model: string })[];
}

/** basic's `resolveTargetPolicy` reduced to the fields the CLM gate reads. */
export function resolveTargetPolicy(config: PolicySource, target: { provider: string; model: string }): TargetPolicy {
  const override = (config.modelPolicies ?? []).find(
    (policy) => policy.provider === target.provider && policy.model === target.model,
  );
  const retention = override?.retainTokens !== undefined
    ? { retainTokens: override.retainTokens }
    : override?.retainRatio !== undefined
      ? { retainRatio: override.retainRatio }
      : config.retainTokens !== undefined
        ? { retainTokens: config.retainTokens }
        : { retainRatio: config.retainRatio };
  return {
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio ?? 0.75,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens ?? 0,
    ...retention,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries ?? 0,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries ?? 0,
  };
}

/** basic's `resolveCompactSpec` output, reduced to the CLM gate's needs. */
export interface CompactSpec {
  readonly thresholdTokens: number;
  readonly retainTokens: number;
  readonly compactionRetries: number;
}

/**
 * basic's `resolveCompactSpec`: scale the routed policy into concrete token
 * budgets. Throws plain Errors (not TargetPressureConfigError) — the pre-step
 * listener in basic catches and warns either way.
 */
export function resolveCompactSpec(
  policy: TargetPolicy,
  target: { provider: string; model: string },
  contextWindow: number,
  reserved: number,
): CompactSpec {
  const targetKey = `${target.provider}/${target.model}`;
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`dsh-clm-compaction: no context capacity for ${targetKey}; configure contextWindow on that adapter model`);
  }
  const messageBudgetTokens = contextWindow - reserved;
  if (messageBudgetTokens <= 0) {
    throw new Error(`dsh-clm-compaction: ${targetKey} reserves ${reserved} completion tokens of its ${contextWindow}-token window, leaving no message budget`);
  }
  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens;
  if (pressureBudgetTokens <= 0) {
    throw new Error(`dsh-clm-compaction: ${targetKey} leaves no pressure budget after completion reservation and headroom`);
  }
  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens));
  const retainTokens = policy.retainTokens ?? Math.floor(messageBudgetTokens * (policy.retainRatio ?? 0));
  if (retainTokens >= thresholdTokens) {
    throw new Error(`dsh-clm-compaction: ${targetKey} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`);
  }
  return { thresholdTokens, retainTokens, compactionRetries: policy.compactionRetries };
}

/** One priced surface node, mirroring the token meter's measurement shape. */
export interface PricedNode {
  readonly seq: SessionSeq;
  readonly tokens: number;
  readonly heuristicTokens: number;
}

/** The slice of the token meter measurement the gate consumes. */
export interface Measurement {
  readonly totalTokens: number;
  readonly nodes: readonly PricedNode[];
}

function systemHead(session: Session, headSeq: SessionSeq) {
  const head = session.eventAt(headSeq);
  return head?.type === "system/message" ? head : undefined;
}

/**
 * basic's `selectCompactableRange`: the inclusive positional seq range that
 * keeps a priced recent tail verbatim and never splits a tool-call pair.
 */
export function selectCompactableRange(
  session: Session,
  measurement: Measurement,
  retainTokens: number,
): { start: SessionSeq; end: SessionSeq } | null {
  const pricedNodes = measurement.nodes;
  if (pricedNodes.length === 0) return null;
  const surfaceNodes = session.surface.nodes;
  if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error("compaction: token-meter surface does not match the current session surface");
  }
  const firstIdx = systemHead(session, surfaceNodes[0]!) === undefined ? 0 : 1;
  let accumulated = 0;
  let keepFromIdx = pricedNodes.length;
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index]!.tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;
  return { start: surfaceNodes[firstIdx]!, end: surfaceNodes[keepFromIdx - 1]! };
}

/** basic's `inspectCompactionEntryState`, reduced: unmatched start + open turn. */
export interface CompactionEntryState {
  readonly openTurn: number | null;
  readonly unmatchedCompactionStart: { readonly seq: SessionSeq; readonly data: unknown } | undefined;
}

export function inspectCompactionEntryState(session: Session): CompactionEntryState {
  let openTurn: number | null = null;
  let openTurnStateKnown = false;
  let unmatchedCompactionStart: CompactionEntryState["unmatchedCompactionStart"];
  let compactionEntryStateKnown = false;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq as SessionSeq);
    if (event === undefined) continue;
    if (!compactionEntryStateKnown) {
      if (event.type === "compaction/start") {
        unmatchedCompactionStart = event as CompactionEntryState["unmatchedCompactionStart"];
        compactionEntryStateKnown = true;
      } else if (event.type === "compaction/end") {
        compactionEntryStateKnown = true;
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === "turn/start") {
        openTurn = (event.data as { turn: number }).turn;
        openTurnStateKnown = true;
      } else if (event.type === "turn/end") {
        openTurnStateKnown = true;
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown) break;
  }
  return { openTurn, unmatchedCompactionStart };
}

/** Current turn/step envelope for the nudge message (dsh-clm core's currentPosition). */
export function currentPosition(session: Session): { turn: number; step: number } {
  let turn = 0;
  let step = 0;
  for (let seq = session.seq - 1; seq >= 0 && step === 0; seq -= 1) {
    const event = session.eventAt(seq as SessionSeq);
    if (event === undefined) continue;
    if (event.type === "step/start") {
      turn = (event.data as { turn: number }).turn;
      step = (event.data as { step: number }).step;
    }
  }
  return { turn, step };
}
