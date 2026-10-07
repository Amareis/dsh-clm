import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/core/args.js";
import { renderBudget } from "../src/core/budget.js";
import { formatTokens } from "../src/core/format.js";
import { renderMap } from "../src/core/map.js";
import { editableSurface, newTestSession } from "./helpers.js";

describe("formatTokens", () => {
  it("formats small, K and M magnitudes", () => {
    expect(formatTokens(537)).toBe("537");
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });
});

describe("parseArgs", () => {
  it("accepts map and edit", () => {
    expect(parseArgs({ op: "map" })).toEqual({ op: "map" });
    const parsed = parseArgs({ op: "edit", edits: [{ from: 1, to: 2, content: "x" }] });
    expect(parsed.op).toBe("edit");
    expect(parsed.edits).toHaveLength(1);
  });
  it("rejects bad shapes", () => {
    expect(() => parseArgs(null)).toThrow(/object/);
    expect(() => parseArgs({ op: "nope" })).toThrow(/map.*edit/);
    expect(() => parseArgs({ op: "edit" })).toThrow(/non-empty edits array/);
    expect(() => parseArgs({ op: "edit", edits: ["x"] })).toThrow(/\{from, to, content\}/);
  });
});

describe("renderBudget", () => {
  it("renders the plain line below 50%", () => {
    const session = editableSurface();
    const line = renderBudget(session, undefined);
    expect(line).toMatch(/^context budget: ~\S+ \/ 100\.0K tokens \(\d+%\) · self-edits applied: 0$/);
  });
  it("escalates at the 50/75/90 thresholds", () => {
    const session = editableSurface();
    session.append("request/context", { provider: "test", model: "test", contextWindow: 10 }); // tiny window → ratio ≫ 0.9
    expect(renderBudget(session, undefined)).toContain("Budget past 90%");
  });
  it("counts applied self-edits", () => {
    const session = editableSurface();
    session.addClmNode("[context-edit: replaced units #1–#2 …]");
    session.addClmNode("[context_edit txn: edit: 1 edits]", { sweep: true }); // sweep markers don't count
    expect(renderBudget(session, undefined)).toContain("self-edits applied: 1");
  });
});

describe("renderMap", () => {
  it("says when nothing is editable yet", () => {
    const session = newTestSession();
    session.addSystem("sys").addUser("u1");
    expect(renderMap(session, undefined)).toContain("nothing editable yet");
  });

  it("locks #0 and the fresh tail, hides superseded snapshots with a footer", () => {
    const session = editableSurface();
    session.addSnapshot(); // second snapshot → the first becomes superseded
    const map = renderMap(session, undefined);
    expect(map).toContain("#0 system");
    expect(map).toContain("🔒");
    expect(map).toContain("hidden from map: 1 superseded runtime-context snapshots");
    expect(map).toMatch(/surface: \d+ units \(\d+ nodes\), ~\S+ \/ 100\.0K tokens/);
  });

  it("marks stale context_edit pairs with ⏳ (map is a pure read)", () => {
    const session = editableSurface();
    // plant a stale pure context_edit pair below the locked zone
    const seqsBefore = session.surfaceNodes.length;
    session.addAssistantCalls([{ id: "m1", name: "context_edit" }]);
    session.addToolResult("m1", "surface: 9 units (9 nodes), ~500 tokens total");
    // move it out of the fresh tail by adding more messages
    session.addUser("x1").addAssistantText("y1").addUser("x2").addAssistantText("y2");
    expect(session.surfaceNodes.length).toBeGreaterThan(seqsBefore);
    const map = renderMap(session, undefined);
    expect(map).toContain("⏳ folds on next edit");
    // map must NOT have mutated the surface
    expect(session.appends.filter((a) => a.ref !== undefined)).toHaveLength(0);
  });
});
