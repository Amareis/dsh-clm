import { describe, expect, it } from "vitest";
import { applyEdits } from "../src/core/edits.js";
import { renderMap } from "../src/core/map.js";
import { buildNodes } from "../src/core/nodes.js";
import { FakeSession } from "./helpers.js";

const MAP_RECEIPT = "surface: 12 units (14 nodes), ~1.0K tokens total\nlocked: #0 (system)";

/** A realistic surface: history, a STALE map pair below the lock, a superseded
 *  snapshot, the planning map pair, and the in-flight edit call. */
function flowSurface(): FakeSession {
  const session = new FakeSession();
  session.addSystem("system prompt"); // 0
  session.addUser("user one"); // 1
  session.addAssistantText("answer one"); // 2
  // stale context_edit pair (well below the locked zone)
  session.addAssistantCalls([{ id: "m1", name: "context_edit" }]); // 3
  session.addToolResult("m1", MAP_RECEIPT); // 4
  session.addUser("user two"); // 5
  session.addAssistantText("answer two"); // 6
  session.addSnapshot(); // 7 — superseded by 12
  session.addUser("user three"); // 8
  session.addAssistantText("answer three"); // 9
  // the planning pair: map → (reasoning is part of the call node) → edit
  session.addAssistantCalls([{ id: "m2", name: "context_edit" }]); // 10
  session.addToolResult("m2", MAP_RECEIPT); // 11
  session.addSnapshot(); // 12 — newest snapshot
  session.addAssistantCalls([{ id: "e1", name: "context_edit" }]); // 13 — in-flight
  return session;
}

describe("full map → edit flow", () => {
  it("applies the edit, sweeps the stale pair, folds the old snapshot, and eager-sweeps the planning pair — in ONE transaction", () => {
    const session = flowSurface();
    // units: #4 = user two (node 5), #5 = answer two (node 6)
    const receipt = applyEdits(session, undefined, [{ from: 4, to: 5, content: "[user two + answer two compressed]" }]);
    expect(receipt).toContain("applied 1 edit:");
    expect(receipt).toContain("#4–#5 → 1 node");
    expect(receipt).toContain("swept: 2 txn nodes → 1 markers");
    expect(receipt).toContain("folded: 1 superseded runtime-context snapshots → dropped (0 wire tokens)");
    expect(receipt).toContain("eager-swept: the planning pair (map → this edit) → 1 marker immediately");
    expect(receipt).not.toContain("warning:");
    // the stale pair and the planning pair are now one-line markers
    const texts = buildNodes(session, undefined).map((n) => JSON.stringify(n.message?.content));
    expect(texts.filter((t) => t.includes("[context_edit txn: map: 14 nodes ~1.0K]"))).toHaveLength(2);
    // the superseded snapshot is GONE (dropped, invisible), the newest stays
    const snapshots = buildNodes(session, undefined).filter((n) => n.event?.type === "user/message" && JSON.stringify(n.event?.data).includes("runtime-context"));
    expect(snapshots).toHaveLength(1);
  });

  it("sweeps the previous edit pair on the NEXT edit (one-transaction lag)", () => {
    const session = flowSurface();
    const receipt1 = applyEdits(session, undefined, [{ from: 4, to: 5, content: "[compressed]" }]);
    // the harness commits the in-flight call's result AFTER execute() returns
    session.addToolResult("e1", receipt1);
    // push the edit pair out of the fresh tail
    session.addUser("later one").addAssistantText("reply one");
    session.addUser("later two").addAssistantText("reply two");
    session.addUser("later three").addAssistantText("reply three");
    session.addAssistantCalls([{ id: "e2", name: "context_edit" }]); // in-flight again
    const receipt2 = applyEdits(session, undefined, [{ from: 1, to: 2, content: "[user one compressed]" }]);
    expect(receipt2).toContain("swept:");
    const texts = buildNodes(session, undefined).map((n) => JSON.stringify(n.message?.content));
    expect(texts.some((t) => t.includes("[context_edit txn: edit: 1 edits"))).toBe(true);
  });

  it("renumbers units positionally after an edit (map reflects collapsed spans)", () => {
    const session = flowSurface();
    const before = renderMap(session, undefined);
    expect(before).toContain("surface: 12 units");
    applyEdits(session, undefined, [{ from: 4, to: 5, content: "[compressed]" }]);
    const after = renderMap(session, undefined);
    // the 5–6 span collapsed 2→1, the stale pair 2→1, the planning pair 2→1,
    // one snapshot dropped: 14 nodes → 10 visible → 10 units (no pairs left)
    expect(after).toContain("surface: 10 units");
  });
});
