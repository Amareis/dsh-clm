/** Shared constants for dsh-clm. */

export const PLUGIN_NAME = "dsh-clm";
export const TOOL_NAME = "context_edit";
/** Source kind stamped on every durable node this plugin writes. */
export const SOURCE_KIND = "dsh-clm";
/** Fresh-tail protection: the newest N surface nodes are never editable. */
export const PROTECT_TAIL = 4;
/** Map output cap: beyond it, keep the head and tail units and elide the middle. */
export const MAP_LIMIT = 300;
export const MAP_HEAD = 30;
/** Single-line preview length in the map. */
export const PREVIEW_CHARS = 72;
/** Marker text left by folds before drop folding existed; such markers are
 *  migrated to drops on the next edit. */
export const OLD_FOLD_MARKER = "[context-edit: runtime-context snapshot superseded]";
/** Prefix of a collapsed context_edit transaction marker. */
export const TXN_MARKER_PREFIX = "[context_edit txn:";
