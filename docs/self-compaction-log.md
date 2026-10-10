# Self-compaction dogfooding log

Running log of the agent's own `context_edit` compactions under the
70/75/90 nudge strategy (first nudge at the 70% bucket, hard directive at
75%, stop line at 90%). Purpose: judge how workable this strategy feels
from the inside — when nudges arrive, whether the map gives enough to plan
by, what friction shows up, what gets lost.

Format per entry:

- **When** — date + budget bucket at the time of the compaction.
- **Trigger** — which nudge/line prompted it (or "proactive").
- **What was folded** — unit ranges and what they held.
- **Kept verbatim** — what survived and why.
- **Friction** — anything awkward: numbering surprises, lost context
  discovered later, nudge timing too early/late, receipt confusion.
- **Verdict** — did the strategy help or hinder the ongoing task.

---

## Entries

### 2026-10-10 — OVERFLOW: the 70% nudge lost to "just one more phase"

- **When** — ~70% of the 262.1K window (k3-256k), consolidation task nearly
  done (bundles installed, commit pending).
- **Trigger** — the new 70% nudge line arrived on schedule: "plan a
  context_edit pass at the next phase boundary."
- **What happened** — the agent deferred the pass to "right after the
  commit" and kept verifying instead: two full `list_plugins` pages (190
  rows), `Tool.listTools` (full schemas of every tool), several
  `dump-config` greps. Those inspection dumps ate the remaining ~30% far
  faster than ordinary work would have. The session overflowed the 262K
  window; the user had to switch the session to the 1M-token model (k3) to
  continue. No mechanical backstop existed: this session is pinned to the
  retired STUB engine revision (no auto-compaction, no overflow recovery).
- **Friction** — (1) "plan a pass at the next phase boundary" reads as
  permission to finish the current phase first — with big verification
  dumps that is exactly wrong; (2) inspection tools that dump unbounded
  listings (plugin lists, config dumps, full tool schemas) are the real
  budget killers near the threshold, not the work itself; (3) the pinned
  stub engine meant zero safety net — a Stage-1 engine revision would have
  run classic overflow recovery.
- **Verdict** — the 70% nudge timing itself was fine (~79K headroom at
  arrival); the failure was deferral. Working rule adopted: when the 70%
  line arrives, the pass happens BEFORE the next big tool call, not after
  the current phase; page/filter large inspections instead of reading them
  whole. The 75% "run context_edit now" line should be treated as a hard
  stop.
- **Postscript (root cause, measured from the session log)** — turn 4 ended
  with provider 400 "Your request exceeded k3-256k model token limit:
  262144", code INVALID_REQUEST. Per-step provider `usage` shows: last
  success 186,462 tokens (step 87), then ~1KB of new events, then the 400 —
  the failing request was ~187.5K tokens. So the wall sat at **~71.3% of
  the raw window** — almost exactly the 70% nudge. The provider DOES
  reserve completion budget, but by an unmeasurable amount: K ≈ 75K
  (186,029 + K ≤ 262,144 succeeded; ~187,500 + K failed) — neither the
  nominal maxTokens 131072 (an adapter default) nor 2×32768. Estimator
  error was NOT the cause (local count 183K vs provider 186K — ~2%).
  Actions taken: (1) user lowered k3-256k maxTokens to 32768 → worst-case
  prompt ceiling 229,376 (87.5%); (2) the budget counter keeps the raw
  window with NO reservation formula (any formula would mislead — K is
  provider-specific), relying on the 70/75/90 thresholds for the margin;
  (3) logged the classification gap as compaction-engine.md §6 item 9.
- **Postscript 2** — after the model switch the same surface measured ~17%
  of the 1M window, so the deferred pass was skipped as unnecessary.
  Thresholds are relative to the routed window — a mid-session window
  change resets the escalation state.

## Entry 2 — 2026-10-10, ~13:45 (turn 13): automatic CLASSIC compaction at the pressure threshold — and a stale-fiber finding

**Trigger.** The automatic pressure gate (`agent/before-step` →
`compactIfNeeded`) fired at ~60–62% of the 262K window — consistent with
the computed threshold 163,840 tokens (62.5%) for maxTokens 32768.
The gate itself is healthy and fired at the designed point.

**What folded.** seqs 10..1681 (everything from the boot checkpoint through
the overflow-shim work) → one classic one-shot summary (8,424 chars) at
seq 1939; `compaction/start` 1938 → `compaction/end` 1941, no error.
The summarizer mostly re-emitted the existing checkpoint summary's
structure — a graceful fold of an already-condensed span. Budget counter
dropped ~60% → ~15–20%; `self-edits applied` reset to 0 (the context_edit
tool pairs were inside the shadowed span — expected accounting, not data
loss).

**Kept verbatim.** Everything from seq 1682 on: Stage 3 (compactRegion),
de-escalation, the race test, the viewer badge — all post-span.

**Friction — the real finding.** The running engine behaved as PLAIN BASIC:
no `clm/compaction-nudge` event, a synchronous one-shot summarizer call
(the rawOutput reasoning even narrates "this is the classic one-shot
summarizer format"). The Stage-2+ build cannot reach that path without a
prior pending transaction (none existed). Conclusion: **the live
compaction service fiber is the Stage-1 build constructed when the
harness process started (2026-09-27); it has survived every `npm run
build` since.** HMR reloads host-plugin fibers (the dsh-clm plugin's v13
tool description went live) but NOT this preset-mounted service fiber —
the startup log shows `Fiber._reload` errors and `HMR is disposed`.
**Implication for dogfooding: verify the fiber vintage, not just the file
build. The CLM-loop dogfood requires a harness restart** (AGENTS.md's
"fallback with a 100% guarantee").

**Verdict.** Recovery worked — the session continued coherently from the
summary; the old 133s summarizer abort did NOT repeat (the fold completed
inside the step). But the Stage-2 loop remains unverified live: the nudge
never fired because the nudging code was never running.
