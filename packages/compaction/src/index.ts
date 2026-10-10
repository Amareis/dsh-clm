/**
 * dsh-clm-compaction — CLM condensation engine (approach C), Stage 2.
 *
 * `ClmCompactionEngine` subclasses the harness's OWN `BasicCompactionEngine`
 * (resolved through the `node_modules/@deepseek-ai` symlinks created by
 * `scripts/link-harness.mjs`, so class identity — including
 * `ManualCompactionError` `instanceof` checks in `dsh-command-compact` — is
 * preserved).
 *
 * Stage 2 semantics (spec: docs/compaction-engine.md §4.2): the three-phase
 * self-edit loop. On pressure/overflow the engine does NOT summarize; it
 * opens a compaction transaction (`compaction/start`), nudges the working
 * model on the surface with a span/budget/deadline, and returns null. The
 * model then condenses the span itself through `context_edit(compaction: id)`
 * checkpoints (committed by the dsh-clm plugin). The next pre-steps check the
 * close detector (§4.8): compact enough → `compaction/end` + result;
 * deadline missed → `compaction/end { error }` + classic fallback
 * (`super.compactIfNeeded`). All communication between engine and tool flows
 * through the session log — the two plugins stay decoupled (§5.3).
 *
 * Config plumbing note: `static Config` reuses basic's schemastery schema —
 * schemastery objects pass unknown keys through, so the CLM fields reach the
 * constructor, where `resolveClmConfig` validates them (basic's own
 * `resolveConfig` REJECTS unknown keys, so CLM fields are stripped before
 * `super`). Config errors fail plugin load, same as basic's.
 */

