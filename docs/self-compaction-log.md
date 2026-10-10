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

(none yet — log created at ~15% budget, before the first compaction)
