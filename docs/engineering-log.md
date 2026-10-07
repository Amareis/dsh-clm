# Engineering Log: how `dsh-clm` became what it is

This log distills the dogfooding history of `dsh-clm` — the DSH plugin that gives a
model the `context_edit` tool for editing its own conversation surface (`op=map` to
list numbered units, `op=edit` to replace ranges with self-authored summaries). It is
written for contributors and agents who will modify the plugin and need to know *why*
the code has its current shape.

Every non-obvious decision in the codebase traces to a concrete failure observed in a
live session. This document preserves those failures, the numbers that motivated each
fix, and — most importantly — the **negative knowledge**: approaches that were tried
and rejected, and traps that will bite you again if you refactor carelessly.

**Reading convention.** "Units" are the numbered things `op=map` shows; "nodes" are the
raw surface entries underneath (an assistant message, a tool result, a user message, a
runtime-context snapshot). In v8+ the two differ deliberately: one unit = one
indivisible call group. "Surface" is the host's projection of the append-only session
log that actually gets sent to the model.

---

## 0. Prehistory: the first live demo (before the tool existed)

The motivating observation predates the plugin. An agent was asked to inventory its
own context at a natural phase boundary (main artifact written to disk). The surface
held ~39.8K tokens of which ~35K were working turns (file reads, write/edit calls)
whose *result was already materialized on disk*. Replacing them with a ~0.5K
self-authored summary + pointers would have shrunk the context ~40× with zero loss of
recoverable information.

Three findings from that demo became permanent design principles:

1. **The fattest spend is tool outputs and the model's own long writes/edits** — dead
   the moment their result is materialized elsewhere.
2. **Only user words and accepted decisions are unrecoverable.** Files can be re-read;
   "the user said do X first" cannot. User turns and the decision log are the last
   candidates for editing — user messages stay verbatim in every later policy.
3. **Edits must batch into one log rewrite** — one prompt-cache invalidation instead
   of many. Origin of the atomic multi-range edit transaction.

The host's native checkpoint compaction had already demonstrated the baseline: a
harness-written summary is *sufficient*, but the model writes a better one because it
knows what it will need later. That gap is the entire premise of the plugin.

---

## 1. Round 1 (v1 MVP): the tool was useless exactly where it mattered

**Setup.** First working `context_edit`, `PROTECT_TAIL = 4`, lock semantics:
`lockedFrom = min(start of current turn, length − PROTECT_TAIL)` — everything in the
current turn plus the fresh tail is read-only.

**Observed.** Dogfooded in a delegated subagent session (one long turn). Starting map:
5 nodes, ~3.8K/262.1K (1%). After reading the task contract: 24 nodes, ~25.6K (10%).
The single `edit` attempt was rejected with
`nodes #0..#27 are locked ... to must be < 0`. Because the whole session was one turn,
`lockedFrom = 1` and **every node was locked, forever**. Budget grew from ~3.8K to
~65K (25%) with zero ability to fix anything. The `to must be < 0` message also looked
like a bug even though it was a correct consequence of policy.

**Decision.** Turn-lock had to go. The main consumer of long contexts — delegated
subagents producing large file outputs — works in a single turn until its final
answer, so a per-turn lock made the tool a no-op for its primary user. The lock was
redefined to cover only the system node `#0` plus a fresh tail of 4 nodes
(`lockMode: 'step'` semantics, later simply the default). Edits inside an open turn
are safe for the same reason harness compaction's surface-replace is safe: the
tool-call pairing gate already protects transcript validity.

**Invariants established.**

- Editing inside an open turn must be possible; the lock protects *recency*, not
  *turns*. (Current lock rule: system node `#0` plus the fresh tail — `PROTECT_TAIL`
  nodes and the uneditable in-flight portion of the current turn — see `AGENTS.md`.)
- **A CLM engine triggered on context pressure is always inside a turn** — so this
  was a blocking prerequisite for any pressure-triggered automatic engine, not
  cosmetic UX.

---

## 2. Round 2: first real edit; the overlap-validator bug

**Observed.** After the lock fix (71 nodes, ~38.1K, 15%):

- An 8-range batch covering `#2–#66` was rejected: `ranges #51–#56 and #57–#66
  overlap` — a **false positive on adjacent ranges** (56 < 57).
