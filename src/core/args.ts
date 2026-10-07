import type { EditInput } from "./types.js";

export interface ParsedArgs {
  op: "map" | "edit";
  edits?: EditInput[];
}

/** Validate raw tool arguments (they arrive deep-frozen — never mutate). */
export function parseArgs(args: unknown): ParsedArgs {
  if (typeof args !== "object" || args === null) throw new Error("context_edit: arguments must be an object");
  const { op, edits } = args as { op?: unknown; edits?: unknown };
  if (op !== "map" && op !== "edit") throw new Error('context_edit: op must be "map" or "edit"');
  if (op === "edit") {
    if (!Array.isArray(edits) || edits.length === 0) throw new Error("context_edit: op=edit requires a non-empty edits array of {from, to, content}");
    for (const edit of edits) {
      if (typeof edit !== "object" || edit === null) throw new Error("context_edit: each edit must be {from, to, content}");
    }
    return { op, edits: edits as EditInput[] };
  }
  return { op };
}
