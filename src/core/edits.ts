import { CHECKPOINT_PREAMBLE, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG } from "./compaction.js";
import type { OpenCompaction } from "./compaction.js";
import { PROTECT_TAIL, SOURCE_KIND } from "./constants.js";
import { formatTokens } from "./format.js";
import { buildNodes, buildUnits, computeCutBalances, currentPosition, lockedZoneStart } from "./nodes.js";
import { shadowedSeqsInRange } from "./shadow.js";
import { findSnapshotFolds, isSnapshotNode } from "./snapshots.js";
import { applySpans } from "./spans.js";
import { findEagerPairSpan, findTxnSpans } from "./txns.js";
import { asSeq } from "./types.js";
import type { EditInput, MeterLike, Session, SurfaceNode, SweepStats } from "./types.js";
import type { MessageId, MessageSource } from "@deepseek-ai/dsh-llm";
import type { SessionSeq } from "@deepseek-ai/dsh-session";

/** Compact per-role census of a replaced span, e.g. "2 user, 5 assistant,
 *  10 tool, 3 snapshot". Runtime-context snapshots (user/message role) count
 *  as "snapshot", not "user"; null-projection nodes count as "dropped".
 *  Replaces the old raw "assistant+tool+user+…" sequence, which scaled with
 *  span length and carried no information beyond the first few entries. */
export function summarizeSpanRoles(span: SurfaceNode[]): string {
  const counts = new Map<string, number>();
  for (const node of span) {
    const role = isSnapshotNode(node) ? "snapshot" : node.message?.role ?? "dropped";
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  const order = ["user", "assistant", "tool", "developer", "system", "snapshot", "dropped"];
  return [...counts.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    })
    .map(([role, n]) => `${n} ${role}`)
    .join(", ");
}

interface WorkEdit extends EditInput {
  spanFrom?: number;
  spanTo?: number;
}

interface MergedSpan {
  spanFrom: number;
  spanTo: number;
  fromUnit: number;
  toUnit: number;
  content: string;
}

interface PreparedSpan {
  edit: MergedSpan;
  startSeq: number;
  endSeq: number;
  shadowedSeqs: number[];
  spanTokens: number;
  freed: number;
  marker: string;
}

/** Validate and apply one edit batch; returns the receipt text.
 *  Ranges address UNITS (pair-atomic), so a call/result pair can never be split —
 *  there is no auto-extend; whole-unit spans are balanced by construction.
 *  With `compaction` (an open transaction from findOpenCompaction) the batch
 *  runs in checkpoint mode (spec §4.5): each replace is metered by a
 *  `compaction/summary` event appended immediately before it, and the
 *  replacement is a `user/message` checkpoint with
 *  `source = { kind: 'compact-checkpoint', compactionId, clm: true }`. */