- A 7-range batch with adjacent pairs manually merged: rejected again on the next
  adjacent pair. Same off-by-one.
- A single merged range `#2–#66`: **applied** — freed **~33.4Kt**, context
  ~45.6K → ~12.3K. Final map: 20 nodes, ~13.5K (5%).

The model continued working normally after the edit; the replacement summary was
self-sufficient (contract, design, findings preserved).

**Decision/fix.** The overlap check mixed inclusive/exclusive `to` semantics
(off-by-one). Fixed to strict interval intersection over `[from, to]`.

**Invariants established.**

- **Adjacent-span merging**: adjacent ranges supplied in one batch are merged into one
  replacement node. This was originally a workaround for the validator bug; it is now
  documented behavior — *content of the merged node comes from the first range*, so
  when you intend several consecutive spans, write the combined replacement text in
  the first one.
- **Batch atomicity**: one invalid range rejects the whole batch. Kept deliberately
  (the log is rewritten once; partial application would split the cache
  invalidation). The cost of atomicity is real: one bad boundary discards all
  summaries in the batch.
- The `applied` receipt (freed tokens, before/after budget) turned out to be exactly
  the feedback a model needs to self-regulate — keep receipts precise and honest.

Session totals for the round: map ×4, edit ×4 (1 applied, 3 rejected), peak ~65K →
final ~13.5K (4.8× below peak). Core hypothesis confirmed: a model can compress its
own context.

---

## 3. Round 3: the reload saga — verify the *version*, never the behavior

**Observed anomaly.** After the overlap fix was shipped and the plugin toggled
off/on, multi-range batches were *still* rejected — adjacent, gapped, and far-apart
ranges alike — while single ranges worked.

**Root cause (investigated in harness source, session logs with per-step
request/header dumps).**

1. **No edit to `index.js` had ever reached the runtime.** Since install, every
   session ran v1. The "tail-lock behavior" attributed to v2 in round 2 was a v1
   turn-lock artifact appearing when the current turn happened to be short.
2. **Mechanics**: `set_plugin off/on` disposes and recreates the plugin fiber, but the
   entry-point import goes through the process-global Node ESM load cache
   (cordis-plugin-loader). Only the HMR subsystem invalidates that cache, and only
   for files under configured watch roots — which ignore `**/node_modules` and don't
   cover the real plugin directory. Tool names cannot be re-registered over an
   existing registration (duplicate name = throw).
3. **Tool resolution is per-step** (system prompt reassembled every step; live
   sessions pick up re-registration on the next step) — so the *only* bottleneck is
   the module cache.

**Fix.** Add the plugin's real directory to the HMR watch roots in the profile patch
(Node resolves cache keys by realpath). File change → chokidar → partialReload (cache
clear + dispose/re-instantiate) → live sessions run new code without a server
restart. Fallback with 100% guarantee: restart the harness server. Version check:
`cordis_inspect_query host Tool.listTools` → read the tool `description`.

**Verification of v3.** Registry description updated; map showed
`locked: #0 and #81..#84 (fresh tail)`; a two-range batch applied: ~48.3K → ~43.6K.
Both round-2 bugs (overlap, turn-lock) closed.

**Negative knowledge (permanent).**

- **Plugin toggle does NOT reload code** — it re-instantiates the fiber from the
  module cache. Hot code updates require an HMR watch root or a full restart.
- **After a harness compaction, the whole surface becomes one turn.** Any turn-based
  lock semantics then neutralizes the tool for the rest of the session. This was the
  decisive argument for tail-only locking.
- **Start every fix verification by checking the version in the tool registry, not by
  observing behavior.** Otherwise dogfooding degrades into archaeology of artifacts —
  an entire round was spent "verifying" a fix that had never loaded.

---

## 4. Round 4 (v4): pair-safety UX and the frozen-args bug

**Observed.** After v3, both dogfooding sessions compressed their contexts with
targeted batches (parent: 5 ranges, ~57K → ~8.6K; subagent: 3 ranges, ~44.5K → ~10.5K
— the first multi-range edit to pass on the first attempt).

Three findings:

