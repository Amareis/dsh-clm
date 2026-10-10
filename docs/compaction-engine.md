# Design: `dsh-clm-compaction` — a CLM condensation engine for DSH

> **Status: Stage 1 implemented** (`packages/compaction`). Stage 0 (the CLM
> presets) is done as GENERATED declarations (`packages/preset`): `clm`
> (everyday work, from the shipped standard preset) and `clm-creator`
> (cordis dev tooling, from the shipped cordis preset).
> Stage 1 ships `ClmCompactionEngine extends BasicCompactionEngine` with the
> full config surface parsed (`maxWaitSteps`, `overflowMaxWaitSteps`,
> `targetReductionRatio`, `fallback`, `manual`), `manual: 'reject'` honored,
> and behavior otherwise identical to basic. Stage 2 (the three-phase
> self-edit loop, §4.2) is the next milestone.
>
> **Module identity (§5.3 resolved as "real package"):** the engine imports
> the harness's OWN `@deepseek-ai/dsh-compaction{,-basic}` through symlinks
> (`scripts/link-harness.mjs`, wired into postinstall) — Node resolves them
> by realpath into the harness installation, so there is exactly one class
> object and `error instanceof ManualCompactionError` in `dsh-command-compact`
> keeps working. Verified live: engine construction, service registration as
> `ctx.compaction`, and the instanceof check all pass.
>
> This document remains the reference design for Stages 2–4. Approach A —
> the `context_edit` context self-editing tool (the `dsh-clm` plugin in this
> repo) — is already implemented; this document describes **approach C**, a
> native CLM compaction engine implementing DSH's `dsh-compaction` contract.
> In approach C the checkpoint content is produced not by a separate LLM
> summarizer call (as in `dsh-compaction-basic`) but by **the working model
> itself**, through its own `context_edit` edits.
>
> **Staged plan:** §0 below slices the work into demoable milestones; the
> rest of the document is the full reference design.

---

## 0. Implementation stages

The work is sliced so every stage lands in a working, dogfoodable state —
no stage leaves the harness broken. Effort estimates assume an engineer
working with an agent pair.

### Stage 0 — CLM preset port (½ day; self-contained warm-up)

Move the local dogfooding setup into a clean, committed preset patch:
`dsh-clm` enabled, the `compaction` group still on `compaction-basic`,
HMR roots configured, budget counter visible. **Exit criteria:** a fresh
profile boots from the preset, `context_edit` works, `/compact` works via
basic. **Demo value:** shows the composition layer (preset patches,
service isolation groups, HMR) and a live self-edit on a seeded long
session.

### Stage 1 — Engine skeleton, classic behavior (~½–1 day) — ✅ implemented 2026-10-10

`@dsh-experimental/dsh-clm-compaction` package: `class ClmCompactionEngine
extends BasicCompactionEngine`, the full config surface
(`maxWaitSteps`, `targetReductionRatio`, `fallback`, `manual`, …) parsed
but the CLM path not yet active — `compactIfNeeded` behaves exactly like
basic. Swap the single `compaction-basic` entry in the preset group (§5.1).
**Exit criteria:** auto-pressure compaction and `/compact` still work
unchanged with the new backend mounted; config validation errors surface.
**Demo value:** proves service swap = one YAML line, dynamic dispatch of
`compactIfNeeded`, and that the transactional machinery is fully inherited.

### Stage 2 — The CLM loop (the core demo, 1–2 days) — ✅ implemented 2026-10-10 (unit-tested; live dogfood pending)

Implementation notes (deviations from the sketch, all within the design):
- The phase-1 gate copies basic's module-private helpers into
  `packages/compaction/src/basic-copies.ts` (`routedTarget`,
  `resolveTargetPolicy`, `resolveCompactSpec`, `selectCompactableRange`,
  `inspectCompactionEntryState`) — they are not exported from
  `dsh-compaction-basic`, and the loop needs the gate WITHOUT the immediate
  compaction. The fallback delegates to `super.compactIfNeeded` (basic
  re-measures, so pressure already fixed by a param-less edit does not
  double-compact).
- The nudge addresses the span by MAP NODE POSITIONS + first/last node
  previews (the engine cannot know `context_edit` unit numbers — the map
  projection lives in the plugin). `Session.append` accepts the custom
  `clm/compaction-nudge` event type (verified against the real validator);
  the plugin reads the budget back from it — engine↔tool coupling stays
  log-only.
