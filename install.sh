#!/usr/bin/env bash
# learn — installer. Symlinks repo items into an OpenCode config dir.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_CFG="$HOME/.config/opencode"
MANIFEST="$REPO/.learn-links.json"
DRY=0
FORCE=0
TARGET=""    # resolved config dir links are created in
TARGET_KEY="" # manifest key: the config dir for -g, the project .opencode otherwise
MODE=""      # "global" | "project"

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
${B}learn — installer${R}
Symlinks this repo's items (skills, agents, plugins, lib) into an OpenCode
config dir, so one repo copy serves every project. Nothing is copied; edits
here apply everywhere after a restart.

${B}Usage:${R}
  install.sh -g [options]        install globally (~/.config/opencode)
  install.sh <project> [options] install project-level (<project>/.opencode)

${B}Options:${R}
  -g                 global config (alias for ~/.config/opencode)
  -f, --force        install even if another location already has these items
  -n, --dry-run      print what would change, change nothing
  -h, --help         show this help

${B}Notes:${R}
  - Existing files that are not our symlinks are left untouched.
  - Created links are tracked in .learn-links.json (gitignored);
    uninstall.sh removes exactly those.
  - Global installs also register the md-link TUI module in cli.json
    (the only piece v2 cannot auto-discover).
  - Do NOT install the same repo into global AND a project that loads it:
    OpenCode would register the same plugin ids twice and hang. install.sh
    refuses that combination unless --force is given.

${B}Examples:${R}
  install.sh -g                        # into ~/.config/opencode
  install.sh ~/Projects/notes          # into ~/Projects/notes/.opencode
  install.sh -g --dry-run              # preview
EOF
}

[[ $# -gt 0 ]] || { usage; echo; die "nothing to do — pass -g or a project dir"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    -g) MODE="global"; shift ;;
    -f|--force) FORCE=1; shift ;;
    -n|--dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) usage; echo; die "unknown option: $1" ;;
    *) [[ -z "$MODE" || "$MODE" == "project" ]] || die "pass either -g or a project dir, not both"
       [[ -d "$1" ]] || die "not a directory: $1"
       MODE="project"; PROJECT="$(cd "$1" && pwd)"; shift ;;
  esac
done
if [[ "$MODE" == "global" ]]; then
  TARGET="$GLOBAL_CFG"; TARGET_KEY="$GLOBAL_CFG"
else
  TARGET="$PROJECT/.opencode"; TARGET_KEY="$TARGET"
fi

