import { SOURCE_KIND } from "./constants.js";
import { currentPosition } from "./nodes.js";
import { shadowedSeqsInRange } from "./shadow.js";
import { asSeq } from "./types.js";
import type { MessageShape, Session, SurfaceNode, SweepStats, TxnSpan } from "./types.js";
import type { MessageId, MessageSource } from "@deepseek-ai/dsh-llm";
import type { SessionEventMap, SessionSeq } from "@deepseek-ai/dsh-session";

/** Collapse the given txn spans (highest-first): pure pairs into developer markers,
 *  single results (stubCallId) into tool-role stubs that keep the call link alive,
 *  and drop spans into empty-content events that project to no wire message at
 *  all (the harness's own erase pattern: createSystemMessage("") → content [],
 *  surface.js skips null projections — zero tokens, no marker). */
export function applySpans(session: Session, nodes: SurfaceNode[], spans: TxnSpan[]): SweepStats {
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
      surfaceOp: { op: "replace" as const, startSeq: asSeq(startSeq), endSeq: asSeq(endSeq) },
      sourceEventSeqs: shadowedSeqs as SessionSeq[]
    };
    if (stub) {
      // Result stubs keep the original envelope VERBATIM and change ONLY the
      // content — the real session's assertToolResultRewrite deep-compares
      // everything else (id, source, toolCallId, turn/step) against the
      // shadowed original and rejects any other change. Idempotency still
      // holds: the stub text starts with TXN_MARKER_PREFIX, which findTxnSpans
      // never re-matches. (This bug was latent until tests ran against the
      // real validator — the stub path had never fired live.)
      const originalData = (slice[0]!.event?.data ?? {}) as Record<string, unknown>;
      const originalMessage = (originalData.message ?? {}) as MessageShape;
      const message = { ...originalMessage, content: [{ type: "text", text: span.content ?? "" }] };
      session.append("tool/result", { ...originalData, message } as unknown as SessionEventMap["tool/result"], surfaceRef);
      continue;
    }
    session.append("developer/message", {
      turn,
      step,
      message: {
        id: `dsh-clm-${crypto.randomUUID()}` as MessageId,
        role: "developer",
        content: drop ? [] : [{ type: "text", text: span.content ?? "" }],
        // Our plugin kind carries bookkeeping fields beyond the base source union.
        source: { kind: SOURCE_KIND, sweep: true, ...(drop ? { drop: true } : {}), from: span.from, to: span.to, turn, step } as unknown as MessageSource
      }
    }, surfaceRef);
  }
  return { swept, markers: spans.length - drops, drops, migrated };
}
