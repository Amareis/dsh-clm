/**
 * dsh-clm-compaction — CLM condensation engine (approach C), Stage 1.
 *
 * `ClmCompactionEngine` subclasses the harness's OWN `BasicCompactionEngine`
 * (resolved through the `node_modules/@deepseek-ai` symlinks created by
 * `scripts/link-harness.mjs`, so class identity — including
 * `ManualCompactionError` `instanceof` checks in `dsh-command-compact` — is
 * preserved). All transactional machinery (span selection, marker protocol,
 * stability checks, retry, overflow recovery, auto triggers with dynamic
 * dispatch) is inherited unchanged.
 *
 * Stage 1 semantics (spec: docs/compaction-engine.md §0):
 *  - the full CLM config surface (`maxWaitSteps`, `overflowMaxWaitSteps`,
 *    `targetReductionRatio`, `fallback`, `manual`) is parsed and validated,
 *    but the CLM three-phase loop is NOT active — `compactIfNeeded` is the
 *    inherited basic behavior;
 *  - `manual: 'reject'` is honored in `compactNow` (the working model is not
 *    generating on an idle agent, so self-edit is impossible there);
 *  - `fallback` is parsed for Stage 2 and otherwise unused.
 *
 * Config plumbing note: `static Config` reuses basic's schemastery schema —
 * schemastery objects pass unknown keys through, so the CLM fields reach the
 * constructor, where `resolveClmConfig` validates them (basic's own
 * `resolveConfig` REJECTS unknown keys, so CLM fields are stripped before
 * `super`). Config errors fail plugin load, same as basic's.
 */

import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import type { BasicCompactionConfig } from "@deepseek-ai/dsh-compaction-basic";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";

/** The harness's own Context type, derived from the base class signature —
 *  importing `Context` directly would resolve to this repo's type-only
 *  devDependency copy, which differs from the harness's cordis build. */
type HarnessContext = ConstructorParameters<typeof BasicCompactionEngine>[0];

/** Escalation policy when the model's self-edit misses its deadline (Stage 2). */
export type ClmFallbackMode = "basic" | "fail" | "off";
/** Behavior of manual `/compact` on an idle agent. */
export type ClmManualMode = "basic" | "reject";

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
}

/** Validated immutable CLM config (the basic half lives in `this.config`). */
export interface ResolvedClmConfig {
  readonly maxWaitSteps: number;
  readonly overflowMaxWaitSteps: number;
  readonly targetReductionRatio: number;
  readonly fallback: ClmFallbackMode;
  readonly manual: ClmManualMode;
}

const CLM_CONFIG_KEYS = [
  "maxWaitSteps",
  "overflowMaxWaitSteps",
  "targetReductionRatio",
  "fallback",
  "manual",
] as const;

const FALLBACK_MODES: readonly ClmFallbackMode[] = ["basic", "fail", "off"];
const MANUAL_MODES: readonly ClmManualMode[] = ["basic", "reject"];

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
  return Object.freeze({
    maxWaitSteps,
    overflowMaxWaitSteps,
    targetReductionRatio,
    fallback,
    manual,
  });
}

/** `config` minus the CLM-only keys (basic's resolveConfig rejects unknowns). */
function basicConfigOf(config: ClmCompactionConfig): BasicCompactionConfig {
  const out: Record<string, unknown> = { ...config };
  for (const key of CLM_CONFIG_KEYS) delete out[key];
  return out as BasicCompactionConfig;
}

/**
 * CLM compaction backend. Stage 1: behaves exactly like
 * `BasicCompactionEngine`; the three-phase self-edit loop (nudge →
 * `context_edit(compaction: …)` checkpoints → close/fallback) lands in
 * Stage 2 by overriding `compactIfNeeded` — the inherited auto triggers
 * dispatch dynamically, so the override is picked up without rewiring.
 */
export class ClmCompactionEngine extends BasicCompactionEngine {
  /** Reuse basic's schema: schemastery passes unknown (CLM) keys through to
   *  the constructor, where resolveClmConfig validates them. */
  static Config = BasicCompactionEngine.Config;

  /** Resolved and validated CLM configuration half. */
  readonly clm: ResolvedClmConfig;

  constructor(ctx: HarnessContext, config: ClmCompactionConfig = {}) {
    super(ctx, basicConfigOf(config));
    this.clm = resolveClmConfig(config);
  }

  /** Manual `/compact` on an idle agent: the model is not running, so the
   *  CLM path is impossible there — classic summary or an explicit reject. */
  compactNow(
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
