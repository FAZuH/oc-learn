# learn

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

This is a port of [amosblomqvist's learning system](https://github.com/amosblomqvist/learn) — his AI setup from the video [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU), originally built as [pi](https://github.com/earendil-works/pi) configuration.

The teaching philosophy, the skills, and the system design are all his; this repo adapts that pi configuration to [OpenCode v2](https://opencode.ai/v2/docs/)

> [!WARNING]
> This repo is still in experimental phase. Some stuffs may not work/break.

## What's in it

- `skills/teach/` — the philosophy and the process
- `skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `agents/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to
- `plugins/md-link/` — live-mirrors the session to a markdown file for comfortable reading in Obsidian (assistant replies, your prompts, and quiz Q&A as callouts)
- `plugins/learn-quiz.ts` — the graded `quiz_ask` / `quiz_grade` question pair
- `plugins/learn-viz-tools.ts` + `lib/viz-common.ts` — the `write_*/edit_*/render_*` authoring loops the visual makers use (SVG via `rsvg-convert`, Mermaid via `mmdc`)

## Install

One source copy symlinked to other projects.

**Global** — symlink the items into your OpenCode config; every project gets them without per-project setup:

```bash
./install.sh -g              # symlink into ~/.config/opencode
./uninstall.sh -g            # remove again
```

**Project-level** — symlink into one project (or `git clone <this-repo-url> .opencode`):

```bash
./install.sh ~/Projects/notes        # symlinks into ~/Projects/notes/.opencode
./uninstall.sh ~/Projects/notes
```

Then open `opencode2` in the project. Skills, agents, and all plugins are discovered automatically.

## Requirements

- [OpenCode v2](https://opencode.ai/v2/docs) (`opencode2` beta) — developed against beta-1805x; plugin APIs may still shift
- `rsvg-convert` (librsvg) or ImageMagick — SVG rendering
- `mmdc` (`@mermaid-js/mermaid-cli`) on PATH — Mermaid rendering
- A provider/model for the subagents — edit `agents/*.md` frontmatter to taste
- For the quiz popups: nothing extra — OpenCode v2's TUI renders the question forms natively

## Notes

- The teaching flow: `teach` probes your level with graded quizzes (`quiz_ask`/`quiz_grade`), plans a dependency map, then teaches node by node with a quiz check after each one. Non-graded questions use OpenCode's built-in `question` tool.
- Visuals are never hand-faked: the skill briefs a maker subagent, which authors, renders to PNG, **looks at the result**, iterates, and only then publishes into `viz/` for embedding.
- `md-link` mirrors only reading-relevant content: your prompts, lesson prose, and quiz Q&A. Tool noise (bash, reads, edits) is omitted. Toggle it in the TUI with `ctrl+alt:m` or `/md-link <dir>` — `install.sh -g` registers the TUI module for you.

- The makers render but cannot push images into the model's context (v2 beta strips tool-result images) — so `render_*` returns the PNG path and the maker opens it with `read` to inspect. Same verify-by-looking loop, one extra step.
- You can run the system without subagents: the main session does the teaching. You lose the researcher (truth verification) and the generated visuals.

## Credits

- **amosblomqvist** — original system, teaching philosophy, and video: [amosblomqvist/learn](https://github.com/amosblomqvist/learn) (pi configuration)
- This repository — OpenCode v2 port of that pi configuration; the port mechanics (plugins, forms-based quiz, symlinking installer) are the only new work here
