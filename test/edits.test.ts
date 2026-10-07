import { describe, expect, it } from "vitest";
import { applyEdits } from "../src/core/edits.js";
import { buildNodes, buildUnits } from "../src/core/nodes.js";
import { editableSurface, FakeSession } from "./helpers.js";

/** Unit indices of the units whose members cover the given surface seqs. */
function unitRangeCovering(session: FakeSession, seqs: number[]): { from: number; to: number } {
  const nodes = buildNodes(session, undefined);
  const units = buildUnits(nodes);
  const bySeq = new Set(seqs);
  const covered = units.filter((unit) => unit.members.some((member) => bySeq.has(member.seq)));
  if (covered.length === 0) throw new Error("no unit covers seqs");
  return { from: covered[0]!.unit, to: covered[covered.length - 1]!.unit };
}

describe("applyEdits", () => {
  it("applies a single span and produces a receipt", () => {
    const session = editableSurface();
    const receipt = applyEdits(session, undefined, [{ from: 1, to: 2, content: "[compressed]" }]);
    expect(receipt).toContain("applied 1 edit:");
    expect(receipt).toContain("#1–#2 → 1 node");
    const replacement = session.appends.find((a) => a.type === "developer/message" && a.ref !== undefined);
    expect(replacement).toBeDefined();
    expect(JSON.stringify(replacement!.data)).toContain("[compressed]");
  });

  it("merges ADJACENT ranges into one contiguous replacement", () => {
    const session = editableSurface();
    const receipt = applyEdits(session, undefined, [
      { from: 1, to: 2, content: "part one" },
      { from: 3, to: 4, content: "part two" }
    ]);
    expect(receipt).toContain("applied 1 edit:");
    expect(receipt).toContain("#1–#4 → 1 node");
    const replacements = session.appends.filter((a) => a.type === "developer/message" && a.ref !== undefined);
    expect(replacements).toHaveLength(1);
    const message = (replacements[0]!.data as { message: { content: Array<{ text: string }> } }).message;
    expect(message.content[0]!.text).toContain("part one\npart two");
  });

  it("rejects overlapping ranges", () => {
    const session = editableSurface();
    expect(() => applyEdits(session, undefined, [
      { from: 1, to: 3, content: "a" },
      { from: 2, to: 4, content: "b" }
    ])).toThrow(/overlap/);
  });

  it("rejects edits into the locked fresh tail", () => {
    const session = editableSurface();
    const units = buildUnits(buildNodes(session, undefined));
    const lastUnit = units[units.length - 1]!.unit;
    expect(() => applyEdits(session, undefined, [{ from: 1, to: lastUnit, content: "x" }])).toThrow(/locked fresh tail/);
  });

  it("rejects unit #0 (system)", () => {
    const session = editableSurface();
    expect(() => applyEdits(session, undefined, [{ from: 0, to: 1, content: "x" }])).toThrow(/system prompt/);
  });

  it("rejects empty content", () => {
    const session = editableSurface();
    expect(() => applyEdits(session, undefined, [{ from: 1, to: 2, content: "   " }])).toThrow(/non-empty/);
  });

  it("is ALL-OR-NOTHING: a failing second span leaves the session untouched (two-phase regression)", () => {
    const session = editableSurface();
    const appendsBefore = session.appends.length;
    const surfaceBefore = [...session.surfaceNodes];
    expect(() => applyEdits(session, undefined, [
      { from: 1, to: 2, content: "valid" },
      { from: 3, to: 999, content: "invalid — unit does not exist" }
    ])).toThrow(/does not exist/);
    // Production bug (fixed): span 1 used to APPLY before span 2 threw —
    // half-applied transaction, lost receipt, miscounted edits.
    expect(session.appends.length).toBe(appendsBefore);
    expect(session.surfaceNodes).toEqual(surfaceBefore);
  });

  it("covers shadowed seqs whose VALUES lie outside [start..end] (missing-928 regression)", () => {
    // Surface [0, 9, 8, …]: a span over positions 1..2 shadows seqs 9 and 8;
    // a value filter in [9..8] would find nothing / miss nodes.
    const session = new FakeSession();
    session.addSystem("sys"); // 0
    session.addUser("a").addUser("b").addUser("c").addUser("d"); // 1..4
    session.append("developer/message", { message: { role: "developer", content: [{ type: "text", text: "m1" }] } },
      { surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] }); // 5 → [0,5,3,4]
    session.append("developer/message", { message: { role: "developer", content: [{ type: "text", text: "m2" }] } },
      { surfaceOp: { op: "replace", startSeq: 5, endSeq: 3 }, sourceEventSeqs: [5, 3] }); // 6 → [0,6,4]
    session.addUser("e").addUser("f"); // 7,8 → [0,6,4,7,8]
    session.append("developer/message", { message: { role: "developer", content: [{ type: "text", text: "m3" }] } },
      { surfaceOp: { op: "replace", startSeq: 6, endSeq: 7 }, sourceEventSeqs: [6, 4, 7] }); // 9 → [0,9,8]
    // filler + protected tail
    session.addUser("g").addAssistantText("h").addUser("i").addAssistantText("j");
    session.addUser("latest");
    session.addAssistantCalls([{ id: "live", name: "bash" }]);
    session.addToolResult("live", "ok");
    session.addSnapshot();
    expect(session.surfaceNodes.slice(0, 3)).toEqual([0, 9, 8]);
    const range = unitRangeCovering(session, [9, 8]);
    const receipt = applyEdits(session, undefined, [{ from: range.from, to: range.to, content: "[compressed]" }]);
    expect(receipt).toContain("applied 1 edit:");
    const replacement = session.appends.find((a) => a.ref !== undefined && a.ref.sourceEventSeqs.includes(9));
    expect(replacement!.ref!.sourceEventSeqs).toEqual([9, 8]);
  });

  it("applies a span whose first node carries a FRESH seq (marker before older node — #85–#86 regression)", () => {
    // Surface [0, 4, 3, …] where seq 4 is a fresh marker positionally BEFORE
    // the older seq 3. The old value filter returned [] here —
    // "sourceEventSeqs must not be empty" aborted the whole transaction.
    const session = new FakeSession();
    session.addSystem("sys"); // 0
    session.addUser("a").addUser("b").addUser("c"); // 1,2,3
    session.append("developer/message", { message: { role: "developer", content: [{ type: "text", text: "m1" }] } },
      { surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] }); // seq 4 → surface [0,4,3]
    session.addUser("d").addAssistantText("e");
    session.addUser("latest");
    session.addAssistantCalls([{ id: "live", name: "bash" }]);
    session.addToolResult("live", "ok");
    session.addSnapshot();
    expect(session.surfaceNodes.slice(0, 3)).toEqual([0, 4, 3]);
    const range = unitRangeCovering(session, [4, 3]);
    const receipt = applyEdits(session, undefined, [{ from: range.from, to: range.to, content: "[compressed]" }]);
    expect(receipt).toContain("applied 1 edit:");
    expect(receipt).not.toContain("warning:");
  });

  it("summarizes span roles as counts, with snapshots separated from users", () => {
    const session = new FakeSession();
    session.addSystem("sys"); // unit 0 (locked)
    session.addUser("q"); // unit 1
    session.addAssistantCalls([{ id: "c1", name: "bash" }]); // unit 2 (pair…)
    session.addToolResult("c1", "ok"); // …pair member
    session.addSnapshot(); // unit 3 — user/message role, but counts as snapshot
    session.addUser("filler"); // unit 4
    session.addAssistantText("filler"); // unit 5 — PROTECT_TAIL counts units 5..8
    session.addUser("latest");
    session.addAssistantCalls([{ id: "live", name: "bash" }]);
    session.addToolResult("live", "ok");
    session.addSnapshot();
    applyEdits(session, undefined, [{ from: 1, to: 3, content: "[compressed]" }]);
    const replacement = session.appends.find((a) => a.type === "developer/message" && a.ref !== undefined);
    const text = JSON.stringify(replacement!.data);
    expect(text).toContain("(1 user, 1 assistant, 1 tool, 1 snapshot,");
    expect(text).not.toContain("user+assistant");
  });
});