- Re-nudge only on visible progress (the coverage price decreased), never
  under the overflow trigger (every extra node hurts there — §6.6).
- `compactRegion` is NOT overridden yet (Stage 3); the inherited basic
  implementation serves the fallback via `super.compactIfNeeded`.
- Tests: `packages/compaction/test/loop.test.ts` (6 tests — full loop on a
  real detached Session with a structural fake ctx) and
  `test/checkpoint.test.ts` (6 tests — checkpoint mode, adjacency, framing,
  typo rejection).

The three-phase protocol from §4.2 end to end:

1. **Nudge phase:** `compaction/start` + `clm/compaction-nudge` (log-only)
   + the developer/message nudge on the surface (span display numbers,
   budget, deadline). Return `null`.
2. **Self-edit phase:** `dsh-clm` plugin gains the `compaction:` parameter
   (§4.5): user/message checkpoint with
   `source = { kind: 'compact-checkpoint', compactionId, clm: true }`,
   `compaction/summary` emitted immediately before the replace
   (contractual adjacency), rejection when no open transaction matches,
   receipt line with progress toward the budget.
3. **Close phase:** `isCompactEnough` detector (§4.8) on the next
   pre-step → `compaction/end` + `CompactionResult`; on timeout →
   `compaction/end { error: 'clm-timeout' }` → classic fallback via
   `super.compactRegion` (§4.3).

**Exit criteria:** on a seeded long session, crossing the pressure
threshold produces a nudge, the model's own `context_edit(compaction: …)`
lands as a recognized checkpoint, the transaction closes, and a forced
non-responding model (tool disabled) falls back to the classic path.
**Demo value:** this is the interview centerpiece — the working model
compacting itself inside the stock marker protocol, with telemetry/UI
unaffected. **Explicitly out of scope here:** everything in Stage 3+.

### Stage 3 — Contract edges (~1 day) — ✅ implemented 2026-10-10

Implementation notes:
- `compactRegion` (§4.7) opens the same async transaction over the FIXED
  span (basic's validateSurfaceRegion checks copied: positions exist,
  ordered, tool-pairing balanced) and HOLDS the returned promise until the
  close detector fires on a later pre-step (open question 2 resolved as
  sketched: a waiter on the pending entry, settled by closeTransaction /
  settleRegionFallback / the abort listener — no session/event
  subscription needed since the close already runs on pre-steps). Timeout
  or abort fulfills the promise via the classic compaction of the same
  span (super.compactRegion), or rejects it for fallback 'off'/'fail'.
  With another transaction open it throws; outside a turn it defers to the
  classic path (basic would throw there anyway).
- `compactNow` modes and `fallback: 'off'` landed with Stages 1–2.
- Tests: 4 new (fixed-span open + held-promise close; timeout rejection;
  abort rejection with clm-aborted; double-open rejection). 81/81 green.


- `compactRegion` (§4.7): fixed-span protocol; resolve open question 2
  (hold the returned promise until close/timeout via a `session/event`
  subscription).
- `compactNow` (§4.6): `manual: 'basic' | 'reject'` modes through
  `runMaintenance`.
- `fallback: 'off'` mode for clean A/B runs.

**Exit criteria:** `/compact` and explicit-region compaction behave per
config in all modes.

### Stage 4 — Hardening and evaluation (open-ended)

Resolve the open questions (§6) in order of demo impact: 1 (close timing:
pre-step lag vs `session/event` listener), 4 (budget-loop de-escalation
counter), 3 (nudge/auto-recovery race test), 6 (overflow nudge size cap),
8 (UI "awaiting self-edit" marker), 5 (A/B continuability metric),
7 (mirror transport-independence).

---

## 1. The `dsh-compaction` contract (what we implement)

### 1.1 Abstract class

```ts
abstract class CompactionEngine extends Service {  // super(ctx, 'compaction')
  abstract compactIfNeeded(agent: CompactionAgentContext,
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal): Promise<CompactionResult | null>;
  abstract compactNow(agent: ManualCompactAgentContext,
    signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
  abstract compactRegion(start: SessionSeq, end: SessionSeq,
    agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>;
}
```

- Cordis service: `ctx.compaction`, "one implementation per context". Swapping
  the backend = replacing one entry in the YAML composition (see §4).
- `CompactionAgentContext` = `{ session, options: { provider?, model? } }` —
  minimal, with no dependency on the agent package.
- `ManualCompactAgentContext` additionally provides `runMaintenance(task)` —
  serialization of manual compaction against the idle agent's turns
  (implemented in `dsh-agent` runtime types).