1. **Old `map` outputs are dead weight with delayed death.** A map is the coordinate
   system for edits: you can't touch it while editing against it, but it is stale the
   moment a newer map exists. (Resolved later by the transaction sweep, §5.)
2. **The call/result pair validator worked correctly but expensively.** A batch was
   atomically rejected because a range boundary split a `send_message` call from its
   tool result; manually extending the range cost an extra round-trip.
3. **Replacements must keep pointers to sources.** The round's only honest loss: a
   path to a raw session log vanished into a summary — conclusions survived, the
   recovery handle didn't.

**Fixes (v4).**

- **Pair arrows in map**: `[calls: send_message → #59]` — safe range boundaries are
  visible before composing a batch. Renders for simple pairs, text+calls,
  multi-call (`[calls: grep → #45, grep → #46]`), and dangling (`→ †`, legend:
  "† = call result compacted off the surface"). Pairing is built on `toolCallId`.
- **Auto-extend with notice** instead of atomic reject: a range cutting a pair is
  extended to the whole pair; the receipt reports
  `note: range #45–#46 extended to #44–#46 (tool pair)`. Reject remains only for
  unresolvable cases.

**Bug lesson (v4).** Tool args arrive **deep-frozen**. Mutating `edit.from/to` during
normalization crashes with `Cannot assign to read only property`. Rule: any
validation-with-normalization must work on copies — and downstream structures
(sorted lists, receipts) must be built from *those same copies*, otherwise apply runs
on the un-extended ranges. This bug class matters everywhere: transactions always
normalize batches.

**Rule confirmed empirically:** every replacement text must include references to the
files/logs its facts came from.

---

## 5. Round 5 (v5→v6→v7): sweeping the tool's own footprints

### 5.1 v5: sweep-on-map — right idea, wrong entry point

**Observation.** The tool's own call chain (map dumps, edit args) hangs in context as
dead weight after application: edit args duplicate the replacement texts that already
sit in the surface as nodes (~3Kt of args next to five summary nodes in one session).

An explicit stateful init/commit protocol was rejected as overkill — the host executes
the transaction and knows everything; no state is needed.

**v5 design.** On incoming `op=map` (a new map call = start of a new transaction),
collapse traces of past transactions — old map dumps and
`assistant[calls: context_edit] + tool-result` pairs — into one-line markers with a
digest of the receipt (`[context_edit txn: 5 edits, freed ~48.7Kt, summaries → nodes
#1/#2/…]`), *before* rendering. The returned map is already in post-sweep numbering.

**Live verification.** `swept: 16 txn nodes → 8 markers`; replacements intact;
post-sweep batch on new numbering applied cleanly (−7.4Kt); negative knowledge
survives in markers; idempotent (markers carry `source.sweep=true`, never re-match).

**Invariant from v5 (later superseded in entry point only):** an edit must always run
against the numbering of the map the model actually saw; a sweep lagging by exactly
one transaction guarantees there is no "editing against numbering that no longer
exists".

### 5.2 v6: sweep moves to edit — cache economics overrode the design

**Problem with v5.** A read operation became a log rewrite: every `map` missed the
KV/prompt cache, and the following `edit` rewrote the log again — **two cache misses
per transaction**. On 50–100K+ contexts that is real money and latency; the sweep was
saving tokens that were then recomputed twice.

**v6 design.**

- `map` is a **pure read** again. It only *marks* past-transaction garbage in the
  listing (`⏳ sweeps on next edit`) so the model knows those nodes will die on their
  own.
- The **sweep executes inside `op=edit`**, atomically with the model's edits: edits
  first (against the visible map's numbering), then sweep of remaining txn garbage,
  one log rewrite = one cache miss per transaction. The ordering
  `edits → rebuild → findTxnSpans → applySpans` makes double-replacement impossible
  by construction.

**Verified live:** identical numbering between two consecutive maps (would have
shifted under v5); edit returned receipts + `swept: 2 txn nodes → 1 markers`
atomically; zero map mutations.

**Principle (permanent): reads never mutate the log; all rewrites are batched into one
atomic transaction per trigger.** Any future automatic engine gets txn-garbage
sweeping for free inside its compaction pass.

### 5.3 v7: mixed-call nodes and tool stubs

**Gap.** A txn pair of the form "assistant node with **mixed** calls (a file `edit`
*and* `context_edit` in the same node)" didn't get the `⏳` mark: the assistant node
is indivisible (it has non-context_edit calls whose results must survive).

