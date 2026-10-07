/**
 * dsh-clm — CLM-style context self-editing for the DeepSeek Harness.
 * INTEGRATION LAYER: harness wiring only. All logic lives in ../core/*.
 *
 * Approach A from the context-management README: the model maintains its own
 * context through a dedicated `context_edit` tool instead of waiting for
 * harness-scheduled compaction.
 *
 * Components:
 *  1. `context_edit` tool — `map` renders the numbered model-visible surface
 *     as pair-atomic units; `edit` replaces numbered unit ranges with shorter
 *     model-written text, committed as durable `developer/message` surface
 *     replacements (source.kind === 'dsh-clm'). The event log stays append-only.
 *  2. System-prompt section with the edit policy (when to edit, invariants).
 *  3. Runtime-context budget counter (per-step, superseding snapshot).
 *  4. Snapshot auto-fold + txn sweeps inside each edit (see core docs).
 *  5. Debug dump: full rendered surface written to $DSH_CLM_DUMP_DIR
 *     (default ~/.dsh/clm-dumps/<session-id>/) after map/edit calls.
 *
 * Runtime imports of `@deepseek-ai/*` are impossible in bundle code — every
 * import below is type-only and compiles away; node builtins go through
 * process.getBuiltinModule.
 */
import type { Context } from "@deepseek-ai/cordis";
import { parseArgs } from "../core/args.js";
import { renderBudget } from "../core/budget.js";
import { PLUGIN_NAME, TOOL_NAME } from "../core/constants.js";
import { applyEdits } from "../core/edits.js";
import { formatTokens } from "../core/format.js";
import { renderMap } from "../core/map.js";
import { buildNodes, countEdits } from "../core/nodes.js";
import type { MeterLike, SessionLike } from "../core/types.js";

const name = PLUGIN_NAME;

/** Hard dependencies; systemPrompt and tokenMeter are optional (ctx.inject / ctx.get). */
const inject = ["tools"];

const TOOL_DESCRIPTION = `View and rewrite this conversation's own context. (v8: pair-atomic map units — an assistant message with tool calls plus ALL its tool results is ONE numbered unit, so an edit can never split a call/result pair: prevention at planning time, no auto-extend. op=map is a pure read — stale context_edit transaction traces are marked "⏳ folds on next edit" and superseded runtime-context snapshots are hidden outright (counted in the map footer); both collapse inside the next op=edit (one log rewrite per transaction; snapshots fold only at/after the first edit point — the prompt-cache-clean prefix is never touched). Pure context_edit call+result pairs collapse into one-line markers; in a mixed multi-call node (context_edit sharing an assistant node with other tools) only the stale context_edit result is stubbed in place — the node and the call→result link stay.) When an edit call directly follows its planning map (nothing but runtime-context snapshots between), that map pair collapses IMMEDIATELY in the same transaction; the edit call's own trace collapses on the next edit as usual.

op=map lists the units currently in your context as numbered lines (#N(#a..#b), role, ~tokens, preview) — #N is the unit number, (#a..#b) the original node span it covers. op=edit permanently replaces numbered unit ranges with shorter text you write, freeing context; removed messages stay in the durable session log but leave the model-visible history. Ranges in one call share the most recent map's numbering and are applied highest-first, so earlier numbers stay valid within the call. Adjacent units in one edit merge into a single contiguous span.

Hard constraints: unit #0 (system) and the newest few units (fresh tail) are locked — a unit straddling the lock boundary is wholly locked. In the map, \`[calls: name → result-preview]\` links each tool call to its result inside the unit (\`†\` = result compacted off the surface), and \`⏳ folds on next edit\` marks stale context_edit transaction traces — leave those alone, they collapse automatically. Superseded runtime-context snapshots are hidden from the map (counted in its footer, unit numbers keep gaps where they sit; the newest snapshot stays visible as the live budget counter) and fold automatically inside the next edit once past the first edit point — folding DROPS them (empty replacement, zero wire tokens, no marker); the prompt-cache-clean prefix is never touched. The receipt lists each applied range as \`#N–#M → 1 node (freed ~Xt)\` in unit numbers. After an edit call, replaced spans collapse into single nodes and the next map renumbers units positionally — call map again before planning further edits.`;

const SECTION_TEXT = `## Context self-editing

This session lets you maintain your own context with the \`context_edit\` tool; the runtime budget counter shows live usage. You edit whole numbered units: a unit is either a single message or an atomic call group (an assistant message plus all its tool results) — plan boundaries by units, never inside a group. Edit at natural boundaries: a completed phase or subtask; an artifact superseding its earlier drafts (keep the final, compress the rest); large tool output you have already digested; a mode switch; the counter crossing 50%.

Keep verbatim: the user's original goal, their exact words and decisions; active state you still need (current plan, open questions); exact identifiers, paths, and commands you will reuse; negative knowledge ("X does not work because…"). Make every replacement self-describing about what it compressed, and batch related ranges into one edit call.`;

