import { PREVIEW_CHARS } from "./constants.js";
import { isTextBlock, isToolCallBlock } from "./types.js";
import type { ContentBlock, MessageShape, Unit } from "./types.js";

/** Text preview of one message: first text block, single line, bounded. */
export function previewOf(message: MessageShape | undefined): string {
  const text = (message?.content ?? [])
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0 && message?.role === "assistant") {
    const calls = (message.content ?? []).filter(isToolCallBlock);
    if (calls.length > 0) return `[calls: ${calls.map((call) => call.name ?? "?").join(", ")}]`;
  }
  if (text.length === 0) return "[no text]";
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Compact one-line unit preview: the head message's own preview plus call→result
 *  links as `[calls: name → result-preview; name → †]` (`†` = result off-surface). */
export function unitPreview(unit: Unit): string {
  const head = previewOf(unit.members[0]?.message);
  if (unit.calls.length === 0) return head;
  const parts = unit.calls.map((call) => {
    const result = call.id === undefined ? undefined : unit.results.get(call.id);
    if (result === undefined) return `${call.name ?? "?"} → †`;
    const text = previewOf(result.message);
    return `${call.name ?? "?"} → ${text.slice(0, 40)}`;
  });
  const base = head.startsWith("[calls:") ? "" : `${head} `;
  return `${base}[calls: ${parts.join("; ")}]`;
}

/** Joined text of a node's message (all text blocks). */
export function textOf(message: MessageShape | undefined): string {
  return (message?.content ?? [])
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n");
}

/** Tool-call blocks of a message. */
export function toolCallsOf(message: MessageShape | undefined): ContentBlock[] {
  return (message?.content ?? []).filter(isToolCallBlock);
}