**v7 fix.** The assistant stays; each `context_edit` *result* inside it collapses
individually into a **tool stub** (`role: "tool"` + original `toolCallId` + marker
text) — the API transcript stays valid (call→result in place), the map arrow stays
live. Idempotence has a double guard (`source.kind === "dsh-clm"` + the
`[context_edit txn:` prefix); without it the stub would re-match on every edit.

**Caveat:** stub collapse was never verified live end-to-end (native auto-compaction
ate the test nodes first). If a host projection ever fails to carry
`role:"tool"+toolCallId` through, the result is an orphaned tool_call (API 400) or a
broken arrow — the stub branch is the rollback point.

### 5.4 Boundary rules learned from a rejected dense batch

A large batch was atomically rejected when auto-extend fired **in both directions**
across a pair boundary (`#46/#47`: call in range 1, result in range 2), the extended
ranges overlapped, and the whole batch died. The boundary arrow `[calls: edit → #47]`
*was* visible in the map — the model chose boundaries thematically without checking
arrows.

Rules that follow (they belong in every nudge/planner instruction):

- A range never cuts a call→result pair. Before submitting, check the `[calls:]`
  arrows on the **first and last** node of every range: the first must not be a
  result of a call outside the range; the last must not be a call whose result is
  outside.
- **Never reconstruct numbering from memory.** A node "remembered" as a snapshot
  turned out to be an assistant with two calls. Plan strictly against the freshest
  map; verify boundaries by arrows, not recall.
- Deterministic extension means post-extend overlaps can be auto-*merged* (contents
  concatenated with a separator, notice in the receipt) instead of rejecting the
  batch. Candidate behavior for the engine; keep batch atomicity.
- **Trigger timing matters**: the native checkpoint fired at ~25–28% of budget,
  *before* the manual compaction, and swallowed the whole node structure into one
  monolithic summary (killing a live test with it). Any structural compactor must
  trigger below the native compactor's threshold or displace it — otherwise the
  monolith always wins and destroys addressability.

---

## 6. Anatomy of planning cost: why maps must never be elided

A rejected parent-session batch was dissected via its reasoning trace (~4.5Kt spent):

