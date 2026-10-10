# AGENTS.md — guide for coding agents

This repo is **dsh-clm**, a DSH (DeepSeek Harness) host plugin that lets the
model edit its own context via a `context_edit` tool (map + edit ops), with
automatic transaction sweeping, runtime-snapshot folding, and a live budget
counter.

## Layout

- `src/core/` — pure logic. **No DSH RUNTIME imports allowed here** — bundle
  code cannot resolve `@deepseek-ai/*` at runtime. **Type-only imports are
  used deliberately**: the core is typed directly against the real
  `Session`/`SessionSeq` (`@deepseek-ai/dsh-session`) and brand types
  (`@deepseek-ai/dsh-llm`); they erase at compile time and give compile-time
  coupling to the real API. Runtime values (e.g. the `SessionSeq()` brand
  constructor) must NEVER be called — brand via `asSeq()` (`types.ts`) or
  targeted casts. Loose structural views (`EventShape`, `MessageShape`,
  `ContentBlock`) cover the fields the core reads.
- `src/integration/plugin.ts` — the only Cordis/DSH-aware file: tool
  registration, prompt section, runtime-context, debug surface dumps.
- `index.js` — thin ESM entry re-exporting from `dist/`; the harness loads
  this file.
- `test/` — vitest suite. **No fakes**: `test/helpers.ts`
  (`newTestSession()`) builds a REAL detached `Session`
  (`Session.create()` from `@deepseek-ai/dsh-session`, a devDependency) and
  monkey-patches builder methods onto it, so every test runs through the
  production append validator and surface derivation.
- `docs/` — research background, engineering log (why the code is the way it
  is), the compaction-engine spec (Stages 2+), and the self-compaction
  dogfooding log.
- `packages/compaction/` — `@local/dsh-clm-compaction`, the CLM compaction
  engine (Stage 2: the three-phase self-edit loop — `compactIfNeeded` opens
  a transaction and nudges the model, `context_edit(compaction: …)`
  checkpoints close it, a missed deadline falls back to the inherited basic
  path). **Opposite import rule from the core**: it value-imports
  the harness's OWN `@deepseek-ai/dsh-compaction{,-basic}` through symlinks
  (`scripts/link-harness.mjs`, run by postinstall; set
  `DSH_RUNTIME_NODE_MODULES` when the harness is not under `~/.npm/_npx`) so
  class identity (`instanceof ManualCompactionError`) is preserved. Never
  let npm install real copies of those two packages.
- `packages/viewer/` — `@local/clm-context-viewer` (context viewer tab).
  `src/client.ts` compiles as a SCRIPT (`module: none`, no imports — the
  client loader serves it raw); ambient declarations stand in for
  `require('react')` and the injected services.
- `packages/preset/` — `@local/dsh-clm-preset`. `cordis.patch.yml` is
  **generated** by `packages/preset/scripts/gen-preset.mjs` from the shipped
  cordis preset — never edit it by hand; re-run `npm run gen:preset` after
  a dsh update (`npm run check` fails when it is stale).

## Commands

```bash
npm install
npm run build    # tsc → dist/ for the plugin and packages/* (required after
                 # clone; dist/ is gitignored)
npm test         # vitest run
npm run check    # tsc --noEmit everywhere + preset sync check
npm run gen:preset  # re-derive the clm preset from the installed dsh
npm run link-harness  # recreate the @deepseek-ai symlinks for packages/compaction
```

## Live development (HMR) — read this before touching a running harness

**The trap:** toggling the plugin off/on does **not** reload its code. The
plugin fiber is recreated, but the entry-point import goes through the
process-global Node ESM module cache — every session keeps running the version
that was first imported. An entire dogfooding round was once wasted
"verifying" a fix that had never loaded (see `docs/engineering-log.md` §3).

**What actually reloads code:** only the HMR subsystem invalidates the module
cache, and only for files under its configured watch roots (the defaults
ignore `node_modules` and do not cover a local plugin checkout).

**Setup (once per profile):** enable the `hmr` service and add the plugin's
real directory to its watch roots in the profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`). The base composition ships the
hmr service disabled; the patch flips it on. **The config is per-profile** —
if you run the plugin in another profile (e.g. `headless`), copy the same
block into that profile's patch too; profiles do not share watch roots.

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - .
      - /absolute/path/to/dsh-clm   # this repo; resolved by realpath
```

**Dev loop:** edit `src/` → `npm run build` (or keep `tsc --watch` running) →
chokidar sees the rebuilt `dist/` files → partial reload (cache clear +
dispose/re-instantiate) → **live sessions pick the new code up on the next
step** (tool resolution and system-prompt assembly are per-step). No harness
restart needed. Fallback with a 100% guarantee: restart the harness.

**Verify the version, never the behavior.** After each reload, confirm the
running code before interpreting any test outcome:

```
cordis_inspect_query → host → Tool.listTools → read context_edit's description
```

(Bump a visible marker in `TOOL_DESCRIPTION` when iterating.) Note that tool
names cannot be re-registered over an existing registration — a duplicate-name
throw means an old fiber is still alive; restart in that case.

## Invariants — do not break these

1. **The session log is append-only.** Edits never mutate history; they commit
   `developer/message` nodes with `surfaceOp: {op: "replace"}` +
   `source.kind: "dsh-clm"`, changing only the model-visible surface.
2. **tool_call/tool_result pairs are atomic.** Neither spans nor sweeps may
   ever split them; map units are pair-atomic so numbering can't split them
   either.
3. **Lock rules:** node 0 (system prompt) and the fresh tail (`PROTECT_TAIL`
   nodes + the whole current turn) are uneditable.
4. **Prompt-cache prefix:** runtime-context snapshots *before the first edit*
   are never touched — folding them would invalidate the provider cache and
   reprice the whole session. Snapshots after the first edit fold eagerly.
5. **Edits are atomic across spans:** any failing span aborts the call before
   any mutation (validation runs against the untouched surface).
6. **Dropped-node accounting:** `surface.nodes` keeps slots for dropped nodes;
   span validation must consult positional shadow accounting
   (`src/core/shadow.ts`), never a naive seq filter.
7. **tool/result rewrites are content-only.** The real session's
   `assertToolResultRewrite` deep-compares a tool/result replacement against
   the shadowed original and rejects any change outside `message.content`
   (id, source, toolCallId, turn/step are untouchable). Result stubs must
   keep the original envelope verbatim.

## Testing expectations

Run `npm test` before committing. Tests must cover failure modes, not just
happy paths — the suite exists because live dogfooding kept hitting edge cases
(inverted spans, stale numbering after folds, sweep crashers). See
`docs/engineering-log.md` for the incidents each test family guards against.

## When changing tool behavior

Update all of: the implementation, `TOOL_DESCRIPTION`/`SECTION_TEXT` in
`src/integration/plugin.ts` (the model reads these), the README if
user-facing, and the tests. The model-facing text is part of the feature.
