/**
 * Compaction-checkpoint mode (spec docs/compaction-engine.md §4.5): when the
 * CLM compaction engine opens a self-edit transaction, the model answers the
 * nudge with `context_edit({…, compaction: '<compactionId>'})`. The plugin
 * then commits the replacements as `user/message` checkpoints recognized by
 * the stock UI (`source.kind === 'compact-checkpoint'`) and meters each
 * replace with a `compaction/summary` event appended IMMEDIATELY before it
 * (the contractual shadow-price adjacency).
 *
 * Engine ↔ tool coupling is log-only: the plugin discovers the open
 * transaction and its budget by scanning for the engine's
 * `compaction/start` / `clm/compaction-nudge` events; no direct calls.
 */

import { asSeq } from "./types.js";
import type { Session } from "./types.js";

/** Framing copied from dsh-compaction-basic (module-private there): the
 *  preamble makes the checkpoint read as installed background, the tags
 *  delimit the condensed content. */
export const CHECKPOINT_PREAMBLE =
  "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
export const SUMMARY_OPEN_TAG = "<compacted-summary>";
export const SUMMARY_CLOSE_TAG = "</compacted-summary>";

/** An open self-edit transaction discovered in the session log. */
export interface OpenCompaction {
  readonly compactionId: string;
  /** Seq of the unmatched `compaction/start` event. */
  readonly startSeq: number;
  readonly turn: number | null;
  /** From the engine's `clm/compaction-nudge` event, when present. */
  readonly budgetTokens?: number;
  readonly baselineTokens?: number;
  readonly deadlineSteps?: number;
}

/**
 * Find an UNMATCHED `compaction/start` with the given id: scan the log tail
 * backwards; a `compaction/end` with the same id met first means the
 * transaction already closed (timeout/fallback/close) and the edit must be
 * rejected. The engine's `clm/compaction-nudge` event (same id) supplies the
 * budget numbers for the receipt. Protection against model typos — spec
 * §4.5.2, the same tail inspection as basic's entry-state check.
 */
export function findOpenCompaction(session: Session, compactionId: string): OpenCompaction | undefined {
  let nudge: { budgetTokens?: number; baselineTokens?: number; deadlineSteps?: number } | undefined;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // The dev-dependency session type union does not include the compaction
    // events (their declaration merging lives in dsh-compaction, which the
    // bundle cannot import) — widen to the loose structural view.
    const event = session.eventAt(asSeq(seq)) as { type: string; data?: Record<string, unknown> } | undefined;
    if (event === undefined) continue;
    const data = event.data;
    if (data?.compactionId !== compactionId) continue;
    if (event.type === "compaction/end") return undefined;
    if (event.type === "clm/compaction-nudge") {
      nudge = {
        budgetTokens: data.budgetTokens as number | undefined,
        baselineTokens: data.baselineTokens as number | undefined,
        deadlineSteps: data.deadlineSteps as number | undefined,
      };
      continue;
    }
    if (event.type === "compaction/start") {
      return {
        compactionId,
        startSeq: seq,
        turn: (data.turn as number | null | undefined) ?? null,
        ...nudge,
      };
    }
  }
  return undefined;
}
