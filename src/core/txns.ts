import { TOOL_NAME, TXN_MARKER_PREFIX } from "./constants.js";
import { textOf, toolCallsOf } from "./preview.js";
import { isSnapshotNode } from "./snapshots.js";
import type { SurfaceNode, TxnSpan } from "./types.js";

/** One-line summary of a swept context_edit transaction, extracted from its receipt text. */
export function txnSummary(receipt: string): string {
  const applied = /applied (\d+) edits?/.exec(receipt);
  if (applied !== null) {
    const ctx = /context: (~\S+) → (~\S+) tokens/.exec(receipt);
    return ctx === null ? `edit: ${applied[1]} edits` : `edit: ${applied[1]} edits, ${ctx[1]} → ${ctx[2]}`;
  }
  // Current map summary: "surface: U units (N nodes), ~X tokens …"; an older
  // format ("surface: N nodes, ~X") is kept as a fallback for legacy receipts.
  const surface = /surface: \d+ units \((\d+) nodes\), ~(\S+)/.exec(receipt);
  if (surface !== null) return `map: ${surface[1]} nodes ~${surface[2]}`;
  const legacy = /surface: (\d+) nodes, ~(\S+)/.exec(receipt);
  if (legacy !== null) return `map: ${legacy[1]} nodes ~${legacy[2]}`;
  return `other: ${receipt.split("\n", 1)[0].replace(/\s+/g, " ").trim().slice(0, 60)}`;
}

/** Find stale context_edit transaction traces fully below the locked zone. Pure: no
 *  mutation — used by map (marking) and edit (sweeping). Two shapes:
 *  - pure pair: assistant node whose calls are ALL context_edit + its results → one
 *    span over the whole pair, collapses into a developer marker;
 *  - mixed node: context_edit call sharing an assistant node with foreign calls → the
 *    node must stay (it hosts the foreign call), so each context_edit RESULT becomes a
 *    single-node span with stubCallId, collapsed into a tool-role stub that keeps the
 *    call→result link (and API transcript) valid.
 *  Replacement summaries (developer nodes) are value, not garbage; already-stubbed
 *  results (source.kind dsh-clm / "[context_edit txn:" text) never re-match, so this is
 *  idempotent. Whole pairs only, so the in-flight call survives (one-transaction lag). */
export function findTxnSpans(nodes: SurfaceNode[], lockedFrom: number): TxnSpan[] {
  const spans: TxnSpan[] = [];
  for (const node of nodes) {
    if (node.index < 1 || node.index >= lockedFrom) continue;
    const calls = toolCallsOf(node.message);
    if (calls.length === 0) continue;
    const txnCalls = calls.filter((call) => call.name === TOOL_NAME);
    if (txnCalls.length === 0) continue;
    if (txnCalls.length < calls.length) {
      // Mixed multi-call node: stub only the context_edit results, node stays.
      const window = nodes.slice(node.index + 1, node.index + 1 + calls.length);
      for (const call of txnCalls) {
        const result = window.find((candidate) => candidate.message?.role === "tool" && candidate.message?.toolCallId === call.id);
        if (result === undefined || result.index >= lockedFrom) continue;
        if (result.message?.source?.kind === "dsh-clm") continue;
        const text = textOf(result.message);
        if (text.startsWith(TXN_MARKER_PREFIX)) continue;
        spans.push({ from: result.index, to: result.index, content: `${TXN_MARKER_PREFIX} ${txnSummary(text)}]`, stubCallId: call.id });
      }
      continue;
    }
    const end = node.index + calls.length;
    if (end >= lockedFrom) continue;
    const results = nodes.slice(node.index + 1, end + 1);
    if (results.length !== calls.length || results.some((result) => result.message?.role !== "tool")) continue;
    spans.push({
      from: node.index,
      to: end,
      content: `${TXN_MARKER_PREFIX} ${results.map((result) => txnSummary(textOf(result.message))).join("; ")}]`
    });
  }
  return spans;
}

/** The immediately-preceding pure context_edit pair (typically the map that
 *  planned this edit), sweepable RIGHT NOW instead of one edit later — but
 *  only when nothing but runtime-context snapshots sits between it and the
 *  in-flight call (the "map → reasoning → edit" shape). The pair is complete
 *  (call + results), so replacing it mid-turn keeps pairing valid. */
export function findEagerPairSpan(nodes: SurfaceNode[], inflightIndex: number): TxnSpan | undefined {
  let i = inflightIndex - 1;
  while (i >= 0 && isSnapshotNode(nodes[i]!)) i--;
  if (i < 0 || nodes[i]!.message?.role !== "tool") return undefined;
  let j = i;
  while (j >= 0 && nodes[j]!.message?.role === "tool") j--;
  const head = nodes[j];
  if (head === undefined || head.message?.role !== "assistant") return undefined;
  const calls = toolCallsOf(head.message);
  if (calls.length === 0 || calls.some((call) => call.name !== TOOL_NAME)) return undefined;
  if (i - j !== calls.length) return undefined; // result count must match call count
  const results = nodes.slice(j + 1, i + 1);
  if (results.some((result) => textOf(result.message).startsWith(TXN_MARKER_PREFIX))) return undefined;
  return {
    from: j,
    to: i,
    content: `${TXN_MARKER_PREFIX} ${results.map((result) => txnSummary(textOf(result.message))).join("; ")}]`
  };
}