export function applyEdits(session: Session, meter: MeterLike | undefined, edits: EditInput[], compaction?: OpenCompaction): string {
  const nodes = buildNodes(session, meter);
  const units = buildUnits(nodes);
  const { turn, step } = currentPosition(session);
  const lockedFrom = lockedZoneStart(nodes);
  if (lockedFrom <= 1) {
    throw new Error(`context_edit: nothing editable yet — the surface has ${units.length} units (${nodes.length} nodes), and only #0 (system) plus the fresh tail (last ${PROTECT_TAIL} nodes) exist. Continue working and edit once older units accumulate above the tail.`);
  }
  // Safety net: message-level pairing fold; whole-unit spans must be balanced.
  const liveCallIds = new Set<string>();
  for (const node of nodes) {
    for (const block of node.message?.content ?? []) {
      if (block.type === "tool-call" && typeof block.id === "string") liveCallIds.add(block.id);
    }
  }
  const balances = computeCutBalances(nodes, liveCallIds);
  // Tool arguments arrive deep-frozen — never mutate; resolve units into node spans.
  const work: WorkEdit[] = edits.map((edit) => ({ from: edit.from, to: edit.to, content: edit.content }));

  for (const edit of work) {
    if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to)) throw new Error("context_edit: from/to must be integers");
    if (edit.from < 1) throw new Error("context_edit: unit #0 (system prompt) is locked — from must be ≥ 1");
    if (edit.from > edit.to) throw new Error(`context_edit: from (#${edit.from}) must be ≤ to (#${edit.to})`);
    if (edit.to >= units.length) throw new Error(`context_edit: unit #${edit.to} does not exist (surface has ${units.length} units) — call map to renumber`);
    const firstUnit = units[edit.from]!;
    const lastUnit = units[edit.to]!;
    const spanFrom = firstUnit.members[0]!.index;
    const spanTo = lastUnit.members[lastUnit.members.length - 1]!.index;
    if (spanTo >= lockedFrom) throw new Error(`context_edit: unit #${edit.to} straddles the locked fresh tail — a unit straddling the lock boundary is wholly locked; to must stay below it`);
    if (typeof edit.content !== "string" || edit.content.trim().length === 0) throw new Error(`context_edit: content for units #${edit.from}–#${edit.to} must be non-empty text`);
    edit.spanFrom = spanFrom;
    edit.spanTo = spanTo;
  }
  const sorted = [...work].sort((a, b) => a.from - b.from);
  // Overlapping unit ranges are an error; ADJACENT ranges merge into one
  // contiguous span (one replacement node, per the edit contract).
  const merged: MergedSpan[] = [];
  for (const edit of sorted) {
    const top = merged[merged.length - 1];
    if (top !== undefined && edit.from <= top.toUnit) throw new Error(`context_edit: ranges #${edit.from}–#${edit.to} and #${top.fromUnit}–#${top.toUnit} overlap`);
    if (top !== undefined && edit.from === top.toUnit + 1) {
      top.toUnit = edit.to;
      top.spanTo = edit.spanTo!;
      top.content = `${top.content}\n${edit.content}`;
    } else {
      merged.push({ spanFrom: edit.spanFrom!, spanTo: edit.spanTo!, fromUnit: edit.from, toUnit: edit.to, content: edit.content });
    }
  }
  merged.sort((a, b) => b.spanFrom - a.spanFrom);

  const before = nodes.reduce((sum, node) => sum + node.tokens, 0);
  // Phase 1: validate and prepare EVERY span before mutating the surface —
  // a throw here leaves the session untouched (no half-applied transaction,
  // no lost receipt). Phase 2 below only appends; a mid-append throw remains
  // theoretically possible (surface-manager deep checks) but none of the
  // observed failure classes reach it.
  const prepared: PreparedSpan[] = [];
  for (const edit of merged) {
    // Contiguity assertion: the node span must cover exactly the units' members.
    const memberCount = nodes.slice(edit.spanFrom, edit.spanTo + 1).length;
    const expected = units.slice(edit.fromUnit, edit.toUnit + 1).reduce((sum, unit) => sum + unit.members.length, 0);
    if (memberCount !== expected) throw new Error(`context_edit: internal span mismatch for units #${edit.fromUnit}–#${edit.toUnit} (span ${memberCount} nodes ≠ ${expected} members) — call map to renumber`);
    // Pair-integrity assertion: whole-unit spans are balanced by construction.
    if (!balances[edit.spanFrom] || !balances[edit.spanTo + 1]) throw new Error(`context_edit: units #${edit.fromUnit}–#${edit.toUnit} would split a tool call/result pair (surface changed since map?) — call map to renumber`);
    const span = nodes.slice(edit.spanFrom, edit.spanTo + 1);
    const startSeq = span[0]!.seq;
    const endSeq = span[span.length - 1]!.seq;
    const shadowedSeqs = shadowedSeqsInRange(session, startSeq, endSeq);
    const spanTokens = span.reduce((sum, node) => sum + node.tokens, 0);
    const freed = spanTokens - Math.ceil(edit.content.length / 4);
    const marker = `[context-edit: replaced units #${edit.fromUnit}–#${edit.toUnit} (${summarizeSpanRoles(span)}, freed ~${formatTokens(Math.max(0, freed))}t)]`;
    prepared.push({ edit, startSeq, endSeq, shadowedSeqs, spanTokens, freed, marker });
  }
  // Phase 2: apply (highest span first — lower spans' positional ranges are
  // untouched by higher replaces, so the precomputed shadowed seqs stay exact).
  const receipts: string[] = [];
  for (const item of prepared) {
    if (compaction !== undefined) {
      // Checkpoint mode (spec §4.5.1 — close-time-markers variant): commit a
      // user/message checkpoint WITHOUT any compaction markers — the engine
      // consolidates all checkpoints into ONE stock chain at close time.
      // The kind is deliberately NOT 'compact-checkpoint': a replace with
      // the stock kind requires a matching OPEN compaction at that point in
      // the log on replay, and no markers exist while the transaction is
      // open (the checkpoint may even land in a later turn than the nudge).
      session.append("user/message", {
        id: `dsh-clm-${crypto.randomUUID()}` as MessageId,
        role: "user",
        content: [{ type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${item.edit.content}\n${SUMMARY_CLOSE_TAG}` }],
        source: { kind: "dsh-clm-checkpoint", compactionId: compaction.compactionId, clm: true } as unknown as MessageSource
      }, {
        surfaceOp: { op: "replace", startSeq: asSeq(item.startSeq), endSeq: asSeq(item.endSeq) },
        sourceEventSeqs: [asSeq(compaction.startSeq), ...item.shadowedSeqs] as SessionSeq[]
      });
      const target = compaction.budgetTokens === undefined ? "" : `, target ≤ ${formatTokens(compaction.budgetTokens)}t`;
      receipts.push(`#${item.edit.fromUnit}–#${item.edit.toUnit} → 1 checkpoint node (freed ~${formatTokens(Math.max(0, item.freed))}t; compaction ${compaction.compactionId}: span ~${formatTokens(item.spanTokens)}t → ~${formatTokens(Math.ceil(item.edit.content.length / 4))}t${target})`);
      continue;
    }
    session.append("developer/message", {
      turn,
      step,
      message: {
        id: `dsh-clm-${crypto.randomUUID()}` as MessageId,
        role: "developer",
        content: [{ type: "text", text: `${item.marker}\n${item.edit.content}` }],
        // Our plugin kind carries bookkeeping fields beyond the base source union.
        source: { kind: SOURCE_KIND, units: [item.edit.fromUnit, item.edit.toUnit], from: item.edit.spanFrom, to: item.edit.spanTo, turn, step } as unknown as MessageSource
      }
    }, {
      surfaceOp: { op: "replace", startSeq: asSeq(item.startSeq), endSeq: asSeq(item.endSeq) },
      sourceEventSeqs: item.shadowedSeqs as SessionSeq[]
    });
    receipts.push(`#${item.edit.fromUnit}–#${item.edit.toUnit} → 1 node (freed ~${formatTokens(Math.max(0, item.freed))}t)`);
  }
  // Sweep stale txn traces and fold superseded runtime-context snapshots
  // atomically with this edit (one cache bust per transaction — see findSnapshotFolds).
  // Fresh surface state: nodes the model just replaced are already gone, so no double replace.
  // Best-effort: a sweep/fold failure must not eat the receipt of the edits
  // that already applied — the next edit's sweep retries from fresh state.
  let sweep: SweepStats = { swept: 0, markers: 0, drops: 0, migrated: 0 };
  let folds: SweepStats = { swept: 0, markers: 0, drops: 0, migrated: 0 };
  let sweepError: unknown;
  let finalNodes: SurfaceNode[];
  try {
    const afterNodes = buildNodes(session, meter);
    sweep = applySpans(session, afterNodes, findTxnSpans(afterNodes, lockedZoneStart(afterNodes)));
    const foldNodes = sweep.swept > 0 ? buildNodes(session, meter) : afterNodes;
    folds = applySpans(session, foldNodes, findSnapshotFolds(foldNodes, lockedZoneStart(foldNodes)));
    finalNodes = folds.swept > 0 ? buildNodes(session, meter) : foldNodes;
  } catch (error) {
    sweepError = error;
    finalNodes = buildNodes(session, meter);
  }
  // v9: eager sweep. The pure context_edit pair immediately preceding this
  // call (the map that planned the edit) collapses NOW — it is complete
  // (call + results), so mid-turn replacement keeps pairing valid; the
  // deferred sweep skips the locked tail, which is exactly where this pair
  // sits. Fires only when nothing but runtime-context snapshots sits between
  // the pair and this call (the "map → reasoning → edit" shape). Best-effort:
  // any failure leaves the transcript as-is.
  let eager: SweepStats = { swept: 0, markers: 0, drops: 0, migrated: 0 };
  try {
    const eagerSpan = findEagerPairSpan(finalNodes, finalNodes.length - 1);
    if (eagerSpan !== undefined) eager = applySpans(session, finalNodes, [eagerSpan]);
  } catch {
    // eager sweep is best-effort — the edit itself already succeeded
  }
  const after = (eager.swept > 0 ? buildNodes(session, meter) : finalNodes).reduce((sum, node) => sum + node.tokens, 0);
  return [
    `applied ${merged.length} edit${merged.length === 1 ? "" : "s"}:`,
    ...receipts.map((line) => `- ${line}`),
    ...(sweep.swept > 0 ? [`swept: ${sweep.swept} txn nodes → ${sweep.markers} markers`] : []),
    ...(folds.swept > 0 ? [`folded: ${folds.swept - folds.migrated} superseded runtime-context snapshots → dropped (0 wire tokens)${folds.migrated > 0 ? `; migrated: ${folds.migrated} old fold markers → dropped` : ""}`] : []),
    ...(sweepError !== undefined ? [`warning: deferred sweep/fold failed: ${sweepError instanceof Error ? sweepError.message : String(sweepError)} — the next edit retries`] : []),
    ...(eager.swept > 0 ? [`eager-swept: the planning pair (map → this edit) → ${eager.markers} marker immediately`] : []),
    `context: ~${formatTokens(before)} → ~${formatTokens(after)} tokens`,
    "Each replaced span is now one node; unit numbers shift after edits (the next map renumbers positionally). Call map before planning further edits."
  ].join("\n");
}
