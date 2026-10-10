/**
 * Three-phase loop tests (spec docs/compaction-engine.md §4.2): nudge →
 * waiting → close, and the timeout fallbacks. The engine runs against a REAL
 * detached Session and a fake ctx (cordis Service tolerates a structural
 * context: reflect.provide + on/get/waterfall stubs); the token meter is a
 * fixed 100-tokens-per-node fake so the gate math stays exact.
 *
 * CLOSE-TIME MARKERS variant: open logs NOTHING (the open state is the
 * in-memory pending plus ONE surface nudge user/message); the whole stock
 * compaction/start → summary → consolidated replace → end chain is emitted
 * atomically by the close, inside the current turn.
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

function events(session: Session, type: string): Array<{ seq: number; data: any }> {
  const out: Array<{ seq: number; data: any }> = [];
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq as never) as any;
    if (event?.type === type) out.push(event);
  }
  return out;
}

/** The engine's surface notices: user/message events whose source carries
 *  kind 'dsh-clm-compaction' (the nudge at open, the expiry at timeout). */
function clmNotices(session: Session): Array<{ seq: number; data: any }> {
  return events(session, "user/message").filter((event) => event.data?.source?.kind === "dsh-clm-compaction");
}

/** Open-transaction nudges (not expired). */
function clmNudges(session: Session): Array<{ seq: number; data: any }> {
  return clmNotices(session).filter((event) => event.data.source.expired !== true);
}

/** Timeout/retirement notices (source.expired === true). */
function clmExpiries(session: Session): Array<{ seq: number; data: any }> {
  return clmNotices(session).filter((event) => event.data.source.expired === true);
}

/** Emulate the dsh-clm plugin's checkpoint commit (spec §4.5.1 — close-time
 *  markers): ONE user/message replace with the plugin's checkpoint kind and
 *  the preamble/tags framing, citing the nudge plus the shadowed seqs. NO
 *  compaction/summary event is appended — the engine emits the whole stock
 *  chain at close time. */
function commitCheckpoint(session: Session, compactionId: string, startSeq: number, endSeq: number, shadowedSeqs: number[], text: string): void {
  const nudge = clmNudges(session).find((event) => event.data.source.compactionId === compactionId);
  if (nudge === undefined) throw new Error(`no nudge found for compaction ${compactionId}`);
  append(session, "user/message", {
    id: `dsh-clm-${mid()}`, role: "user",
    content: [{ type: "text", text: `This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>\n${text}\n</compacted-summary>` }],
    source: { kind: "dsh-clm-checkpoint", compactionId, clm: true },
  }, {
    surfaceOp: { op: "replace", startSeq, endSeq },
    sourceEventSeqs: [nudge.seq, ...shadowedSeqs],
  });
}

/** The span the nudge asks the model to fold, as current surface seqs (the
 *  nudge names map node POSITIONS, which index the surface at nudge time —
 *  valid until the next replace). */
function nudgedSpan(session: Session, nudge: { seq: number; data: any }): number[] {
  const text = nudge.data.content[0].text as string;
  const match = /node positions (\d+)–(\d+)/.exec(text);
  if (match === null) throw new Error(`nudge text has no span positions: ${text}`);
  const surface = session.surface.nodes as unknown as number[];
  return surface.slice(Number(match[1]), Number(match[2]) + 1);
}

/** The close-time stock chain for one transaction (spec §4.2 step 3):
 *  compaction/start → compaction/summary → consolidated compact-checkpoint
 *  replace → compaction/end, all appended in ONE pre-step. */