# ── validation ────────────────────────────────────────────────────────────────
# 1. Never link into the repo itself (e.g. ./install.sh . would write through
#    a .opencode symlink back into the tree being linked from).
case "$TARGET" in
  "$REPO"|"$REPO"/*) die "target is inside the repo ($REPO) — pass a project dir or -g" ;;
esac

# 2. Plugin ids are unique per OpenCode session. If these plugins are already
#    linked into another config root that can load alongside this one — global
#    plus a project that loads it, or the repo's own .opencode — OpenCode
#    registers the same ids twice and the TUI hangs. Refuse unless --force.
if [[ $FORCE -ne 1 && -f "$MANIFEST" ]]; then
  conflict="$(python3 - "$MANIFEST" "$TARGET_KEY" "$MODE" "$GLOBAL_CFG" <<'EOF'
import json, sys
manifest_path, key, mode, global_cfg = sys.argv[1:5]
try:
    m = json.load(open(manifest_path))
except Exception:
    m = {}
others = [k for k, v in m.items() if k != key and v.get("links")]
if mode == "global":
    dangerous = others            # any project install collides with global
else:
    dangerous = [k for k in others if k == global_cfg]
print("\n".join(dangerous))
EOF
)"
  if [[ -n "$conflict" ]]; then
    die "this repo is already installed at:
$conflict

OpenCode would load the same plugin ids from both locations and hang.
Uninstall the other location first (./uninstall.sh …) or pass --force."
  fi
fi

# ── repo items to link, relative to the repo root ────────────────────────────
items=()
for top in agents skills plugins lib; do
  for child in "$REPO/$top"/*; do
    [[ -e "$child" ]] && items+=("$top/$(basename "$child")")
  done
done
[[ ${#items[@]} -gt 0 ]] || die "no items found in $REPO"

step "Config"
info "repo     $REPO"
info "target   $TARGET ($([[ $MODE == global ]] && echo global || echo project-level))"
[[ $DRY -eq 1 ]] && info "${B}dry run${R} — nothing will be changed"

# ── prune stale links: tracked symlinks whose repo item was renamed/removed ──
if [[ -f "$MANIFEST" ]]; then
  step "Prune stale links"
  LEARN_DRY=$DRY python3 - "$MANIFEST" "$TARGET_KEY" "$REPO/" <<'EOF' | while IFS= read -r link; do
import json, os, sys
manifest_path, key, repo_prefix = sys.argv[1:4]
dry = os.environ.get("LEARN_DRY") == "1"
try:
    m = json.load(open(manifest_path))
except Exception:
    raise SystemExit
e = m.get(key)
if not e:
    raise SystemExit
kept = []
for link in e.get("links", []):
    if os.path.islink(link) and os.readlink(link).startswith(repo_prefix) and not os.path.exists(link):
        if not dry:
            os.unlink(link)
        print(link)
    else:
        kept.append(link)
e["links"] = kept
m[key] = e
json.dump(m, open(manifest_path, "w"), indent=2)
EOF
    [[ -n "$link" ]] || continue
    if [[ $DRY -eq 1 ]]; then
      would "prune stale $(basename "$link")"
    else
      ok "pruned stale $(basename "$link")"
    fi
  done
fi

step "Linking ${#items[@]} items"
created=0
for rel in "${items[@]}"; do
  src="$REPO/$rel"
  dst="$TARGET/$rel"
  mkdir -p "$(dirname "$dst")"
  if [[ -L "$dst" ]]; then
    if [[ "$(readlink "$dst")" == "$src" ]]; then
      ok "$rel (already linked)"
    else
      warn "$rel skipped — symlink points elsewhere ($(readlink "$dst"))"
    fi
  elif [[ -e "$dst" ]]; then
    warn "$rel skipped — already exists and is not our symlink; left untouched"
  elif [[ $DRY -eq 1 ]]; then
    would "link $rel"
    created=$((created + 1))
  else
    ln -s "$src" "$dst"
    ok "$rel"
    created=$((created + 1))
  fi
done

# ── cli.json: only global installs touch it (TUI module registration) ───────
# CLI_OURS records that our tui entries live in this cli.json, whether we just
# added them or found them already there — uninstall removes them either way.
TUI_PATHS=("$REPO/plugins/md-link/tui.ts" "$REPO/plugins/learn-viz-tui.ts")
CLI_OURS=0
if [[ "$MODE" == "global" ]]; then
  step "Register TUI modules"
  for p in "${TUI_PATHS[@]}"; do
    [[ -f "$p" ]] || die "tui module missing: $p"
  done
  if [[ $DRY -eq 1 ]]; then
    for p in "${TUI_PATHS[@]}"; do
      would "add $p to $GLOBAL_CFG/cli.json plugins[]"
    done
  else
    out="$(python3 - "$GLOBAL_CFG/cli.json" "${TUI_PATHS[@]}" <<'EOF'
import json, sys
path, tuis = sys.argv[1], sys.argv[2:]
try:
    cfg = json.load(open(path))
except FileNotFoundError:
    cfg = {}
plugins = cfg.setdefault("plugins", [])
for tui in tuis:
    if tui not in plugins:
        plugins.append(tui)
        print("added " + tui)
    else:
        print("present " + tui)
json.dump(cfg, open(path, "w"), indent=2)
EOF
)"
    CLI_OURS=1
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      if [[ "$line" == added* ]]; then
        ok "cli.json — registered $(basename "${line#added }")"
      else
        ok "cli.json — already registered $(basename "${line#present }")"
      fi
    done <<< "$out"
  fi
fi

# ── manifest: record every link we own under this target ────────────────────
# Ownership rule: a link is ours when it is a symlink whose readlink equals
# the canonical repo path for that item. Only those get tracked, so
# uninstall.sh can never remove anything it did not create.
if [[ $DRY -eq 0 ]]; then
  LEARN_CLI_TOUCHED=$CLI_OURS python3 - "$MANIFEST" "$TARGET_KEY" "$TARGET" "$REPO" "${items[@]}" <<'EOF'
import json, os, sys
manifest_path, key, target, repo, *items = sys.argv[1:]
cli_touched = os.environ.get("LEARN_CLI_TOUCHED") == "1"
try:
    m = json.load(open(manifest_path))
except (FileNotFoundError, json.JSONDecodeError):
    m = {}
entry = m.get(key, {"target": target, "links": [], "cli": False})
owned = set(entry["links"])
for rel in items:
    link = os.path.join(target, rel)
    if os.path.islink(link) and os.readlink(link) == os.path.join(repo, rel):
        owned.add(link)
m[key] = {"target": target, "links": sorted(owned), "cli": entry["cli"] or cli_touched}
json.dump(m, open(manifest_path, "w"), indent=2)
EOF
fi

step "Next steps"
cat <<EOF
  1. Restart OpenCode (or just the background service).
  2. Repeat with a project dir to install elsewhere:
       ${B}./install.sh ~/Projects/notes${R}
  ${DIM}Uninstall: ./uninstall.sh $([[ $MODE == global ]] && echo -g || echo "$PROJECT")${R}
EOF
[[ $DRY -eq 1 ]] && echo && info "dry run — nothing was changed"
exit 0
