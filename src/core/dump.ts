/**
 * Pure surface-dump renderer shared by the live plugin (debug dumps under
 * $DSH_CLM_DUMP_DIR) and the test-suite: any scenario — live or synthetic —
 * renders to the exact same markdown format, so a failing test can be
 * eyeballed against a live session dump directly.
 */
import { buildNodes } from "./nodes.js";
import { formatTokens } from "./format.js";
import type { MeterLike, Session } from "./types.js";

/** Render the full model-visible surface (roles + full node texts) as markdown. */
export function renderSurfaceDump(session: Session, meter: MeterLike | undefined, tag: string): string {
  const nodes = buildNodes(session, meter);
  const total = nodes.reduce((sum, node) => sum + node.tokens, 0);
  const parts = [
    `# dsh-clm surface dump — ${tag} — ${new Date().toISOString()}`,
    `# nodes: ${nodes.length}, ~${formatTokens(total)} tokens`,
    ""
  ];
  for (const node of nodes) {
    const role = node.message?.role ?? node.event?.type ?? "?";
    parts.push(`\n## #${node.index} [${role}] ~${formatTokens(node.tokens)}t (seq ${node.seq})`);
    for (const block of node.message?.content ?? []) {
      // Indent body so markdown headers inside content don't collide with node headers.
      if (block.type === "text") parts.push(`  ${(block.text ?? "").replace(/\n/g, "\n  ")}`);
      else parts.push(`  [${block.type}] ${JSON.stringify(block)}`);
    }
  }
  return parts.join("\n");
}
