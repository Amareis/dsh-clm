import type { EditInput } from "./types.js";

export interface ParsedArgs {
  op: "map" | "edit";
  edits?: EditInput[];
  /** Open compaction transaction this edit answers (spec §4.5). */
  compaction?: string;
}

/** Validate raw tool arguments (they arrive deep-frozen — never mutate). */
export function parseArgs(args: unknown): ParsedArgs {
  if (typeof args !== "object" || args === null) throw new Error("context_edit: arguments must be an object");
  const { op, edits, compaction } = args as { op?: unknown; edits?: unknown; compaction?: unknown };
  if (op !== "map" && op !== "edit") throw new Error('context_edit: op must be "map" or "edit"');
  if (compaction !== undefined && (typeof compaction !== "string" || compaction.trim().length === 0)) {
    throw new Error("context_edit: compaction must be a non-empty compaction id string");
  }
  const compactionId = compaction as string | undefined;
  if (op === "edit") {
    if (!Array.isArray(edits) || edits.length === 0) throw new Error("context_edit: op=edit requires a non-empty edits array of {from, to, content}");
    for (const edit of edits) {
      if (typeof edit !== "object" || edit === null) throw new Error("context_edit: each edit must be {from, to, content}");
    }
    return { op, edits: edits as EditInput[], ...(compactionId === undefined ? {} : { compaction: compactionId }) };
  }
  return { op };
}
