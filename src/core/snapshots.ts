import { OLD_FOLD_MARKER, SOURCE_KIND } from "./constants.js";
import type { SurfaceNode, TxnSpan } from "./types.js";

/** True when the node is a runtime-context snapshot message. Payload shapes
 *  differ by event type: developer/message nests the message under
 *  data.message, user/message carries it directly on data. */
export function isSnapshotNode(node: SurfaceNode): boolean {
  const event = node.event;
  if (event?.type !== "user/message") return false;
  const source = event.data?.message?.source ?? event.data?.source;
  return source?.kind === "runtime-context";
}

/** True when the node is a pre-drop fold marker (a visible dsh-clm sweep node
 *  carrying only OLD_FOLD_MARKER). */
export function isOldFoldMarkerNode(node: SurfaceNode): boolean {
  const event = node.event;
  if (event?.type !== "developer/message") return false;
  const message = event.data?.message;
  if (message?.source?.kind !== SOURCE_KIND || message.source.sweep !== true) return false;
  const block = message.content?.[0];
  return block?.type === "text" && block.text === OLD_FOLD_MARKER;
}

/** Superseded runtime-context snapshots foldable under the prompt-cache rule.
 *  Our budget counter changes the snapshot text every step, so the harness
 *  projection's dedup never fires and a durable snapshot commits per step
 *  (~145t each). Folding rewrites the surface, which re-invalidates the prompt
 *  cache from the fold position — hence two guards:
 *  - fold only at/after the FIRST dsh-clm replacement on the surface (the
 *    prefix before the first edit is cache-clean; touching it would re-process
 *    the whole session for ~145t/node);
 *  - fold only inside applyEdits, piggybacked on the model edit's own cache
 *    bust (per-step folding would keep the tail cache dirty forever).
 *  The NEWEST snapshot never folds: it is the projection's retained message,
 *  and replacing it makes the projection re-project a fresh one next step.
 *  Folds are DROP spans (applySpans replaces with an empty-content event that
 *  projects to no wire message — zero tokens, no marker). Idempotent: dropped
 *  events produce no map unit and never re-match; pre-drop text markers are
 *  re-targeted once (migration).
 *  Pure: used by map (marking) and edit (folding). */
export function findSnapshotFolds(nodes: SurfaceNode[], lockedFrom: number): TxnSpan[] {
  let firstEdit = -1;
  const snapshots: SurfaceNode[] = [];
  const oldMarkers: SurfaceNode[] = [];
  for (const node of nodes) {
    const event = node.event;
    if (event?.type === "developer/message" && event.data?.message?.source?.kind === SOURCE_KIND) {
      if (firstEdit === -1) firstEdit = node.index;
      if (isOldFoldMarkerNode(node)) oldMarkers.push(node);
    } else if (isSnapshotNode(node)) {
      snapshots.push(node);
    }
  }
  if (firstEdit === -1) return [];
  const spans: TxnSpan[] = [];
  for (const node of oldMarkers) {
    if (node.index < firstEdit || node.index >= lockedFrom) continue;
    spans.push({ from: node.index, to: node.index, drop: true, migrate: true });
  }
  if (snapshots.length > 1) {
    const newest = snapshots[snapshots.length - 1]!.index;
    for (const node of snapshots) {
      if (node.index === newest) continue;
      if (node.index < firstEdit || node.index >= lockedFrom) continue;
      spans.push({ from: node.index, to: node.index, drop: true });
    }
  }
  return spans;
}