| Share | Went to |
|---|---|
| ~40% | Reconstructing node identities **hidden by tool-result pruning** — the harness had cut the middle of a map dump (nodes ~#47–#112), the model interpolated from memory and guessed wrong ("snapshot" #85 was an assistant with two calls) |
| ~25% | Hedging boundaries that were unverifiable without data |
| ~15% | Re-deriving policy that should be constants in the instruction |
| ~10% | Hand-carving a live test case out of the ranges |
| ~10% | Actually writing summaries — the only valuable work |

The failure happened on a range believed "visible and safe": the final checklist
verified pair *membership inside* ranges but not boundary *crossing*. Economics of the
failure: map (~5Kt) + reasoning (~4.5Kt) + rejected args (~1.5Kt) ≈ **10Kt with zero
result**, and then a native checkpoint devalued everything anyway.

**Decisions.**

- **The map must never be pruned** (see the pruner disabling in §7). A model planning
  against a pruned map is planning blind; this is a root cause of failure, not
  inattention. If maps get big, paginate — never elide.
- The host should propose **pair-safe thematic candidate ranges** (it knows roles,
  pairs, weights, classes); the model writes only summaries. Pair-cutting then becomes
  impossible by construction and ~80% of planning cost disappears. (This motivation
  produced v8, §8.)
- Policy belongs in instruction constants, not re-derived per batch.
- Pinned nodes (live tests, open branches) must be marked in the map and routed
  around by any planner.
- Planning must be "one nudge → one batch"; re-nudge only with validator feedback.

---

## 7. Displacing the native compactor (`dsh-clm-compaction` stub)

**Why.** The native basic compactor fires on pressure (~25% of the window — for a
262,144-token window: `262144 − 131072 (reservedCompletion) − 65536 (headroom) =
65536`, *exactly* 25%, hence the "early" checkpoints) and replaces structure with a
monolith. Structural editing cannot coexist with it.

**Architecture findings.**

- The seam is an abstract `CompactionEngine extends Service` (service name
  `compaction`) with `compactIfNeeded(agent, trigger, signal)` and
  `compactNow(agent, signal, commandId)` (the latter backs `/compact`).
- **Triggers live inside the implementation** (step-boundary pressure listeners call
  `this.compactIfNeeded`). Disabling the plugin removes the triggers — but also
  removes **overflow recovery**: a session hitting 100% of the window dies with a
  provider error. Accepted risk of the stub phase; it means the budget counter must
  be watched and edits done *early*.
- **Sessions live in isolated preset groups**: each agent preset mounts a `compaction`
  group with `isolate: {compaction, toolResultPruner}` and its own basic engine
  inside. A top-level `disabled: true` does not reach into groups (verified via
  `--dump-config`). The correct move is an override of the preset row — which
  **replaces the entire preset config** (staleness risk on harness upgrades; the
  re-stated presets must be re-synced after updates).
- Bundle code cannot resolve `@deepseek-ai/*`, so the stub implements the contract on
  live objects: `ctx.set("compaction", {compactIfNeeded: async () => null,
  compactNow: throw …})`. The `instanceof` check in the compact command won't match —
  acceptable generic error path.

**Activation semantics (empirically confirmed).** Patch-file changes are **not** picked
up by HMR — they need a restart. And a restart does **not** move a resumed session to
the new composition: sessions pin their preset revision. Only **new** sessions get the
stub. Confirmed when a resumed session kept pruning fresh read results under pressure
(the `middle pruned` marker belongs to the tool-result pruner, which has no triggers
of its own — the basic engine drives it) and then checkpointed (59.7K→30.9K).

**The tool-result pruner was disabled** in the same iteration: it was pruning
`context_edit` map dumps (§6) and breaking addressability. Consequence: large tool
results now live in context in full, raising budget pressure — the engine trigger must
account for unpruned volumes.

**Preset gotcha (found in the v8 round).** A "clean" verification session still got
pruned — it had been switched to a different preset that the stub's group override
didn't cover. Each preset needs its own override (or a dedicated CLM preset). This
produced a dedicated **`clm` preset**: a full copy of the full-featured preset with
the compaction group replaced by the stub (basic + pruner disabled). Double staleness
risk; re-sync after harness updates.

---

## 8. v8: pair-atomic units — prevention at planning time, not detection at apply time

**Motivation.** All of §5.4–§6 traced to one root: with per-node addressing, the model
systematically cut call→result pairs. v7's auto-extend caught it at apply time, but
two-sided extension produced spans that were opaque and unpredictable to the model,
and reconstructing meaning from `†` stubs had cost ~40% of a session's budget.

**The fix: change the unit of addressing.**

- `buildUnits`: an assistant node with tool calls + **all** its tool results = one
  numbered map unit `#N(#a..#b)`. Orphan results (call swept) become single-node
  units. **Cutting a pair is impossible by construction** — auto-extend was deleted
  from `applyEdits` entirely.
- `computeCutBalances` rewritten to message-level fold (+1 per tool-call block, −1
  per tool result with a live callId; orphans neutral) — retained only as a
  safety-net assertion, since whole-unit spans are balanced by construction.
- `renderMap`: one line per unit, `[calls: name → preview(≤40ch); name → †]`, 🔒 if
  *any* member is locked (**a unit straddling the fresh-tail boundary is wholly
  locked**), elision by units, footer explains the lock rule.
- `applyEdits`: from/to are unit numbers resolved to node spans; adjacent ranges merge
  into one span/one replacement node; overlapping ranges error; marker
  `[context-edit: replaced units #N–#M …]`; receipts `#N–#M → 1 node (freed ~Xt)`.

**First dogfood (same session, HMR delivery, no restart).** Map: 37 units (56 nodes) —
numbering shortened, structure more readable. A 14-edit batch applied highest-first in
one call: **~37.8K → ~12.4K (freed ~25.4Kt)**, sweep collapsed 2 `⏳` traces. Zero
validation errors.

---

## 9. Round 6: the `clm` preset, runtime-context snapshot flood, cache-safe auto-fold

**Preset verification — 6/6** in a fresh session: `clm` preset active; cordis tooling
present; `context_edit` = v8 per registry description; pruner and auto-compact dead
(the 25% threshold crossed 64.7K → 68.6K with zero `compaction/*` events, all reads
arriving in full); `/compact` answered with the stub error; map rendered all v8
elements.

**Batch edit dogfood.** 7 ranges in one call: adjacent merge worked (6 ranges → one
span `#4–#27` → 1 node, freed ~62.1Kt); sweep collapsed the map's own `⏳` trace with
the designed one-transaction lag; **~73.1K → ~9.8K**. Full reads (~36Kt) survived
crossing the 25% threshold — the ~40% planning tax of §6 was gone.

### 9.1 Introspection findings

- **Map blind spot**: thinking-only assistant blocks render as `[no text]` with no
  preview — ~1Kt can sit invisible in the tail. A model compressing "its own
  reasoning" must remember thinking is not readable in the map.
- **Misleading receipt wording**: "Numbering above the edited ranges is unchanged"
  was literally false — the next map renumbers units positionally (old #29 became
  #5). Numbering is per-map, not stable IDs. Receipt text fixed.
- **Surface ≠ raw log**: the host elides an attachment envelope (~5.4Kt → 54t) from
  the surface after persisting the file; the log stays append-only. Account for host
  projections when estimating budget.

### 9.2 The runtime-context snapshot flood — root cause was our own counter

The harness dedupes runtime-context snapshots by full text (`retained?.text ===
snapshot → skip`). Stock sections are stable, so stock gets ~one snapshot per policy
change. But the plugin's budget line rendered `~X tokens (Z%)`, **changing every
step**, so dedup never fired. Insertion happens every step (preStep projects context
and appends the snapshot right before the model request — not at turn boundaries).
Empirically: 29 steps → ~27 snapshots (~145t each, ≈3.9Kt total).

The plumbing for supersede existed (snapshots are machine-identifiable via
`source.kind="runtime-context"`; the projection re-projects on replacement) but no
component performed it.

### 9.3 Cache-safe auto-fold → full drop

**The prompt-cache rule (negative knowledge, load-bearing).** Any replacement in the
prefix invalidates the prompt cache from that point on. Therefore:

- Fold superseded snapshots **only at/after the point of the first edit** (the
  earliest replaced node). Before the first edit, touch nothing — burning the whole
  session's cache to save ~145t per snapshot is unacceptable. After the first edit
  the tail is already "dirty", so folding is free.
- **Never touch the newest snapshot** — replacing it forces re-projection → churn.

**Implementation evolution.** Fold markers were later compressed to **full drops**:
drop spans write `content: []` (`source {fold: true, drop: true}`). This is safe
because the host projects empty system/developer/assistant content to `null` — no
wire message at all, position retained. Critical detail: node building switched to
per-event `deriveEventMessage` + skip `null`, because the batch projection
**compacts** nulls, which would have misaligned units. Receipt: `folded: N … →
dropped (0 wire tokens)`. Old fold markers migrate to drops on the first edit.

**Event-payload gotcha:** shapes differ — `user/message` puts `source` directly on
`data`, `developer/message` nests it under `data.message`. Snapshot detection must
handle both (`isSnapshotNode()`).

**Empirics.** 14 model spans + sweep of 8 txn nodes (→4 markers) + fold of 22
snapshots: **96.6K → 11.0K**. Later with drops: 10 spans + 11 drops + 21 migrated
markers: **82.5K → 13.7K, 260 → 55 nodes**; dump-verified no fold marker or superseded
snapshot remained; session alive.

**Also implemented:** superseded snapshots hidden from the map (newest stays — the
live budget counter); footer `hidden from map: N superseded runtime-context snapshots
(~Xt)`; unit numbering keeps gaps; lock range and elision computed over visible units.
A debug surface dump (env `DSH_CLM_DUMP_DIR`, `"off"` disables) writes full-fidelity
surfaces after every map/edit.

**Deferred:** counter quantization (change the budget text only on bucket transitions
so stock dedup revives). Independent change, recorded as an option.

---

## 10. Round 7: eager sweep live, abort confabulation, counter divergence

A live `map → edit → observe` experiment, dissected via a surface dump and GUI
trajectory.

**Confirmed working.**

- **Eager sweep**: the map that planned an edit collapses into a marker *in the same
  transaction* (proof: the fresh marker's seq is newer than all tail nodes but sits
  positionally where the map was; the dump is taken mid-transaction).
- **Planning reasoning lives inside the edit-call node** (one assistant node =
  `[reasoning, tool-call]`, ~700t). The in-flight call can't be swept (pairing); it
  dies with its pair on the *next* successful edit via deferred sweep
  (`PROTECT_TAIL = 4`, a `user msg + map call + map result + snapshot + edit call`
  cycle adds ~5 nodes, so the pair exits the lock zone in time). Lag of exactly one
  cycle, confirmed by receipt (`swept: 6 txn nodes → 3 markers`).
- **Behavioral effect is positive**: with no map on screen and no open task, the
  model felt no urge to re-call the tool. A previous "looping" episode was explained
  by "open task + visible residue in the map + ignored numeric contradiction", not by
  lost state.

**Defects found (by severity).**

1. **Abort confabulation.** The user aborted an edit call; the host rolled back the
   call node tracelessly. The model completed the pattern and reported a successful
   retry with *invented numbers* ("freed ~28.9Kt, 70.1K → 12.3K") anchored on real
   receipts (72.9K from a snapshot, 10.0K from a receipt). An aborted call is
   indistinguishable from "already swept": both are absent nodes.
   **Fixes**: (a) tool description line — "If the tool result is missing or the call
   was aborted, the edit did NOT happen — never narrate outcomes you did not
   receive"; (b) a host-side abort marker at the rollback position (also fixes
   pairing predictably). **Ground truth is only the receipt and the self-edits
   counter.**
2. **Receipt vs host-budget divergence — a planning mine.** Receipts computed
   `after = before − freed` by plugin surface math; the snapshot counts full wire.
   Observed: receipt "→ 45.5K" vs snapshot 59.5K; earlier receipt "→ 10.0K" vs
   snapshot 72.9K. The model saw "59.5K when promised 45.5K", concluded
   "under-compressed", and planned extra edits. **Resolution (later found):** the
   snapshot includes ~18K of system prompt + tool definitions that the map never
   counts — not a plugin bug, but receipts should still recompute `after` honestly
   via `buildNodes` after all sweeps and warn on divergence.
3. **Elided maps are dangerous to edit against.** A 128-unit map with "73 middle
   units elided" led the model to plan spans over invisible units, extrapolating from
   older maps with *different* numbering → it compressed the wrong copy of a debug
   artifact (there were two) → fresh map showed "unclosed volume" → wasted edit.
   **Fix direction**: reject edits referencing elided numbers with a "narrow down
   first" error. Never edit against an elided map.
4. **`shadowedSeqsInRange` positional walk.** Verbatim clones of old units (stuck
   inside persisted old-map results) carry seqs *outside* `[first..last]` of the
   span; a value-range filter missed them → hard fail "missing 397, 451, …". Fixed
   by walking `surface.nodes` by index from the startSeq position to the endSeq
   position. (Lives on as `droppedSeqsInRange` in the TS port.)
5. **`txnSummary` cosmetics**: receipts like "applied 2 edits … folded: 9 …" produced
   markers reading "edit: 10 edits" — misleading when reading a trajectory.
6. **GUI noise**: dropped nodes render as empty "—" rows in session view (0 tokens
   for the model, noise for humans) — filter empty dropped nodes in the web view.
   Non-critical.

**Design decision (for the future engine, host-level):** replace the
"reasoning + edit-call + receipt" pair with a marker **on the next host pre-step**
rather than waiting for the next model edit. Pre-step is the only point where the
pair is complete (pairing valid), the cache under it isn't built yet (cheap
replacement), and ~700t of dead planning reasoning doesn't hang for an extra cycle.

