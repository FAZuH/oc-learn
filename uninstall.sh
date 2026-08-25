#!/usr/bin/env bash
# learn — uninstaller. Removes symlinks recorded by install.sh, per target.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_CFG="$HOME/.config/opencode"
MANIFEST="$REPO/.learn-links.json"
DRY=0
TARGET=""     # resolved config dir whose links get removed
TARGET_KEY="" # manifest key
MODE=""       # "global" | "project" | "all"

# ── output helpers (colors on TTY only, respect NO_COLOR) ────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  B=$'\e[1m' DIM=$'\e[2m' GRN=$'\e[32m' YLW=$'\e[33m' RED=$'\e[31m' R=$'\e[0m'
else
  B="" DIM="" GRN="" YLW="" RED="" R=""
fi
step()  { printf '\n%s==>%s %s\n' "$B" "$R" "$1"; }
ok()    { printf '  %s✔%s %s\n' "$GRN" "$R" "$1"; }
info()  { printf '  %s·%s %s\n' "$DIM" "$R" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YLW" "$R" "$1"; }
would() { printf '  %s~%s %s\n' "$YLW" "$R" "$1"; }
die()   { printf '%s✗ error:%s %s\n' "$RED" "$R" "$1" >&2; exit 1; }

usage() {
  cat <<EOF
${B}learn — uninstaller${R}
Removes the symlinks install.sh created, based on the manifest at
.learn-links.json (gitignored). Safety rules: a link is removed only if it
is a symlink whose target is inside this repo; anything else is reported
and left untouched.

${B}Usage:${R}
  uninstall.sh -g [options]        clean the global config
  uninstall.sh <project> [options] clean <project>/.opencode
  uninstall.sh --all [options]     clean every tracked target

${B}Options:${R}
  -g                 global config (alias for ~/.config/opencode)
  -a, --all          uninstall every tracked target
  -n, --dry-run      print what would change, change nothing
  -h, --help         show this help

${B}Examples:${R}
  uninstall.sh -g
  uninstall.sh ~/Projects/notes
  uninstall.sh --all --dry-run
EOF
}

[[ $# -gt 0 ]] || { usage; echo; die "nothing to do — pass -g, a project dir, or --all"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    -g) MODE="global"; shift ;;
    -a|--all) MODE="all"; shift ;;
    -n|--dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) usage; echo; die "unknown option: $1" ;;
    *) [[ -z "$MODE" ]] || die "pass only one of -g, a project dir, --all"
       [[ -d "$1" ]] || die "not a directory: $1"
       MODE="project"; PROJECT="$(cd "$1" && pwd)"; shift ;;
  esac
done
case "$MODE" in
  global)  TARGET="$GLOBAL_CFG"; TARGET_KEY="$GLOBAL_CFG" ;;
  project) TARGET="$PROJECT/.opencode"; TARGET_KEY="$TARGET" ;;
  all)     TARGET=""; TARGET_KEY="" ;;
esac

[[ -f "$MANIFEST" ]] || die "no manifest at $MANIFEST — nothing was installed by install.sh"

# Collect the manifest keys to clean.
keys=()
if [[ "$MODE" == "all" ]]; then
  while IFS= read -r k; do keys+=("$k"); done < <(python3 -c "
import json,sys
m=json.load(open('$MANIFEST'))
print('\n'.join(m.keys()))")
  [[ ${#keys[@]} -gt 0 ]] || die "manifest is empty — nothing to uninstall"
else
  keys=("$TARGET_KEY")
fi

for key in "${keys[@]}"; do
  # Read one entry; skip silently if the key vanished between reads.
  ENTRY_JSON="$(python3 - "$MANIFEST" "$key" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
e = m.get(sys.argv[2])
print(json.dumps(e) if e else "")
EOF
)"
  [[ -n "$ENTRY_JSON" ]] || continue

  step "Target $key"
  while IFS= read -r link; do
    [[ -n "$link" ]] || continue
    if [[ $DRY -eq 1 ]]; then
      if [[ -L "$link" && "$(readlink "$link")" == "$REPO"/* ]]; then
        would "unlink $(basename "$link")"
      else
        info "skip $(basename "$link") (not our symlink)"
      fi
      continue
    fi
    if [[ ! -e "$link" && ! -L "$link" ]]; then
      info "already gone: $(basename "$link")"
    elif [[ -L "$link" && "$(readlink "$link")" == "$REPO"/* ]]; then
      rm "$link"
      ok "unlinked $(basename "$link")"
    else
      warn "kept $(basename "$link") — not a symlink into this repo; remove manually if unwanted"
    fi
  done < <(python3 -c "
import json,sys
e=json.loads(sys.argv[1])
print('\n'.join(e.get('links',[])))" "$ENTRY_JSON")

  # cli.json entry: only for the global target, only if it is our path.
  IS_CLI=$(python3 -c "
import json,sys
e=json.loads(sys.argv[1])
print('1' if e.get('cli') else '0')" "$ENTRY_JSON")
  if [[ "$IS_CLI" == "1" ]]; then
    TUI_PATH="$REPO/plugins/md-link/tui.ts"
    if [[ $DRY -eq 1 ]]; then
      would "remove tui module from $key/cli.json"
    else
      python3 - "$key/cli.json" "$TUI_PATH" <<'EOF'
import json, sys
path, tui = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
if tui in cfg.get("plugins", []):
    cfg["plugins"].remove(tui)
    json.dump(cfg, open(path, "w"), indent=2)
EOF
      ok "cli.json — tui module unregistered"
    fi
  fi
done

# ── prune cleaned targets from the manifest ──────────────────────────────────
if [[ $DRY -eq 0 ]]; then
  python3 - "$MANIFEST" "${keys[@]}" <<'EOF'
import json, os, sys
manifest_path = sys.argv[1]
keys = sys.argv[2:]
m = json.load(open(manifest_path))
for key in keys:
    e = m.get(key)
    if not e:
        m.pop(key, None)
        continue
    e["links"] = [l for l in e.get("links", []) if os.path.islink(l)]
    if not e["links"] and not e.get("cli"):
        m.pop(key, None)
    else:
        m[key] = e
json.dump(m, open(manifest_path, "w"), indent=2)
EOF
fi

step "Done"
[[ $DRY -eq 1 ]] && info "dry run — nothing was changed"
exit 0