- `compactIfNeeded`: `null` means "nothing safe to compress". The
  `context-overflow` trigger may force compression below the normal threshold.
- `compactRegion(start, end, …)`: `start`/`end` are **surface positions**
  (an inclusive span over `session.surface.nodes`), not a numeric seq
  interval: after a replace the visible seqs are non-monotonic, so `start`
  may be greater than `end`. Both edges must be tool-pairing balanced. The
  replacement user message must carry `compactCheckpointSource(compactionId)`.
- `ManualCompactionError` with codes `busy | cancelled | changed | summary |
  commit | persistence` — the expected failure classes of manual compaction.

### 1.2 Lifecycle: markers and events (log-only, not surface)

Declaration merging into `SessionEventMap`:

| Event | Role |
|---|---|
| `compaction/start` | Opens the transaction = **write lock** until `compaction/end`. `turn: number \| null` (`null` — standalone manual compaction between turns). |
| `compaction/summary` | The finished summary + inputs + model-call facts. No surfaceOp. **Contractual adjacency**: the surface replacement follows immediately after — the shadow-price protocol (the consumer reads the span price from the metering event directly preceding the replacement; the same protocol applies to `compaction/prune`). `llmStreamCall: true` + `rawOutput` mark a call made through `ctx.llm.stream`; otherwise it is an "unmarked summarizer". |
| `compaction/end` | Releases the lock; `error?` records failure. |

**Key finding for CLM** (confirmed by the `compactNow` contract): "Context
injected while the summary runs may sit between the marker pair; only the
selected span must remain stable." In other words, a self-edit acting as a
"slow summarizer" is legal: the model's edits may land **between**
`compaction/start` and `compaction/end`.

`CompactionResult` = `{ compactionId, sourceCommandId?, startSeq, summarySeq,
endSeq, summary, shadowedRange, shadowedSeqs, shadowedTokenCount }`.

### 1.3 Helpers

- `toolPairingBalancedBefore(session, seq)` / `toolPairingBalancedAfter(session, seq)`
  — cut balancing over tool_call/tool_result pairs: a fold over the current
  surface (+1 per tool-call block in an `assistant/message`, −1 per
  `tool/result`); the per-session cache is invalidated on
  `surface.replaceGeneration`. Throws on a "corrupt surface" (a `tool/result`
  without an open call). The contract re-exports these from
  `dsh-compaction/tool-pairing`.
- `compactCheckpointSource(compactionId, sourceCommandId?)` — a frozen
  `{ kind: 'compact-checkpoint', compactionId, sourceCommandId? }`; the
  `isCompactCheckpointSource` predicate checks **only**
  `source.kind === 'compact-checkpoint'` (structurally). Registered in
  `MessageSourceMap` via declaration merging — client and UI recognize the
  checkpoint independently of the backend.
- `CompactionId(id)` — a branded string; basic mints it via `randomUUID()`.

### 1.4 Recovery event

`compaction/summary-error` (waterfall): synchronously modify the selected
input after a summarizer failure; returning `true` means progress was made —
the engine will recompute and retry.

---

## 2. The `dsh-compaction-basic` reference (what we reuse and what we replace)

### 2.1 Config and threshold scheduler

- `resolveConfig`: `thresholdRatio` (def 0.8), `headroomTokens` (def 65536),
  `retainRatio` (def 0.16) **xor** `retainTokens`,
  `summarizationProvider/Model` (a pair: both or neither), `maxTokens`,
  `compactionRetries` (def 1), `maxOverflowRetries` (def 1), per-route
  `modelPolicies[]`, `auto` (def true).
- `resolveCompactSpec(policy, contextWindow, reservedCompletionTokens)`:
  `messageBudget = window − reservedCompletion`;
  `pressureBudget = messageBudget − headroom`;
  `thresholdTokens = min(window·thresholdRatio, pressureBudget)`;
  `retainTokens < thresholdTokens` is mandatory. Capacity configuration
  errors raise `TargetPressureConfigError` (warned once per route; the turn
  continues).

### 2.2 Automatic triggers (registered by the engine itself when `auto: true`)

1. `ctx.on('agent/pre-step', …)` → `this.compactIfNeeded(agent, 'pressure',
   signal)` — **dynamic dispatch**: subclass overrides are picked up.
   Errors are logged; the turn continues (`next()`).
