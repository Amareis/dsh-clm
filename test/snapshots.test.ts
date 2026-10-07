import { describe, expect, it } from "vitest";
import { OLD_FOLD_MARKER } from "../src/core/constants.js";
import { buildNodes, lockedZoneStart } from "../src/core/nodes.js";
import { findSnapshotFolds } from "../src/core/snapshots.js";
import { applySpans } from "../src/core/spans.js";
import { newTestSession } from "./helpers.js";

describe("findSnapshotFolds", () => {
  it("folds NOTHING before the first dsh-clm edit (prompt-cache-clean prefix)", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addSnapshot().addSnapshot();
    session.addUser("u1").addAssistantText("a1").addUser("u2");
    const nodes = buildNodes(session, undefined);
    expect(findSnapshotFolds(nodes, lockedZoneStart(nodes))).toHaveLength(0);
  });

  it("folds every superseded snapshot at/after the first edit, keeping the NEWEST", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addClmNode("[context-edit: replaced units #1–#2 …]"); // first edit
    session.addSnapshot(); // superseded, after firstEdit → folds
    session.addSnapshot(); // superseded, after firstEdit → folds
    session.addUser("u1").addAssistantText("a1");
    session.addSnapshot(); // newest — never folds
    session.addUser("u2");
    const nodes = buildNodes(session, undefined);
    const spans = findSnapshotFolds(nodes, lockedZoneStart(nodes));
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.drop === true)).toBe(true);
    // the two older snapshots, in node order
    const snapshotIndices = nodes.filter((n) => n.event?.type === "user/message").map((n) => n.index);
    expect(spans.map((s) => s.from)).toEqual(snapshotIndices.slice(0, 2));
  });

  it("never folds snapshots BEFORE the first edit (cache-clean prefix)", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addSnapshot(); // before the first edit — cache-clean prefix, off-limits
    session.addClmNode("[context-edit: replaced units #1–#2 …]");
    session.addSnapshot(); // after → folds
    session.addUser("u1").addAssistantText("a1");
    session.addSnapshot(); // newest — kept
    session.addUser("u2");
    const nodes = buildNodes(session, undefined);
    const spans = findSnapshotFolds(nodes, lockedZoneStart(nodes));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.from).toBe(3);
  });

  it("migrates a pre-drop fold marker to a drop", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addClmNode("[context-edit: replaced units #1–#2 …]"); // first edit
    session.addClmNode(OLD_FOLD_MARKER, { sweep: true }); // legacy marker
    session.addUser("u1").addAssistantText("a1").addUser("u2").addAssistantText("a2");
    const nodes = buildNodes(session, undefined);
    const spans = findSnapshotFolds(nodes, lockedZoneStart(nodes));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ drop: true, migrate: true });
  });
});

describe("applySpans", () => {
  it("drops produce empty-content events that project to NO wire message", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addSnapshot();
    session.addUser("u1").addAssistantText("a1").addUser("u2").addAssistantText("a2");
    const nodes = buildNodes(session, undefined);
    const snapshotIndex = nodes.findIndex((n) => n.event?.type === "user/message");
    const stats = applySpans(session, nodes, [{ from: snapshotIndex, to: snapshotIndex, drop: true }]);
    expect(stats).toMatchObject({ swept: 1, drops: 1, markers: 0 });
    const dropAppend = session.appends[session.appends.length - 1]!;
    expect(dropAppend.type).toBe("developer/message");
    const message = (dropAppend.data as { message: { content: unknown[]; source: Record<string, unknown> } }).message;
    expect(message.content).toEqual([]);
    expect(message.source).toMatchObject({ kind: "dsh-clm", sweep: true, drop: true });
    // the dropped node is invisible now (other user messages stay)
    const after = buildNodes(session, undefined);
    expect(after.some((n) => JSON.stringify(n.event?.data).includes("runtime-context"))).toBe(false);
    expect(after).toHaveLength(nodes.length - 1);
  });

  it("stubs keep the tool-role envelope and the call→result link", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addAssistantCalls([{ id: "b1", name: "bash" }, { id: "m1", name: "context_edit" }]);
    session.addToolResult("b1", "bash output");
    session.addToolResult("m1", "surface: 20 units (20 nodes), ~1.0K tokens total");
    session.addUser("u1").addAssistantText("a1").addUser("u2").addAssistantText("a2");
    const nodes = buildNodes(session, undefined);
    const resultIndex = nodes.findIndex((n) => n.message?.toolCallId === "m1");
    const stats = applySpans(session, nodes, [{ from: resultIndex, to: resultIndex, content: "[context_edit txn: map: 20 nodes ~1.0K]", stubCallId: "m1" }]);
    expect(stats).toMatchObject({ swept: 1, drops: 0 });
    const stub = session.appends[session.appends.length - 1]!;
    expect(stub.type).toBe("tool/result");
    const message = (stub.data as { message: { role: string; toolCallId: string } }).message;
    expect(message.role).toBe("tool");
    expect(message.toolCallId).toBe("m1");
  });
});
