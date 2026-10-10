import { describe, expect, it } from "vitest";
import { CHECKPOINT_PREAMBLE, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG, findOpenCompaction } from "../src/core/compaction.js";
import { applyEdits } from "../src/core/edits.js";
import { editableSurface, type TestSession } from "./helpers.js";

const CMP_ID = "cmp-test-1";

/** Open a CLM self-edit transaction the way the engine does (log-only). */
function openTransaction(session: TestSession, id: string = CMP_ID, budgetTokens = 500): void {
  session.append("compaction/start", { compactionId: id, turn: 0 });
  session.append("clm/compaction-nudge", {
    compactionId: id,
    span: { start: 1, end: 2 },
    baselineTokens: 1000,
    budgetTokens,
    deadlineSteps: 3,
  }, { ignorable: true });
}

describe("findOpenCompaction", () => {
  it("returns undefined when no transaction exists", () => {
    expect(findOpenCompaction(editableSurface(), CMP_ID)).toBeUndefined();
  });

  it("finds an unmatched start and picks up the nudge budget", () => {
    const session = editableSurface();
    openTransaction(session);
    const open = findOpenCompaction(session, CMP_ID);
    expect(open).toBeDefined();
    expect(open!.compactionId).toBe(CMP_ID);
    expect(open!.budgetTokens).toBe(500);
    expect(open!.baselineTokens).toBe(1000);
    expect(open!.deadlineSteps).toBe(3);
    expect(open!.startSeq).toBeGreaterThan(0);
  });

  it("returns undefined once the transaction closed (timeout/close)", () => {
    const session = editableSurface();
    openTransaction(session);
    session.append("compaction/end", { compactionId: CMP_ID, turn: 0, error: "clm-timeout: test" });
    expect(findOpenCompaction(session, CMP_ID)).toBeUndefined();
  });

  it("returns undefined for a different id (typo protection)", () => {
    const session = editableSurface();
    openTransaction(session);
    expect(findOpenCompaction(session, "cmp-other")).toBeUndefined();
  });
});

describe("applyEdits in checkpoint mode", () => {
  it("commits a user/message checkpoint with a metering summary event immediately before it", () => {
    const session = editableSurface();
    openTransaction(session);
    const open = findOpenCompaction(session, CMP_ID)!;
    const receipt = applyEdits(session, undefined, [{ from: 1, to: 2, content: "[condensed by the model]" }], open);

    // Receipt reports the transaction progress toward the budget (spec §4.5.3).
    expect(receipt).toContain("1 checkpoint node");
    expect(receipt).toContain(`compaction ${CMP_ID}`);
    expect(receipt).toContain("target ≤");

    // Contractual adjacency: compaction/summary sits IMMEDIATELY before the replace.
    const summaryIdx = session.appends.findIndex((a) => a.type === "compaction/summary");
    expect(summaryIdx).toBeGreaterThan(-1);
    const replace = session.appends[summaryIdx + 1]!;
    expect(replace.type).toBe("user/message");
    expect(replace.ref).toBeDefined();

    // The summary event meters the shadowed span (spec §4.4).
    const summary = session.appends[summaryIdx]!.data as Record<string, unknown>;
    expect(summary.compactionId).toBe(CMP_ID);
    expect(summary.shadowedTokenCount).toBeGreaterThan(0);
    expect(Array.isArray(summary.shadowedSeqs)).toBe(true);
    expect((summary.shadowedSeqs as number[]).length).toBeGreaterThan(0);
    expect(summary.llmStreamCall).toBeUndefined();

    // The checkpoint is a user/message recognized structurally by the stock UI.
    const checkpoint = replace.data as { role?: string; content?: Array<{ text: string }>; source?: Record<string, unknown> };
    expect(checkpoint.role).toBe("user");
    expect(checkpoint.source?.kind).toBe("compact-checkpoint");
    expect(checkpoint.source?.compactionId).toBe(CMP_ID);
    expect(checkpoint.source?.clm).toBe(true);

    // Framing: preamble + summary tags (spec §4.5.1).
    const text = checkpoint.content![0]!.text;
    expect(text).toContain(CHECKPOINT_PREAMBLE);
    expect(text).toContain(SUMMARY_OPEN_TAG);
    expect(text).toContain("[condensed by the model]");
    expect(text).toContain(SUMMARY_CLOSE_TAG);

    // The replace cites the transaction's start event plus the shadowed seqs.
    const cited = (replace.ref as { sourceEventSeqs: number[] }).sourceEventSeqs;
    expect(cited).toContain(open.startSeq);
    for (const seq of summary.shadowedSeqs as number[]) expect(cited).toContain(seq);
  });

  it("still rejects edits that violate the ordinary invariants in checkpoint mode", () => {
    const session = editableSurface();
    openTransaction(session);
    const open = findOpenCompaction(session, CMP_ID)!;
    expect(() => applyEdits(session, undefined, [{ from: 0, to: 1, content: "x" }], open)).toThrow(/system prompt/);
  });
});