2. `ctx.on('agent/request-error', …)` on `CONTEXT_WINDOW_EXCEEDED_CODE` →
   `compactIfNeeded(agent, 'context-overflow', …)`; on success or partial
   progress (growth of `surface.replaceGeneration`) — `{ kind: 'retry' }`;
   retries are bounded by `maxOverflowRetries` (reset on
   `agent/status === 'idle'` / a new `assistant/message`).
3. Before condensing, if `ctx.get('toolResultPruner')` is present — first
   prune old tool results, then re-measure.

### 2.3 Span selection and the transaction

- `selectCompactableRange(session, measurement, retainTokens)`: from the
  first non-system node (the system head at position 0 is protected) down to
  a tail covering `retainTokens`; the left edge slides down until
  `toolPairingBalancedBefore`. Returns `null` when there is nothing to
  compress.
- `compactSurfaceRegion(…)` — the transaction:
  1. `validateSurfaceRegion` (positions, ordering, both edges balanced);
  2. `inspectCompactionEntryState` + `assertCompactionInactive` — a log-tail
     scan: an unmatched `compaction/start` ⇒ `ManualCompactionError('busy')`
     (unless a later `session/end-seed` marks a past lifecycle boundary);
  3. ownership: manual (`owner: null`) requires no open turn; auto must be
     inside a turn;
  4. `session.append('compaction/start', …)` — **locked until first yield**;
  5. `prepareCompaction` (price snapshot + replay input) →
     `summarizeCompaction`;
  6. stability check: auto — `whole-surface` (deep-equal of all metered
     nodes), manual — `selected-span` (the selected span unchanged, external
     additions OK);
  7. `commitCompactionBody` — **no yields between**:
     `compaction/summary` → `user/message` with
     `surfaceOp: { op: 'replace', startSeq, endSeq }`,
     `sourceEventSeqs: [start.seq, summary.seq, ...shadowedSeqs]` →
     `compaction/end`;
  8. any error ⇒ exactly one attempt of `compaction/end { error }`; manual
     errors are classified into `changed/summary/commit`; `flush` (durability
     checkpoint via `ctx.sessions.flush`) only for manual.

### 2.4 The summarizer (the part CLM replaces)

