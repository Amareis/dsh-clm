/**
 * Compaction-checkpoint mode (spec docs/compaction-engine.md §4.5): when the
 * CLM compaction engine opens a self-edit transaction, the model answers the
 * nudge with `context_edit({…, compaction: '<compactionId>'})`. The plugin
 * commits the replacements as `user/message` checkpoints (source kind
 * 'dsh-clm-checkpoint'); the engine consolidates them into ONE stock
 * `compact-checkpoint` node — with the full compaction/start|summary|end
 * chain — at close time (close-time markers, see the engine's
 * closeTransaction: the session format requires the whole chain inside one
 * turn, so nothing is logged while the transaction is open).
 *
 * Engine ↔ tool coupling is log-only: the plugin discovers the open
 * transaction and its budget from the engine's surface nudge — a
 * user/message whose source carries kind 'dsh-clm-compaction' plus the
 * compactionId and budget fields.
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
  /** Seq of the engine's nudge message that opened the transaction. */
  readonly startSeq: number;
  readonly turn: number | null;
  /** From the nudge's source, when present. */
  readonly budgetTokens?: number;
  readonly baselineTokens?: number;
  readonly deadlineSteps?: number;
}

/**
 * Find an OPEN self-edit transaction with the given id: scan the log tail
 * backwards for the engine's nudge (a user/message whose source carries
 * kind 'dsh-clm-compaction' and the id). A `compaction/end` with the same
 * id met first means the transaction already closed and the edit must be
 * rejected; a nudge whose source is marked `expired` means the deadline
 * passed. Protection against model typos — spec §4.5.2.
 */
export function findOpenCompaction(session: Session, compactionId: string): OpenCompaction | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // The dev-dependency session type union does not include the compaction
    // events (their declaration merging lives in dsh-compaction, which the
    // bundle cannot import) — widen to the loose structural view.
    const event = session.eventAt(asSeq(seq)) as { type: string; data?: Record<string, unknown> } | undefined;
    if (event === undefined) continue;
    const data = event.data;
    if (event.type === "compaction/end" && data?.compactionId === compactionId) return undefined;
    if (event.type !== "user/message") continue;
    const source = data?.source as Record<string, unknown> | undefined;
    if (source?.kind !== "dsh-clm-compaction" || source.compactionId !== compactionId) continue;
    if (source.expired === true) return undefined; // the deadline passed; the engine took over
    return {
      compactionId,
      startSeq: seq,
      turn: null,
      budgetTokens: source.budgetTokens as number | undefined,
      baselineTokens: source.baselineTokens as number | undefined,
      deadlineSteps: source.deadlineSteps as number | undefined,
    };
  }
  return undefined;
}