import { randomUUID } from "node:crypto";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import type { BasicCompactionConfig } from "@deepseek-ai/dsh-compaction-basic";
import { CompactionId, ManualCompactionError, toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import type { Session, SessionSeq } from "@deepseek-ai/dsh-session";
import {
  inspectCompactionEntryState,
  reservedCompletionTokens,
  resolveCompactSpec,
  resolveTargetPolicy,
  routedTarget,
  selectCompactableRange,
} from "./basic-copies.js";
import type { Measurement, PricedNode } from "./basic-copies.js";

/** The harness's own Context type, derived from the base class signature —
 *  importing `Context` directly would resolve to this repo's type-only
 *  devDependency copy, which differs from the harness's cordis build. */
type HarnessContext = ConstructorParameters<typeof BasicCompactionEngine>[0];
type Agent = Parameters<BasicCompactionEngine["compactIfNeeded"]>[0];
type Trigger = Parameters<BasicCompactionEngine["compactIfNeeded"]>[1];
type CompactionResultT = Awaited<ReturnType<BasicCompactionEngine["compactIfNeeded"]>> extends infer R
  ? Exclude<R, null>
  : never;

/** Escalation policy when the model's self-edit misses its deadline (Stage 2). */
export type ClmFallbackMode = "basic" | "fail" | "off";
/** Behavior of manual `/compact` on an idle agent. */
export type ClmManualMode = "basic" | "reject";
/** Recovery for provider overflow wordings dsh-llm does not classify. */
export type ClmOverflowWordingMode = "shim" | "off";

/** Full CLM engine configuration: every basic field plus the CLM surface. */
export interface ClmCompactionConfig extends BasicCompactionConfig {
  /** Steps the engine waits for the model's checkpoint edits before closing
   *  or falling back (pressure trigger). Defaults to 3. */
  maxWaitSteps?: number;
  /** Same budget under the context-overflow trigger. Defaults to 1. */
  overflowMaxWaitSteps?: number;
  /** Target span price after self-edit, as a fraction of the baseline.
   *  Defaults to 0.5. */
  targetReductionRatio?: number;
  /** What happens on self-edit timeout: classic summary ('basic', default),
   *  surface the failure ('fail'), or close silently ('off', A/B mode). */
  fallback?: ClmFallbackMode;
  /** Manual `/compact`: classic summary ('basic', default) or reject. */
  manual?: ClmManualMode;
  /** Recovery shim for provider overflow wordings that
   *  `isContextWindowExceededError` misses — e.g. Kimi's "Your request
   *  exceeded k3-256k model token limit: 262144" (compaction-engine.md §6
   *  item 9: without it, overflow recovery is dead on that route even for
   *  basic). 'shim' (default) recognizes the wording in an
   *  `agent/request-error` listener and runs the standard retry flow;
   *  'off' disables. */
  overflowWording?: ClmOverflowWordingMode;
  /** De-escalation (spec §6 item 4): after this many CONSECUTIVE self-edit
   *  timeouts on a session, stop opening CLM transactions and use the
   *  classic path for the rest of the session — a systematically
   *  non-responding model must not pay the nudge→timeout→fallback cycle
   *  every time. Defaults to 3; a successful close resets the counter. */
  deescalateAfter?: number;
}

/** Validated immutable CLM config (the basic half lives in `this.config`). */
export interface ResolvedClmConfig {
  readonly maxWaitSteps: number;
  readonly overflowMaxWaitSteps: number;
  readonly targetReductionRatio: number;
  readonly fallback: ClmFallbackMode;
  readonly manual: ClmManualMode;
  readonly overflowWording: ClmOverflowWordingMode;
  readonly deescalateAfter: number;
}

const CLM_CONFIG_KEYS = [
  "maxWaitSteps",
  "overflowMaxWaitSteps",
  "targetReductionRatio",
  "fallback",
  "manual",
  "overflowWording",
  "deescalateAfter",
] as const;

const FALLBACK_MODES: readonly ClmFallbackMode[] = ["basic", "fail", "off"];
const MANUAL_MODES: readonly ClmManualMode[] = ["basic", "reject"];
const OVERFLOW_WORDING_MODES: readonly ClmOverflowWordingMode[] = ["shim", "off"];

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${String(value)}`);
  }
}

/** Validate the CLM half of the config; mirror basic's resolveConfig style. */
export function resolveClmConfig(config: ClmCompactionConfig = {}): ResolvedClmConfig {
  const maxWaitSteps = config.maxWaitSteps ?? 3;
  assertPositiveInteger("ClmCompactionConfig.maxWaitSteps", maxWaitSteps);
  const overflowMaxWaitSteps = config.overflowMaxWaitSteps ?? 1;
  assertPositiveInteger("ClmCompactionConfig.overflowMaxWaitSteps", overflowMaxWaitSteps);
  const targetReductionRatio = config.targetReductionRatio ?? 0.5;
  if (typeof targetReductionRatio !== "number"
    || !(targetReductionRatio > 0 && targetReductionRatio < 1)) {
    throw new Error(
      `ClmCompactionConfig.targetReductionRatio must be in (0, 1), got ${String(targetReductionRatio)}`,
    );
  }
  const fallback = config.fallback ?? "basic";
  if (!FALLBACK_MODES.includes(fallback)) {
    throw new Error(
      `ClmCompactionConfig.fallback must be one of ${FALLBACK_MODES.join(" | ")}, got ${String(fallback)}`,
    );
  }
  const manual = config.manual ?? "basic";
  if (!MANUAL_MODES.includes(manual)) {
    throw new Error(
      `ClmCompactionConfig.manual must be one of ${MANUAL_MODES.join(" | ")}, got ${String(manual)}`,
    );
  }
  const overflowWording = config.overflowWording ?? "shim";
  if (!OVERFLOW_WORDING_MODES.includes(overflowWording)) {
    throw new Error(
      `ClmCompactionConfig.overflowWording must be one of ${OVERFLOW_WORDING_MODES.join(" | ")}, got ${String(overflowWording)}`,
    );
  }
  const deescalateAfter = config.deescalateAfter ?? 3;
  assertPositiveInteger("ClmCompactionConfig.deescalateAfter", deescalateAfter);
  return Object.freeze({
    maxWaitSteps,
    overflowMaxWaitSteps,
    targetReductionRatio,
    fallback,
    manual,
    overflowWording,
    deescalateAfter,
  });
}

/** `config` minus the CLM-only keys (basic's resolveConfig rejects unknowns). */
function basicConfigOf(config: ClmCompactionConfig): BasicCompactionConfig {
  const out: Record<string, unknown> = { ...config };
  for (const key of CLM_CONFIG_KEYS) delete out[key];
  return out as BasicCompactionConfig;
}

/** An open self-edit transaction (between compaction/start and /end). */
interface PendingClm {
  readonly compactionId: ReturnType<typeof CompactionId>;
  /** Seq of the appended `compaction/start` event. */
  readonly startSeq: SessionSeq;
  /** Selected span as inclusive positional seqs at selection time. */
  readonly span: { readonly start: SessionSeq; readonly end: SessionSeq };
  /** Surface seqs covered by the span at selection time, in order. */
  readonly shadowedSeqs: readonly SessionSeq[];
  /** Heuristic price of the span at selection time. */
  readonly baselineTokens: number;
  /** Close budget: floor(baseline * targetReductionRatio). */
  readonly budgetTokens: number;
  readonly turn: number | null;
  readonly trigger: Trigger;
  /** Origin: automatic pressure/overflow selection, or a fixed explicit
   *  span from compactRegion (whose fallback is the classic compaction of
   *  THAT span, and whose caller holds a waiter promise — spec §4.7). */
  readonly origin: "auto" | "region";
  /** Pre-step calls observed while waiting (the step clock). */
  stepsWaited: number;
  /** Last measured coverage price — re-nudge only on visible progress. */
  lastPrice: number;
  /** compactRegion's held promise (spec §6 open question 2). */
  waiter?: {
    resolve: (result: CompactionResultT) => void;
    reject: (error: unknown) => void;
  };
}

/** Loose event shape for log scans (the session event union is harness-side). */
interface LogEvent {
  readonly seq: SessionSeq;
  readonly type: string;
  readonly data: unknown;
}

/** Read `source` off a surface event's data (`user/message` carries it
 *  directly; `developer/message` nests it under `message`). */
function sourceOf(event: LogEvent): Record<string, unknown> | undefined {
  const data = event.data as { source?: Record<string, unknown>; message?: { source?: Record<string, unknown> } };
  return data?.source ?? data?.message?.source;
}

/** Source kind of the MODEL's checkpoint commits (the plugin's
 *  context_edit compaction mode). Deliberately NOT 'compact-checkpoint':
 *  the replay validator requires a replace carrying the stock kind to have
 *  a matching OPEN compaction at that point in the log, and checkpoints
 *  land while no markers exist yet (close-time markers). The consolidated
 *  node the engine writes at close DOES use the stock kind. */
const CLM_CHECKPOINT_KIND = "dsh-clm-checkpoint";

/** Framing duplicated from the dsh-clm plugin (src/core/compaction.ts —
 *  the engine bundle cannot import the plugin). Keep in sync. */
const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";

/** Whether the surface node is one of OUR checkpoint commits. */
function isClmCheckpoint(session: Session, seq: SessionSeq): boolean {
  const event = session.eventAt(seq) as unknown as LogEvent | undefined;
  if (event === undefined) return false;
  const source = sourceOf(event);
  return source?.kind === CLM_CHECKPOINT_KIND;
}

/** Text of a checkpoint node with the framing stripped (the consolidated
 *  close node re-wraps everything in ONE frame). Falls back to the raw
 *  text when the framing is absent. */
function extractCheckpointText(session: Session, seq: SessionSeq): string {
  const event = session.eventAt(seq) as unknown as LogEvent | undefined;
  const data = (event?.data ?? {}) as { content?: Array<{ type?: string; text?: string }>; message?: { content?: Array<{ type?: string; text?: string }> } };
  const blocks = data.content ?? data.message?.content ?? [];
  const raw = blocks.map((block) => block.text ?? "").join("\n");
  const open = raw.indexOf(SUMMARY_OPEN_TAG);
  const close = raw.indexOf(SUMMARY_CLOSE_TAG);
  if (open !== -1 && close > open) return raw.slice(open + SUMMARY_OPEN_TAG.length, close).trim();
  return raw.trim();
}

/** First ~80 chars of a node's projected text, for the nudge's "find this
 *  in the map" anchors. */
function nodePreview(session: Session, seq: SessionSeq): string {
  try {
    const event = session.eventAt(seq);
    if (event === undefined) return "(no text)";
    const message = session.deriveEventMessage(event);
    const text = (message?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length === 0 ? "(no text)" : text.slice(0, 80);
  } catch {
    return "(no text)";
  }
}

/** Overflow wordings that dsh-llm's `isContextWindowExceededError` misses
 *  (compaction-engine.md §6 item 9). Kimi's measured wording:
 *  "Your request exceeded k3-256k model token limit: 262144" — every stock
 *  pattern requires the literal word "context", which Kimi never says. */
const UNCLASSIFIED_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /\b(?:request|prompt|input)\b.{0,40}\bexceed(?:ed|s)?\b.{0,40}\b(?:[\w.-]+\s+)?model\s+token\s+limit\b/i,
];

/** The literal value of dsh-llm's CONTEXT_WINDOW_EXCEEDED_CODE (the package
 *  is not linkable from here; the code string is stable API). */
const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";

/** Loose shape of the agent/request-error event payload the shim consumes. */
interface RequestErrorEvent {
  readonly agent: { readonly session: Session; readonly options: Record<string, unknown> };
  readonly failure: { readonly code?: string; readonly message?: string };
  readonly signal: AbortSignal;
}

/** Loose ctx view for listener registration (cordis Context at runtime). */
interface ListenerCtx {
  on(event: string, listener: (event: never, next: () => unknown) => unknown): void;
  logger: { info(message: string): void; warn(message: string): void };
}

/**
 * CLM compaction backend. Stage 2: the three-phase self-edit loop
 * (nudge → `context_edit(compaction: …)` checkpoints → close/fallback) inside
 * the stock marker protocol; telemetry/UI see the ordinary
 * `compaction/start|summary|end` lifecycle.
 */
export class ClmCompactionEngine extends BasicCompactionEngine {
  /** Reuse basic's schema: schemastery passes unknown (CLM) keys through to
   *  the constructor, where resolveClmConfig validates them. */
  static Config = BasicCompactionEngine.Config;

  /** Resolved and validated CLM configuration half. */
  readonly clm: ResolvedClmConfig;

  /** Open self-edit transactions, one per session. */
  private readonly pending = new WeakMap<Session, PendingClm>();

  /** Retry counter for the overflow-wording shim (per agent). */
  private readonly shimOverflowRetries = new WeakMap<object, number>();

  /** Consecutive self-edit timeouts per session (spec §6 item 4); at
   *  `deescalateAfter` the session drops to the classic path for good. */
  private readonly consecutiveTimeouts = new WeakMap<Session, number>();

  constructor(ctx: HarnessContext, config: ClmCompactionConfig = {}) {
    super(ctx, basicConfigOf(config));
    this.clm = resolveClmConfig(config);
    if (this.clm.overflowWording === "shim") this.registerOverflowWordingShim();
  }

  /**
   * Overflow-wording shim (spec §6 item 9): when the provider's overflow
   * wording escapes dsh-llm's classifier, basic's `agent/request-error`
   * listener never fires and the session dies at the wall. This listener
   * (registered AFTER basic's, i.e. inner) recognizes the missed wordings
   * and runs the same growth-gated retry flow through OUR compactIfNeeded,
   * so the CLM overflow protocol (nudge with the tighter deadline, then
   * fallback) applies. Already-classified failures pass through untouched.
   */
  private registerOverflowWordingShim(): void {
    const ctx = this.ctx as unknown as ListenerCtx;
    ctx.on("agent/status", (({ agent, status }: { agent: object; status: string }) => {
      if (status === "idle") this.shimOverflowRetries.delete(agent);
    }) as never);
    ctx.on("agent/request-error", (async (event: RequestErrorEvent, next: () => unknown) => {
      const { agent, failure, signal } = event;
      if (signal.aborted) return next();
      if (failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) return next();
      const detail = `${failure.code ?? ""} ${failure.message ?? ""}`;
      if (!UNCLASSIFIED_OVERFLOW_PATTERNS.some((pattern) => pattern.test(detail))) return next();
      const session = agent.session;
      const target = routedTarget(session);
      const maxRetries = target === undefined
        ? (this.config.maxOverflowRetries ?? 1)
        : resolveTargetPolicy(this.config, target).maxOverflowRetries;
      const retries = this.shimOverflowRetries.get(agent) ?? 0;
      if (retries >= maxRetries) return next();
      const generation = session.surface.replaceGeneration;
      let result;
      try {
        result = await this.compactIfNeeded(agent as unknown as Agent, "context-overflow", signal);
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        if (!signal.aborted && session.surface.replaceGeneration > generation) {
          ctx.logger.warn(`context-overflow wording shim: compaction failed after durable surface progress: ${message}; retrying from the replacement surface`);
          this.shimOverflowRetries.set(agent, retries + 1);
          return { kind: "retry" };
        }
        ctx.logger.warn(`context-overflow wording shim: compaction failed: ${message}; preserving the original request error`);
        return next();
      }
      if (signal.aborted || session.surface.replaceGeneration <= generation) return next();
      if (result !== null) {
        ctx.logger.info(`context-overflow wording shim: shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens)`);
      }
      this.shimOverflowRetries.set(agent, retries + 1);
      return { kind: "retry" };
    }) as never);
  }

  /** The token meter, narrowed to the measurement shape the gate consumes. */
  private measure(session: Session): Measurement {
    const meter = (this.ctx as unknown as { tokenMeter: { measure(s: Session): Measurement } }).tokenMeter;
    return meter.measure(session);
  }

  /**
   * Three-phase CLM loop (spec §4.2):
   *  1. no pending → gate (basic's threshold policy, copied) → open the
   *     transaction + nudge → return null;
   *  2. pending, not compact enough → wait (re-nudge on progress) → null;
   *  3. pending, compact enough → close with a CompactionResult;
   *     pending, deadline missed → `compaction/end { error }` + fallback.
   */
  override async compactIfNeeded(agent: Agent, trigger: Trigger, signal: AbortSignal) {
    const session = agent.session as unknown as Session;
    const pending = this.pending.get(session);

    if (pending !== undefined) {
      if (this.isCompactEnough(session, pending)) {
        this.pending.delete(session);
        return this.closeTransaction(session, pending);
      }
      pending.stepsWaited += 1;
      const maxWait = pending.trigger === "context-overflow" ? this.clm.overflowMaxWaitSteps : this.clm.maxWaitSteps;
      if (pending.stepsWaited > maxWait || signal.aborted) {
        this.pending.delete(session);
        const errorText = signal.aborted
          ? "clm-aborted: the turn was cancelled while awaiting self-edit"
          : `clm-timeout: self-edit did not reach the budget within ${maxWait} steps`;
        // Nothing was logged at open, so no marker needs closing. A short
        // surface notice retires the id so the model stops checkpointing
        // into a dead transaction (user/message = step-independent, like
        // the nudge itself).
        session.append("user/message", {
          id: `dsh-clm-compaction-${randomUUID()}`,
          role: "user",
          content: [{ type: "text", text: `[clm-compaction ${pending.compactionId}] Expired (${errorText}). The engine is handling compaction itself now — do not call context_edit with this compaction id.` }],
          source: { kind: "dsh-clm-compaction", compactionId: pending.compactionId, expired: true },
        } as unknown as never, { surfaceOp: "append" });
        // De-escalation bookkeeping (spec §6 item 4): only the automatic
        // path counts — a compactRegion caller explicitly asked for CLM.
        if (pending.origin === "auto") {
          this.consecutiveTimeouts.set(session, (this.consecutiveTimeouts.get(session) ?? 0) + 1);
        }
        if (pending.origin === "region") {
          return await this.settleRegionFallback(agent, pending, signal, errorText);
        }
        return this.fallbackCompact(agent, trigger, signal);
      }
      // Re-nudge only on visible progress; a silent wait means the model is
      // mid-map, and under overflow every extra surface node hurts (§6.6).
      const price = this.coveragePrice(session, pending);
      if (price !== undefined && price < pending.lastPrice && trigger === "pressure") {
        pending.lastPrice = price;
        this.nudge(session, pending, price);
      }
      return null;
    }

    // Phase 1: basic's gate, copied (threshold → prune → span selection).
    const target = routedTarget(session);
    if (target === undefined) return null;
    // De-escalated sessions skip the CLM path entirely (spec §6 item 4).
    if ((this.consecutiveTimeouts.get(session) ?? 0) >= this.clm.deescalateAfter) {
      return super.compactIfNeeded(agent, trigger, signal);
    }
    const policy = resolveTargetPolicy(this.config, target);
    const prune = (this.ctx as unknown as { get(name: string): { pruneSession(s: Session): void } | undefined }).get("toolResultPruner");
    let measurement = this.measure(session);
    let retainTokens: number;
    if (trigger === "context-overflow") {
      if (prune !== undefined) {
        prune.pruneSession(session);
        measurement = this.measure(session);
      }
      retainTokens = 0;
    } else {
      const llm = (this.ctx as unknown as {
        llm: { resolveModelInfo(p: string, m: string, s?: AbortSignal): Promise<{ context?: { contextWindow: number }; defaultMaxTokens?: number }> };
      }).llm;
      const info = await llm.resolveModelInfo(target.provider, target.model, signal);
      if (info.context === undefined) {
        throw new Error(`dsh-clm-compaction: no context capacity for ${target.provider}/${target.model}; configure contextWindow on that adapter model`);
      }
      const spec = resolveCompactSpec(policy, target, info.context.contextWindow, reservedCompletionTokens(session, info.defaultMaxTokens));
      if (measurement.totalTokens < spec.thresholdTokens) return null;
      if (prune !== undefined) {
        prune.pruneSession(session);
        measurement = this.measure(session);
      }
      if (measurement.totalTokens < spec.thresholdTokens) return null;
      retainTokens = spec.retainTokens;
    }

    const range = selectCompactableRange(session, measurement, retainTokens);
    if (range === null) return null;
    const entry = inspectCompactionEntryState(session);
    if (entry.unmatchedCompactionStart !== undefined) {
      throw new Error("dsh-clm-compaction: another compaction transaction is already active");
    }

    const nodes = measurement.nodes;
    const startIdx = nodes.findIndex((node) => node.seq === range.start);
    const endIdx = nodes.findIndex((node) => node.seq === range.end);
    const pricedSpan = nodes.slice(startIdx, endIdx + 1);
    const baselineTokens = pricedSpan.reduce((sum, node) => sum + node.heuristicTokens, 0);
    const compactionId = CompactionId(randomUUID());
    // CLOSE-TIME MARKERS (spec §4.2 deviation, forced by the session format —
    // see closeTransaction): NOTHING is logged at open. The open state is the
    // in-memory pending entry plus the surface nudge; the stock
    // compaction/start|summary|replace|end chain is emitted atomically at
    // close, inside one pre-step, so a turn boundary or a process death can
    // never strand an open transaction in the log.
    const pendingClm: PendingClm = {
      compactionId,
      startSeq: -1 as unknown as SessionSeq, // set to the nudge's seq below
      span: range,
      shadowedSeqs: pricedSpan.map((node) => node.seq),
      baselineTokens,
      budgetTokens: Math.max(1, Math.floor(baselineTokens * this.clm.targetReductionRatio)),
      turn: entry.openTurn,
      trigger,
      origin: "auto",
      stepsWaited: 0,
      lastPrice: baselineTokens,
    };
    const nudgeEvent = this.nudge(session, pendingClm);
    (pendingClm as { startSeq: SessionSeq }).startSeq = nudgeEvent.seq;
    this.pending.set(session, pendingClm);
    return null;
  }

  /** Surface nudge: an additive user/message telling the model which span
   *  to fold, to what budget, by which deadline (spec §4.2 step 1). The
   *  source carries the full transaction parameters so the context_edit
   *  plugin can discover the open transaction log-only (findOpenCompaction).
   *  Returns the appended event (its seq anchors the pending entry). */
  private nudge(session: Session, pending: PendingClm, currentPrice?: number): LogEvent {
    const surfaceNodes = session.surface.nodes as readonly SessionSeq[];
    const startPos = surfaceNodes.indexOf(pending.span.start);
    const endPos = surfaceNodes.indexOf(pending.span.end);
    const maxWait = pending.trigger === "context-overflow" ? this.clm.overflowMaxWaitSteps : this.clm.maxWaitSteps;
    const remaining = Math.max(0, maxWait - pending.stepsWaited);
    const progress = currentPrice === undefined
      ? ""
      : ` Progress so far: the span now costs ~${currentPrice} of the original ~${pending.baselineTokens} tokens — keep going.`;
    const text = [
      `[clm-compaction ${pending.compactionId}] Context pressure: condense the conversation span at map node positions ${startPos}–${endPos} (~${pending.baselineTokens} tokens) down to ≤ ${pending.budgetTokens} tokens, within ${remaining} step${remaining === 1 ? "" : "s"}.`,
      `The span opens with "${nodePreview(session, pending.span.start)}" and closes with "${nodePreview(session, pending.span.end)}".`,
      `Use context_edit: call map, find the units covering those positions, and replace them with one compact summary that keeps the user's goal and exact words, your active plan, exact identifiers/paths/commands, and negative knowledge. Pass compaction: "${pending.compactionId}" in the context_edit call so the edit counts toward this transaction.${progress}`,
      `If the deadline passes, the engine falls back to a one-shot classic summary of the same span.`,
    ].join(" ");
    // Carrier: user/message, NOT developer/message. The nudge fires from a
    // PRE-STEP listener (between steps), and the replay validator
    // (dsh-session-format-v3-to-v4) requires developer/message to name the
    // currently open turn+step — a developer nudge makes the whole session
    // UNRESUMABLE (found by the headless dogfood 2026-10-10: "stored log is
    // corrupt … does not match an open turn and step"). user/message is
    // step-independent in BOTH validators (live: `case "user/message":
    // break`, replay: not in STEP_EVENT_TYPES) and still folds onto the
    // surface as a first-class node — the same carrier checkpoints use.
    return session.append("user/message", {
      id: `dsh-clm-compaction-${randomUUID()}`,
      role: "user",
      content: [{ type: "text", text }],
      source: {
        kind: "dsh-clm-compaction",
        compactionId: pending.compactionId,
        baselineTokens: pending.baselineTokens,
        budgetTokens: pending.budgetTokens,
        deadlineSteps: maxWait,
        trigger: pending.trigger,
      },
    } as unknown as never, // branded MessageId / custom source kind — the bundle can't import the brand types
    { surfaceOp: "append" }) as unknown as LogEvent;
  }

  /**
   * Current heuristic price of the pending span's coverage: the checkpoint
   * nodes carrying our compactionId plus the still-untouched shadowed seqs.
   * `undefined` when no checkpoint has landed yet.
   */
  private coveragePrice(session: Session, pending: PendingClm): number | undefined {
    return this.coverage(session, pending)?.price;
  }

  private coverage(session: Session, pending: PendingClm): { price: number; nodes: PricedNode[] } | undefined {
    const measurement = this.measure(session);
    const shadowed = new Set<SessionSeq>(pending.shadowedSeqs);
    const covered: PricedNode[] = [];
    let checkpoints = 0;
    for (const node of measurement.nodes) {
      let include = shadowed.has(node.seq);
      if (!include) {
        const event = session.eventAt(node.seq);
        const source = event === undefined ? undefined : sourceOf(event as unknown as LogEvent);
        if (source?.kind === CLM_CHECKPOINT_KIND && source.compactionId === pending.compactionId) {
          include = true;
          checkpoints += 1;
        }
      }
      if (include) covered.push(node);
    }
    if (checkpoints === 0) return undefined;
    return { price: covered.reduce((sum, node) => sum + node.heuristicTokens, 0), nodes: covered };
  }

  /** Close detector (spec §4.8): ≥1 checkpoint of ours, coverage price ≤
   *  budget, span edges still tool-pairing balanced. */
  private isCompactEnough(session: Session, pending: PendingClm): boolean {
    const coverage = this.coverage(session, pending);
    if (coverage === undefined) return false;
    if (coverage.price > pending.budgetTokens) return false;
    const first = coverage.nodes[0]!;
    const last = coverage.nodes[coverage.nodes.length - 1]!;
    return toolPairingBalancedBefore(session, first.seq) && toolPairingBalancedAfter(session, last.seq);
  }

  /** Phase 3: close the transaction (spec §4.2 step 3 — CLOSE-TIME MARKERS
   *  variant). The session format (dsh-session-format-v3-to-v4 replay)
   *  requires the whole compaction chain — start, summary, surface
   *  replacement, end — to live inside ONE turn with the summary adjacent
   *  to the replace it meters (`turn/* crosses an open compaction`,
   *  `compaction/end changes its owner turn`, `shadowedSeqs do not name an
   *  exact current surface span`). A multi-step self-edit transaction can
   *  outlive its turn (the model may answer final instead of editing), so
   *  the engine logs NOTHING at open and emits the entire stock chain
   *  atomically here, in the current turn: the checkpoints the model
   *  already committed are consolidated into one `compact-checkpoint`
   *  node and the coverage span (checkpoint + leftover nodes, contiguous
   *  by construction) is replaced by it — a textbook classic compaction
   *  for the stock UI, priced exactly like the coverage it retires. */
  private closeTransaction(session: Session, pending: PendingClm): CompactionResultT {
    const coverage = this.coverage(session, pending)!; // caller checked isCompactEnough
    const coverageSeqs = coverage.nodes.map((node) => node.seq);
    const first = coverageSeqs[0]!;
    const last = coverageSeqs[coverageSeqs.length - 1]!;
    const checkpointTexts = coverageSeqs
      .filter((seq) => isClmCheckpoint(session, seq))
      .map((seq) => extractCheckpointText(session, seq));
    const consolidated = [
      CHECKPOINT_PREAMBLE,
      "",
      `${SUMMARY_OPEN_TAG}\n${checkpointTexts.join("\n\n")}\n${SUMMARY_CLOSE_TAG}`,
    ].join("\n");
    const turn = inspectCompactionEntryState(session).openTurn;
    // shadowedRange is POSITIONAL (the replay span() check slices
    // surface.nodes with it): after the model's replaces, coverage seqs are
    // no longer position-ordered (the checkpoint node slides to the span's
    // first position), so seqs != positions here. surfaceOp startSeq/endSeq
    // stay the coverage's first/last SEQS — the surface manager resolves
    // them positionally, so (checkpointSeq > leftoverSeq) pairs are legal.
    const surfaceNodes = session.surface.nodes as readonly SessionSeq[];
    const startPos = surfaceNodes.indexOf(first);
    const endPos = surfaceNodes.indexOf(last);
    const startEvent = (session.append as (type: string, data: unknown) => LogEvent)("compaction/start", {
      compactionId: pending.compactionId,
      turn,
    });
    const summaryEvent = (session.append as (type: string, data: unknown) => LogEvent)("compaction/summary", {
      compactionId: pending.compactionId,
      summary: [{ type: "text", text: consolidated }],
      shadowedRange: { start: startPos, end: endPos },
      shadowedSeqs: [...coverageSeqs],
      shadowedTokenCount: coverage.price,
      provider: "unknown",
      model: "unknown",
    });
    const checkpointEvent = session.append("user/message", {
      id: `dsh-clm-${randomUUID()}`,
      role: "user",
      content: [{ type: "text", text: consolidated }],
      source: { kind: "compact-checkpoint", compactionId: pending.compactionId, clm: true },
    } as unknown as never, {
      surfaceOp: { op: "replace", startSeq: first, endSeq: last },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...coverageSeqs],
    }) as unknown as LogEvent;
    const endEvent = (session.append as (type: string, data: unknown) => LogEvent)("compaction/end", {
      compactionId: pending.compactionId,
      turn,
    });
    const result = {
      compactionId: pending.compactionId,
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: [{ type: "text", text: consolidated }],
      shadowedRange: { start: pending.span.start, end: pending.span.end },
      shadowedSeqs: [...pending.shadowedSeqs],
      shadowedTokenCount: pending.baselineTokens,
    } as unknown as CompactionResultT;
    void checkpointEvent;
    pending.waiter?.resolve(result);
    // A successful close resets the de-escalation counter (spec §6 item 4).
    this.consecutiveTimeouts.delete(session);
    return result;
  }

  /**
   * Fixed-span fallback for a timed-out/aborted compactRegion (spec §4.7):
   * the classic compaction of THAT span fulfills the caller's held promise;
   * 'off'/'fail' reject it. The pre-step that detected the timeout returns
   * null either way — the error travels through the waiter, not the
   * pre-step listener.
   */
  private async settleRegionFallback(
    agent: Agent,
    pending: PendingClm,
    signal: AbortSignal,
    errorText: string,
  ) {
    const waiter = pending.waiter;
    try {
      if (this.clm.fallback === "off") throw new Error(`dsh-clm-compaction: ${errorText}`);
      if (this.clm.fallback === "fail") {
        throw new Error("dsh-clm-compaction: self-edit transaction failed and fallback is 'fail'");
      }
      const result = await super.compactRegion(pending.span.start, pending.span.end, agent, signal);
      waiter?.resolve(result as unknown as CompactionResultT);
      return null;
    } catch (error) {
      waiter?.reject(error);
      if (waiter === undefined) throw error;
      return null;
    }
  }

  /**
   * Explicit-span compaction (spec §4.7): the same async protocol as the
   * pressure path — validate the fixed span's balanced edges, open the
   * transaction, nudge with the exact span — but the returned promise is
   * HELD until the close detector fires on a later pre-step (open question
   * 2), then resolves with the CompactionResult; on timeout/abort the
   * classic compaction of the same span fulfills it (or rejects for
   * 'off'/'fail'). With another transaction already open, or when called
   * outside a turn, the classic synchronous path keeps the contract.
   */
  override async compactRegion(
    start: Parameters<BasicCompactionEngine["compactRegion"]>[0],
    end: Parameters<BasicCompactionEngine["compactRegion"]>[1],
    agent: Parameters<BasicCompactionEngine["compactRegion"]>[2],
    signal?: Parameters<BasicCompactionEngine["compactRegion"]>[3],
  ): Promise<CompactionResultT> {
    const session = agent.session as unknown as Session;
    if (this.pending.has(session)) {
      throw new Error("dsh-clm-compaction: a CLM self-edit transaction is already open on this session");
    }
    const entry = inspectCompactionEntryState(session);
    if (entry.unmatchedCompactionStart !== undefined || entry.openTurn === null) {
      return super.compactRegion(start, end, agent, signal);
    }
    // Validate the fixed span exactly like basic's validateSurfaceRegion.
    const surfaceNodes = session.surface.nodes as readonly SessionSeq[];
    const startIdx = surfaceNodes.indexOf(start as unknown as SessionSeq);
    const endIdx = surfaceNodes.indexOf(end as unknown as SessionSeq);
    if (startIdx === -1) throw new Error(`compactRegion: start seq ${String(start)} not found in surface`);
    if (endIdx === -1) throw new Error(`compactRegion: end seq ${String(end)} not found in surface`);
    if (startIdx > endIdx) {
      throw new Error(`compactRegion: start seq ${String(start)} (position ${startIdx}) is after end seq ${String(end)} (position ${endIdx}) on the surface`);
    }
    if (!toolPairingBalancedBefore(session, surfaceNodes[startIdx]!)) {
      throw new Error(`compactRegion: start seq ${String(start)} is not a balanced boundary (would split a step's tool-call/result pair)`);
    }
    if (!toolPairingBalancedAfter(session, surfaceNodes[endIdx]!)) {
      throw new Error(`compactRegion: end seq ${String(end)} is not a balanced boundary (would split a step, or the step is still open)`);
    }
    const measurement = this.measure(session);
    const pricedSpan = measurement.nodes.slice(startIdx, endIdx + 1);
    const baselineTokens = pricedSpan.reduce((sum, node) => sum + node.heuristicTokens, 0);
    const compactionId = CompactionId(randomUUID());
    // Marker-free open — same close-time-markers rationale as the pressure
    // path (see phase 1).
    const pending: PendingClm = {
      compactionId,
      startSeq: -1 as unknown as SessionSeq, // set to the nudge's seq below
      span: { start: start as unknown as SessionSeq, end: end as unknown as SessionSeq },
      shadowedSeqs: pricedSpan.map((node) => node.seq),
      baselineTokens,
      budgetTokens: Math.max(1, Math.floor(baselineTokens * this.clm.targetReductionRatio)),
      turn: entry.openTurn,
      trigger: "pressure",
      origin: "region",
      stepsWaited: 0,
      lastPrice: baselineTokens,
    };
    const nudgeEvent = this.nudge(session, pending);
    (pending as { startSeq: SessionSeq }).startSeq = nudgeEvent.seq;
    this.pending.set(session, pending);
    // Hold the promise until the close detector fires on a later pre-step
    // (spec §6 open question 2); abort settles immediately.
    return await new Promise<CompactionResultT>((resolve, reject) => {
      pending.waiter = {
        resolve: resolve as (result: CompactionResultT) => void,
        reject,
      };
      signal?.addEventListener("abort", () => {
        if (!this.pending.has(session)) return;
        // Nothing was logged at open, so nothing needs closing — the
        // surface nudge stays as inert history (the waiter rejects).
        this.pending.delete(session);
        reject(signal.reason instanceof Error ? signal.reason : new Error("compactRegion aborted"));
      }, { once: true });
    });
  }

  /** Classic fallback after a failed self-edit (spec §4.3): the inherited
   *  basic gate re-measures and compacts classically; if pressure has
   *  already dropped (the model edited without the compaction param) it
   *  returns null and nothing double-compacts. */
  private fallbackCompact(agent: Agent, trigger: Trigger, signal: AbortSignal) {
    if (this.clm.fallback === "off") return null;
    if (this.clm.fallback === "fail") {
      throw new Error("dsh-clm-compaction: self-edit transaction failed and fallback is 'fail'");
    }
    return super.compactIfNeeded(agent, trigger, signal);
  }

  /** Manual `/compact` on an idle agent: the model is not running, so the
   *  CLM path is impossible there — classic summary or an explicit reject. */
  override compactNow(
    agent: Parameters<BasicCompactionEngine["compactNow"]>[0],
    signal: AbortSignal,
    sourceCommandId?: Parameters<BasicCompactionEngine["compactNow"]>[2],
  ) {
    if (this.clm.manual === "reject") {
      throw new ManualCompactionError(
        "summary",
        "clm engine compacts only inside working turns (manual: 'reject')",
      );
    }
    return super.compactNow(agent, signal, sourceCommandId);
  }
}

export default ClmCompactionEngine;
