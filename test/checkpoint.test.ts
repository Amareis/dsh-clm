import { describe, expect, it } from "vitest";
import { CHECKPOINT_PREAMBLE, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG, findOpenCompaction } from "../src/core/compaction.js";
import { applyEdits } from "../src/core/edits.js";
import { editableSurface, type TestSession } from "./helpers.js";

const CMP_ID = "cmp-test-1";

/** Open a CLM self-edit transaction the way the engine does (close-time
 *  markers): ONE surface nudge user/message whose source carries the
 *  transaction parameters — nothing else is logged at open. Returns the
 *  nudge event's seq. */
function openTransaction(session: TestSession, id: string = CMP_ID, budgetTokens = 500): number {
  session.append("user/message", {
    content: [{ type: "text", text: `[clm-compaction ${id}] Context pressure: condense the conversation span at map node positions 1–2 (~1000 tokens) down to ≤ ${budgetTokens} tokens, within 3 steps.` }],
    source: { kind: "dsh-clm-compaction", compactionId: id, baselineTokens: 1000, budgetTokens, deadlineSteps: 3, trigger: "pressure" },
  });
  return (session.seq as unknown as number) - 1;
}

describe("findOpenCompaction", () => {
  it("returns undefined when no transaction exists", () => {
    expect(findOpenCompaction(editableSurface(), CMP_ID)).toBeUndefined();
  });

  it("finds the open transaction via the nudge and picks up the budget", () => {
    const session = editableSurface();
    const nudgeSeq = openTransaction(session);
    const open = findOpenCompaction(session, CMP_ID);
    expect(open).toBeDefined();
    expect(open!.compactionId).toBe(CMP_ID);
    expect(open!.startSeq).toBe(nudgeSeq); // the nudge event's seq
    expect(open!.turn).toBeNull();
    expect(open!.budgetTokens).toBe(500);
    expect(open!.baselineTokens).toBe(1000);
    expect(open!.deadlineSteps).toBe(3);

    // A compaction/end with the id retires the transaction.
    session.append("compaction/end", { compactionId: CMP_ID, turn: 0 });
    expect(findOpenCompaction(session, CMP_ID)).toBeUndefined();

    // …and so does a nudge whose source is marked expired (timeout: the
    // engine took over).
    const expired = editableSurface();
    expired.append("user/message", {
      content: [{ type: "text", text: `[clm-compaction ${CMP_ID}] Expired (clm-timeout: test). The engine is handling compaction itself now.` }],
      source: { kind: "dsh-clm-compaction", compactionId: CMP_ID, budgetTokens: 500, expired: true },
    });
    expect(findOpenCompaction(expired, CMP_ID)).toBeUndefined();
  });

  it("returns undefined once the transaction closed (timeout/close)", () => {
    const session = editableSurface();
    openTransaction(session);
    session.append("compaction/end", { compactionId: CMP_ID, turn: 0 });
    expect(findOpenCompaction(session, CMP_ID)).toBeUndefined();
  });

  it("returns undefined for a different id (typo protection)", () => {
    const session = editableSurface();
    openTransaction(session);
    expect(findOpenCompaction(session, "cmp-other")).toBeUndefined();
  });
});

describe("applyEdits in checkpoint mode", () => {
  it("commits a user/message checkpoint with the plugin framing and no summary event", () => {
    const session = editableSurface();
    const nudgeSeq = openTransaction(session);
    const open = findOpenCompaction(session, CMP_ID)!;
    const receipt = applyEdits(session, undefined, [{ from: 1, to: 2, content: "[condensed by the model]" }], open);

    // Receipt reports the transaction progress toward the budget (spec §4.5.3).
    expect(receipt).toContain("1 checkpoint node");
    expect(receipt).toContain(`compaction ${CMP_ID}`);
    expect(receipt).toContain("target ≤");

    // Close-time markers: NO metering event — the engine emits the whole
    // stock compaction/start|summary|end chain at close time.
    expect(session.appends.some((a) => a.type === "compaction/summary")).toBe(false);
    expect(session.appends.some((a) => a.type === "compaction/start")).toBe(false);

    // The checkpoint is a user/message replace with the PLUGIN's checkpoint
    // kind (deliberately not the stock 'compact-checkpoint': that kind
    // requires a matching open compaction on replay, and none exists while
    // the transaction is open).
    const replace = session.appends.find((a) => (a.data.source as { kind?: string } | undefined)?.kind === "dsh-clm-checkpoint")!;
    expect(replace.type).toBe("user/message");
    expect(replace.ref).toBeDefined();
    expect((replace.ref!.surfaceOp as { op: string }).op).toBe("replace");

    const checkpoint = replace.data as { role?: string; content?: Array<{ text: string }>; source?: Record<string, unknown> };
    expect(checkpoint.role).toBe("user");
    expect(checkpoint.source?.kind).toBe("dsh-clm-checkpoint");
    expect(checkpoint.source?.compactionId).toBe(CMP_ID);
    expect(checkpoint.source?.clm).toBe(true);

    // Framing: preamble + summary tags (spec §4.5.1).
    const text = checkpoint.content![0]!.text;
    expect(text).toContain(CHECKPOINT_PREAMBLE);
    expect(text).toContain(SUMMARY_OPEN_TAG);
    expect(text).toContain("[condensed by the model]");
    expect(text).toContain(SUMMARY_CLOSE_TAG);

    // The replace cites the nudge event plus the shadowed seqs.
    const cited = replace.ref!.sourceEventSeqs!;
    expect(cited[0]).toBe(nudgeSeq);
    expect(cited[0]).toBe(open.startSeq);
    expect(cited.length).toBeGreaterThan(1);
  });

  it("still rejects edits that violate the ordinary invariants in checkpoint mode", () => {
    const session = editableSurface();
    openTransaction(session);
    const open = findOpenCompaction(session, CMP_ID)!;
    expect(() => applyEdits(session, undefined, [{ from: 0, to: 1, content: "x" }], open)).toThrow(/system prompt/);
  });
});