---

## 11. TypeScript migration and the test suite

**Layering (the important architectural decision).**

- `src/core/` — pure logic, **zero runtime imports** (independent of `@deepseek-ai/*`),
  operating against structural interfaces `SessionLike` / `MeterLike` / `SurfaceLike`.
  Real DSH types are type-only imports (erased at compile time).
- `src/integration/plugin.ts` — ctx wiring, surface dumps, tool description/prompt
  section.
- The package stays ESM; the 3-line `index.js` re-exports from `dist/`; the frozen
  809-line JS original is kept as `index.legacy.js` (the reference implementation).

**Session contract (exact).** `append(type, data, {surfaceOp, sourceEventSeqs})`;
`deriveEventMessage(event) → Message | null`; `events: SessionEvent[]`;
`surface.nodes: SurfaceNode[]` — a positional array of event seqs that **holds the
positions of dropped nodes** (drop location found indexOf-style).

**Testing.** Vitest + a `FakeSession` helper implementing the Session contract with
exact replacement semantics (indexOf + slice, coverage validated *before* mutating
the log — throwing the same errors as the real one). **47/47 green** across 7 files:
shadow spans (inverted bounds, past-the-end, empty range, real-drop integration),
edits (atomicity, inverted bounds don't throw, marker gluing, eager path), units
(pairing, null projections, both lock rules), txns (pair detection, all txnSummary
formats, sweep atomicity, dropped tail), snapshots (drop only after first edit,
drop writes empty content not a marker), misc, and full-flow integration replaying
live-session bugs (inverted bounds, eager renumber via delta, sweep exclusion next
to an edit).

**The one real bug found by tests:** `txnSummary` didn't match the live map-summary
format "U units (N nodes)" (old tests expected "U units, N nodes") → markers got a
misleading "other: …" prefix. Fixed with an updated regex plus a legacy fallback.
The other 8 initial failures were bugs in the tests themselves (fake-session seq
arithmetic, JSON `\n` escaping, a cache-prefix guard for prefix insertions, unit
counting).

**Live smoke through `dist/`:** map and edit (4 spans, one freeing ~62.5Kt, snapshots
dropped, eager sweep fired) — both OK.

---

## 12. Cross-cutting invariants (the checklist)

If you change this plugin, re-read these first. Each one was paid for.

1. **Prompt cache is the currency.** Any prefix replacement invalidates cache from
   that point. Reads never mutate the log. All rewrites batch into one atomic
   transaction per trigger. Don't touch anything before the first edit point; never
   touch the newest snapshot.
2. **Units are pair-atomic.** Cutting a call→result pair must stay impossible by
   construction. Any unit straddling the lock boundary is wholly locked. If you add
   node-level addressing back, you reintroduce §5.4/§6.
3. **Edits run against the numbering of the map the model saw.** Numbering is
   per-map, positional, *not* stable IDs. Never reconstruct numbering from memory;
   never edit against an elided or pruned map.
4. **Atomic batches.** One bad range rejects all. Adjacent ranges merge into one
   replacement node whose content comes from the first range — write combined
   replacement text accordingly.
5. **Never mutate tool args** — they arrive deep-frozen. Normalize on copies; build
   all derived structures from those copies.
6. **Ground truth is the receipt and the self-edits counter.** An aborted call leaves
   no nodes and no receipt; absence of evidence is not evidence of success. Never
   narrate outcomes not received.
7. **Replacements carry pointers.** Every replacement text references the files/logs
   its facts came from. User messages and decisions are the last things to edit —
   everything else is re-readable.
8. **Verify versions, not behavior.** Plugin toggles don't reload code; HMR watch
   roots or restart do. Bundle patches need a restart; preset changes affect only
   new sessions (resumed sessions pin their preset revision). Check the registry
   description before dogfooding anything.
9. **The native compactor is the adversary.** It fires at 25% of the window and
   replaces structure with a monolith. Structural compaction must trigger below it
   or displace it — and disabling it removes overflow recovery, so budget must be
   managed *before* the window fills.
10. **The tool's own traces are garbage too.** Map dumps, edit args, and planning
    reasoning die on a one-transaction lag by design (eager where pairing allows,
    deferred otherwise). Idempotence guards (`source.kind` + marker prefix) are
    load-bearing — without them markers re-match and collapse recursively.
11. **Host projections differ.** Event payload shapes vary by event type; batch
    projections compact nulls while per-event derivation preserves them (use the
    latter or units misalign); dropped nodes hold surface positions with zero wire
    tokens.
12. **Snapshot flooding is self-inflicted if your text changes every step.** The
    harness dedupes runtime-context snapshots by exact text. Any per-step-varying
    section defeats it.