/** Structural shapes of the harness services this plugin touches — the
 *  harness's ambient service declarations are unavailable to bundle code, so
 *  cordis returns `unknown`; we narrow locally. */
interface ToolsService {
  register(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: { schema: { type: string }; render: (args: unknown, value: string) => Array<{ type: string; text: string }> };
    execute: (args: unknown, exec: { agent?: { session: SessionLike } }) => Promise<string>;
  }): void;
}

interface SystemPromptService {
  section(definition: { name: string; order: number; text: string }): void;
  context(definition: { name: string; order: number; text: (context: { agent?: { session: SessionLike } }) => string }): void;
}

/** Debug dump of the full rendered surface (roles + full node texts) to
 *  $DSH_CLM_DUMP_DIR ("off" disables; default ~/.dsh/clm-dumps/<session-id>/).
 *  surface-latest.md is overwritten every call; edit calls also keep a tagged
 *  copy. Node builtins go through process.getBuiltinModule — bundle code cannot
 *  resolve imports. Best-effort: a debug aid must never break the tool. */
function dumpSurface(session: SessionLike, meter: MeterLike | undefined, tag: string): void {
  try {
    const fs = process.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined;
    const os = process.getBuiltinModule?.("node:os") as typeof import("node:os") | undefined;
    const path = process.getBuiltinModule?.("node:path") as typeof import("node:path") | undefined;
    if (fs === undefined || os === undefined || path === undefined) return;
    const env = process.env?.DSH_CLM_DUMP_DIR;
    if (env === "off") return;
    const dir = env !== undefined && env !== ""
      ? env
      : path.join(os.homedir(), ".dsh", "clm-dumps", String(session.id ?? "session"));
    const nodes = buildNodes(session, meter);
    const total = nodes.reduce((sum, node) => sum + node.tokens, 0);
    const parts = [
      `# dsh-clm surface dump — ${tag} — ${new Date().toISOString()}`,
      `# nodes: ${nodes.length}, ~${formatTokens(total)} tokens`,
      ""
    ];
    for (const node of nodes) {
      const role = node.message?.role ?? node.event?.type ?? "?";
      parts.push(`\n## #${node.index} [${role}] ~${formatTokens(node.tokens)}t (seq ${node.seq})`);
      for (const block of node.message?.content ?? []) {
        // Indent body so markdown headers inside content don't collide with node headers.
        if (block.type === "text") parts.push(`  ${(block.text ?? "").replace(/\n/g, "\n  ")}`);
        else parts.push(`  [${block.type}] ${JSON.stringify(block)}`);
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    const body = parts.join("\n");
    fs.writeFileSync(path.join(dir, "surface-latest.md"), body);
    if (tag !== "map") fs.writeFileSync(path.join(dir, `surface-${tag}.md`), body);
  } catch {
    // debug only — swallow everything
  }
}

function apply(ctx: Context): void {
  const meter = ctx.get("tokenMeter") as MeterLike | undefined;
  const tools = (ctx as unknown as { tools: ToolsService }).tools;

  tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["map", "edit"],
          required: true,
          description: "`map` renders the numbered context surface; `edit` replaces numbered ranges."
        },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "integer", required: true, description: "First unit number to replace, from the most recent map." },
              to: { type: "integer", required: true, description: "Last unit number to replace, inclusive; equals `from` for a single unit." },
              content: { type: "string", required: true, description: "Replacement text: the compressed stand-in for the removed range. Must keep every fact still needed (see the context self-editing policy)." }
            },
            additionalProperties: false
          },
          description: "Required for op=edit. Ranges share the most recent map's numbering and apply highest-first."
        }
      },
      additionalProperties: false
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined) throw new Error("context_edit: no agent session on this call");
      const { op, edits } = parseArgs(args);
      if (op === "map") {
        const map = renderMap(agent.session, meter);
        dumpSurface(agent.session, meter, "map");
        return map;
      }
      const receipt = applyEdits(agent.session, meter, edits!);
      dumpSurface(agent.session, meter, `after-edit-${countEdits(agent.session)}`);
      return receipt;
    }
  });

  ctx.inject(["systemPrompt"], (scoped) => {
    const systemPrompt = (scoped as unknown as { systemPrompt: SystemPromptService }).systemPrompt;
    systemPrompt.section({
      name: "dsh-clm:edit-policy",
      order: 3200,
      text: SECTION_TEXT
    });
    systemPrompt.context({
      name: "dsh-clm:budget",
      order: 130,
      text: (context) => {
        const session = context.agent?.session;
        if (session === undefined) return "";
        try {
          return renderBudget(session, meter);
        } catch {
          return "";
        }
      }
    });
  });
}

export { apply, inject, name };