function closeChain(session: Session, compactionId: string): {
  starts: Array<{ seq: number; data: any }>;
  summaries: Array<{ seq: number; data: any }>;
  consolidated: Array<{ seq: number; data: any }>;
  ends: Array<{ seq: number; data: any }>;
} {
  return {
    starts: events(session, "compaction/start").filter((event) => event.data.compactionId === compactionId),
    summaries: events(session, "compaction/summary").filter((event) => event.data.compactionId === compactionId),
    consolidated: events(session, "user/message").filter(
      (event) => event.data?.source?.kind === "compact-checkpoint" && event.data?.source?.compactionId === compactionId,
    ),
    ends: events(session, "compaction/end").filter((event) => event.data.compactionId === compactionId),
  };
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
    // Close-time markers: NOTHING is logged at open — no compaction/start,
    // no log-only nudge event. The open state is in-memory pending + ONE
    // surface nudge user/message.
    expect(events(session, "compaction/start")).toHaveLength(0);
    expect(events(session, "clm/compaction-nudge")).toHaveLength(0);
    const nudges = clmNudges(session);
    expect(nudges).toHaveLength(1);
    const nudge = nudges[0]!;
    const source = nudge.data.source as Record<string, unknown>;
    const compactionId = source.compactionId as string;
    expect(compactionId).toBeTruthy();
    expect(source.baselineTokens).toBe(800);
    expect(source.budgetTokens).toBe(400); // 800 baseline × 0.5
    expect(source.deadlineSteps).toBe(3); // maxWaitSteps default
    expect(source.trigger).toBe("pressure");
    const text = nudge.data.content[0].text as string;
    expect(text).toContain(`[clm-compaction ${compactionId}] Context pressure:`);
    expect(text).toContain("≤ 400 tokens"); // the budget
    expect(text).toContain("within 3 steps"); // the deadline
    expect(text).toContain("context_edit");
    // No summary ran: the engine returned without touching the span.
    expect(events(session, "compaction/summary")).toHaveLength(0);
    // The transaction is pending: the next pre-step is a silent wait (no
    // progress → no re-nudge), still nothing logged.
    expect(await engine.compactIfNeeded(agent(session), "pressure", SIGNAL)).toBeNull();
    expect(clmNudges(session)).toHaveLength(1);
    expect(events(session, "compaction/start")).toHaveLength(0);
    expect(events(session, "compaction/end")).toHaveLength(0);
  });

  it("waits while no checkpoint has landed (phase 2), then closes on a sufficient checkpoint (phase 3)", async () => {
    const session = longSession();
    const { engine } = makeEngine({ maxWaitSteps: 2 });
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    const nudge = clmNudges(session)[0]!;
    const compactionId = nudge.data.source.compactionId as string;

    // Waiting step: no checkpoint yet → null, still open (nothing logged).
    const waiting = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(waiting).toBeNull();
    expect(events(session, "compaction/start")).toHaveLength(0);
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

    // The WHOLE stock chain is emitted atomically at close: start → summary
    // → consolidated replace → end, adjacently, in one pre-step.
    const { starts, summaries, consolidated, ends } = closeChain(session, compactionId);
    expect(starts).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(consolidated).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(summaries[0]!.seq).toBe(starts[0]!.seq + 1);
    expect(consolidated[0]!.seq).toBe(summaries[0]!.seq + 1);
    expect(ends[0]!.seq).toBe(consolidated[0]!.seq + 1);
    // result.startSeq is the CLOSE-TIME start event's seq — not the nudge's.
    expect(closed!.startSeq).toBe(starts[0]!.seq);
    expect(closed!.startSeq).not.toBe(nudge.seq);
    // The summary meters the coverage span (the checkpoint + leftovers).
    const coverageSeqs = summaries[0]!.data.shadowedSeqs as number[];
    expect(coverageSeqs).toHaveLength(1); // the single checkpoint node
    // The consolidated node is a STOCK compact-checkpoint carrying the
    // model's text; it cites the close chain plus the coverage seqs.
    expect(consolidated[0]!.data.content[0].text).toContain("[model-written checkpoint]");
    // The coverage span is off the surface, replaced by the consolidated node.
    const after = session.surface.nodes as unknown as number[];
    expect(after).toContain(consolidated[0]!.seq);
    expect(after).not.toContain(coverageSeqs[0]);
    for (const seq of shadowed) expect(after).not.toContain(seq);

    // Pressure is gone; the next pre-step is a no-op.
    const noop = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(noop).toBeNull();
    expect(events(session, "compaction/start")).toHaveLength(1);
  });

  it("times out with an expiry notice (no compaction/end) and fallback 'off' → null", async () => {
    const session = longSession();
    const { engine } = makeEngine({ maxWaitSteps: 1 });
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // waited 1
    const result = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // waited 2 > 1
    expect(result).toBeNull(); // fallback: 'off'
    // Nothing was logged at open, so nothing needs closing: NO
    // compaction/end. A surface expiry notice retires the id instead.
    expect(events(session, "compaction/end")).toHaveLength(0);
    const expiries = clmExpiries(session);
    expect(expiries).toHaveLength(1);
    expect(expiries[0]!.data.content[0].text).toMatch(/Expired \(clm-timeout/);
  });

  it("fallback 'fail' surfaces the timeout as an error", async () => {
    const session = longSession();
    const { engine } = makeEngine({ maxWaitSteps: 1, fallback: "fail" });
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // waited 1
    await expect(engine.compactIfNeeded(agent(session), "pressure", SIGNAL)).rejects.toThrow(/self-edit transaction failed/);
    expect(events(session, "compaction/end")).toHaveLength(0);
    expect(clmExpiries(session)).toHaveLength(1);
    expect(clmExpiries(session)[0]!.data.content[0].text).toMatch(/Expired \(clm-timeout/);
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
    // Overflow ignores the threshold and opens the transaction — marker-free,
    // nudge only.
    expect(await engine.compactIfNeeded(agent(session), "context-overflow", SIGNAL)).toBeNull();
    expect(events(session, "compaction/start")).toHaveLength(0);
    const nudges = clmNudges(session);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.data.source.deadlineSteps).toBe(1); // overflowMaxWaitSteps
    expect(nudges[0]!.data.source.trigger).toBe("context-overflow");
  });

  it("refuses to open while the log holds an unmatched compaction/start (left by another engine)", async () => {
    const session = longSession();
    append(session, "compaction/start", { compactionId: "dead-beef", turn: null });
    const { engine } = makeEngine();
    await expect(engine.compactIfNeeded(agent(session), "pressure", SIGNAL)).rejects.toThrow(/already active/);
    expect(clmNudges(session)).toHaveLength(0);
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
    // The CLM overflow path opened a self-edit transaction (no growth yet —
    // only the surface nudge), so the original error passes through — the
    // nudge drives the next turn.
    expect(result).toBe("passthrough");
    expect(nextCalls).toBe(1);
    expect(events(session, "compaction/start")).toHaveLength(0);
    const nudges = clmNudges(session);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.data.source.deadlineSteps).toBe(1); // overflowMaxWaitSteps
    expect(nudges[0]!.data.source.trigger).toBe("context-overflow");
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
    // The promise is held; the transaction is open marker-free, nudge only.
    expect(events(session, "compaction/start")).toHaveLength(0);
    const nudges = clmNudges(session);
    expect(nudges).toHaveLength(1);
    const compactionId = nudges[0]!.data.source.compactionId as string;

    // The model answers with a checkpoint over the exact span; the next
    // pre-step closes and the held promise resolves.
    const shadowed = surface.slice(1, 5);
    commitCheckpoint(session, compactionId, startSeq, endSeq, shadowed, "[region checkpoint]");
    const closed = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(closed).not.toBeNull();
    const result = await held;
    expect(result.compactionId).toBe(compactionId);
    expect(JSON.stringify(result.summary)).toContain("[region checkpoint]");
    // The close-time chain: exactly one start, one summary, one consolidated
    // compact-checkpoint replace, one end.
    const { starts, summaries, consolidated, ends } = closeChain(session, compactionId);
    expect(starts).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]!.data.content[0].text).toContain("[region checkpoint]");
    expect(ends).toHaveLength(1);
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
    // Timeout appends NO compaction/end — only the expiry notice.
    expect(events(session, "compaction/end")).toHaveLength(0);
    const expiries = clmExpiries(session);
    expect(expiries).toHaveLength(1);
    expect(expiries[0]!.data.content[0].text).toMatch(/Expired \(clm-timeout/);
  });

  it("rejects the held promise on abort and logs nothing", async () => {
    const session = longSession();
    openTurn(session);
    const { engine } = makeEngine();
    const surface = session.surface.nodes as unknown as number[];
    const controller = new AbortController();
    const held = engine.compactRegion(surface[1] as never, surface[3] as never, agent(session), controller.signal);
    const assertion = expect(held).rejects.toThrow();
    controller.abort();
    await assertion;
    // Abort deletes the pending and rejects the waiter — NO log append at
    // all (no compaction/end with clm-aborted, no expiry notice).
    expect(events(session, "compaction/end")).toHaveLength(0);
    expect(clmExpiries(session)).toHaveLength(0);
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
      // Timeout #1: open + wait + timeout. Timeouts append NO compaction/end
      // anymore — count them via the expiry notices.
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // open
      expect(clmNudges(session)).toHaveLength(1);
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // timeout #1
      expect(clmExpiries(session)).toHaveLength(1);
      expect(events(session, "compaction/end")).toHaveLength(0);
      // Recovery: the next transaction CLOSES (new close-time chain) — a
      // successful close resets the consecutive-timeout counter.
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // open
      const recoveryNudge = clmNudges(session).at(-1)!;
      const recoverySpan = nudgedSpan(session, recoveryNudge);
      commitCheckpoint(
        session,
        recoveryNudge.data.source.compactionId as string,
        recoverySpan[0]!,
        recoverySpan[recoverySpan.length - 1]!,
        recoverySpan,
        "[recovery checkpoint]",
      );
      const closed = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      expect(closed).not.toBeNull();
      expect(events(session, "compaction/start")).toHaveLength(1); // close-time chain
      expect(events(session, "compaction/end")).toHaveLength(1);
      // Back above the threshold for the remaining cycles (the close freed
      // the span; the fixture needs fresh pressure).
      for (let index = 0; index < 5; index += 1) addUser(session, `post-close filler ${index}`);
      // The counter restarted at zero: two FRESH consecutive timeouts are
      // needed to de-escalate.
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // open
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // post-recovery timeout #1
      expect(clmExpiries(session)).toHaveLength(2);
      // Not yet de-escalated: a new CLM transaction opens (timeout #2 cycle).
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // open
      expect(events(session, "compaction/start")).toHaveLength(1); // no new close → no new start
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL); // post-recovery timeout #2
      expect(clmExpiries(session)).toHaveLength(3);
      // De-escalated: the next pre-step goes straight to the classic path —
      // no new CLM transaction.
      const nudgesBefore = clmNudges(session).length;
      await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
      expect(clmNudges(session)).toHaveLength(nudgesBefore);
      expect(classicCalls).toBeGreaterThan(0);
    } finally {
      parent.compactIfNeeded = original;
    }
  });
});

