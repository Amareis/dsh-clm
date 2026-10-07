import { describe, expect, it } from "vitest";
import { shadowedSeqsInRange } from "../src/core/shadow.js";
import { newTestSession } from "./helpers.js";

describe("shadowedSeqsInRange", () => {
  it("returns the positional slice when seq values are NOT sorted (fresh seq spliced between older ones)", () => {
    // Build surface [0, 6, 9, 8]: seq 9 was spliced between 6 and 8 by an
    // earlier replace. A seq-VALUE filter in [6..8] would return {6, 8} and
    // miss 9 — the production "sourceEventSeqs missing 928" failure class.
    const session = newTestSession();
    session.addSystem("sys"); // 0
    session.addUser("a"); // 1
    session.addUser("b"); // 2
    session.addUser("c"); // 3
    session.addUser("d"); // 4
    // replace 1..2 → new event seq 5: surface [0, 5, 3, 4]
    session.append("developer/message", { message: { role: "developer", content: [{ type: "text", text: "m1" }] } },
      { surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] });
    // replace 5..3 → new event seq 6: surface [0, 6, 4]
    session.append("developer/message", { message: { role: "developer", content: [{ type: "text", text: "m2" }] } },
      { surfaceOp: { op: "replace", startSeq: 5, endSeq: 3 }, sourceEventSeqs: [5, 3] });
    session.addUser("e"); // 7
    session.addUser("f"); // 8
    // replace 6..7 → positions 1..3 → shadowed [6, 4, 7] → seq 9: surface [0, 9, 8]
    session.append("developer/message", { message: { role: "developer", content: [{ type: "text", text: "m3" }] } },
      { surfaceOp: { op: "replace", startSeq: 6, endSeq: 7 }, sourceEventSeqs: [6, 4, 7] });
    expect(session.surfaceNodes).toEqual([0, 9, 8]);
    // Span over positions 1..2: startSeq 9, endSeq 8 — value range [9..8] is
    // empty, yet positionally the shadowed seqs are exactly [9, 8].
    expect(shadowedSeqsInRange(session, 9, 8)).toEqual([9, 8]);
  });

  it("throws a precise error when a bound is not on the surface", () => {
    const session = newTestSession();
    session.addSystem("sys").addUser("a");
    expect(() => shadowedSeqsInRange(session, 0, 99)).toThrow(/not on the surface/);
  });

  it("throws when bounds are positionally inverted", () => {
    const session = newTestSession();
    session.addSystem("sys").addUser("a").addUser("b");
    expect(() => shadowedSeqsInRange(session, 2, 1)).toThrow(/inverted/);
  });
});