- `summarizeWithLlm`: replay of the conversation prefix (system head + tool
  schemas from `requestHeader` + the span's messages in surface order) + a
  final user message `COMPACTION_INSTRUCTION` (checkpoint structure: Primary
  Request / Key Technical Concepts / Files and Code / Errors and Fixes /
  Pending Jobs / Current Work / Next Step / Critical Context). The verbatim
  system+tools prefix keeps the provider's KV cache warm. Route:
  configured ?? last `requestHeader().config` ?? agent options.
- Shrink check: `estimateMessage(checkpoint) >= shadowedRouteTokenCount` ⇒
  throw.
- Retry loop: on summarizer failure → `compaction/summary-error` waterfall;
  if recovered — recompute `prepareCompaction` and retry.
- The checkpoint is framed: `CHECKPOINT_PREAMBLE` +
  `<compacted-summary>…</…>`,
  `createUserMessage({ content, source: compactCheckpointSource(...) })`.

### 2.5 Customization point

**`summarize(input, agent, signal)` is the only documented subclass hook.**
All transactional machinery (`validateSurfaceRegion`, `prepareCompaction`,
`commitCompactionBody`, the lock, stability, retry) is fixed. This is the
seam for the hybrid (see §5.2).

---

## 3. Engine registration in the runtime

Who consumes `ctx.compaction`:

1. **`dsh-command-compact`** (`/compact`): `ctx.compaction.compactNow(agent,
   signal, commandId)` — the only external caller. Backend-independent
   ("follows whichever compaction service this leaf mounts").
2. **The engine itself** registers the auto-triggers (`agent/pre-step`,
   `agent/request-error`) in its constructor when `auto: true` — there is no
   external scheduler. `compactRegion` is called by the engine from its own
   `compactIfNeeded`/`compactNow`; nothing outside calls it.

How the engine lands in a cordis composition:

- The base host patch declares `compaction-basic`, `command-compact`,
  `tool-result-pruner` (+ pruner config) on the host plane.
- The web-app patch **disables** `compaction-basic` and `command-compact` on
  the host — the token meter stays host-level (process-wide projections),
  while the backend moves into presets.
- The preset patches define an isolated group per preset:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true          # the compaction service is isolated per-preset
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

**Conclusion**: swapping the engine = replacing the single `compaction-basic`
entry with `dsh-clm-compaction` in the preset group. The `compaction: true`
isolation guarantees every agent preset gets exactly one `ctx.compaction`.

Session primitives (`dsh-session`) the design relies on:

- `session.append(type, data, { surfaceOp, sourceEventSeqs })` — for surface
  types (`system|developer|user|assistant/message`, `tool/result`) a
  `SurfaceIntent` is mandatory; `assistant/message` cannot carry
  `sourceEventSeqs` (it embeds a stream).
- `SurfaceOp = 'append' | { op: 'replace', startSeq, endSeq }` — replace
  requires `sourceEventSeqs` to include all shadowed nodes.
- `session.surface: { nodes: readonly SessionSeq[], replaceGeneration,
  contentGeneration }` — a live position snapshot; the generations are
  mutation detectors.
- `session.deriveMessages()`, `session.deriveEventMessage(event)`,
  `session.requestHeader()`, `session.requestContext()`,
  `session.registerMessageProjection()`, `session.toolHistory()`.
- `SESSION_FORMAT_VERSION = 4`; ordinary new event types do not bump the
  version (the `ignorable` guard).

---

## 4. The `dsh-clm-compaction` design

### 4.1 Idea and the key difference from basic

Basic: one auxiliary `ctx.llm.stream()` call writes the summary **inside** a
single transaction while the agent loop waits at `agent/pre-step`. CLM: the
summary is written by **the working model itself** via its own `context_edit`
edits — and that requires the loop to keep stepping between
`compaction/start` and `compaction/end`. The blocking `summarize()` hook is
unsuitable for this: if we waited for the edits inside it, the model would
never get its next step (deadlock). Therefore the engine is an **asynchronous
three-phase protocol on top of the stock markers**, legitimized by the
contract ("context injected while the summary runs may sit between the
marker pair").

### 4.2 The protocol (pressure trigger, inside a turn)

Per-session state: `pending: { compactionId, span {startSeq,endSeq},
baselineTokens, nudgeSeq, startedAtStep, attempts }`.

1. **"Select + nudge" phase** (`compactIfNeeded`, pre-step, pressure/overflow
   trigger):
   - same threshold policy as basic (threshold/retain/prune — reused);
   - `selectCompactableRange` → span; if `null` → return `null`;
   - `session.append('compaction/start', { compactionId, turn })` — lock;
   - `session.append('developer/message', …)` — a **nudge** on the surface:
     the target span (by the `context_edit` map's display numbers), the
     `compactionId`, a budget ("shrink nodes #a–#b from ~X to ≤ Y tokens"),
     a deadline ("within N steps");
   - return `null` (the condensation is not finished yet — honest per the
     contract: the result will appear later; basic's pre-step listener only
     logs a non-null result).
2. **Self-edit phase** (ordinary agent steps): the model calls
   `context_edit({ op: 'edit', edits, compaction: '<compactionId>' })`. The
   `dsh-clm` plugin (modification in §4.5) commits the replacements with
   `source: { kind: 'compact-checkpoint', compactionId, clm: true }` and,
   **immediately before each replacement**, emits a log-only
   `compaction/summary` (see §4.4): the contractual adjacency
   "metering event → replace" (the shadow-price protocol) is preserved.
3. **"Sufficiency detection + close" phase** (the next pre-step of the same
   engine):
   - `tokenMeter.measure(session)`; the span counts as sufficiently compact
     when the target nodes have been replaced by checkpoint nodes carrying
     our `compactionId`, the total span price is ≤ the target budget (a
     fraction of `baselineTokens`, config `targetReductionRatio`, def 0.5)
     **and** the edges remain tool-pairing balanced;
   - yes → `session.append('compaction/end', { compactionId, turn })`,
     assemble and return the `CompactionResult` (startSeq/summarySeq/endSeq
     from the log, summary = concatenation of the checkpoint texts,
     shadowed* from the recorded summary events);
   - no → if `maxWaitSteps` (def 3) has not expired — return `null` and keep
     waiting.
4. **Timeout / abort** → fallback (§4.3).

For `context-overflow` the protocol is the same, but `maxWaitSteps` is
smaller (def 1): overflow demands progress before the request retry; if the
model has not compressed within one step — an immediate fallback to
classic-summary so that `agent/request-error` gets `{ kind: 'retry' }` with a
real `replaceGeneration` growth.

### 4.3 Fallback to basic behavior

On timeout, explicit abort (`signal.aborted`), or a span-stability violation:

1. `session.append('compaction/end', { compactionId, turn, error:
   'clm-timeout' })` — release the lock (the failure is visible in the log,
   as the contract requires).
2. Run the same span (revalidated with a `validateSurfaceRegion` equivalent)
   through the **classic path**: one-shot replay-summarize à la
   `summarizeWithLlm` (the same `COMPACTION_INSTRUCTION` or a shortened
   variant) → `compaction/summary` (`llmStreamCall: true`) → replace →
   `compaction/end`. Effectively this is a second engine inside the first;
   implement it via inheritance (§5.2) or by composing copied basic
   functions (bundle without imports, see §5.3).
3. Escalation policy is configurable: `fallback: 'basic' | 'fail' | 'off'`
   (`off` — CLM-only mode for clean A/B runs: after the timeout just
   `compaction/end { error }` and `null`).

### 4.4 Events

The contractual `compaction/start|summary|end` are fully reused — telemetry,
UI, and `compaction/summary-error` keep working unchanged. Filling
particulars:

- `compaction/summary` on self-edit is committed **by the dsh-clm plugin**
  (it performs the replace): `summary` = the edit text, `provider/model` =
  from `session.requestHeader().config` (the working route), **without**
  `llmStreamCall` ("unmarked summarizer" — a stock branch of the type),
  `rawOutput` optionally empty. `shadowedSeqs/shadowedTokenCount` — for the
  edit's replaced range.
- Binding to the transaction: the `compactionId` in the checkpoint's
  `source` and in the summary event.
- Additionally a log-only `clm/compaction-nudge { compactionId, span,
  budgetTokens, deadlineStep }` (`ignorable: true`) — an audit trail of
  "what we asked to compress". A new ordinary event type;
  `SESSION_FORMAT_VERSION` is not bumped.

### 4.5 `dsh-clm` plugin changes (the `context_edit` tool)

1. Optional call parameter: `compaction: '<compactionId>'` — the "edit
   inside a compaction transaction" mode:
   - the replacing message is a `user/message` (not `developer/message`)
     with `source = { kind: 'compact-checkpoint', compactionId, clm: true }`
     — `isCompactCheckpointSource` recognizes it structurally, the UI marks
     it as a checkpoint;
   - immediately before the replace — `session.append('compaction/summary',
     …)` (adjacency!);
   - framing with a `CHECKPOINT_PREAMBLE` equivalent so the checkpoint reads
     as "installed background".
2. Reject `compaction` edits when the log has no unmatched `compaction/start`
   with that id (protection against model typos; the same tail inspection as
   `inspectCompactionEntryState`).
3. The receipt gains a line "compaction \<id\>: span ~X → ~Y tokens, target
   ≤ Z" so the model sees progress toward the budget.
4. Without the `compaction` parameter the tool behaves as it does today
   (approach A).

### 4.6 `compactNow` (manual `/compact`)

Manual compaction runs on an idle agent — the working model **is not
generating**, so self-edit is impossible. Options (config `manual: 'basic' |
'reject'`, def `'basic'`):

- `'basic'`: an honest classic-summary via `runMaintenance` (like basic) —
  `/compact` always works;
- `'reject'`: `ManualCompactionError('summary', 'clm engine compacts only
  inside working turns')` — for pure experiments.

### 4.7 `compactRegion` (explicit span)

The same protocol as §4.2, but the nudge carries an exact seq→display-number
range instead of auto-selection; the edges are validated with
`toolPairingBalancedBefore/After` before nudging. We do not require
`whole-surface` stability: the model's edits are the expected mutation — we
only check that the **target span positions** are covered by our checkpoints
and that system node 0 is untouched.

### 4.8 The "compressed enough" detector (closing criteria)

All conditions are mandatory:

1. ≥1 checkpoint node with our `compactionId` on the surface;
2. the total heuristic price of the nodes covering the span's original
   positions ≤ `baselineTokens · targetReductionRatio`;
3. `toolPairingBalancedBefore/After` on the span edges — true (the edits did
   not cut any pair — `context_edit` already guarantees this via its gate);
4. the fresh tail (the last `PROTECT_TAIL` nodes) is not inside the span.

On partial progress (the span shrank but is still above budget) — re-nudge
with a refined budget, `attempts++`; the attempt limit is part of
`maxWaitSteps`.

---

## 5. Implementation

### 5.1 Package and registration

```
dsh-clm-compaction/
  package.json        # @dsh-experimental/dsh-clm-compaction
  index.js            # ClmCompactionEngine + apply/inject/name
```

In the preset (`presets/*.patch.yml`), inside the `compaction` group, replace:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
# →
- id: clm-compaction
  name: '@dsh-experimental/dsh-clm-compaction'
  config:
    auto: true
    maxWaitSteps: 3
    overflowMaxWaitSteps: 1
    targetReductionRatio: 0.5
    fallback: basic        # basic | fail | off
    manual: basic          # basic | reject
```

`command-compact` and `tool-result-pruner` stay — the former calls our
`compactNow`, the latter is called by us before span selection (as in basic).

### 5.2 Plugin skeleton (code)

```js
/**
 * dsh-clm-compaction — CLM compaction backend: the working model writes
 * checkpoints via its own context_edit calls between compaction/start and
 * compaction/end; falls back to classic one-shot summarization on timeout.
 */
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { CompactionId, ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { randomUUID } from "node:crypto";

const name = "dsh-clm-compaction";

class ClmCompactionEngine extends BasicCompactionEngine {
  /** Per-session pending self-edit transactions. */
  pending = new WeakMap(); // Session → { compactionId, span, baselineTokens, deadlineStep, turn }

  /**
   * Pressure/overflow: open the marker, nudge the model, return null;
   * close on a later pre-step when the span is compact enough.
   */
  async compactIfNeeded(agent, trigger, signal) {
    const session = agent.session;
    const pending = this.pending.get(session);

    if (pending !== undefined) {
      if (this.isCompactEnough(session, pending)) {
        const result = this.closeTransaction(session, pending);
        this.pending.delete(session);
        return result;                 // phase 3: close, CompactionResult
      }
      if (this.expired(pending, trigger)) {
        this.pending.delete(session);
        session.append("compaction/end", {
          compactionId: pending.compactionId, turn: pending.turn,
          error: "clm-timeout: self-edit did not reach the budget in time",
        });
        return this.fallbackCompact(agent, trigger, signal); // §4.3
      }
      return null;                     // phase 2: waiting for the model's edits
    }

    // Phase 1: span selection via basic policy, lock + nudge, return null.
    if (!this.pressureExceeded(agent, trigger)) return null;   // threshold/prune as in basic
    const range = this.selectRange(agent, trigger);            // selectCompactableRange equivalent
    if (range === null) return null;
    const compactionId = CompactionId(randomUUID());
    const turn = this.openTurn(session);                       // inspectCompactionEntryState equivalent
    session.append("compaction/start", { compactionId, turn });
    session.append("clm/compaction-nudge", {
      compactionId, span: range, budgetTokens: this.budgetFor(range),
      deadlineStep: this.currentStep(session) + this.maxWaitSteps(trigger),
    }, { ignorable: true });
    this.nudge(agent, compactionId, range);                    // developer/message on the surface
    this.pending.set(session, {
      compactionId, span: range, baselineTokens: this.priceSpan(session, range),
      deadlineStep: this.currentStep(session) + this.maxWaitSteps(trigger), turn,
    });
    return null;
  }

  /** Explicit span: same async protocol with a fixed range. */
  async compactRegion(start, end, agent, signal) {
    this.assertBalanced(agent.session, start, end);            // toolPairingBalanced*
    // …open the transaction with the fixed span, nudge with exact display numbers…
    // Result commit on the next pre-step (see compactIfNeeded), or
    // waiting via a turn-boundary listener (see Open Questions, item 2).
  }

  /** Manual /compact on an idle agent: the model is not running → classic path. */
  compactNow(agent, signal, sourceCommandId) {
    if (this.config.manual === "reject")
      throw new ManualCompactionError("summary",
        "clm engine compacts only inside working turns");
    return super.compactNow(agent, signal, sourceCommandId);   // basic behavior
  }

  /** Classic fallback: one-shot replay summarizer of the parent class. */
  fallbackCompact(agent, trigger, signal) {
    if (this.config.fallback === "off") return null;
    const range = this.selectRange(agent, trigger);
    if (range === null) return null;
    return super.compactRegion(range.start, range.end, agent, signal);
  }
}

function apply(ctx) {
  // Service registration: inheritance gives us super(ctx, 'compaction') + the
  // auto-triggers (agent/pre-step, agent/request-error) with dynamic dispatch
  // of compactIfNeeded — our override is picked up.
  ctx.plugin(ClmCompactionEngine, ctx.get("config") ?? {});
}

export { apply, name };
export default ClmCompactionEngine;
```

### 5.3 Bundle-vs-package limitation

The `dsh-clm` plugin (approach A) is a bundle without imports (`@deepseek-ai/*`
does not resolve). For `dsh-clm-compaction` that means: **either** a real npm
package next to `dsh-compaction-basic` (inheritance + contract imports —
preferred, all transactional machinery is reused), **or** a bundle copying
~300 lines from basic (config, `selectCompactableRange`,
`compactSurfaceRegion`, `summarizeWithLlm`) and implementing `class extends
Service` with a manual `super(ctx, 'compaction')`. The design above assumes
a package; the bundle variant is plan B.

Coupling with `dsh-clm`: the engine and the tool communicate **only through
the log** (`compaction/start` + nudge → `context_edit(compaction: id)` →
`compaction/summary` + replace), with no direct calls — both can be enabled
independently (the engine without the tool will always fall back on timeout).

---

## 6. Open questions

1. **When to close the transaction.** Closing on the next `pre-step`
   introduces a one-step lag: the model's edit enters the very request that
   initiates the close. That is safe (the replacement is already in the
   log), but it is worth checking whether the simultaneous presence of the
   nudge and the model's own checkpoint confuses the model. An alternative
   is a `session/event` listener that closes the transaction immediately
   after the checkpoint replace.
2. **`compactRegion` — synchronous contract, async reality.** The contract
   returns `Promise<CompactionResult>`; our path resolves several steps
   later. Who waits? Today only the engine itself calls `compactRegion`
   (from the pressure path) and no external code was found — but API callers
   may appear. An option: `compactRegion` holds the promise until
   close/timeout (with an AbortSignal), using a `session/event`
   subscription instead of waiting for pre-step.
3. **Nudge vs auto-recovery race.** Recovery of failed steps also performs a
   surface replace inside a turn — between our markers. Stability is checked
   only on the target span, but a test for co-triggering is needed.
4. **The budget loop.** If the model systematically fails to shrink the
   span, every "nudge → timeout → fallback" cycle costs extra steps and
   tokens. A per-session failure counter and de-escalation are needed: after
   K consecutive timeouts — only the basic path until the end of the session
   (analogous to `warnedPressureConfigTargets`). **Shipped 2026-10-10**:
   `deescalateAfter` (default 3) counts CONSECUTIVE automatic-path timeouts
   per session; at the limit the engine delegates straight to
   `super.compactIfNeeded`, and a successful close resets the counter.
5. **Self-checkpoint quality vs classic-summary.** A CLM checkpoint is
   written by the model "about itself" in its working context — expected to
   be better on relevance (it knows what it will need) but worse on
   structure (no rigid template). A/B metric: task continuability after
   condensation.
6. **`context-overflow` and the step budget.** The nudge is a
   developer/message on the surface and itself grows the context under
   overflow. Keep the nudge ≤ ~300 tokens; on a repeated overflow fall back
   immediately.
7. **Compatibility with approach B (mirror).** If a mirror file appears, the
   nudge may ask for a mirror edit instead of `context_edit`; the marker
   protocol does not change — only the summarizer's "hand" does. The engine
   should be designed transport-independent: detection by checkpoint nodes,
   not by the editing mechanism.
8. **UI.** Checkpoints with `kind: 'compact-checkpoint'` are already
   recognized; it is worth showing an "awaiting self-edit" state (between
   start/end) as a live marker, analogous to the compaction indicator.
9. **Provider overflow wording (found by dogfooding, 2026-10-10).** Kimi's
   400 `"Your request exceeded k3-256k model token limit: 262144"` is NOT
   recognized by `isContextWindowExceededError` in `dsh-llm` (checked live:
   returns `false`), so it surfaces as INVALID_REQUEST and the
   `agent/request-error` overflow-recovery listener never fires — **even
   `dsh-compaction-basic` has no recovery on this route**. Harness-level
   fix: extend the regex family with `request exceeded … model token
   limit`. **Engine-side shim shipped 2026-10-10** (`overflowWording:
   'shim' | 'off'`, default 'shim'): the CLM engine registers an inner
   `agent/request-error` listener that recognizes the missed wording and
   runs the standard growth-gated retry flow through its own
   `compactIfNeeded`; already-classified failures pass through to basic.
   Every stock pattern requires the literal word "context", which Kimi
   never says — the shim pattern matches `request exceeded … model token
   limit` instead.