describe("nudge vs concurrent surface mutation (spec §6 item 3)", () => {
  it("closes cleanly when unrelated replaces land between the nudge and the close", async () => {
    const session = longSession();
    const { engine } = makeEngine({ maxWaitSteps: 2 });
    await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    const nudge = clmNudges(session)[0]!;
    const compactionId = nudge.data.source.compactionId as string;
    const surface = session.surface.nodes as unknown as number[];

    // Concurrent mutation OUTSIDE the span (step-recovery style): replace
    // the last user node (index 9) — the span is nodes 1..8.
    const outsideSeq = surface[9]!;
    append(session, "user/message", {
      id: mid(), role: "user", content: [{ type: "text", text: "recovered step" }], source: { kind: "user" },
    }, { surfaceOp: { op: "replace", startSeq: outsideSeq, endSeq: outsideSeq }, sourceEventSeqs: [outsideSeq] });

    // The model's checkpoint over the span still closes the transaction.
    const startSeq = surface[1]!;
    const endSeq = surface[8]!;
    commitCheckpoint(session, compactionId, startSeq, endSeq, surface.slice(1, 9), "[checkpoint after race]");
    const closed = await engine.compactIfNeeded(agent(session), "pressure", SIGNAL);
    expect(closed).not.toBeNull();
    expect(closed!.compactionId).toBe(compactionId);
    // …with the clean close-time chain.
    const { starts, summaries, consolidated, ends } = closeChain(session, compactionId);
    expect(starts).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(consolidated).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.data.error).toBeUndefined();
  });
});
