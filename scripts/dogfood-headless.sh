#!/usr/bin/env bash
# Stage-2 headless dogfood runner (compaction-engine.md §4.2 live check).
#
# Usage (from a shell that has KIMI_CODING_API_KEY exported):
#   bash scripts/dogfood-headless.sh
#
# What it does:
#   1. Creates a throwaway workspace /tmp/clm-dogfood with a ~85K-char seed.
#   2. Ensures @local symlinks in the headless profile.
#   3. Boots `dsh headless` with scripts/dogfood-headless.patch.yml: the CLM
#      engine at thresholdRatio 0.08 + the context_edit tool, kimi-coding/k3-256k.
#   4. The task forces a large read; the surface crosses ~21K tokens; the
#      engine opens a transaction and nudges; the model answers with
#      context_edit(compaction: …); the close detector ends the transaction.
#   5. Prints the compaction marker chain from the session log.
#
# The script MUST run against the same harness checkout the engine's
# @deepseek-ai symlinks point at (class identity!) — hence the explicit
# npx-cache path below.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DSH="${DSH_BIN:-/Users/joe/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh}"
WORK=/tmp/clm-dogfood

if [[ -z "${KIMI_CODING_API_KEY:-}" ]]; then
  echo "ERROR: KIMI_CODING_API_KEY is not set in this shell." >&2
  echo "Run from a shell that has it (e.g. the one you start dsh web from)." >&2
  exit 1
fi

mkdir -p "$HOME/.dsh/profiles/headless/node_modules/@local"
ln -sfn "$REPO" "$HOME/.dsh/profiles/headless/node_modules/@local/dsh-clm"
ln -sfn "$REPO/packages/compaction" "$HOME/.dsh/profiles/headless/node_modules/@local/dsh-clm-compaction"

mkdir -p "$WORK"
python3 - <<'EOF'
import pathlib
chapters = []
for i in range(1, 11):
    body = "\n\n".join(
        f"Chapter {i}, section {j}: " + ("The archive describes a system that "
        "edits its own memory while it thinks. Each fold cites what it replaced; "
        "nothing is deleted, only shadowed. " * 40)
        for j in range(1, 6)
    )
    chapters.append(f"# Chapter {i}: The Folded Garden, part {i}\n\n{body}")
pathlib.Path("/tmp/clm-dogfood/seed.txt").write_text("\n\n".join(chapters))
EOF
echo "seed: $(wc -c < "$WORK/seed.txt") chars"

cd "$WORK"
set +e
node "$DSH" headless --patch "$REPO/scripts/dogfood-headless.patch.yml" \
  "Read the file seed.txt in this directory with the read tool (it is long; read it fully), then list the ten chapter titles from memory." \
  > "$WORK/answer.txt" 2> "$WORK/run.log"
status=$?
set -e
echo "== run exit: $status"
tail -5 "$WORK/run.log" || true
echo "== answer (head):"; head -5 "$WORK/answer.txt" || true

echo "== compaction marker chain:"
python3 - <<'EOF'
import glob, json, os, subprocess
dirs = glob.glob(os.path.expanduser("~/.dsh/sessions/*/session-*"))
newest = max(dirs, key=os.path.getmtime)
log = os.path.join(newest, "session.v4.jsonl.zstd")
print("session:", newest)
out = subprocess.run(["zstd", "-dc", log], capture_output=True, text=True).stdout
found = False
for line in out.splitlines():
    try:
        e = json.loads(line)
    except json.JSONDecodeError:
        continue
    t = e.get("type", "")
    d = e.get("data", {})
    if t.startswith("compaction/") or t.startswith("clm/"):
        found = True
        slim = {k: (str(v)[:100]) for k, v in d.items() if k not in ("summary", "rawOutput", "shadowedSeqs")}
        print(f"  seq={e.get('seq')} {t} {json.dumps(slim)[:240]}")
    elif t == "developer/message" and "clm-compaction" in json.dumps(d):
        found = True
        print(f"  seq={e.get('seq')} developer/message [clm-compaction nudge on surface]")
    elif t == "user/message":
        src = (d.get("message") or {}).get("source") or {}
        if isinstance(src, dict) and src.get("kind") == "compact-checkpoint":
            found = True
            print(f"  seq={e.get('seq')} user/message CHECKPOINT source={json.dumps(src)[:160]}")
if not found:
    print("  (no compaction events — the loop did not fire)")
EOF
