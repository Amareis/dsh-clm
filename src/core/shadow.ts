import type { SessionLike } from "./types.js";

/** Every surface seq shadowed by a replace spanning startSeq..endSeq
 *  POSITIONALLY. session.surface.nodes is a positional seq array — NOT sorted
 *  by seq: a replace splices a fresh (larger) seq between older ones, so a
 *  seq-value filter misses shadowed positions outside [start..end] ("missing
 *  N" errors) and returns [] when a fresh marker positionally precedes an
 *  older node ("sourceEventSeqs must not be empty"). Mirror the surface
 *  manager's own replacementRange: indexOf + positional slice. */
export function shadowedSeqsInRange(session: SessionLike, startSeq: number, endSeq: number): number[] {
  const surfaceSeqs = session.surface.nodes;
  const startIdx = surfaceSeqs.indexOf(startSeq);
  const endIdx = surfaceSeqs.indexOf(endSeq);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`context_edit: span bounds ${startSeq}..${endSeq} are not on the surface (startIdx ${startIdx}, endIdx ${endIdx}) — surface changed since map? Call map to renumber`);
  }
  if (startIdx > endIdx) {
    throw new Error(`context_edit: span bounds ${startSeq}..${endSeq} are inverted on the surface (index ${startIdx} > ${endIdx}) — surface changed since map? Call map to renumber`);
  }
  return surfaceSeqs.slice(startIdx, endIdx + 1);
}
