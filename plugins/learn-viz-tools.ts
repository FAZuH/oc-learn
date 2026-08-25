import {
  applyEdit,
  currentBody,
  existsSync,
  join,
  mkdirSync,
  publish,
  readFileSync,
  run,
  snippetAround,
  writeBody,
  writeFileSync,
} from "../lib/viz-common.ts"

/**
 * learn-viz-tools — the visual maker authoring loops as v2 custom tools.
 *
 * Ported from the pi visual-tools extension (extensions/visual-tools/):
 *   svg      → write_svg / edit_svg / render_svg   (rsvg-convert, fallback magick)
 *   mermaid  → write_mermaid / edit_mermaid / render_mermaid  (mmdc from PATH)
 *
 * Each trio shares ONE per-session managed source file (keyed by OpenCode
 * sessionID when the harness provides it, else a shared slot), so a maker
 * writes, exact-match-edits, and renders without naming files.
 *
 * v2 beta constraint (see ocv2-findings): custom tool results cannot deliver
 * images to the model. render_* therefore returns the PNG's absolute path and
 * instructs the agent to LOOK at it via the native read tool — same
 * render-and-inspect loop, one extra step.
 */

const SVG_GROUP = "svg"
const MERMAID_GROUP = "mermaid"
const SVG_BODY = "diagram.svg"
const MERMAID_BODY = "diagram.mmd"

/** Session key from the optional per-call context the harness passes execute. */
function sid(tctx: any): string {
  const s = tctx?.sessionID ?? tctx?.callID ?? tctx?.messageID
  return typeof s === "string" && s.length > 0 ? s : "shared"
}

