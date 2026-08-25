# Commit scopes

Closed vocabulary. Every commit picks a scope from this table, or takes no
scope. Never invent a new one — if nothing fits, that is what no scope is for.

Format: `type(scope): summary` or `type: summary`.

## Scopes

| Scope       | Covers                                              |
| ----------- | --------------------------------------------------- |
| `learn-quiz` | `plugins/learn-quiz.ts`                            |
| `md-link`   | `plugins/md-link/**`                                 |
| `viz`       | `plugins/learn-viz-tools.ts`, `plugins/learn-viz-tui.ts`, `lib/viz-common.ts` |
| `agents`    | `agents/**`                                          |
| `skills`    | `skills/**`                                          |

No scope = repo-wide: `install.sh` / `uninstall.sh`, README, `.gitignore`,
`docs/`, and any change that genuinely spans several components.

## Rules

- Types: `feat`, `fix`, `refactor`, `docs`, `chore`.
- Pick the scope by WHAT changed, not by why.
- One logical change per commit. A change spanning two scopes becomes two
  commits; only fall back to no scope when splitting is impossible.
- Old commit subjects are never rewritten to match this list — the vocabulary
  applies from its introduction onward.

## Examples

```
fix(learn-quiz): stop truncating long questions in the form title
feat(viz): configurable publish dir via viz-state.json
feat(md-link): /md-link-keep trims existing mirrors immediately
feat: self-healing re-runs after renames/removals
docs: add Differences from upstream section
chore: gitignore viz/
```
