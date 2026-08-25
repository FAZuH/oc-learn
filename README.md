# learn

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

My AI learning system from this video: [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).

A personal system I built for myself, shared as-is. Built for **OpenCode v2** (`opencode2` beta): the teaching philosophy encoded as skills, the subagents that do research and visuals, and a live Obsidian mirror of every lesson.

## What's in it

- `skills/teach/` — the philosophy and the process
- `skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `agents/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to
- `plugins/md-link/` — live-mirrors the session to a markdown file for comfortable reading in Obsidian (assistant replies, your prompts, and quiz Q&A as callouts)

Two pieces install **outside** this repo, into your global OpenCode config (`~/.config/opencode/`):

- `plugins/learn-viz-tools.ts` + `tools/viz-common.ts` — the `write_*/edit_*/render_*` authoring loops the visual makers use (SVG via `rsvg-convert`, Mermaid via `mmdc`)
- `plugins/learn-quiz.ts` — the graded `quiz_ask` / `quiz_grade` question pair

## Install

This repo **is** an `.opencode` directory. From your learning project's root:

```bash
git clone <this-repo-url> .opencode
```

Then open `opencode2` in that directory. (Or copy the pieces you want into your existing `.opencode`.)

Then install the two global pieces:

```bash
cp <repo>/global/learn-viz-tools.ts ~/.config/opencode/plugins/
cp <repo>/global/viz-common.ts     ~/.config/opencode/tools/
cp <repo>/global/learn-quiz.ts     ~/.config/opencode/plugins/
```

## Requirements

- [OpenCode v2](https://opencode.ai/v2/docs) (`opencode2` beta) — developed against beta-1805x; plugin APIs may still shift
- `rsvg-convert` (librsvg) or ImageMagick — SVG rendering
- `mmdc` (`@mermaid-js/mermaid-cli`) on PATH — Mermaid rendering
- A provider/model for the subagents — edit `agents/*.md` frontmatter to taste
- For the quiz popups: nothing extra — OpenCode v2's TUI renders the question forms natively

## Notes

- The teaching flow: `teach` probes your level with graded quizzes (`quiz_ask`/`quiz_grade`), plans a dependency map, then teaches node by node with a quiz check after each one. Non-graded questions use OpenCode's built-in `question` tool.
- Visuals are never hand-faked: the skill briefs a maker subagent, which authors, renders to PNG, **looks at the result**, iterates, and only then publishes into `viz/` for embedding.
- `md-link` mirrors only reading-relevant content: your prompts, lesson prose, and quiz Q&A. Tool noise (bash, reads, edits) is omitted. Toggle it in the TUI with `ctrl+alt:m` or `/md-link <dir>`; the TUI module needs an entry in your `cli.json`:

```json
{ "plugins": ["/absolute/path/to/.opencode/plugins/md-link/tui.ts"] }
```

- The makers render but cannot push images into the model's context (v2 beta strips tool-result images) — so `render_*` returns the PNG path and the maker opens it with `read` to inspect. Same verify-by-looking loop, one extra step.
- You can run the system without subagents: the main session does the teaching. You lose the researcher (truth verification) and the generated visuals.
