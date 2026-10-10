#!/usr/bin/env node
/**
 * link-harness.mjs — symlink the harness's OWN @deepseek-ai packages into
 * this repo's node_modules so packages/compaction imports the very module
 * instances the running harness uses.
 *
 * Why: ClmCompactionEngine extends BasicCompactionEngine. If npm installed a
 * second copy, `error instanceof ManualCompactionError` in the harness's
 * dsh-command-compact would fail for errors our engine throws (duplicate
 * class objects). Cordis itself is cross-copy safe (Symbol.for branding), but
 * Error classes are not. Node resolves symlinked packages by realpath, so a
 * symlink into the harness installation yields the SAME module instance.
 *
 * Only packages that packages/compaction imports directly are linked; their
 * own dependencies resolve from the harness's realpath automatically.
 *
 * Wired as the root `postinstall` so npm install recreates the links after
 * pruning node_modules. Re-run `npm run link-harness` after a dsh update.
 */

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findHarnessNodeModules } from "./harness-dir.mjs";

const REQUIRED = ["dsh-compaction", "dsh-compaction-basic"];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scopeDir = join(repoRoot, "node_modules", "@deepseek-ai");

const found = findHarnessNodeModules(REQUIRED[0]);
if (found === null || !REQUIRED.every((pkg) => existsSync(join(found.scopeDir, pkg)))) {
  console.warn(
    "[link-harness] no harness installation found (set DSH_RUNTIME_NODE_MODULES); "
    + "packages/compaction will NOT typecheck or run until the links exist",
  );
  process.exit(0); // not fatal: the core plugin does not need the links
}

mkdirSync(scopeDir, { recursive: true });
for (const pkg of REQUIRED) {
  const target = join(found.scopeDir, pkg);
  const link = join(scopeDir, pkg);
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (stat !== undefined) {
    if (stat.isSymbolicLink()) {
      rmSync(link, { force: true });
    } else {
      console.warn(`[link-harness] ${link} is a real directory (npm-managed) — leaving it in place; `
        + "runtime identity for " + pkg + " is NOT guaranteed");
      continue;
    }
  }
  symlinkSync(target, link, "dir");
  console.log(`[link-harness] @deepseek-ai/${pkg} → ${target}`);
}
