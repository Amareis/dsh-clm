/**
 * Tests unique to the REAL dsh-session Session: the negative validator proof
 * (a raw incomplete replace must throw), the surface-dump renderer, and the
 * snapshot-fold scenario against the production derivation. Everything else
 * runs on real sessions via test/helpers.ts — this file only covers what the
 * shared builders cannot express.
 */
import { describe, expect, it } from "vitest";
import { renderSurfaceDump } from "../src/core/dump.js";
import { applyEdits } from "../src/core/edits.js";
import { SOURCE_KIND } from "../src/core/constants.js";
import { editableSurface, newTestSession, type TestSession } from "./helpers.js";

describe("real dsh-session Session", () => {
  it("rejects a replace citing incomplete source seqs (production validator)", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addUser("u1").addAssistantText("a1").addUser("u2");
    const nodes = [...session.surface.nodes];
    const startSeq = nodes[1]!;
    const endSeq = nodes[3]!;
    expect(() => rawIncompleteReplace(session, startSeq, endSeq)).toThrow();
  });

  it("folds superseded snapshots inside an edit once a first edit exists", () => {
    const session = editableSurface();
    // First edit establishes the first-edit point; snapshots before it are
    // cache-clean prefix and never fold.
    applyEdits(session, undefined, [{ from: 4, to: 4, content: "[c]" }]);
    session.addSnapshot("snapshot A");
    session.addSnapshot("snapshot B");
    session.addSnapshot("snapshot C");
    session.addUser("later user").addAssistantText("later answer");
    // Second edit: A is past the first edit and outside the fresh tail →
    // dropped. B sits inside the locked tail; C is the newest snapshot.
    applyEdits(session, undefined, [{ from: 4, to: 4, content: "[c2]" }]);
    const texts = visibleTexts(session);
    expect(texts.filter((text) => text.includes("snapshot A"))).toHaveLength(0);
    expect(texts.some((text) => text.includes("snapshot B"))).toBe(true);
    expect(texts.some((text) => text.includes("snapshot C"))).toBe(true);
    expect(texts.some((text) => text.includes("later user"))).toBe(true);
  });

  it("renders a surface dump from a real session", () => {
    const session = editableSurface();
    const dump = renderSurfaceDump(session, undefined, "test");
    expect(dump).toContain("# dsh-clm surface dump — test");
    expect(dump).toContain("[system]");
    expect(dump).toContain("system prompt");
    expect(dump).toContain("user message 5");
  });
});

/** Cite only the span ends, omitting the shadowed middle node — the real
 *  session must refuse the append. The wrapper's defaults are harmless here;
 *  the intent itself is broken. */
function rawIncompleteReplace(session: TestSession, startSeq: number, endSeq: number): void {
  session.append(
    "developer/message",
    {
      turn: 0,
      step: 0,
      message: {
        id: "raw-1",
        role: "developer",
        content: [{ type: "text", text: "bad" }],
        source: { kind: SOURCE_KIND }
      }
    },
    { surfaceOp: { op: "replace", startSeq, endSeq }, sourceEventSeqs: [startSeq, endSeq] }
  );
}

function visibleTexts(session: TestSession): string[] {
  const out: string[] = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const message = session.deriveEventMessage(event);
    if (message === null) continue;
    for (const block of message.content) {
      if (block.type === "text") out.push((block as { text: string }).text);
    }
  }
  return out;
}
