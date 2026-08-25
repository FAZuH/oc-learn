#!/usr/bin/env bash
# learn — install the one global-side piece: the md-link TUI module.
#
# Everything else needs NO installation. Clone this repo as a project's
# `.opencode` directory and skills/, agents/, and the plugins (md-link,
# learn-quiz, learn-viz-tools) are discovered automatically.
#
# The TUI module is the exception: v2 does not auto-discover TUI modules, so
# it must be registered in cli.json's plugins array. This script does that.
#
#   ./install.sh                     # register into ~/.config/opencode/cli.json
#   ./install.sh --dir /path/to/cfg  # another config dir
#   ./install.sh --dry-run
#
# Uninstall anytime: ./uninstall.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HOME/.config/opencode"
DRY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) CFG="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)"; exit 1 ;;
  esac
done

TUI_PATH="$REPO/plugins/md-link/tui.ts"
CLI_JSON="$CFG/cli.json"
mkdir -p "$CFG"

if [[ $DRY -eq 0 ]]; then
  python3 - "$CLI_JSON" "$TUI_PATH" <<'EOF'
import json, sys
path, tui = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(path))
except FileNotFoundError:
    cfg = {}
plugins = cfg.setdefault("plugins", [])
if tui in plugins:
    print("  ok      cli.json (tui module already registered)")
else:
    plugins.append(tui)
    json.dump(cfg, open(path, "w"), indent=2)
    print("  added   cli.json plugins[] += md-link tui module")
EOF
else
  echo "  would add $TUI_PATH to $CLI_JSON plugins[]"
fi

cat <<'EOF'

Done. Per-project setup (each learning project):
  git clone <this-repo> .opencode     # skills, agents, plugins auto-load

Restart OpenCode after first install.
Uninstall anytime: ./uninstall.sh
EOF
