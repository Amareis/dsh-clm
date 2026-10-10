#!/usr/bin/env node
/**
 * harness-dir.mjs — locate the node_modules of the dsh installation the
 * harness actually runs from (shared by link-harness.mjs and the preset
 * generator).
 *
 * Resolution order:
 *   1. DSH_RUNTIME_NODE_MODULES env — absolute path to the harness's
 *      node_modules (the directory containing @deepseek-ai).
 *   2. The newest ~/.npm/_npx/* whose node_modules contains
 *      @deepseek-ai/dsh-web-app (the npx cache the harness runs from;
 *      re-run after a dsh version bump changes the cache hash).
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** @returns {{ nodeModules: string, scopeDir: string } | null} */
export function findHarnessNodeModules(marker = "dsh-web-app") {
  const candidates = [];
  if (process.env.DSH_RUNTIME_NODE_MODULES) {
    candidates.push(process.env.DSH_RUNTIME_NODE_MODULES);
  }
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) {
      candidates.push(join(npx, entry, "node_modules"));
    }
  }
  let best = null;
  for (const nm of candidates) {
    const scopeDir = join(nm, "@deepseek-ai");
    if (existsSync(join(scopeDir, marker))) {
      const mtime = lstatSync(scopeDir).mtimeMs;
      if (best === null || mtime > best.mtime) best = { nodeModules: nm, scopeDir, mtime };
    }
  }
  return best;
}
