import { formatTokens } from "./format.js";
import { countEdits } from "./nodes.js";
import type { MeterLike, SessionLike } from "./types.js";

/** Live budget line(s) for the runtime-context snapshot. */
export function renderBudget(session: SessionLike, meter: MeterLike | undefined): string {
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
  const base = window === undefined
    ? `context budget: ~${formatTokens(total)} tokens in context · self-edits applied: ${edits}`
    : `context budget: ~${formatTokens(total)} / ${formatTokens(window)} tokens (${Math.round((total / window) * 100)}%) · self-edits applied: ${edits}`;
  if (window === undefined) return base;
  const ratio = total / window;
  if (ratio >= 0.9) return `${base}\nBudget past 90% — stop expanding context; run context_edit (map → edit) before any further large reads.`;
  if (ratio >= 0.75) return `${base}\nBudget past 75% — run context_edit now: map the surface, compress completed phases before continuing.`;
  if (ratio >= 0.5) return `${base}\nBudget past 50% — plan a context_edit pass at the next phase boundary.`;
  return base;
}
