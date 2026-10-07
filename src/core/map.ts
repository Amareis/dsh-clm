import { MAP_HEAD, MAP_LIMIT } from "./constants.js";
import { formatTokens } from "./format.js";
import { buildNodes, buildUnits, lockedZoneStart } from "./nodes.js";
import { unitPreview } from "./preview.js";
import { isSnapshotNode, findSnapshotFolds } from "./snapshots.js";
import { findTxnSpans } from "./txns.js";
import type { MeterLike, SessionLike, Unit } from "./types.js";

/** Render the numbered surface map, one line per pair-atomic unit. */
export function renderMap(session: SessionLike, meter: MeterLike | undefined): string {
  const nodes = buildNodes(session, meter);
  const units = buildUnits(nodes);
  const lockedFrom = lockedZoneStart(nodes);
  if (lockedFrom <= 1) {
    return `surface: ${units.length} units (${nodes.length} nodes), nothing editable yet — only unit #0 (system) and the fresh tail exist.\nContinue working; edit once older units have accumulated above the tail.`;
  }
  // Pure read: mark stale txn traces instead of collapsing them (the next edit sweeps,
  // so a transaction costs one log rewrite, not two).
  const pending = new Set<number>();
  for (const span of findTxnSpans(nodes, lockedFrom)) {
    for (let index = span.from; index <= span.to; index++) pending.add(index);
  }
  for (const span of findSnapshotFolds(nodes, lockedFrom)) pending.add(span.from);
  const lines: string[] = [];
  const total = nodes.reduce((sum, node) => sum + node.tokens, 0);
  // Hide superseded runtime-context snapshots from the map: noise the model
  // must not edit by hand (foldable ones auto-fold; the cache-clean prefix is
  // off-limits by policy). The NEWEST snapshot stays visible — it carries the
  // live budget counter. Unit numbers are preserved (gaps = hidden units), so
  // edit addressing stays consistent with this map.
  let newestSnapshot = -1;
  for (const node of nodes) if (isSnapshotNode(node)) newestSnapshot = node.index;
  let hiddenCount = 0;
  let hiddenTokens = 0;
  const visible: Unit[] = [];
  for (const unit of units) {
    const sole = unit.members.length === 1 ? unit.members[0] : undefined;
    if (sole !== undefined && isSnapshotNode(sole) && sole.index !== newestSnapshot) {
      hiddenCount += 1;
      hiddenTokens += sole.tokens;
      continue;
    }
    visible.push(unit);
  }
  const elide = visible.length > MAP_LIMIT;
  for (let position = 0; position < visible.length; position++) {
    const unit = visible[position]!;
    if (elide && position >= MAP_HEAD && position < visible.length - (MAP_LIMIT - MAP_HEAD)) {
      if (position === MAP_HEAD) lines.push(`… ${visible.length - MAP_LIMIT} middle units elided (call edit with explicit numbers, or narrow down via previews) …`);
      continue;
    }
    const first = unit.members[0]!;
    const last = unit.members[unit.members.length - 1]!;
    const span = unit.members.length > 1 ? `(#${first.index}..#${last.index}) ` : "";
    const role = first.message?.role ?? first.event?.type ?? "?";
    const tokens = unit.members.reduce((sum, node) => sum + node.tokens, 0);
    // A unit straddling a lock boundary is wholly locked.
    const locked = first.index === 0 || last.index >= lockedFrom ? " 🔒" : "";
    const stale = unit.members.some((node) => pending.has(node.index)) ? " ⏳ folds on next edit" : "";
    lines.push(`#${unit.unit} ${span}${role}${unit.members.length > 1 ? "+" : ""} ~${formatTokens(tokens)}t${locked} ${unitPreview(unit)}${stale}`);
  }
  const window = session.requestContext?.()?.contextWindow;
  const summary = window === undefined
    ? `surface: ${units.length} units (${nodes.length} nodes), ~${formatTokens(total)} tokens total`
    : `surface: ${units.length} units (${nodes.length} nodes), ~${formatTokens(total)} / ${formatTokens(window)} tokens (${Math.round((total / window) * 100)}%)`;
  const dangling = units.some((unit) => unit.calls.some((call) => call.id === undefined || !unit.results.has(call.id)));
  const tailUnit = visible.find((unit) => unit.members[unit.members.length - 1]!.index >= lockedFrom);
  const tailLock = tailUnit === undefined ? "" : ` and #${tailUnit.unit}..#${visible[visible.length - 1]!.unit} (fresh tail; a unit straddling the boundary is wholly locked)`;
  const hidden = hiddenCount > 0 ? `\nhidden from map: ${hiddenCount} superseded runtime-context snapshots (~${formatTokens(hiddenTokens)}t) — they drop automatically inside the next edit once past the first edit point; unit numbers above keep gaps where they sit` : "";
  return `${lines.join("\n")}\n\n${summary}\nlocked: #0 (system)${tailLock}${dangling ? "\n† = call result compacted off the surface" : ""}${pending.size > 0 ? `\n⏳ = stale context_edit transaction trace or superseded runtime-context snapshot; the trace collapses into a marker and the snapshot is dropped (replaced with an empty node you never see) automatically inside the next edit — no need to edit them yourself` : ""}${hidden}`;
}
