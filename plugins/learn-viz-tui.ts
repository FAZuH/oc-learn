/**
 * learn-viz-tui — TUI command for the viz publish directory.
 *
 * The learn-viz-tools server plugin reads defaultDir from
 * ~/.config/opencode/viz-state.json on every publish (empty = the session
 * project's viz/). This module adds the /viz-dir command that edits it:
 *
 *   /viz-dir            open the dialog (prefilled with the current value)
 *   /viz-dir <path>     set it directly; relative paths resolve against the
 *                       session's project at publish time
 *
 * Empty input in the dialog clears the override. Like every TUI module, this
 * file is not auto-discovered — install.sh registers it in cli.json.
 */

import { readFileSync, writeFileSync } from "fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

type DirResult = { ok: true; value: string } | { ok: false; error: string }

const STATE_FILE = join(homedir(), ".config", "opencode", "viz-state.json")

function loadState(): { defaultDir: string } {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    return { defaultDir: typeof raw?.defaultDir === "string" ? raw.defaultDir : "" }
  } catch {
    return { defaultDir: "" }
  }
}

function saveState(st: { defaultDir: string }): void {
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), "utf8")
}

/** Light validation: publish creates the dir, so it only has to be sane. */
function validateDir(raw: string): DirResult {
  const v = String(raw ?? "").trim().replace(/^["']+|["']+$/g, "")
  if (v.includes("\0")) return { ok: false, error: "invalid path" }
  if (v.split("/").includes("..")) return { ok: false, error: "path may not contain '..'" }
  if (v.length > 0 && !/^[A-Za-z0-9 ._\-\/~]+$/.test(v)) {
    return { ok: false, error: `unsupported characters in "${v}"` }
  }
  return { ok: true, value: v }
}

export default {
  id: "learn.viz-tui",

  setup: async (ctx: any) => {
    const toast = (message: string, variant: string = "info") => {
      try {
        ctx.ui?.toast?.show?.({ title: "viz", message, variant })
      } catch {}
    }

    async function openSetDirDialog(): Promise<void> {
      try {
        const v = await ctx.ui.dialog.prompt({
          title: "viz output directory",
          description: "Where render_* saves published PNGs. Empty = the session project's viz/.",
          placeholder: "absolute path, or relative to the project",
          value: loadState().defaultDir,
        })
        if (typeof v !== "string") return // cancelled
        const res = validateDir(v)
        if (!res.ok) {
          toast(`Invalid dir: ${res.error}`, "error")
          return
        }
        const st = loadState()
        st.defaultDir = res.value
        saveState(st)
        toast(
          res.value
            ? `Viz output dir set → ${res.value}${isAbsolute(res.value) ? "" : " (relative to project)"}`
            : "Viz output dir cleared — publishing into the session project's viz/",
        )
      } catch (e: any) {
        toast(`Cannot open dialog: ${e?.message ?? e}`, "error")
      }
    }

    // ——— registration (MUST happen inside a rendered component) ———

    ctx.ui?.slot?.({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 1,
          enabled: true,
          commands: [
            {
              id: "viz.setdir",
              title: "viz: set output directory…",
              description: "Where published visuals are saved (empty = project viz/)",
              group: "viz",
              palette: true,
              slash: { name: "viz-dir" },
              run: () => openSetDirDialog(),
            },
          ],
        }))
        return null // layer carrier renders nothing
      },
    })

    return undefined
  },
}
