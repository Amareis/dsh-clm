# Context Viewer Tab — spec

A third conversation tab (next to Chat and Trajectory) that shows the context
**exactly as the model sees it**, with version history sliced by successful
`context_edit` calls. Pure client-side plugin; zero host changes.

## Status

**Live, TypeScript port** (`packages/viewer` in this repo; bundle
`@local/clm-context-viewer`). The full surface fold + version slicing +
detail panels are implemented in `src/client.ts` (compiled as a script
module — no imports — so the host clientModules service serves it raw).
Originally developed as the standalone `clm-context-viewer/` bundle (plain
JS); moved into this monorepo and ported to TS with the fold domain model
typed. Installed with `plugin_manager install_bundle`; the tab updates in
realtime without a page refresh (dev:web + the live clientModules graph).

Environment gotcha worth keeping: `install_bundle` shells out to `pnpm` from
PATH; when the harness session's PATH is shadowed by a source checkout
(pnpm 11) while the profile was installed with pnpm 10, installs fail with
`ERR_PNPM_UNEXPECTED_STORE`. Fix: set the plugin manager's `pnpmCommand`
config to the profile's original pnpm in the profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: plugin-manager
  config:
    pnpmCommand: /path/to/pnpm   # the one the profile's node_modules was linked with
```

## Why client-only works

The session is event-sourced and the model-visible surface is a pure function
of the durable log — otherwise it could not be reconstructed on resume. Every
rewrite (context_edit transactions, native `compaction/summary`,
`compaction/prune`) is committed as a surface event. The surface protocol is
exported from `@deepseek-ai/dsh-session` and already folded client-side by
`@deepseek-ai/dsh-token-meter` (it powers the GUI's context-pressure counter):

- Surface events are `append` (new node) or `replace` (swap an inclusive seq
  range for new content). Nodes are kept in model-visible order.
- Reference fold: `planSurfaceTokens` / `commitSurfaceTokens`
  (`dsh-token-meter/lib/types/surface-fold.d.ts`) — plan/commit pair,
  validates replacement ranges, throws loud on corruption. The token meter
  stores per-node *prices*; the viewer stores *content* instead (one generic
  parameter different).
- System prompt + tool catalog + request config per step:
  `inspectRequestPrompt(previous, requestHeaderEvent, systemNode)` — pure
  client function from `@deepseek-ai/dsh-client-ui-conversation`
  (`contract/request-inspection.d.ts`), the same one Trajectory uses.

Caveat: a client bundle cannot value-import another *plugin's* module, but
`dsh-token-meter` and `dsh-session` are plain packages — import the fold
directly, or copy ~100 lines.

## Version slicing (the core semantics)

Boundary events, in log order:

1. `tool/call` for `context_edit` with `op: "edit"` → **checkpoint**: snapshot
   the current fold state as the pre-version. (`op: "map"` is read-only — no
   checkpoint.)
2. Transaction events follow (surface `replace` ops, snapshot drops, txn
   markers) — the fold just applies them.
3. `tool/result` for that call:
   - **success** → the fold state at this point becomes **version N+1**.
   - **error** → discard; a failed edit is transactional and mutates nothing.

Also cut versions on native compaction events (`compaction/summary`,
`compaction/prune` replaces) — same protocol, same viewer.

A version is rendered as: full message list (model-visible order, roles +
content) + `inspectRequestPrompt` state (system prompt, tools) at the first
`request/header` after the boundary — the model only "sees" context at steps,
so the first request after an edit *is* the faithful post-edit view.

Versions work post-hoc for any session: page older history in (Trajectory's
`loadOlder` pattern) and fold from the beginning. Note the loaded-window
caveat from `request-inspection.d.ts`: a system node outside the loaded
window reports empty — keep folding from history start to stay exact.

## UI skeleton

Model on `@deepseek-ai/dsh-client-ui-trajectory`, radically simpler:

- Register a `ConversationViewDefinition` into the `conversation.view` slot
  (the slot's occupants are Chat + Trajectory; this adds a third tab).
- Left: version list — index, boundary seq, token delta vs previous version,
  receipt summary for edit versions.
- Right: markdown/message viewer of the selected version; later a diff mode
  between adjacent versions (replaced ranges are known from the fold plans).

## Fidelity deltas (accepted, documented in UI)

- Attachments (images/files) are projected at request-assembly time by route;
  the viewer shows the durable blocks, not the routed projection.
- Heuristic token counts (same fixed estimator as token-meter), not provider
  tokenizer counts.
- Optional later: host-side `@Remote previewNextRequest` assembled by the
  same code path as the real request, as a parity-check mode.

## Dev setup

- Client plugins are discovered by the host `clientModules` service
  (incremental `dsh.client` scan) and served as bundles; the pattern for a
  host package shipping a browser half is Trajectory's "host loader entry for
  the browser-only plugin".
- Client-bundle HMR requires `pnpm run dev:web` running from the DSH checkout
  (the user keeps a pushed checkout for this); without it, client changes
  need a rebuild + page refresh. Host-side changes in this repo keep using
  the existing HMR watch-root setup (AGENTS.md).

## Effort

~1 day MVP (fold + version list + viewer). Diff view, attachments
projection, and the host parity-check are follow-ups.

## Open questions

- Exact plugin-packaging path for contributing a `conversation.view` entry
  from a locally installed bundle (copy Trajectory's manifest shape).
- Whether to share the fold via a small client util package or duplicate it
  (drift risk vs. dependency weight).
- Version storage: in-memory per open session vs. persisted index (fold is
  cheap; in-memory + refold on history page-in is likely enough).