export default {
  id: "fazuh.learn-viz-tools",

  setup: async (ctx: any) => {
    // Publish base: resolved per call. A globally loaded plugin's setup ctx
    // points at the server's default location ($HOME), and the execute ctx
    // carries only the sessionID — so resolve the session's project dir from
    // the session API when the ctx lacks directory/worktree.
    const fallbackBase = ctx.worktree || ctx.directory || process.cwd()

    function apiGet(path: string): Promise<any> {
      const proc = Bun.spawn(["opencode2", "api", "get", path], { stdout: "pipe", stderr: "pipe" })
      return new Response(proc.stdout).text().then(async (out) => {
        await proc.exited
        try {
          return JSON.parse(out)
        } catch {
          return undefined
        }
      })
    }

    async function publishBase(tctx: any): Promise<string> {
      const direct = tctx?.worktree || tctx?.directory
      if (direct) return direct
      const sid = typeof tctx?.sessionID === "string" ? tctx.sessionID : ""
      if (sid) {
        try {
          const s = await apiGet(`/api/session/${sid}`)
          const dir = s?.data?.location?.directory || s?.data?.directory
          if (dir) return dir
        } catch {}
      }
      return fallbackBase
    }

    // ── managed-file helpers shared by both trios ────────────────────────────
    function requireBody(group: string, bodyFile: string, tctx: any) {
      const s = currentBody(group, sid(tctx))
      if (!s || !existsSync(s.bodyPath)) return null
      return s
    }

    function makeWriteTool(group: string, bodyFile: string, kind: string, extraDesc: string) {
      const cap = kind.toUpperCase()
      return {
        name: `write_${kind}`,
        description:
          `Write the FULL ${cap} source to this session's managed file (your first draft or a complete rewrite). ` +
          `You do NOT name the file — edit_${kind} and render_${kind} act on the same one.\n\n` +
          extraDesc +
          ` Writing does NOT render — call render_${kind} when ready. For a small fix, prefer edit_${kind} over rewriting.`,
        input: {
          type: "object",
          properties: {
            source: { type: "string", description: `The complete ${cap} document.` },
          },
          required: ["source"],
          additionalProperties: false,
        },
        execute: async (input: any, tctx: any) => {
          try {
            const source = String(input.source ?? "").trim()
            if (!source) throw new Error(`\`write_${kind}\` requires a non-empty \`source\`.`)
            if (kind === "svg" && !source.includes("<svg")) {
              throw new Error("`write_svg`: source must be a complete <svg>…</svg> document.")
            }
            const s = writeBody(group, bodyFile, source, sid(tctx))
            const lines = source.split("\n").length
            return {
              content: `Wrote ${lines}-line ${cap} source.\nCall render_${kind} to render it, or edit_${kind} to tweak it.`,
            }
          } catch (error) {
            return { content: `❌ write_${kind} failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      }
    }

    function makeEditTool(kind: string) {
      const cap = kind.toUpperCase()
      return {
        name: `edit_${kind}`,
        description:
          `Make a single exact-match replacement in this session's ${cap} source — the same contract as the built-in edit, locked to the one managed file. ` +
          `\`old_text\` must appear EXACTLY ONCE (include surrounding context for uniqueness); on 0 or >1 matches the call fails and nothing changes. ` +
          `Call write_${kind} first. Editing does NOT render.`,
        input: {
          type: "object",
          properties: {
            old_text: { type: "string", description: "Exact substring of the current source to replace (must match once)." },
            new_text: { type: "string", description: "Replacement text for `old_text`." },
          },
          required: ["old_text", "new_text"],
          additionalProperties: false,
        },
        execute: async (input: any, tctx: any) => {
          try {
            const s = requireBody(kind === "svg" ? SVG_GROUP : MERMAID_GROUP, kind === "svg" ? SVG_BODY : MERMAID_BODY, tctx)
            if (!s) throw new Error(`edit_${kind}: no source yet — call write_${kind} first.`)
            const current = readFileSync(s.bodyPath, "utf8")
            const { updated, index } = applyEdit(current, String(input.old_text ?? ""), String(input.new_text ?? ""))
            writeFileSync(s.bodyPath, updated, "utf8")
            return {
              content:
                `Applied edit. Updated region:\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall render_${kind} to see it.`,
            }
          } catch (error) {
            return { content: `❌ edit_${kind} failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      }
    }

    function makeRenderTool(kind: string) {
      const cap = kind.toUpperCase()
      return {
        name: `render_${kind}`,
        description:
          `Render the CURRENT session ${cap} source to a PNG, then OPEN the returned PNG path with the read tool and LOOK at it before continuing — ` +
          `rendering success proves nothing about correctness. You do NOT pass the source here; call write_${kind} first.\n\n` +
          `Iterate freely with no \`save_as\` (preview only). When it is correct and clean, call once more with \`save_as\` set to a short kebab-case topic slug: ` +
          `that publishes the PNG into <project>/viz with a unique filename and returns the filename to embed. On a render error this returns error text — fix with edit_${kind} and re-render.`,
        input: {
          type: "object",
          properties: {
            save_as: {
              type: "string",
              description:
                "Short kebab-case topic slug (e.g. 'number-line'). When set, publishes to <project>/viz as viz-<slug>-<timestamp>.png. Omit for preview-only.",
            },
          },
          additionalProperties: false,
        },
        execute: async (input: any, tctx: any) => {
          let outPath = ""
          try {
            const group = kind === "svg" ? SVG_GROUP : MERMAID_GROUP
            const bodyFile = kind === "svg" ? SVG_BODY : MERMAID_BODY
            const s = requireBody(group, bodyFile, tctx)
            if (!s) throw new Error(`render_${kind}: no source yet — call write_${kind} first.`)
            mkdirSync(s.workDir, { recursive: true })
            outPath = join(s.workDir, `render-${Date.now()}.png`)

            let res =
              kind === "svg"
                ? await run("rsvg-convert", ["-z", "2", s.bodyPath, "-o", outPath], {
                    cwd: s.workDir,
                    timeoutMs: 60_000,
                  })
                : await run("mmdc", ["-i", s.bodyPath, "-o", outPath, "-s", "2", "-b", "white"], {
                    cwd: s.workDir,
                    timeoutMs: 120_000,
                  })

            // SVG fallback chain: rsvg-convert → ImageMagick.
            if (kind === "svg" && !(res.code === 0 && existsSync(outPath))) {
              res = await run("magick", ["-density", "192", "-background", "white", s.bodyPath, outPath], {
                cwd: s.workDir,
                timeoutMs: 60_000,
              })
            }

            if (res.code !== 0 || !existsSync(outPath)) {
              const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
              const note = res.timedOut ? `${kind === "svg" ? "SVG" : "mmdc"} render timed out.\n\n` : ""
              return {
                content:
                  `${note}${cap} render FAILED — no PNG produced. Fix the source with edit_${kind} and call render_${kind} again.\n\nError:\n${detail}`,
              }
            }

            const look = `NOW open ${outPath} with the read tool and LOOK at it. `
            if (input.save_as) {
              const pub = publish(outPath, String(input.save_as), await publishBase(tctx))
              return {
                content:
                  `Published to viz/.\nfilename: ${pub.filename}\npath: ${pub.path}\n\n${look}Confirm it is correct and true to the brief before returning it.`,
              }
            }
            return {
              content:
                `Preview render (not yet saved): ${outPath}\n\n${look}` +
                `Are coordinates/arrows/relationships correct, labels clear, nothing clipped or cramped? ` +
                `Fix with edit_${kind}, or re-render with \`save_as\` to publish.`,
            }
          } catch (error) {
            return { content: `❌ render_${kind} failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      }
    }

    await ctx.tool.transform((tools) => {
      tools.add(
        makeWriteTool(
          SVG_GROUP,
          SVG_BODY,
          "svg",
          "`source` is a complete `<svg …>…</svg>` document with an explicit width/height (or viewBox), readable font sizes, and a light or transparent background.",
        ) as any,
      )
      tools.add(makeEditTool("svg") as any)
      tools.add(makeRenderTool("svg") as any)
      tools.add(
        makeWriteTool(
          MERMAID_GROUP,
          MERMAID_BODY,
          "mermaid",
          "`source` is a complete Mermaid diagram, e.g. `graph TD`/`graph LR`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, `mindmap`, or `timeline`.",
        ) as any,
      )
      tools.add(makeEditTool("mermaid") as any)
      tools.add(makeRenderTool("mermaid") as any)
    })
  },
}