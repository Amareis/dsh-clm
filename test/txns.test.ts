import { describe, expect, it } from "vitest";
import { buildNodes, lockedZoneStart } from "../src/core/nodes.js";
import { findEagerPairSpan, findTxnSpans, txnSummary } from "../src/core/txns.js";
import { newTestSession } from "./helpers.js";

const MAP_RECEIPT = "surface: 20 units (20 nodes), ~1.0K tokens total\nlocked: #0 (system)";
const EDIT_RECEIPT = "applied 2 edits:\n- #5–#8 → 1 node (freed ~900t)\ncontext: ~1.0K → ~500 tokens";

describe("txnSummary", () => {
  it("summarizes an edit receipt with the before/after context sizes", () => {
    expect(txnSummary(EDIT_RECEIPT)).toBe("edit: 2 edits, ~1.0K → ~500");
  });
  it("summarizes a map receipt", () => {
    expect(txnSummary(MAP_RECEIPT)).toBe("map: 20 nodes ~1.0K");
  });
  it("falls back to a bounded first line", () => {
    expect(txnSummary("something weird happened")).toBe("other: something weird happened");
  });
});

describe("findTxnSpans", () => {
  it("finds a complete pure context_edit pair below the locked zone", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addAssistantCalls([{ id: "m1", name: "context_edit" }]);
    session.addToolResult("m1", MAP_RECEIPT);
    session.addUser("u1").addAssistantText("a1").addUser("u2").addAssistantText("a2").addUser("u3");
    const nodes = buildNodes(session, undefined);
    const spans = findTxnSpans(nodes, lockedZoneStart(nodes));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.from).toBe(1);
    expect(spans[0]!.to).toBe(2);
    expect(spans[0]!.content).toBe("[context_edit txn: map: 20 nodes ~1.0K]");
    expect(spans[0]!.stubCallId).toBeUndefined();
  });

  it("is idempotent: an already-stubbed pair never re-matches", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addAssistantCalls([{ id: "m1", name: "context_edit" }]);
    session.addToolResult("m1", MAP_RECEIPT);
    // simulate the sweep's replacement
    session.append("developer/message", {
      message: {
        role: "developer",
        content: [{ type: "text", text: "[context_edit txn: map: 20 nodes ~1.0K]" }],
        source: { kind: "dsh-clm", sweep: true }
      }
    }, { surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] });
    session.addUser("u1").addAssistantText("a1").addUser("u2").addAssistantText("a2").addUser("u3");
    const nodes = buildNodes(session, undefined);
    expect(findTxnSpans(nodes, lockedZoneStart(nodes))).toHaveLength(0);
  });

  it("stubs only the context_edit result of a MIXED multi-call node", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addAssistantCalls([{ id: "b1", name: "bash" }, { id: "m1", name: "context_edit" }]);
    session.addToolResult("b1", "bash output");
    session.addToolResult("m1", MAP_RECEIPT);
    session.addUser("u1").addAssistantText("a1").addUser("u2").addAssistantText("a2").addUser("u3");
    const nodes = buildNodes(session, undefined);
    const spans = findTxnSpans(nodes, lockedZoneStart(nodes));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.stubCallId).toBe("m1");
    expect(spans[0]!.from).toBe(spans[0]!.to); // single-node span
    expect(spans[0]!.content).toContain("[context_edit txn:");
  });

  it("never touches the locked fresh tail (the in-flight pair survives)", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addUser("u1").addAssistantText("a1");
    session.addAssistantCalls([{ id: "m1", name: "context_edit" }]);
    session.addToolResult("m1", MAP_RECEIPT);
    const nodes = buildNodes(session, undefined);
    expect(findTxnSpans(nodes, lockedZoneStart(nodes))).toHaveLength(0);
  });
});

describe("findEagerPairSpan", () => {
  function eagerSetup(opts: { snapshotBetween?: boolean; foreignCall?: boolean; stubbed?: boolean } = {}): ReturnType<typeof buildNodes> {
    const session = newTestSession();
    session.addSystem("sys"); // 0
    session.addUser("u1"); // 1
    session.addAssistantCalls(opts.foreignCall === true
      ? [{ id: "m1", name: "context_edit" }, { id: "b1", name: "bash" }]
      : [{ id: "m1", name: "context_edit" }]); // 2
    session.addToolResult("m1", opts.stubbed === true ? "[context_edit txn: map: 20 nodes ~1.0K]" : MAP_RECEIPT); // 3
    if (opts.foreignCall === true) session.addToolResult("b1", "out"); // 4
    if (opts.snapshotBetween === true) session.addSnapshot();
    session.addAssistantCalls([{ id: "e1", name: "context_edit" }]); // in-flight edit call (last)
    return buildNodes(session, undefined);
  }

  it("finds the planning pair directly before the in-flight call (map → edit shape)", () => {
    const nodes = eagerSetup();
    const span = findEagerPairSpan(nodes, nodes.length - 1);
    expect(span).toBeDefined();
    expect(span!.from).toBe(2);
    expect(span!.to).toBe(3);
    expect(span!.content).toContain("[context_edit txn:");
  });

  it("skips runtime-context snapshots between the pair and the in-flight call", () => {
    const nodes = eagerSetup({ snapshotBetween: true });
    expect(findEagerPairSpan(nodes, nodes.length - 1)).toBeDefined();
  });

  it("refuses a mixed node (foreign call must keep the node)", () => {
    const nodes = eagerSetup({ foreignCall: true });
    expect(findEagerPairSpan(nodes, nodes.length - 1)).toBeUndefined();
  });

  it("refuses an already-stubbed pair", () => {
    const nodes = eagerSetup({ stubbed: true });
    expect(findEagerPairSpan(nodes, nodes.length - 1)).toBeUndefined();
  });
});
