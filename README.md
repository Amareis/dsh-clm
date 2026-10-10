# dsh-clm — context self-editing for DSH

A [DSH](https://github.com/deepseek-ai/dsh) host plugin implementing
[Context Language Models](https://arxiv.org/abs/2609.37725)-style context
management: the model maintains its own context through a `context_edit` tool
instead of waiting for the harness to compact it on a schedule.

## What it provides

1. **`context_edit` tool**
   - `op: "map"` — a numbered map of the context surface:
     `#n role ~tokens preview`, with 🔒 marks (node 0 = system prompt, plus the
     current-turn tail), call→result links, fold markers and dropped-snapshot
     positions.
   - `op: "edit"` — replaces numbered unit ranges `{from, to, content}` with
     compressed text written by the model itself. Commits are durable
     `developer/message` nodes with `surfaceOp: {op: "replace"}` and
     `source.kind: "dsh-clm"`: the session log stays append-only (undo and
     session reconstruction are unaffected); only the model-visible surface
     changes. Multiple ranges in one call apply highest-first.
   - Validation: tool_call/tool_result pairs cannot be split (the error says
     how to widen the range), the system node and fresh tail are protected
     (4 nodes + the whole current turn), overlaps and stale numbering are
     rejected. Edit application is atomic: a failing span aborts the whole
     call before any mutation.
2. **Automatic surface hygiene** (runs inside each successful edit)
   - *Transaction sweep*: completed `context_edit` call/result pairs older than
     the protected tail collapse into one-line markers (`[context_edit txn: …]`).
   - *Snapshot fold*: superseded runtime-context snapshots created after the
     first edit are dropped entirely (0 wire tokens, no marker); snapshots
     before the first edit stay untouched to preserve the prompt-cache prefix.
   - *Eager sweep*: when an edit call directly follows the map that planned it
     (nothing between them), that planning pair folds immediately in the same
     transaction instead of waiting one cycle.
3. **Edit-policy prompt section** `dsh-clm:edit-policy` (order 3200): when to
   edit (phase boundaries, superseded artifacts, digested tool output, 70% of
   budget) and what to keep verbatim (user's words, active state, identifiers,
   negative knowledge).
4. **Live budget counter** — runtime-context `dsh-clm:budget` (order 130),
   refreshed every step but re-committed only when the 5%-bucketed text
   changes:
   `context budget: ~15% of 262.1K tokens · self-edits applied: 2`,
   with nudge lines at 70/75/90%. The window is the raw `contextWindow`:
   the provider's completion reserve is provider-specific and unmeasurable
   (measured ≈75K on one route — see docs/self-compaction-log.md), so the
   thresholds carry the safety margin instead of a formula. Token counting
   via `ctx.tokenMeter` (fallback: chars/4).

## Repository layout

This repo is the CLM toolkit monorepo: the `context_edit` plugin at the root
(package `@local/dsh-clm`) plus sibling packages under `packages/`:

- `packages/compaction/` — `@local/dsh-clm-compaction`, the CLM compaction
  engine: `ClmCompactionEngine extends BasicCompactionEngine`
  (approach C, spec in [docs/compaction-engine.md](docs/compaction-engine.md)).
  Stage 2 is live: on pressure the engine opens a `compaction/start`
  transaction and nudges the model, which condenses the span itself via
  `context_edit(compaction: …)` checkpoints (committed as stock
  `compact-checkpoint` user messages with `compaction/summary` metering);
  a missed deadline falls back to the inherited classic path. The
  package imports the harness's OWN modules through symlinks created by
  `scripts/link-harness.mjs` (postinstall) so `instanceof` identity holds.
- `packages/viewer/` — `@local/clm-context-viewer`, the context viewer tab
  (spec in [docs/context-viewer-tab.md](docs/context-viewer-tab.md)): the
  model-visible surface fold + version history, TypeScript port of the
  original `clm-context-viewer` bundle.
- `packages/preset/` — `@local/dsh-clm-preset`, the CLM agent presets —
  **`clm`** (everyday work, derived from the shipped standard preset) and
  **`clm-creator`** (cordis development tooling, derived from the shipped
  cordis preset) — **generated** by
  `packages/preset/scripts/gen-preset.mjs` (never hand-copied — re-run
  `npm run gen:preset` after a dsh update; `npm run check` fails when stale).

## Architecture

```
src/
  core/          pure logic — zero DSH runtime imports; operates on structural
                 interfaces (SessionLike, MeterLike, SurfaceLike)
    types.ts       session/surface/meter contracts + DSH type aliases
    constants.ts   PROTECT_TAIL, MAP_LIMIT, budget thresholds
    nodes.ts       buildNodes (surface projection, in-flight guard)
    map.ts         unit pairing, lock rules, renderMap
    spans.ts       span validation/merge against the planning map
    edits.ts       two-phase applyEdits + finalizeAppliedEdits
    txns.ts        transaction-pair sweep + txnSummary
    snapshots.ts   foldable-snapshot detection + drop
    shadow.ts      dropped-seq accounting for validateSpans
    args.ts        deferred edit-args summary
    budget.ts      live budget counter renderer
    format.ts      token formatting
    preview.ts     one-line content previews, category icons
  integration/
    plugin.ts    Cordis wiring: tool registration, prompt section,
                 runtime-context, surface dumps for debugging
index.js         thin entry re-exporting dist/integration/plugin.js
```

The session contract mirrors `lib/types/session.d.ts`:
`append(type, data, {surfaceOp, sourceEventSeqs})`,
`deriveEventMessage(event) → Message | null`, positional
`surface.nodes: SurfaceNode[]` that keeps slots for dropped nodes.

## Development

```bash
npm install        # dev-only deps + postinstall symlinks to the harness's
                   # own @deepseek-ai packages (scripts/link-harness.mjs)
npm run build      # tsc → dist/ for the plugin AND packages/*
npm test           # vitest: 60 tests, ALL driving real detached dsh-session
                   # Sessions (Session.create + production validation) — no
                   # fakes; test/helpers.ts patches builders onto real Sessions
npm run check      # typechecks src/, test/, packages/* + preset sync check
npm run gen:preset # re-derive packages/preset/cordis.patch.yml from the
                   # installed dsh-web-app preset (after a dsh update)
```

`dist/` is gitignored — run `npm run build` after cloning before installing
the plugin into a profile. If `@deepseek-ai/dsh-compaction-basic` fails to
resolve, the harness symlinks are missing: `npm run link-harness` (set
`DSH_RUNTIME_NODE_MODULES` when the harness is not under `~/.npm/_npx`).

For live development against a running harness, see the **HMR section in
[AGENTS.md](AGENTS.md)** — plugin toggles do not reload code (Node ESM module
cache); you need the `hmr` service watching this directory, or a harness
restart.

## Installing into a DSH profile

Via Plugin Manager (requires approval; affects the whole profile):

```
plugin_manager install_bundle → /path/to/dsh-clm
```

The bundle activates over HMR without a restart. The budget counter appears in
context on the next step; the tool shows up in the tool list.
`cordis.patch.yml` registers the plugin into the profile's existing
composition.

## Limitations

- No `Config` schema yet — tunables are constants in `src/core/constants.ts`
  (`PROTECT_TAIL = 4`, `MAP_LIMIT = 300`).
- Replacement nodes are developer messages — original node roles are not
  preserved (native compaction does the same with the user role).
- Adjacent spans merge into a single replacement node; the merged marker takes
  the first span's content — put the combined summary in the first span.

## Documentation

- [docs/research-background.md](docs/research-background.md) — the CLM paper
  in brief + the DSH internals this plugin builds on.
- [docs/engineering-log.md](docs/engineering-log.md) — dogfooding history:
  what broke, what we learned, why the invariants exist.
- [docs/compaction-engine.md](docs/compaction-engine.md) — **next step**: spec
  for `dsh-clm-compaction` (approach C), a native CLM condensation engine
  implementing DSH's `dsh-compaction` contract with a pressure-trigger
  protocol and fallback to the basic summarizer.
- [docs/context-viewer-tab.md](docs/context-viewer-tab.md) — spec for a GUI
  tab showing the context exactly as the model sees it, with version history
  sliced by successful `context_edit` calls (pure client-side, event-sourced).

## Roadmap

1. **`dsh-clm-compaction` engine** (approach C) — staged plan in
   [docs/compaction-engine.md](docs/compaction-engine.md) §0: ~~Stage 0 CLM
   preset port~~ (generated, `packages/preset`) → ~~Stage 1 engine skeleton
   on the basic path~~ (`packages/compaction`) → ~~Stage 2 the three-phase
   self-edit loop~~ (engine + `context_edit(compaction: …)` checkpoint mode;
   unit-tested, live dogfood pending) → ~~Stage 3 contract edges~~
   (compactRegion holds its promise until close/timeout; overflow-wording
   shim for provider wordings dsh-llm misses) → Stage 4 hardening and A/B
   evaluation.
2. **Context viewer tab** — GUI tab with the model-visible context and
   per-edit version history; spec in
   [docs/context-viewer-tab.md](docs/context-viewer-tab.md). The full fold +
   version slicing is live (`packages/viewer`, TypeScript); diff mode and
   the host parity-check are follow-ups.
3. Host-side pre-step hook: fold a completed `context_edit` pair on the next
   host step instead of waiting for the model's next edit.
4. GUI: filter dropped (empty) nodes from the session trajectory view.
5. Reconcile the receipt's surface math with the host budget counter (the
   counter includes system prompt + tool definitions; the receipt doesn't).
6. Approach B: mirror-file CLM (full paper fidelity) on top of the plugin API.

## Quick check

```
context_edit({op: "map"})
context_edit({op: "edit", edits: [{from: 5, to: 9, content: "…"}]})
```
