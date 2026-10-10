#!/usr/bin/env node
/**
 * gen-preset.mjs — derive the `clm` agent preset from the SHIPPED cordis
 * preset instead of hand-copying it.
 *
 * Why: a preset declaration's `plugins` list is opaque config to the Loader
 * (config is replaced wholesale, never deep-merged), so any preset must
 * carry the full entry list. Hand-copied presets silently rot when dsh
 * updates. This generator reads `@deepseek-ai/dsh-web-app/presets/
 * cordis.patch.yml` from the live harness installation and applies the CLM
 * transform as targeted TEXT splices driven by the YAML AST (node ranges),
 * so everything outside the edited nodes — comments, !!js expressions,
 * literal blocks — stays byte-identical to the source of truth.
 *
 * The transform:
 *   - row id `preset-cordis` → `preset-clm`; config.id `cordis` → `clm`;
 *     config.order 4 → 5; adds display name/description;
 *   - the `compaction` group: basic engine row → `@local/dsh-clm-compaction`
 *     (Stage-1 CLM engine); `command-compact` kept verbatim; the
 *     tool-result-pruner kept but disabled (it middle-truncates context_edit
 *     map dumps and breaks node-id addressing).
 *
 * Usage:
 *   node gen-preset.mjs           regenerate packages/preset/cordis.patch.yml
 *   node gen-preset.mjs --check   exit 1 when the committed file is stale
 *                                 (after a dsh update: re-run without flags)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { findHarnessNodeModules } from "../../../scripts/harness-dir.mjs";

const CHECK = process.argv.includes("--check");
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cordis.patch.yml");

/** Parse tolerant to the Loader's !!js scalars (kept as opaque strings; we
 *  never re-stringify those nodes — splices preserve their source text). */
const JS_TAG = {
  tag: "tag:yaml.org,2002:js",
  identify: () => false,
  resolve: (str) => str,
};

function fail(message) {
  console.error("[gen-preset] " + message);
  process.exit(1);
}

function pairOf(map, key) {
  for (const pair of map.items) {
    if (pair.key && pair.key.value === key) return pair;
  }
  return null;
}

function scalarValueRange(pair) {
  if (!pair || !pair.value || !pair.value.range) fail("expected a scalar pair with a range");
  return pair.value.range;
}

