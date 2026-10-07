# AGENTS.md — guide for coding agents

This repo is **dsh-clm**, a DSH (DeepSeek Harness) host plugin that lets the
model edit its own context via a `context_edit` tool (map + edit ops), with
automatic transaction sweeping, runtime-snapshot folding, and a live budget
counter.

## Layout

- `src/core/` — pure logic. **No DSH runtime imports allowed here** (type-only
  aliases in `types.ts` are the single exception; they erase at compile time).
  Everything operates on structural interfaces (`SessionLike`, `MeterLike`,
  `SurfaceLike`).
- `src/integration/plugin.ts` — the only Cordis/DSH-aware file: tool
  registration, prompt section, runtime-context, debug surface dumps.
- `index.js` — thin ESM entry re-exporting from `dist/`; the harness loads
  this file.
- `test/` — vitest suite with `FakeSession` (`test/helpers.ts`) implementing
  the real session's `replacementRange` semantics.
- `docs/` — research background, engineering log (why the code is the way it
  is), and the compaction-engine spec (next milestone).

## Commands

```bash
npm install
npm run build    # tsc → dist/  (required after clone; dist/ is gitignored)
npm test         # vitest run
npm run check    # tsc --noEmit
```

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

## Testing expectations

Run `npm test` before committing. Tests must cover failure modes, not just
happy paths — the suite exists because live dogfooding kept hitting edge cases
(inverted spans, stale numbering after folds, sweep crashers). See
`docs/engineering-log.md` for the incidents each test family guards against.

## When changing tool behavior

Update all of: the implementation, `TOOL_DESCRIPTION`/`SECTION_TEXT` in
`src/integration/plugin.ts` (the model reads these), the README if
user-facing, and the tests. The model-facing text is part of the feature.
