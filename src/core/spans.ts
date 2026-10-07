import { SOURCE_KIND } from "./constants.js";
import { currentPosition } from "./nodes.js";
import { shadowedSeqsInRange } from "./shadow.js";
import type { MessageShape, SessionLike, SurfaceNode, SweepStats, TxnSpan } from "./types.js";

/** Collapse the given txn spans (highest-first): pure pairs into developer markers,
 *  single results (stubCallId) into tool-role stubs that keep the call link alive,
 *  and drop spans into empty-content events that project to no wire message at
 *  all (the harness's own erase pattern: createSystemMessage("") → content [],
 *  surface.js skips null projections — zero tokens, no marker). */
export function applySpans(session: SessionLike, nodes: SurfaceNode[], spans: TxnSpan[]): SweepStats {
  if (spans.length === 0) return { swept: 0, markers: 0, drops: 0, migrated: 0 };
  const { turn, step } = currentPosition(session);
  let swept = 0;
  let drops = 0;
  let migrated = 0;
  for (const span of [...spans].sort((a, b) => b.from - a.from)) {
    const slice = nodes.slice(span.from, span.to + 1);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first === undefined || last === undefined) continue;
    const startSeq = first.seq;
    const endSeq = last.seq;
    const shadowedSeqs = shadowedSeqsInRange(session, startSeq, endSeq);
    swept += slice.length;
    const stub = span.stubCallId !== undefined;
    const drop = span.drop === true && !stub;
    if (drop) drops += 1;
    if (span.migrate === true) migrated += 1;
    const surfaceRef = {
      surfaceOp: { op: "replace" as const, startSeq, endSeq },
      sourceEventSeqs: shadowedSeqs
    };
    if (stub) {
      // Result stubs ride a real tool/result event (copy the original
      // envelope, swap content): validateSessionEventData ties
      // developer/message to the developer role, so the old
      // developer-carries-tool-role shape would throw at append.
      const originalData = (slice[0]!.event?.data ?? {}) as Record<string, unknown>;
      const originalMessage = (originalData.message ?? {}) as MessageShape;
      session.append("tool/result", {
        ...originalData,
        message: {
          ...originalMessage,
          id: `dsh-clm-${crypto.randomUUID()}`,
          role: "tool",
          toolCallId: span.stubCallId,
          content: [{ type: "text", text: span.content ?? "" }],
          source: { kind: SOURCE_KIND, sweep: true, from: span.from, to: span.to, turn, step }
        }
      }, surfaceRef);
      continue;
    }
    session.append("developer/message", {
      turn,
      step,
      message: {
        id: `dsh-clm-${crypto.randomUUID()}`,
        role: "developer",
        content: drop ? [] : [{ type: "text", text: span.content ?? "" }],
        source: { kind: SOURCE_KIND, sweep: true, ...(drop ? { drop: true } : {}), from: span.from, to: span.to, turn, step }
      }
    }, surfaceRef);
  }
  return { swept, markers: spans.length - drops, drops, migrated };
}
