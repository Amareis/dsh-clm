import { formatTokens } from "./format.js";
import { countEdits } from "./nodes.js";
import type { MeterLike, Session } from "./types.js";

/** Live budget line(s) for the runtime-context snapshot. */
export function renderBudget(session: Session, meter: MeterLike | undefined): string {
  const nodes = session.surface.nodes;
  let total: number | undefined;
  if (meter !== undefined) {
    try {
      total = meter.measure(session).totalTokens;
    } catch {
      total = undefined;
    }
  }
  if (total === undefined) {
    total = 0;
    for (const seq of nodes) {
      const event = session.eventAt(seq);
      const message = event === undefined ? undefined : session.deriveEventMessage(event);
      if (message !== undefined && message !== null) total += Math.ceil(JSON.stringify(message.content).length / 4);
    }
  }
  const window = session.requestContext?.()?.contextWindow;
  const edits = countEdits(session);
  if (window === undefined) {
    // Quantize to 5K: identical text never re-commits a durable snapshot.
    const coarse = Math.round(total / 5_000) * 5_000;
    return `context budget: ~${formatTokens(coarse)} tokens in context · self-edits applied: ${edits}`;
  }
  // NOTE: deliberately NO maxTokens reservation here. The dogfooding overflow
  // (docs/self-compaction-log.md, 2026-10-10) pinned the provider's wall at
  // ~71% of the raw window with maxTokens = window/2 — the provider DOES
  // reserve completion budget, but by an unmeasurable provider-specific
  // amount (~75K there, neither the nominal 131K nor a clean 32K). Any
  // formula we baked in would mislead; instead the raw-window counter relies
  // on the 70/75/90 thresholds carrying the margin — and the observed wall
  // matched the 70% nudge almost exactly.
  // Quantize to 5% buckets: the durable snapshot rides history unchanged until
  // the bucket flips, so identical text never re-commits. Threshold lines align
  // with buckets (70/75/90 are multiples of 5).
  const pct = Math.floor((total / window) * 20) * 5;
  const base = `context budget: ~${pct}% of ${formatTokens(window)} tokens · self-edits applied: ${edits}`;
  if (pct >= 90) return `${base}\nBudget past 90% — stop expanding context; run context_edit (map → edit) before any further large reads.`;
  if (pct >= 75) return `${base}\nBudget past 75% — run context_edit now: map the surface, compress completed phases before continuing.`;
  if (pct >= 70) return `${base}\nBudget past 70% — plan a context_edit pass at the next phase boundary.`;
  return base;
}
