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
- **Postscript** — after the model switch the same surface measured ~17% of
  the 1M window, so the deferred pass was skipped as unnecessary. Note:
  thresholds are relative to the routed window — a mid-session window
  change resets the escalation state, which the log should keep in mind
  when judging the strategy.
