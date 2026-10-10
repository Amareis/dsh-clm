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
  on(): void;
  get(): undefined;
  waterfall(event: unknown, payload: unknown, next: () => unknown): unknown;
  logger: { info(): void; warn(): void };
  tokenMeter: { measure(session: Session): { totalTokens: number; nodes: Array<{ seq: unknown; tokens: number; heuristicTokens: number }> } };
  llm: { resolveModelInfo(): Promise<{ context: { contextWindow: number }; defaultMaxTokens: number }> };
  sessions: Record<string, never>;
}

function fakeCtx(): FakeCtx {
  return {
    reflect: { provide() {} },
    on() {},
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

function makeEngine(config: Record<string, unknown> = {}): ClmCompactionEngine {
  return new ClmCompactionEngine(fakeCtx() as never, {
    thresholdRatio: 0.5,
    retainRatio: 0.1,
    headroomTokens: 10,
    compactionRetries: 0,
    maxOverflowRetries: 0,
    auto: false,
    fallback: "off",
    ...config,
  });
}

const agent = (session: Session) => ({ session, options: {} }) as never;
const SIGNAL = new AbortController().signal;

describe("ClmCompactionEngine three-phase loop", () => {
  it("does nothing below the pressure threshold", async () => {
    const session = Session.create(`loop-${++counter}` as never);
    addHeader(session);
    addSystem(session, "sys");
    addUser(session, "a");
    const engine = makeEngine();
    const result = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(result).toBeNull();
    expect(events(session, "compaction/start")).toHaveLength(0);
  });

  it("opens a transaction with a nudge instead of summarizing (phase 1)", async () => {
    const session = longSession();
    const engine = makeEngine();
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
    const engine = makeEngine({ maxWaitSteps: 2 });
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
    const engine = makeEngine({ maxWaitSteps: 1 });
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
    const engine = makeEngine({ maxWaitSteps: 1, fallback: "fail" });
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
    const engine = makeEngine();
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
