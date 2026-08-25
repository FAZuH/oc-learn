#!/usr/bin/env bash
# learn — uninstall the global-side registration (reverse of install.sh).
#
#   ./uninstall.sh                     # clean ~/.config/opencode/cli.json
#   ./uninstall.sh --dir /path/to/cfg
#   ./uninstall.sh --dry-run
#
# Only the cli.json TUI entry is removed. Project-local pieces live inside
# each project's .opencode clone — delete that directory to remove them.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/.config/opencode"
DRY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) CFG="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)"; exit 1 ;;
  esac
done

TUI_PATH="$REPO/plugins/md-link/tui.ts"
CLI_JSON="$CFG/cli.json"
if [[ -f "$CLI_JSON" ]]; then
  if [[ $DRY -eq 1 ]]; then
    echo "  would remove $TUI_PATH from $CLI_JSON plugins[]"
  else
    python3 - "$CLI_JSON" "$TUI_PATH" <<'EOF'
import json, sys
path, tui = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
plugins = cfg.get("plugins", [])
if tui in plugins:
    plugins.remove(tui)
    json.dump(cfg, open(path, "w"), indent=2)
    print("  removed cli.json plugins[] entry")
else:
    print("  ok      cli.json (no tui entry)")
EOF
  fi
else
  echo "  absent  $CLI_JSON"
fi