/** Apply [start, end, text] splices to `source`, last-first. */
function splice(source, splices) {
  let out = source;
  for (const [start, end, text] of splices.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

const found = findHarnessNodeModules("dsh-web-app");
if (found === null) fail("harness installation not found (set DSH_RUNTIME_NODE_MODULES)");
const presetPath = join(found.scopeDir, "dsh-web-app", "presets", "cordis.patch.yml");
if (!existsSync(presetPath)) fail("not found: " + presetPath);
const version = JSON.parse(
  readFileSync(join(found.scopeDir, "dsh-web-app", "package.json"), "utf8"),
).version;
const source = readFileSync(presetPath, "utf8");

const doc = parseDocument(source, { customTags: [JS_TAG] });
if (doc.errors.length > 0) fail("YAML parse errors: " + doc.errors.map(String).join("; "));

// Locate the preset row: the single `- insert:` entry holding preset-cordis.
let row = null;
for (const entry of doc.contents.items) {
  const insert = pairOf(entry, "insert");
  if (!insert || !insert.value || !Array.isArray(insert.value.items)) continue;
  for (const candidate of insert.value.items) {
    const id = pairOf(candidate, "id");
    if (id && id.value && id.value.value === "preset-cordis") row = candidate;
  }
}
if (row === null) fail("preset-cordis row not found in " + presetPath);

const config = pairOf(row, "config").value;
const plugins = pairOf(config, "plugins").value;

const splices = [];

// Row id and config head.
splices.push([...scalarValueRange(pairOf(row, "id")).slice(0, 2), "preset-clm"]);
const configIdPair = pairOf(config, "id");
splices.push([...scalarValueRange(configIdPair).slice(0, 2), "clm"]);
const orderPair = pairOf(config, "order");
if (orderPair === null) fail("config.order not found");
splices.push([...scalarValueRange(orderPair).slice(0, 2), "5"]);

// Display name/description: inserted right after the config.id line.
const idLineEnd = configIdPair.value.range[1];
const configIndent = " ".repeat(8); // config map indentation in the shipped file
const descriptionLines = [
  "name: CLM",
  "description: >-",
  "  Cordis development tooling with CLM context management:",
  "  the context_edit self-editing tool and the Stage-1 CLM",
  "  compaction engine instead of compaction-basic.",
];
splices.push([
  idLineEnd,
  idLineEnd,
  descriptionLines.map((line) => "\n" + configIndent + line).join(""),
]);

// The compaction group: swap the engine row, keep command-compact verbatim,
// keep the pruner row but disable it.
let group = null;
for (const item of plugins.items) {
  const id = pairOf(item, "id");
  if (id && id.value && id.value.value === "compaction") group = item;
}
if (group === null) fail("compaction group not found in the preset's plugins");
const groupConfig = pairOf(group, "config").value;

let commandCompact = null;
let pruner = null;
for (const item of groupConfig.items) {
  const id = pairOf(item, "id");
  if (!id || !id.value) continue;
  if (id.value.value === "command-compact") commandCompact = item;
  if (id.value.value === "tool-result-pruner") pruner = item;
}
if (commandCompact === null || pruner === null) {
  fail("command-compact / tool-result-pruner rows not found in the compaction group");
}

// yaml node ranges start AFTER the item's "- ", so the first row's dash
// stays from the source; continuation indentation is the dash column + 2.
const firstLineStart = source.lastIndexOf("\n", groupConfig.range[0]) + 1;
const itemIndent = source.slice(firstLineStart, groupConfig.range[0]).replace(/- $/, "  ");

// Rows reused verbatim: slice their full text (their inner lines already
// carry absolute indentation) and re-anchor the first line at a fresh dash.
const commandText = itemIndent + "- "
  + source.slice(commandCompact.range[0], commandCompact.range[2]).trimEnd();
const prunerText = itemIndent + "- "
  + source.slice(pruner.range[0], pruner.range[2]).trimEnd();

const groupBlock = [
  "- id: clm-compaction",
  itemIndent + "  name: '@local/dsh-clm-compaction'",
  itemIndent + "  # Stage-1 CLM engine (docs/compaction-engine.md §0): behaves like basic;",
  itemIndent + "  # the self-edit loop lands in Stage 2.",
  commandText,
  prunerText,
  itemIndent + "  # Disabled: middle-truncates context_edit map dumps (>8K chars),",
  itemIndent + "  # which breaks node-id addressing.",
  itemIndent + "  disabled: true",
  "",
].join("\n");

splices.push([groupConfig.range[0], groupConfig.range[2], groupBlock]);

const header =
  "# GENERATED by packages/preset/scripts/gen-preset.mjs — do not edit by hand.\n"
  + "# Source: " + presetPath + " (@deepseek-ai/dsh-web-app " + version + ")\n"
  + "# Transform: preset-cordis → preset-clm (id clm, order 5); the compaction group\n"
  + "# runs @local/dsh-clm-compaction (Stage-1 CLM engine) instead of compaction-basic,\n"
  + "# with the tool-result-pruner disabled (it truncates context_edit map dumps).\n"
  + "# Regenerate after a dsh update: npm run gen:preset (staleness check: npm run\n"
  + "# gen:preset -- --check).\n";

const output = header + splice(source, splices);

if (CHECK) {
  const committed = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (committed !== output) {
    fail("packages/preset/cordis.patch.yml is STALE — regenerate with `npm run gen:preset`");
  }
  console.log("[gen-preset] preset is in sync with @deepseek-ai/dsh-web-app " + version);
} else {
  writeFileSync(outPath, output);
  console.log("[gen-preset] wrote " + outPath + " from @deepseek-ai/dsh-web-app " + version);
}
