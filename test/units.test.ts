import { describe, expect, it } from "vitest";
import { buildNodes, buildUnits, computeCutBalances, lockedZoneStart } from "../src/core/nodes.js";
import { PROTECT_TAIL } from "../src/core/constants.js";
import { editableSurface, newTestSession } from "./helpers.js";

describe("buildUnits (pair-atomic units)", () => {
  it("groups an assistant call node with ALL its tool results into one unit", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addAssistantCalls([{ id: "c1", name: "bash" }, { id: "c2", name: "read" }]);
    session.addToolResult("c1", "out1");
    session.addToolResult("c2", "out2");
    const units = buildUnits(buildNodes(session, undefined));
    expect(units).toHaveLength(2);
    expect(units[1]!.members).toHaveLength(3);
    expect(units[1]!.calls).toHaveLength(2);
    expect(units[1]!.results.size).toBe(2);
  });

  it("keeps an orphan result (call already off the surface) as a single-node unit", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addToolResult("ghost", "orphan");
    const units = buildUnits(buildNodes(session, undefined));
    expect(units).toHaveLength(2);
    expect(units[1]!.members).toHaveLength(1);
    expect(units[1]!.calls).toHaveLength(0);
  });

  it("marks a call whose result is not yet on the surface as dangling (†)", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addAssistantCalls([{ id: "live", name: "bash" }]);
    const units = buildUnits(buildNodes(session, undefined));
    expect(units[1]!.results.size).toBe(0);
  });
});

describe("computeCutBalances", () => {
  it("is balanced at pair boundaries and open inside a pair", () => {
    const session = newTestSession();
    session.addSystem("sys"); // 0
    session.addAssistantCalls([{ id: "c1", name: "bash" }]); // 1
    session.addToolResult("c1", "ok"); // 2
    session.addUser("u"); // 3
    const nodes = buildNodes(session, undefined);
    const live = new Set(["c1"]);
    const balances = computeCutBalances(nodes, live);
    expect(balances[0]).toBe(true); // before system
    expect(balances[1]).toBe(true); // after system
    expect(balances[2]).toBe(false); // inside the pair
    expect(balances[3]).toBe(true); // after the pair
    expect(balances[4]).toBe(true); // after user
  });

  it("treats orphan results as neutral", () => {
    const session = newTestSession();
    session.addSystem("sys");
    session.addToolResult("ghost", "orphan");
    const nodes = buildNodes(session, undefined);
    const balances = computeCutBalances(nodes, new Set());
    expect(balances.every(Boolean)).toBe(true);
  });
});

describe("lockedZoneStart", () => {
  it("locks node 0 and the PROTECT_TAIL freshest nodes", () => {
    const session = editableSurface();
    const nodes = buildNodes(session, undefined);
    expect(lockedZoneStart(nodes)).toBe(Math.max(1, nodes.length - PROTECT_TAIL));
  });
});
