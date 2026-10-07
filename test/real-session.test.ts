/**
 * Integration tests against the REAL `@deepseek-ai/dsh-session` Session:
 * no harness, no Cordis context — `Session.create()` builds a detached
 * session whose append validation, surface derivation, and replacementRange
 * semantics are the exact production code paths. FakeSession (helpers.ts)
 * stays for unit tests; this file guards against semantic drift between the
 * fake and the runtime, and proves the core's replacement appends pass the
 * real validator.
 */
import { describe, expect, it } from "vitest";
import { Session } from "@deepseek-ai/dsh-session";
import { renderMap } from "../src/core/map.js";
import { applyEdits } from "../src/core/edits.js";
import { renderSurfaceDump } from "../src/core/dump.js";
import { SOURCE_KIND } from "../src/core/constants.js";
import type { SessionLike } from "../src/core/types.js";
import { FakeSession, editableSurface } from "./helpers.js";

let counter = 0;
/** Branded ids are plain strings at runtime. */
function mid(): never {
  return `m${++counter}` as never;
}

function text(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** Append helpers mirroring the agent loop's event shapes (types.ts SessionEventMap). */
const real = {
  system(session: Session, body: string): void {
    session.append(
      "system/message",
      { turn: 0, step: 0, message: { id: mid(), role: "system", content: [text(body)], source: { kind: "system-prompt" } } },
      { surfaceOp: "append" }
    );
  },
  user(session: Session, body: string): void {
    session.append(
      "user/message",
      { id: mid(), role: "user", content: [text(body)], source: { kind: "user" } },
      { surfaceOp: "append" }
    );
  },
  snapshot(session: Session, body = "Current runtime context…"): void {
    session.append(
      "user/message",
      // The runtime-context source kind is contributed by another package's
      // augmentation; the base MessageSource union does not list it.
      { id: mid(), role: "user", content: [text(body)], source: { kind: "runtime-context" } as never },
      { surfaceOp: "append" }
    );
  },
  assistantText(session: Session, body: string): void {
    session.append(
      "assistant/message",
      {
        turn: 0,
        step: 0,
        message: { id: mid(), role: "assistant", content: [text(body)], source: { kind: "model", provider: "test", model: "test" } },
        stream: []
      },
      { surfaceOp: "append" }
    );
  },
  assistantCalls(session: Session, calls: Array<{ id: string; name: string }>): void {
    session.append(
      "assistant/message",
      {
        turn: 0,
        step: 0,
        message: {
          id: mid(),
          role: "assistant",
          content: calls.map((call) => ({ type: "tool-call", id: call.id as never, name: call.name, input: {} }) as never),
          source: { kind: "model", provider: "test", model: "test" }
        },
        stream: []
      },
      { surfaceOp: "append" }
    );
  },
  toolResult(session: Session, callId: string, body: string): void {
    session.append(
      "tool/result",
      {
        turn: 0,
        step: 0,
        message: { id: mid(), role: "tool", toolCallId: callId as never, content: [text(body)], source: { kind: "tool", callId: callId as never } }
      },
      { surfaceOp: "append" }
    );
  },
  stepStart(session: Session, turn: number, step: number): void {
    session.append("step/start", { turn, step });
  },
  requestContext(session: Session, contextWindow = 100_000): void {
    session.append("request/context", { provider: "test", model: "test", contextWindow });
  }
};

function asLike(session: Session): SessionLike {
  // Branded seq/id types are numbers/strings at runtime; the core's
  // structural SessionLike is satisfied by the real class.
  return session as unknown as SessionLike;
}

/** Real-session equivalent of helpers.editableSurface: system + filler units + fresh tail. */
function realEditableSurface(filler = 6): Session {
  const session = Session.create("real-test" as never);
  real.system(session, "system prompt");
  real.requestContext(session);
  for (let i = 0; i < filler; i++) {
    real.user(session, `user message ${i}`);
    real.assistantText(session, `assistant answer ${i}`);
  }
  real.user(session, "latest user");
  real.assistantCalls(session, [{ id: "live", name: "bash" }]);
  real.toolResult(session, "live", "ok");
  real.snapshot(session);
  real.stepStart(session, 1, 1);
  return session;
}

/** Visible (message-producing) surface entries as role:text pairs. */
function visibleMessages(session: SessionLike): string[] {
  const out: string[] = [];
  for (const seq of session.surface.nodes) {
    const message = session.deriveEventMessage(session.eventAt(seq));
    if (message == null) continue;
    const body = (message.content ?? [])
      .map((block) => (block.type === "text" ? block.text : `[${block.type}:${block.name ?? block.id ?? ""}]`))
      .join("|");
    out.push(`${message.role}:${body}`);
  }
  return out;
}

describe("real dsh-session Session", () => {
  it("derives the same surface shape the fake models", () => {
    const session = realEditableSurface();
    const like = asLike(session);
    // 1 system + 12 filler + 4 tail nodes
    expect(like.surface.nodes).toHaveLength(17);
    const map = renderMap(like, undefined);
    expect(map).toContain("#0");
    expect(map).toContain("locked: #0 (system)");
    expect(map).toContain("user message 0");
  });

  it("applies an edit through the real replacementRange validation", () => {
    const session = realEditableSurface();
    const like = asLike(session);
    const before = like.surface.nodes.length;
    renderMap(like, undefined); // planning map establishes numbering
    const receipt = applyEdits(like, undefined, [{ from: 4, to: 6, content: "[compressed filler]" }]);
    expect(receipt).toContain("#4–#6 → 1 node");
    // 5 nodes replaced by 1 (three user/assistant pairs = units #4..#6 → 6 nodes? no:)
    expect(like.surface.nodes.length).toBeLessThan(before);
    const visible = visibleMessages(like);
    expect(visible.some((line) => line.includes("[compressed filler]"))).toBe(true);
    // The fresh tail survived untouched.
    expect(visible.at(-1)).toContain("Current runtime context");
    expect(visible.some((line) => line === "user:latest user")).toBe(true);
  });

  it("folds superseded snapshots inside an edit once a first edit exists", () => {
    const session = realEditableSurface();
    const like = asLike(session);
    // First edit establishes the first-edit point; snapshots before it are
    // cache-clean prefix and never fold.
    applyEdits(like, undefined, [{ from: 4, to: 4, content: "[c]" }]);
    real.snapshot(session, "snapshot A");
    real.snapshot(session, "snapshot B");
    real.snapshot(session, "snapshot C");
    real.user(session, "later user");
    real.assistantText(session, "later answer");
    // Second edit: A is past the first edit and outside the fresh tail →
    // dropped. B sits inside the locked tail; C is the newest snapshot.
    applyEdits(like, undefined, [{ from: 4, to: 4, content: "[c2]" }]);
    const visible = visibleMessages(like);
    expect(visible.filter((line) => line.includes("snapshot A"))).toHaveLength(0);
    expect(visible.some((line) => line.includes("snapshot B"))).toBe(true);
    expect(visible.some((line) => line.includes("snapshot C"))).toBe(true);
    expect(visible.some((line) => line.includes("later user"))).toBe(true);
  });

  it("rejects a replace citing incomplete source seqs (real validator parity)", () => {
    const session = realEditableSurface();
    const nodes = [...session.surface.nodes];
    const startSeq = nodes[1]!;
    const endSeq = nodes[3]!;
    expect(() =>
      session.append(
        "developer/message",
        {
          turn: 0,
          step: 0,
          message: {
            id: mid(),
            role: "developer",
            content: [text("bad")],
            source: { kind: SOURCE_KIND } as never
          }
        },
        {
          surfaceOp: { op: "replace", startSeq, endSeq },
          // nodes[2] shadowed but not cited — the real session must refuse.
          sourceEventSeqs: [startSeq, endSeq]
        }
      )
    ).toThrow();
  });

  it("renders identical maps and post-edit surfaces on fake and real sessions", () => {
    const fake = editableSurface();
    const realSession = realEditableSurface();
    const fakeMap = renderMap(fake, undefined).replace(/~[\d.]+Kt?/g, "~N");
    const realMap = renderMap(asLike(realSession), undefined).replace(/~[\d.]+Kt?/g, "~N");
    expect(realMap).toBe(fakeMap);

    const script = [{ from: 4, to: 6, content: "[compressed filler 0–2]" }];
    applyEdits(fake, undefined, script);
    applyEdits(asLike(realSession), undefined, script);
    expect(visibleMessages(asLike(realSession))).toEqual(visibleMessages(fake));
  });

  it("renders a surface dump from a real session", () => {
    const session = realEditableSurface();
    const dump = renderSurfaceDump(asLike(session), undefined, "test");
    expect(dump).toContain("# dsh-clm surface dump — test");
    expect(dump).toContain("[system]");
    expect(dump).toContain("system prompt");
    expect(dump).toContain("user message 5");
  });
});
