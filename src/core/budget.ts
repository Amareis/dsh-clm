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
  // Quantize to 5% buckets: the durable snapshot rides history unchanged until
  // the bucket flips, so identical text never re-commits. Threshold lines align
  // with buckets (50/75/90 are multiples of 5).
  const pct = Math.floor((total / window) * 20) * 5;
  const base = `context budget: ~${pct}% of ${formatTokens(window)} tokens · self-edits applied: ${edits}`;
  if (pct >= 90) return `${base}\nBudget past 90% — stop expanding context; run context_edit (map → edit) before any further large reads.`;
  if (pct >= 75) return `${base}\nBudget past 75% — run context_edit now: map the surface, compress completed phases before continuing.`;
  if (pct >= 50) return `${base}\nBudget past 50% — plan a context_edit pass at the next phase boundary.`;
  return base;
}
