import { PROTECT_TAIL, SOURCE_KIND } from "./constants.js";
import { isToolCallBlock } from "./types.js";
import type { EventShape, MessageShape, MeterLike, Session, SurfaceNode, Unit } from "./types.js";
import { asSeq } from "./types.js";

/** Snapshot the current surface: seq, event, derived message, estimated tokens per node. */
export function buildNodes(session: Session, meter: MeterLike | undefined): SurfaceNode[] {
  const seqs = session.surface.nodes;
  const tokenBySeq = new Map<number, number>();
  if (meter !== undefined) {
    try {
      for (const node of meter.measure(session).nodes) tokenBySeq.set(node.seq, node.tokens);
    } catch {
      // measurement is best-effort; char heuristic below covers the fallback
    }
  }
  const nodes: SurfaceNode[] = [];
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    // Derive per event, not deriveMessages()[index]: deriveMessages compacts
    // nulls, so positional indexing misaligns once any null-projecting event
    // exists. Empty-content events project to no wire message (dsh-session
    // surface.js) — the model never sees them, so they are not map units.
    // This is what makes drop replacements (content: []) zero-cost.
    const message = session.deriveEventMessage(event) as MessageShape | null;
    if (message === null || message === undefined) continue;
    nodes.push({
      index: nodes.length,
      seq,
      event: event as EventShape,
      message,
      tokens: tokenBySeq.get(seq) ?? Math.ceil(JSON.stringify(message.content).length / 4)
    });
  }
  return nodes;
}

/** Pair-atomic map units (v8): an assistant node with tool-call blocks plus ALL
 *  its tool/result nodes (matched by toolCallId) is ONE numbered unit — a call
 *  group can never be split by an edit, so pair integrity is prevented at
 *  planning time instead of detected at apply time (the old auto-extend). Lone
 *  nodes (user, text-only assistant, developer markers) and orphan results whose
 *  call is already off the surface are single-node units. */
export function buildUnits(nodes: SurfaceNode[]): Unit[] {
  const toolByCallId = new Map<string, SurfaceNode>();
  for (const node of nodes) {
    const callId = node.message?.toolCallId;
    if (node.message?.role === "tool" && typeof callId === "string") toolByCallId.set(callId, node);
  }
  const claimed = new Set<number>();
  const units: Unit[] = [];
  for (const node of nodes) {
    if (claimed.has(node.index)) continue;
    const calls = (node.message?.content ?? []).filter(isToolCallBlock);
    const members = [node];
    const results = new Map<string, SurfaceNode>();
    claimed.add(node.index);
    for (const call of calls) {
      const result = toolByCallId.get(call.id);
      if (result !== undefined && result.index > node.index && !claimed.has(result.index)) {
        members.push(result);
        results.set(call.id, result);
        claimed.add(result.index);
      }
    }
    members.sort((a, b) => a.index - b.index);
    units.push({ unit: units.length, members, calls, results });
  }
  return units;
}

/** Tool-pairing cut balance (safety net): +1 per assistant tool-call block, -1 per
 *  tool-role result. Message-level, because v7 txn stubs are developer/message
 *  EVENTS that derive to role "tool" (event-type counting would leave them
 *  unbalanced). Orphan results whose call is already off the surface (post-sweep
 *  surgery, legacy surfaces) are neutral — removing them restores validity. With
 *  pair-atomic units every whole-unit span is balanced by construction; this fold
 *  stays as the apply-time assertion. */
export function computeCutBalances(nodes: SurfaceNode[], liveCallIds: ReadonlySet<string>): boolean[] {
  const balanced = [true];
  let open = 0;
  for (const node of nodes) {
    const message = node.message;
    if (message?.role === "assistant") {
      open += (message.content ?? []).filter(isToolCallBlock).length;
    } else if (message?.role === "tool" && message.toolCallId !== undefined && liveCallIds.has(message.toolCallId)) {
      open -= 1;
    }
    balanced.push(open === 0);
  }
  return balanced;
}

/** First locked index: the fresh tail only — node 0 is locked separately.
 *  Locking the whole current turn (an earlier design) made the tool unusable in
 *  single-turn sessions and would deadlock pressure compaction, which always
 *  fires inside a turn. Compaction engines legally replace in-turn; the
 *  "never remove the user's words" rule lives in the prompt policy, not here. */
export function lockedZoneStart(nodes: SurfaceNode[]): number {
  return Math.max(1, nodes.length - PROTECT_TAIL);
}

/** Walk the log tail back to the latest step/start (and turn boundary) — both exist while a tool runs. */
export function currentPosition(session: Session): { turn: number; step: number; turnStartSeq: number } {
  let turnStartSeq = -1;
  let turn = 0;
  let step = 0;
  for (let seq = session.seq - 1; seq >= 0 && (turnStartSeq === -1 || step === 0); seq -= 1) {
    const event = session.eventAt(asSeq(seq));
    if (event === undefined) continue;
    if (event.type === "step/start" && step === 0) {
      turn = event.data.turn;
      step = event.data.step;
    } else if (event.type === "turn/start" && turnStartSeq === -1) {
      turnStartSeq = seq;
    }
  }
  return { turn, step, turnStartSeq };
}

/** Count durable self-edit nodes already on the surface. */
export function countEdits(session: Session): number {
  let count = 0;
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== "developer/message") continue;
    // Loose view: the real MessageSource union does not list our plugin kind.
    const message = event.data.message as unknown as MessageShape;
    if (message.source?.kind === SOURCE_KIND && message.source.sweep !== true) count += 1;
  }
  return count;
}
