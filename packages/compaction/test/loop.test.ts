/**
 * Three-phase loop tests (spec docs/compaction-engine.md §4.2): nudge →
 * waiting → close, and the timeout fallbacks. The engine runs against a REAL
 * detached Session and a fake ctx (cordis Service tolerates a structural
 * context: reflect.provide + on/get/waterfall stubs); the token meter is a
 * fixed 100-tokens-per-node fake so the gate math stays exact.
 */
import { describe, expect, it } from "vitest";
import { Session } from "@deepseek-ai/dsh-session";
import { ClmCompactionEngine } from "../src/index.js";

const NODE_TOKENS = 100;
const WINDOW = 1000;

interface FakeCtx {
  reflect: { provide(): void };
  on(event: string, listener: (...args: never[]) => unknown): void;
  listeners: Map<string, Array<(...args: never[]) => unknown>>;
  get(): undefined;
  waterfall(event: unknown, payload: unknown, next: () => unknown): unknown;
  logger: { info(): void; warn(): void };
  tokenMeter: { measure(session: Session): { totalTokens: number; nodes: Array<{ seq: unknown; tokens: number; heuristicTokens: number }> } };
  llm: { resolveModelInfo(): Promise<{ context: { contextWindow: number }; defaultMaxTokens: number }> };
  sessions: Record<string, never>;
}

function fakeCtx(): FakeCtx {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
  return {
    reflect: { provide() {} },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    listeners,
    get() { return undefined; },
    waterfall(_event, _payload, next) { return next(); },
    logger: { info() {}, warn() {} },
    tokenMeter: {
      measure(session: Session) {
        const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: NODE_TOKENS, heuristicTokens: NODE_TOKENS }));
        return { totalTokens: nodes.length * NODE_TOKENS, nodes };
      },
    },
    llm: { async resolveModelInfo() { return { context: { contextWindow: WINDOW }, defaultMaxTokens: 100 }; } },
    sessions: {},
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const append = (session: Session, type: string, data: unknown, intent?: unknown): any =>
  (session.append as any)(type, data, intent);

let counter = 0;
const mid = () => `loop-${++counter}`;

function addSystem(session: Session, text: string): void {
  append(session, "system/message", {
    turn: 0, step: 0,
    message: { id: mid(), role: "system", content: [{ type: "text", text }], source: { kind: "system-prompt" } },
  }, { surfaceOp: "append" });
}

function addUser(session: Session, text: string): void {
  append(session, "user/message", {
    id: mid(), role: "user", content: [{ type: "text", text }], source: { kind: "user" },
  }, { surfaceOp: "append" });
}

/** Route the session: the gate's routedTarget reads the durable header. */
function addHeader(session: Session): void {
  append(session, "request/header", { header: { config: { provider: "test", model: "test", maxTokens: 100 } } });
}

/** 1 system + 9 user nodes = 10 nodes × 100t = 1000t total; threshold 500t. */
function longSession(): Session {
  const session = Session.create(`loop-${++counter}` as never);
  addHeader(session);
  addSystem(session, "system prompt");
  for (let index = 1; index <= 9; index += 1) addUser(session, `user message ${index}`);
  return session;
}

/** Emulate the dsh-clm plugin's checkpoint commit (spec §4.5.1). */
function commitCheckpoint(session: Session, compactionId: string, startSeq: number, endSeq: number, shadowedSeqs: number[], text: string): void {
  const summary = append(session, "compaction/summary", {
    compactionId,
    summary: [{ type: "text", text }],
    shadowedRange: { start: startSeq, end: endSeq },
    shadowedSeqs,
    shadowedTokenCount: shadowedSeqs.length * NODE_TOKENS,
    provider: "test",
    model: "test",
  });
  append(session, "user/message", {
    id: mid(), role: "user",
    content: [{ type: "text", text }],
    source: { kind: "compact-checkpoint", compactionId, clm: true },
  }, {
    surfaceOp: { op: "replace", startSeq, endSeq },
    sourceEventSeqs: [summary.seq, ...shadowedSeqs],
  });
}

function events(session: Session, type: string): Array<{ seq: number; data: any }> {
  const out: Array<{ seq: number; data: any }> = [];
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never) as any;
    if (event?.type === type) out.push(event);
  }
  return out;
}

