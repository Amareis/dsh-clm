/**
 * Test helpers — a REAL detached dsh-session Session (`Session.create()`,
 * no harness, no Cordis context) with builder methods monkey-patched on.
 * Every append goes through the production validator and surface derivation;
 * the wrappers only inject envelope defaults (turn/step/id/source) so tests
 * can stay terse. Tests therefore exercise the exact runtime semantics —
 * replacementRange, shadowed-coverage validation, empty-content drops
 * projecting to nothing — with no fake to drift away from them.
 */
import { Session } from "@deepseek-ai/dsh-session";
import { SOURCE_KIND } from "../src/core/constants.js";
import type { ContentBlock, EventShape, MessageShape } from "../src/core/types.js";

const SURFACE_TYPES = new Set(["system/message", "user/message", "assistant/message", "developer/message", "tool/result"]);

export interface RecordedAppend {
  type: string;
  data: Record<string, unknown>;
  ref?: { surfaceOp: unknown; sourceEventSeqs?: number[] };
}

/** The real Session plus the patched-on test builders. */
export interface TestSession extends Session {
  /** Loose test-facing append: envelope defaults are injected, the surface
   *  intent defaults to "append" for surface events. `any` return keeps the
   *  interface assignable back to the real generic Session.append. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  append(type: string, data: unknown, ...rest: unknown[]): any;
  addSystem(text: string): TestSession;
  addUser(text: string): TestSession;
  addAssistantText(text: string): TestSession;
  addAssistantCalls(calls: Array<{ id: string; name: string }>): TestSession;
  addToolResult(toolCallId: string, text: string): TestSession;
  addSnapshot(text?: string): TestSession;
  addClmNode(text: string, opts?: { sweep?: boolean; drop?: boolean }): TestSession;
  addStepStart(turn: number, step: number): TestSession;
  /** Log-derived view of every append, with its surface intent when present. */
  readonly appends: RecordedAppend[];
  /** Copy of the positional surface seq array (numbers). */
  readonly surfaceNodes: number[];
  visibleCount(): number;
}

let counter = 0;
const mid = (): string => `test-${++counter}`;
const MODEL_SOURCE = { kind: "model", provider: "test", model: "test" } as const;

/** Inject the envelope defaults the real validator expects, keeping any
 *  fields the caller supplied. */
function normalize(type: string, data: unknown): unknown {
  const record = (data ?? {}) as Record<string, unknown>;
  const message = (record.message ?? record) as Record<string, unknown>;
  switch (type) {
    case "system/message":
      return { turn: 0, step: 0, ...record, message: { id: mid(), role: "system", source: { kind: "system-prompt" }, ...message } };
    case "user/message":
      return { id: mid(), role: "user", source: { kind: "user" }, ...record };
    case "assistant/message":
      return { turn: 0, step: 0, stream: [], ...record, message: { id: mid(), role: "assistant", source: MODEL_SOURCE, ...message } };
    case "developer/message":
      return { turn: 0, step: 0, ...record, message: { id: mid(), role: "developer", source: { kind: SOURCE_KIND }, ...message } };
    case "tool/result": {
      const withDefaults = { id: mid(), role: "tool", ...message } as Record<string, unknown>;
      return { turn: 0, step: 0, ...record, message: { ...withDefaults, source: { kind: "tool", callId: withDefaults.toolCallId as string } } };
    }
    default:
      return record;
  }
}

/** Create a real detached session with the test builders patched on. */
export function newTestSession(): TestSession {
  const session = Session.create(`test-session-${++counter}` as never) as TestSession;

  const original = session.append.bind(session) as (type: string, data: unknown, intent?: unknown) => unknown;
  session.append = ((type: string, data: unknown, ...rest: unknown[]) => {
    const intent = rest[0] ?? (SURFACE_TYPES.has(type) ? { surfaceOp: "append" } : undefined);
    return intent === undefined
      ? original(type, normalize(type, data))
      : original(type, normalize(type, data), intent);
  }) as never;

  session.addSystem = function (text) {
    session.append("system/message", { message: { content: [{ type: "text", text }] } });
    return session;
  };
  session.addUser = function (text) {
    session.append("user/message", { content: [{ type: "text", text }] });
    return session;
  };
  session.addAssistantText = function (text) {
    session.append("assistant/message", { message: { content: [{ type: "text", text }] } });
    return session;
  };
  session.addAssistantCalls = function (calls) {
    const content: ContentBlock[] = calls.map((call) => ({ type: "tool-call", id: call.id, name: call.name, input: {} }));
    session.append("assistant/message", { message: { content } });
    return session;
  };
  session.addToolResult = function (toolCallId, text) {
    session.append("tool/result", { message: { toolCallId, content: [{ type: "text", text }] } });
    return session;
  };
  /** A runtime-context snapshot (user/message with source.kind runtime-context). */
  session.addSnapshot = function (text = "Current runtime context…") {
    session.append("user/message", { content: [{ type: "text", text }], source: { kind: "runtime-context" } });
    return session;
  };
  /** A dsh-clm developer node (edit replacement or sweep marker). */
  session.addClmNode = function (text, opts = {}) {
    session.append("developer/message", {
      message: {
        content: opts.drop === true ? [] : [{ type: "text", text }],
        source: { kind: SOURCE_KIND, ...(opts.sweep === true ? { sweep: true } : {}), ...(opts.drop === true ? { drop: true } : {}) }
      }
    });
    return session;
  };
  session.addStepStart = function (turn, step) {
    session.append("step/start", { turn, step });
    return session;
  };

  Object.defineProperty(session, "appends", {
    get(): RecordedAppend[] {
      const out: RecordedAppend[] = [];
      for (let seq = 0; seq < session.seq; seq += 1) {
        // Deprecated sync read — fine in tests, the session is fully in-memory.
        const event = session.eventAt(seq as never) as (EventShape & { surfaceOp?: unknown; sourceEventSeqs?: number[] }) | undefined;
        if (event === undefined) continue;
        out.push({
          type: event.type,
          data: (event.data ?? {}) as Record<string, unknown>,
          ref: event.surfaceOp !== undefined && event.surfaceOp !== "append"
            ? { surfaceOp: event.surfaceOp, sourceEventSeqs: event.sourceEventSeqs }
            : undefined
        });
      }
      return out;
    }
  });
  Object.defineProperty(session, "surfaceNodes", {
    get(): number[] {
      return [...session.surface.nodes];
    }
  });
  /** Number of visible (message-producing) surface nodes. */
  session.visibleCount = function (): number {
    let count = 0;
    for (const seq of session.surface.nodes) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      if (session.deriveEventMessage(event) !== null) count += 1;
    }
    return count;
  };

  return session;
}

/** Standard editable surface: request/context (100K window) + system + filler
 *  units + protected tail of 4. The request/context event is log-only — it
 *  does not occupy a surface node but powers the budget line. */
export function editableSurface(filler = 6): TestSession {
  const session = newTestSession();
  session.append("request/context", { provider: "test", model: "test", contextWindow: 100_000 });
  session.addSystem("system prompt");
  for (let i = 0; i < filler; i++) {
    session.addUser(`user message ${i}`);
    session.addAssistantText(`assistant answer ${i}`);
  }
  // fresh tail (PROTECT_TAIL = 4)
  session.addUser("latest user");
  session.addAssistantCalls([{ id: "live", name: "bash" }]);
  session.addToolResult("live", "ok");
  session.addSnapshot();
  return session;
}
