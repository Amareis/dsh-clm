# Research Background: Context Language Models and DSH

This document distills the research that motivates `dsh-clm`: the Context Language
Models (CLM) paper, and the DSH internals that the plugin builds on. It is written
for contributors and coding agents working on the plugin.

---

## 1. The CLM paper in brief

Source: **Context Language Models** ([arXiv:2609.37725](https://arxiv.org/abs/2609.37725),
[code](https://github.com/facebookresearch/context-language-models)). The reference
implementation is cloned locally at `context-language-models/` (repo root of the
parent research workspace).

Core idea: assign every message/turn an ID, mirror the model's context into a file,
and let **the model itself** maintain order in its own context by editing that file
with ordinary tools — instead of the harness mechanically truncating or summarizing
history.

### 1.1 Formal model

- Ordinary LM: `c_{t+1} = c_t ⊕ f_θ(c_t)` — context is append-only, it only grows.
- CLM: `c_{t+1} = f_θ^CLM(c_t)` — the model itself arbitrarily shapes the next context.

The implementation is deliberately simple: the context is **mirrored into a file**,
the model is given the file path in its system prompt and edits it with ordinary
bash (sed/python/heredoc). Before every model call the harness reads the file back
and parses it into a legal message list.

### 1.2 Context-file format

Each turn is wrapped in a numbered header with a role
(`clm/clm_harness/context_utils/context_string.py` in the reference repo):

```
[[CTX_TURN 1 role=assistant]]
<turn text: reasoning + content + invoked command>

[[CTX_TURN 2 role=tool]]
<command result>
```

Key design decisions:

- **Numbering starts at 1 from the beginning of the editable region** — the system
  prompt and the task statement (the first 2 messages, `protect=2`) never enter the
  file and are protected from edits.
- The `[[CTX_TURN …]]` headers must not be deleted for turns you keep; a turn whose
  body is emptied drops out of context.
- **`parse_back` is tolerant of garbage**: unknown roles fold into `user`, tool-call
  structure is not restored after an edit (history becomes flat role+text), and
  consecutive same-role messages are merged. That is the price of "edit however you
  like" — and the result is always legal for the chat template.

### 1.3 Turn cycle

(`clm/clm_harness/context_env/env.py`, `clm/clm_harness/clm_agent/harness.py`,
`clm/clm_harness/utils/budget.py`)

1. **Mirror**: before every command the harness rewrites the editable context into
   `/tmp/.live_ctx/LIVE_CTX_MAIN.txt`.
2. **Budget check**: deterministic token counting (local tokenizer, not provider
   estimates). Escalation: nudge at 25/50/75% of budget; persistent nudge at the
   limit; on overflow — rollback of the newest turns plus a demand to compact
   (up to N times), then one final turn and stop. **No mechanical truncation** —
   overflow is an event, not a silent loss of the tail.
3. **Command**: the model runs one bash command. To compact context, it edits the
   mirror file.
4. **Read back**: if the file changed — parse back into messages, **edit gate**
   (`fit`: the edit must fit within the limit; `shrink`: the edit must reduce the
   context — `clm/clm_harness/context_env/edit_gate.py`), and the model receives a
   one-line receipt (`edit applied — context ~A->B tokens`). A turn that only edits
   the mirror and prints nothing is **free** (it does not consume a task step).
5. **Finish**: at the step/call limit the model writes its final answer.

### 1.4 Reported results

- Zero-shot CLM beats SOTA context-management strategies: **+11.4% accuracy at
  −21.5% FLOPs** on BrowseComp-Plus; **+5% at −59% FLOPs** on 12-hour EdgeBench;
  **+65% at equal compute** on a 24-hour multi-repo agent swarm.
- Emergent behaviors: trackers/scoreboards for orchestrating subagents, a new role
  `role=notes` for internal notes, reusable compaction functions
  (`def compact_turns(...)`), batched edits via loops.
- **In-context learning**: context-management behavior is steered by a textual
  instruction (SKILL.md in the system prompt), evolved via a loop of
  "run → contrast best vs worst run → N candidates from a proposer model →
  validation on dev tasks → gate (d > SE, or tie + cheaper)". Up to **+35.9 points
  on held-out tasks at lower compute** (`clm/clm_icl/README.md`).
- RL (success-gated efficiency advantage in stepwise GRPO): **+47.6%** on
  Qwen3.5-9B.
- Serving: **Suffix Cache Reuse** — reuse of the KV cache beyond the shared prefix
  (mid-context edits break prefix cache), −35% server compute. Out of scope for
  DSH, but it explains why edits "toward the end of context" are cheaper.

### 1.5 Why it works / the cost

- An edit in the middle of the context **breaks the prefix cache**: everything
  below the edit must be re-read (re-prefill). The system prompt therefore teaches
  the model to batch edits and to remember the tail ("compact cheaply" in
  `clm/clm_harness/clm_agent/prompts.yaml`). In API-provider terms this is a loss
  of the cache-read discount on the tail; in FLOPs terms CLM still wins because
  the context becomes radically smaller.
- Tool-call structure is not preserved across an edit → providers requiring strict
  tool_call/tool_result pairs need an adapter (see §2.2, tool-pairing helpers).

---

## 2. DSH internals relevant to context management

DSH is built on event sourcing: **a session is an append-only event log**, and the
"model context" is a derived projection. This maps unusually well onto CLM.

(Facts below come from a read-only source map of the published npm package
`@deepseek-ai/dsh@0.2.0-rc.2` and its ~250 `@deepseek-ai/*` dependency packages —
readable compiled JS plus full `.d.ts` declarations. Upstream repo:
`github.com/deepseek-ai/deepseek-harness`.)

### 2.1 Session log vs model-visible surface (`dsh-session`)

- `session.append(type, data, { surfaceOp })` commits a typed event; plugins may
  append asynchronously (from a `session/event` listener, a timer, etc.).
- **Surface events** are what the model sees: `system/message`, `developer/message`,
  `user/message`, `assistant/message`, `tool/result`. Everything else is log-only:
  `tool/call`, `turn/start`/`turn/end`, `step/start`/`step/end`, `request/header`,
  `request/context`, telemetry, markers.
- `session.deriveMessages()` is an incremental, cached projection of the log into
  the `Message[]` array sent to the model. **Every request is a pure function of
  the log.**
- **Surface replacement**: `surfaceOp: { op: 'replace', ... }` replaces a range of
  the surface with a new event, citing the shadowed events via `sourceEventSeqs`.
  Shadowed events **stay in the log** — replay is deterministic, nothing is lost,
  everything is auditable. This is exactly the semantics needed for "the model
  edited its own context."
- A second replay-safe edit seam: `session.registerMessageProjection()` — a pure
  plugin-owned projection `(event, ctx) → Map<SessionSeq, Message>` keyed by
  original seq, which changes the content of already-recorded messages.
- `system/message` is surface node 0, protected from replacement (the analog of
  CLM's `protect=2`).
- **Addressing already exists**: every event has a `SessionSeq` (log position —
  the natural per-entry ID), every message has a **`MessageId`** ("stable identity
  carried by one message across inbox, log, and model-request boundaries"), turns
  are numbered with integers (`turn/start { turn }`), and
  `TurnBoundaryProjection` / `dsh-session-turn-outline` provide a turn → seq-range
  mapping.
- The rendered system prompt and `request/header` are also logged → every model
  request is reconstructible from the log (replay).
- Custom event types are declared via declaration merging into `SessionEventMap`
  (`declare module '@deepseek-ai/dsh-session/types'`) plus the `ignorable: true`
  flag for informational records; adding an ordinary event type does **not** bump
  `SESSION_FORMAT_VERSION` (= 4) — it changes only when surface mechanics change.
  An unknown *required* event type fails replay closed (no silent skips).

### 2.2 Existing context management (`dsh-compaction*`)

- `dsh-compaction` — the contract: a backend implements `auto` (by token pressure),
  `onDemand`, and `range` condensation. The result is replacement of the old span
  with a single summary message via surface replacement, plus log-only markers and
  a checkpoint. Durable protocol: `compaction/start` (lock) → `compaction/summary`
  (summary blocks, shadowed range, shadowedTokenCount, model, usage) → a
  `user/message` surface replace with `source: compact-checkpoint` →
  `compaction/end`.
- `dsh-compaction-basic` — the stock backend (`BasicCompactionEngine`): the summary
  is written by a **separate model call** — harness-scheduled summarization, not
  "the same model summarizing itself." This is exactly what CLM replaces. Its sole
  subclass hook `summarize()` is a one-shot `ctx.llm.stream()` call that reuses the
  conversation's own system prompt/tools/messages prefix to preserve the KV cache.
- `dsh-command-compact` — the `/compact` command.
- `dsh-compaction-tool-result-pruner` — model-free deterministic head/middle/tail
  pruning (by Unicode code points) of over-budget tool results via surface replace,
  emitting `compaction/prune` shadow-price events.
- Helpers `toolPairingBalancedBefore/After` (exported from
  `dsh-compaction/tool-pairs`) adjust replacement-span boundaries so tool
  call/result pairs are never split — a ready-made adapter for Anthropic-like API
  constraints.
- Token meter (`ctx.tokenMeter`, `dsh-token-meter`) — heuristic token pricing,
  folds the session log, drives compaction pressure triggers. The context window
  size comes from the adapter and is logged in `request/context`.
- Important framing: existing DSH compaction is "harness-scheduled context
  management" in the paper's terminology — the baseline CLM outperforms. It
  remains useful as a fallback.

### 2.3 Agent loop and extension points (`dsh-agent-loop`, `dsh-agent`)

`ReactLoopAgent`: every request is fully derived from the log —
`preStep()` (inbox → prompt assembly → waterfall) → `buildRequest()`
(`request/header` + `deriveMessages()`, messages deep-frozen) →
`ctx.llm.stream(request)` → tool-call execution (bounded parallel pool, default
max 10) → `tool/result` appended to the surface.

Real seams for a plugin (verified against `.d.ts`; note: a cordis event
`agent/step-started` does **not** exist — step boundaries are log events):

- **`agent/pre-step`** (waterfall, scope-filtered per agent) — the closest analog
  of `beforeModelCall`: runs after prompt assembly, before the step is committed.
  Can reject the step or replace the admitted user-message batch (i.e. deliver a
  nudge/receipt). It **cannot rewrite history** — history comes from the surface.
- **`session/event`** — a cordis event fired on every committed append; filter
  `step/start`/`step/end`, `turn/start`/`turn/end` to catch step and turn
  boundaries.
- **`agent/request`** (waterfall) — last chance to change the request config, but
  not the messages: "model-visible content must use logged channels."
- **`tools/pre-execute`** — allow/deny/ask gate; **`tools/execute`** — around-dispatch
  wrapper (timeout/retry/metrics); **`tools/post-execute`** (waterfall) —
  accept/replace/enrich/block a tool result: this is where `dsh-spill-policy`
  rewrites oversized outputs, and a convenient place to append a CLM receipt to a
  tool result.
- **`agent/turn-stopping`** (serial) — object to turn closure via steering; a
  channel for a persistent nudge. Example reminder plugin: `dsh-repeat-tool-reminder`.
- **`system-prompt/assemble`** (waterfall) — lets plugins rewrite the whole prompt
  assembly (sections, dynamic contexts, tool schemas, variables) per turn.
- Tool registration: `ctx.tools.register(ToolDefinition)` (globally or scoped to an
  agent via `agent.ctx`; schema via `defineTool`; `output.render` maps the result
  to model-facing content).
- Auto-recovery of failed steps already uses surface replacement — the mechanism
  is exercised inside the loop itself.

### 2.4 System prompt and runtime context (`dsh-system-prompt`)

- `ctx.systemPrompt.section({ name, order, text })` — a static or dynamic prompt
  section; agent-scoped registrations override global ones.
- `ctx.systemPrompt.variable(name, fn)` — `{{name}}` variables resolved at every
  assembly (mirror-file path, current budget, edit statistics).
- Sections with `interpolate: false` — for text containing literal `{{…}}` in code
  examples.
- **`PromptContext`s** — dynamic context materialized as a durable **user-role
  snapshot message**; this is how "Current runtime context… supersedes earlier
  snapshots" blocks reach the model. `RuntimeContextProjection`
  (in `dsh-agent-loop`) dedupes/retains the dynamic snapshot; a later snapshot
  from the same producer supersedes an earlier one. `SystemPromptProjection`
  decides append-vs-replace of the system prompt at surface node 0.
- Consequence for a budget counter: **do not put a volatile token counter into the
  system prompt** — node 0 is prefix-cached and any change invalidates the cache
  from the first token. A live counter belongs in the dynamic runtime-context
  snapshot near the tail of history; only stable content (protocol, header format,
  edit policy) goes into the system prompt section.

### 2.5 Other relevant machinery

- `dsh-spill` / `dsh-spill-local` / `dsh-spill-policy` / `dsh-output-retention` —
  multi-layer bounding of large outputs: in-memory cap → spill to a private `0700`
  temp file → `[output truncated; full output: <path>]` → token-budget retention on
  `tools/post-execute` → retroactive `dsh-compaction-tool-result-pruner`. CLM
  complements this: the model can itself decide which other pieces of history to
  send to a file or compress.
- Subagents are **separate sessions** (own logs, own JSONL directories); a
  one-shot run returns only the child's final assistant output to the parent (the
  child's history is not spliced into the parent's surface); a fork
  (`subagent_fork`) seeds the child with a **copy of the parent's event log**
  (`inheritedEventCount` in the header). Multi-agent CLM = one mirror file per
  session.
- `dsh-session-persistence-jsonl` — per-session directory under
  `~/.dsh/sessions/--<slugified-cwd>--/<session-id>/` with
  `session.v4.jsonl.zstd` (header line + zstd-compressed checksummed event frames).
  Resume replays the log into a new `Session`; migrations v0→v4 compose at read
  time. Surface replacements survive resume correctly (the log is append-only).
- Turn boundaries: a turn = one user-wake → model/tool loop until no owed
  response, durably delimited by `turn/start { turn }` / `turn/end`; steps by
  `step/start`/`step/end`. `tool/call` and `tool/result` both carry `{turn, step}`.
  There is no separate per-turn ID namespace — turn numbers plus event seqs are
  the addressing scheme.

---

## 3. How dsh-clm maps onto this

The original research doc evaluated three integration approaches; **approach A
("soft CLM") became this plugin**: a `context_edit` tool the model calls to
replace/compact ranges of the numbered surface, implemented via surface
replacement — the same mechanism DSH compaction uses — instead of a mirror file.
(Approach B was a full mirror-file CLM synced on `agent/pre-step`; approach C was
a CLM backend implementing the replaceable `dsh-compaction` engine contract.)

The mapping onto DSH primitives:

- **Turn IDs** — display numbering over the editable surface; DSH supplies stable
  identity underneath via `SessionSeq` / `MessageId` and turn→seq mapping via
  `TurnBoundaryProjection`.
- **Edits** — appended as `surfaceOp: { op: 'replace', … }` events (shadowed
  events stay in the append-only log: free undo, audit, replay, resume — the
  original CLM has no edit rollback at all), with span edges adjusted by the
  `toolPairingBalancedBefore/After` helpers so tool call/result pairs survive.
- **Protected prefix** — system node 0 plus the fresh tail, the analog of CLM's
  `protect=2`.
- **Budget and nudges** — token pressure measured via `ctx.tokenMeter`; the live
  counter is rendered through the dynamic runtime-context channel (user-role
  snapshot, replaced every step), not the prefix-cached system prompt.
- **Prompt protocol** — the stable edit policy ("compact cheaply", batch edits,
  never drop the user's words) registered via `ctx.systemPrompt.section()` /
  `variable()`.

What approach A deliberately trades away, per the paper's framing, is the
"unrestricted action space" of free-text file editing — the source of the
emergent behaviors (`role=notes`, trackers, `compact_turns()`, ad-hoc batching) —
in exchange for atomic, schema-validated edits and a much smaller diff against
stock DSH. The mirror-file design remains the reference for any future deep
integration.
