/**
 * FakeSession — a test double implementing SessionLike with the REAL surface
 * manager's replacement semantics (dsh-session surface.js replacementRange):
 * positional indexOf + slice, and full shadowed-coverage validation. This is
 * what lets the regression tests reproduce the production failure classes
 * ("missing N", "sourceEventSeqs must not be empty") without the harness.
 */
import type { ContentBlock, EventShape, MessageShape, SessionLike, SurfaceRef } from "../src/core/types.js";

const SURFACE_TYPES = new Set(["user/message", "assistant/message", "developer/message", "tool/result"]);

export interface RecordedAppend {
  type: string;
  data: Record<string, unknown>;
  ref?: SurfaceRef;
}

export class FakeSession implements SessionLike {
  readonly id = "fake-session";
  events: EventShape[] = [];
  surfaceNodes: number[] = [];
  appends: RecordedAppend[] = [];
  contextWindow: number | undefined = 100_000;

  get seq(): number {
    return this.events.length;
  }

  get surface(): { readonly nodes: readonly number[] } {
    return { nodes: this.surfaceNodes };
  }

  eventAt(seq: number): EventShape | undefined {
    return this.events[seq];
  }

  /** Mirrors dsh-session deriveEventMessage for the shapes the tests use:
   *  message events project their payload; EMPTY content projects to null
   *  (this is what makes drop replacements invisible). */
  deriveEventMessage(event: EventShape | undefined): MessageShape | null {
    if (event === undefined) return null;
    let message: MessageShape | undefined;
    if (event.type === "user/message") {
      message = event.data?.message ?? (event.data as MessageShape | undefined);
    } else if (SURFACE_TYPES.has(event.type)) {
      message = event.data?.message;
    } else {
      return null;
    }
    if (message === undefined) return null;
    if (Array.isArray(message.content) && message.content.length === 0) return null;
    return message;
  }

  append(type: string, data: unknown, ref?: SurfaceRef): EventShape {
    // Validate BEFORE touching the log — the real session's append throws
    // without changing state, and the two-phase test relies on that.
    let position = -1;
    let removeCount = 0;
    if (ref !== undefined) {
      const { startSeq, endSeq } = ref.surfaceOp;
      const startIdx = this.surfaceNodes.indexOf(startSeq);
      const endIdx = this.surfaceNodes.indexOf(endSeq);
      if (startIdx === -1 || endIdx === -1) throw new Error(`fake surface: bounds ${startSeq}..${endSeq} not on surface`);
      if (startIdx > endIdx) throw new Error(`fake surface: bounds ${startSeq}..${endSeq} inverted`);
      const shadowed = this.surfaceNodes.slice(startIdx, endIdx + 1);
      const missing = shadowed.filter((s) => !ref.sourceEventSeqs.includes(s));
      if (missing.length > 0) throw new Error(`fake surface: sourceEventSeqs missing ${missing.join(", ")}`);
      position = startIdx;
      removeCount = endIdx - startIdx + 1;
    }
    const event: EventShape = { type, data: data as EventShape["data"], seq: this.events.length };
    this.events.push(event);
    this.appends.push({ type, data: data as Record<string, unknown>, ref });
    if (ref !== undefined) {
      this.surfaceNodes.splice(position, removeCount, event.seq as number);
    } else if (SURFACE_TYPES.has(type)) {
      this.surfaceNodes.push(event.seq as number);
    }
    return event;
  }

  requestContext(): { contextWindow?: number } | undefined {
    return this.contextWindow === undefined ? undefined : { contextWindow: this.contextWindow };
  }

  // ---- builders -----------------------------------------------------------

  addSystem(text: string): this {
    this.append("developer/message", { message: { role: "developer", content: [{ type: "text", text }] } });
    return this;
  }

  addUser(text: string): this {
    this.append("user/message", { message: { role: "user", content: [{ type: "text", text }] } });
    return this;
  }

  addAssistantText(text: string): this {
    this.append("assistant/message", { message: { role: "assistant", content: [{ type: "text", text }] } });
    return this;
  }

  addAssistantCalls(calls: Array<{ id: string; name: string }>): this {
    const content: ContentBlock[] = calls.map((call) => ({ type: "tool-call", id: call.id, name: call.name, input: {} }));
    this.append("assistant/message", { message: { role: "assistant", content } });
    return this;
  }

  addToolResult(toolCallId: string, text: string): this {
    this.append("tool/result", { message: { role: "tool", toolCallId, content: [{ type: "text", text }] } });
    return this;
  }

  /** A runtime-context snapshot (user/message with source.kind runtime-context). */
  addSnapshot(text = "Current runtime context…"): this {
    this.append("user/message", {
      message: { role: "user", content: [{ type: "text", text }], source: { kind: "runtime-context" } }
    });
    return this;
  }

  /** A dsh-clm developer node (edit replacement or sweep marker). */
  addClmNode(text: string, opts: { sweep?: boolean; drop?: boolean } = {}): this {
    this.append("developer/message", {
      message: {
        role: "developer",
        content: opts.drop === true ? [] : [{ type: "text", text }],
        source: { kind: "dsh-clm", ...(opts.sweep === true ? { sweep: true } : {}), ...(opts.drop === true ? { drop: true } : {}) }
      }
    });
    return this;
  }

  addStepStart(turn: number, step: number): this {
    this.append("step/start", { turn, step });
    return this;
  }

  /** Number of visible (message-producing) surface nodes. */
  visibleCount(): number {
    return this.surfaceNodes.filter((seq) => this.deriveEventMessage(this.events[seq]) !== null).length;
  }
}

/** Standard editable surface: system + 6 filler units + protected tail of 4.
 *  Returns the session and the unit count added before the tail. */
export function editableSurface(filler = 6): FakeSession {
  const session = new FakeSession();
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