function makeEngine(config: Record<string, unknown> = {}): { engine: ClmCompactionEngine; ctx: FakeCtx } {
  const ctx = fakeCtx();
  const engine = new ClmCompactionEngine(ctx as never, {
    thresholdRatio: 0.5,
    retainRatio: 0.1,
    headroomTokens: 10,
    compactionRetries: 0,
    maxOverflowRetries: 0,
    auto: false,
    fallback: "off",
    ...config,
  });
  return { engine, ctx };
}

const agent = (session: Session) => ({ session, options: {} }) as never;
const SIGNAL = new AbortController().signal;

describe("ClmCompactionEngine three-phase loop", () => {
  it("does nothing below the pressure threshold", async () => {
    const session = Session.create(`loop-${++counter}` as never);
    addHeader(session);
    addSystem(session, "sys");
    addUser(session, "a");
    const { engine } = makeEngine();
    const result = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(result).toBeNull();
    expect(events(session, "compaction/start")).toHaveLength(0);
  });

  it("opens a transaction with a nudge instead of summarizing (phase 1)", async () => {
    const session = longSession();
    const { engine } = makeEngine();
    const result = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(result).toBeNull();
    const starts = events(session, "compaction/start");
    expect(starts).toHaveLength(1);
    const compactionId = starts[0]!.data.compactionId as string;
    expect(compactionId).toBeTruthy();
    // Log-only nudge event with the budget (the dsh-clm plugin reads it back).
    const nudges = events(session, "clm/compaction-nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.data.compactionId).toBe(compactionId);
    expect(nudges[0]!.data.budgetTokens).toBe(400); // 800 baseline × 0.5
    // Surface nudge: a developer/message addressing the model.
    const surfaceNudges = events(session, "developer/message");
    expect(surfaceNudges).toHaveLength(1);
    const text = JSON.stringify(surfaceNudges[0]!.data);
    expect(text).toContain(compactionId);
    expect(text).toContain("context_edit");
    // No summary ran: the engine returned without touching the span.
    expect(events(session, "compaction/summary")).toHaveLength(0);
  });

  it("waits while no checkpoint has landed (phase 2), then closes on a sufficient checkpoint (phase 3)", async () => {
    const session = longSession();
    const { engine } = makeEngine({ maxWaitSteps: 2 });
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    const compactionId = events(session, "compaction/start")[0]!.data.compactionId as string;

    // Waiting step: no checkpoint yet → null, still open.
    const waiting = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(waiting).toBeNull();
    expect(events(session, "compaction/end")).toHaveLength(0);

    // The model answers: fold the span (nodes 1..8 of the original surface)
    // into one checkpoint.
    const surface = session.surface.nodes as unknown as number[];
    // After the nudge the surface is [system, u1..u9, nudge]; the selected
    // span is u1..u8 — seqs 1..8 in this fixture.
    const startSeq = surface[1]!;
    const endSeq = surface[8]!;
    const shadowed = surface.slice(1, 9);
    commitCheckpoint(session, compactionId, startSeq, endSeq, shadowed, "[model-written checkpoint]");

    const closed = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(closed).not.toBeNull();
    expect(closed!.compactionId).toBe(compactionId);
    expect(closed!.shadowedTokenCount).toBe(800);
    expect(closed!.shadowedSeqs).toHaveLength(8);
    expect(JSON.stringify(closed!.summary)).toContain("[model-written checkpoint]");
    const ends = events(session, "compaction/end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.data.error).toBeUndefined();

    // Pressure is gone; the next pre-step is a no-op.
    const after = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(after).toBeNull();
    expect(events(session, "compaction/start")).toHaveLength(1);
  });

  it("times out with compaction/end{error} and fallback 'off' → null", async () => {
    const session = longSession();
    const { engine } = makeEngine({ maxWaitSteps: 1 });
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // waited 1
    const result = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // waited 2 > 1
    expect(result).toBeNull(); // fallback: 'off'
    const ends = events(session, "compaction/end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.data.error).toMatch(/clm-timeout/);
  });

  it("fallback 'fail' surfaces the timeout as an error", async () => {
    const session = longSession();
    const { engine } = makeEngine({ maxWaitSteps: 1, fallback: "fail" });
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // waited 1
    await expect(engine.compactIfNeeded(agent(session), "pressure", SIGNAL)).rejects.toThrow(/self-edit transaction failed/);
    expect(events(session, "compaction/end")[0]!.data.error).toMatch(/clm-timeout/);
  });

  it("context-overflow bypasses the threshold and uses the tighter deadline", async () => {
    const session = Session.create(`loop-${++counter}` as never);
    addHeader(session);
    addSystem(session, "sys");
    addUser(session, "a");
    addUser(session, "b"); // 3 nodes = 300t < 500t threshold
    const { engine } = makeEngine();
    expect(await engine.compactIfNeeded(agent(session), "pressure", SIGNAL)).toBeNull();
    expect(events(session, "compaction/start")).toHaveLength(0);
    // Overflow ignores the threshold and opens the transaction.
    expect(await engine.compactIfNeeded(agent(session), "context-overflow", SIGNAL)).toBeNull();
    const starts = events(session, "compaction/start");
    expect(starts).toHaveLength(1);
    const nudges = events(session, "clm/compaction-nudge");
    expect(nudges[0]!.data.deadlineSteps).toBe(1); // overflowMaxWaitSteps
  });
});

describe("overflow-wording shim (spec §6 item 9)", () => {
  const KIMI_MESSAGE = "Your request exceeded k3-256k model token limit: 262144";

  function requestErrorListener(ctx: FakeCtx): (event: unknown, next: () => unknown) => unknown {
    const list = ctx.listeners.get("agent/request-error") ?? [];
    if (list.length !== 1) throw new Error(`expected exactly 1 shim listener, got ${list.length}`);
    return list[0] as (event: unknown, next: () => unknown) => unknown;
  }

  function failureEvent(session: Session, failure: { code?: string; message?: string }) {
    return { agent: { session, options: {} }, failure, signal: new AbortController().signal };
  }

  it("recognizes Kimi's unclassified overflow wording and runs the CLM overflow path", async () => {
    const session = longSession();
    const { engine: _engine, ctx } = makeEngine({ maxOverflowRetries: 1 });
    const listener = requestErrorListener(ctx);
    let nextCalls = 0;
    const next = () => { nextCalls += 1; return "passthrough"; };
    const result = await listener(failureEvent(session, { code: "INVALID_REQUEST", message: KIMI_MESSAGE }), next);
    // The CLM overflow path opened a self-edit transaction (no growth yet),
    // so the original error passes through — the nudge drives the next turn.
    expect(result).toBe("passthrough");
    expect(nextCalls).toBe(1);
    expect(events(session, "compaction/start")).toHaveLength(1);
    const nudges = events(session, "clm/compaction-nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.data.deadlineSteps).toBe(1); // overflowMaxWaitSteps
  });

  it("returns { kind: 'retry' } when compaction produced surface growth, and stops at maxOverflowRetries", async () => {
    const session = longSession();
    const { engine, ctx } = makeEngine({ maxOverflowRetries: 1 });
    const listener = requestErrorListener(ctx);
    // Force the classic shape: compactIfNeeded that grows replaceGeneration
    // (an additive append does NOT — only a surface replace counts).
    engine.compactIfNeeded = (async () => {
      const seq = (session.surface.nodes as unknown as number[])[1]!;
      append(session, "user/message", {
        id: mid(), role: "user", content: [{ type: "text", text: "compacted" }], source: { kind: "user" },
      }, { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
      return null;
    }) as never;
    let nextCalls = 0;
    const next = () => { nextCalls += 1; return "passthrough"; };
    // The retry counter is keyed by the agent INSTANCE — the runtime reuses
    // it across requests, so the test must too.
    const agentCtx = { session, options: {} };
    const event = () => ({ agent: agentCtx, failure: { code: "INVALID_REQUEST", message: KIMI_MESSAGE }, signal: new AbortController().signal });
    const first = await listener(event(), next);
    expect(first).toEqual({ kind: "retry" });
    expect(nextCalls).toBe(0);
    // Retry budget exhausted → the original error passes through.
    const second = await listener(event(), next);
    expect(second).toBe("passthrough");
    expect(nextCalls).toBe(1);
  });

  it("ignores already-classified overflow and unrelated failures", async () => {
    const session = longSession();
    const { ctx } = makeEngine({ maxOverflowRetries: 1 });
    const listener = requestErrorListener(ctx);
    let nextCalls = 0;
    const next = () => { nextCalls += 1; return "passthrough"; };
    await listener(failureEvent(session, { code: "CONTEXT_WINDOW_EXCEEDED", message: "context length exceeded" }), next);
    await listener(failureEvent(session, { code: "INVALID_CREDENTIAL", message: "bad key" }), next);
    expect(nextCalls).toBe(2);
    expect(events(session, "compaction/start")).toHaveLength(0);
  });

  it("'off' disables the shim (no listeners registered)", () => {
    const { ctx } = makeEngine({ overflowWording: "off" });
    expect(ctx.listeners.get("agent/request-error") ?? []).toHaveLength(0);
  });
});

describe("compactRegion (spec §4.7)", () => {
  /** compactRegion's CLM path requires an open turn (basic contract). */
  function openTurn(session: Session, turn = 1): void {
    append(session, "turn/start", { turn });
  }

  it("opens a fixed-span transaction and resolves the held promise at the close", async () => {
    const session = longSession();
    openTurn(session);
    const { engine } = makeEngine({ maxWaitSteps: 2 });
    const surface = session.surface.nodes as unknown as number[];
    const startSeq = surface[1]!;
    const endSeq = surface[4]!;
    const held = engine.compactRegion(startSeq as never, endSeq as never, agent(session), SIGNAL);
    // The promise is held; the transaction is open with a nudge.
    const starts = events(session, "compaction/start");
    expect(starts).toHaveLength(1);
    const compactionId = starts[0]!.data.compactionId as string;
    expect(events(session, "developer/message")).toHaveLength(1);

    // The model answers with a checkpoint over the exact span; the next
    // pre-step closes and the held promise resolves.
    const shadowed = surface.slice(1, 5);
    commitCheckpoint(session, compactionId, startSeq, endSeq, shadowed, "[region checkpoint]");
    const closed = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(closed).not.toBeNull();
    const result = await held;
    expect(result.compactionId).toBe(compactionId);
    expect(JSON.stringify(result.summary)).toContain("[region checkpoint]");
    expect(events(session, "compaction/end")).toHaveLength(1);
  });

  it("rejects the held promise on timeout with fallback 'off'", async () => {
    const session = longSession();
    openTurn(session);
    const { engine } = makeEngine({ maxWaitSteps: 1, fallback: "off" });
    const surface = session.surface.nodes as unknown as number[];
    const held = engine.compactRegion(surface[1] as never, surface[3] as never, agent(session), SIGNAL);
    const assertion = expect(held).rejects.toThrow(/clm-timeout/);
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // waited 1
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // waited 2 > 1 → timeout
    await assertion;
    expect(events(session, "compaction/end")[0]!.data.error).toMatch(/clm-timeout/);
  });

  it("rejects the held promise on abort and closes with clm-aborted", async () => {
    const session = longSession();
    openTurn(session);
    const { engine } = makeEngine();
    const surface = session.surface.nodes as unknown as number[];
    const controller = new AbortController();
    const held = engine.compactRegion(surface[1] as never, surface[3] as never, agent(session), controller.signal);
    const assertion = expect(held).rejects.toThrow();
    controller.abort();
    await assertion;
    expect(events(session, "compaction/end")[0]!.data.error).toMatch(/clm-aborted/);
  });

  it("throws when another CLM transaction is already open", async () => {
    const session = longSession();
    openTurn(session);
    const { engine } = makeEngine();
    const surface = session.surface.nodes as unknown as number[];
    void engine.compactRegion(surface[1] as never, surface[3] as never, agent(session), SIGNAL);
    await expect(
      engine.compactRegion(surface[4] as never, surface[6] as never, agent(session), SIGNAL),
    ).rejects.toThrow(/already open/);
  });
});

describe("de-escalation after consecutive timeouts (spec §6 item 4)", () => {
  it("drops to the classic path after deescalateAfter consecutive timeouts and recovers on a close", async () => {
    const session = longSession();
    const { engine } = makeEngine({ maxWaitSteps: 1, deescalateAfter: 2 });
    // Track classic-path delegations by stubbing the BASE class method.
    let classicCalls = 0;
    const parent = Object.getPrototypeOf(Object.getPrototypeOf(engine));
    const original = parent.compactIfNeeded;
    parent.compactIfNeeded = async function (...args: unknown[]) {
      classicCalls += 1;
      return null; // do not actually summarize in this test
    };
    try {
      // Timeout #1: open + wait + timeout.
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      expect(events(session, "compaction/start")).toHaveLength(1);
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // timeout #1
      expect(events(session, "compaction/end")).toHaveLength(1);
      // Not yet de-escalated: a new CLM transaction opens (timeout #2 cycle).
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      expect(events(session, "compaction/start")).toHaveLength(2);
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // timeout #2
      expect(events(session, "compaction/end")).toHaveLength(2);
      // De-escalated: the next pre-step goes straight to the classic path —
      // no new CLM transaction.
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      expect(events(session, "compaction/start")).toHaveLength(2);
      expect(classicCalls).toBeGreaterThan(0);
    } finally {
      parent.compactIfNeeded = original;
    }
  });
});
