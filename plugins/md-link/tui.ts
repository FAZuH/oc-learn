/**
 * md-link TUI plugin — silent toggle for the Obsidian live mirror.
 *
 * Loader contract (opencode2 beta): default export MUST be { id, setup }.
 * ctx.keymap.layer() is Solid-scoped and only works inside a rendered
 * component — the ui.slot({ append: "app" }) carrier below is required.
 * Runtime dialog API: await ctx.ui.dialog.prompt({...}) → string | undefined.
 *
 * Commands (all purely client-side — nothing is ever sent to the LLM):
 *   ctrl+alt:m / /md-link [dir]   toggle mirroring for the focused session;
 *                                 ON backfills the newest completed reply
 *   /md-link-dir                  set the default output directory
 *   /md-link-keep                 keep only the N newest replies (empty = all)
 *
 * On TUI exit, mirror files belonging to this project are deleted — mirrors
 * are transient. See core.ts for state/file contracts.
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, rmSync, statSync } from "fs"
import { isAbsolute, join, normalize } from "path"
import { homedir } from "os"
import {
  appendMessage,
  disableSession,
  isEnabled,
  loadState,
  messageText,
  saveState,
  touchMirror,
} from "./core.ts"

type DirResult = { ok: true; abs: string } | { ok: false; error: string }

/** Validate a user-supplied output dir. Must already exist and be writable. */
function validateDir(raw: string, pwd: string): DirResult {
  let d = String(raw ?? "").trim().replace(/^["']+|["']+$/g, "")
  if (d.startsWith("~")) d = join(homedir(), d.slice(1))
  if (d.length === 0) d = "."
  if (d.includes("\0")) return { ok: false, error: "invalid path" }
  if (d.split("/").includes("..")) return { ok: false, error: "path may not contain '..'" }
  if (!/^[A-Za-z0-9 ._\-\/]+$/.test(d)) return { ok: false, error: `unsupported characters in "${d}"` }

  const abs = isAbsolute(d) ? normalize(d) : normalize(join(pwd, d))
  try {
    if (!existsSync(abs)) return { ok: false, error: `directory does not exist: ${abs}` }
    if (!statSync(abs).isDirectory()) return { ok: false, error: `not a directory: ${abs}` }
    accessSync(abs, fsConstants.W_OK)
  } catch (e: any) {
    return { ok: false, error: `cannot use ${abs}: ${e?.code ?? e?.message ?? e}` }
  }
  return { ok: true, abs }
}

/** Pull a free-form argument out of whatever the slash/keybind run() hands us. */
function extractArg(input: unknown): string {
  if (typeof input === "string") return input
  if (Array.isArray(input)) return input.map((x) => extractArg(x)).join(" ")
  const r = input as any
  if (r && typeof r === "object") {
    for (const k of ["value", "arg", "args", "input", "arguments", "text", "message", "prompt"]) {
      const v = r[k]
      if (typeof v === "string") return v
      if (Array.isArray(v)) return v.map((x) => extractArg(x)).join(" ")
    }
  }
  return ""
}

/**
 * Backfill the newest COMPLETED assistant reply via the service HTTP API
 * (ctx.state.session.messages() returns no rows in this beta).
 *
 * `opencode2 api` handles port discovery + auth; response items are
 * NEWEST-FIRST and may cap at ~50, with two text shapes (content[] parts or
 * flat text — see core.messageText).
 *
 * Replies still streaming when the toggle fires are skipped: their
 * time.created is too recent, and live ordinals will finish them anyway.
 */
async function backfillLatestTurn(
  sessionID: string,
  file: string,
  keep: number | null,
  enabledAt: number,
): Promise<boolean> {
  try {
    const proc = Bun.spawn(["opencode2", "api", "get", `/api/session/${sessionID}/message`], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited

    const parsed = JSON.parse(out)
    const items: any[] = Array.isArray(parsed) ? parsed : (parsed?.data ?? [])
    for (const m of items) {
      if (m?.type !== "assistant") continue
      const created = Number(m?.time?.created ?? 0)
      if (created && enabledAt - created < 15_000) continue // likely still streaming
      const text = messageText(m)
      if (!text) continue
      if (readFileSync(file, "utf-8").includes(`<!-- msg:${m.id}`)) break // already mirrored
      return appendMessage(file, { text, markerKey: `${m.id}#backfill` }, keep) === "written"
    }
  } catch {}
  return false
}

export default {
  id: "vault.md-link-tui",

  setup: async (ctx: any) => {
    const pwd = (): string =>
      ctx?.state?.path?.directory ?? ctx?.state?.path?.worktree ?? process.cwd()

    const toast = (message: string, variant: string = "info") => {
      try {
        ctx.ui?.toast?.show?.({ title: "md-link", message, variant })
      } catch {}
    }

    const short = (s: string) => (s.length > 28 ? s.slice(0, 28) + "…" : s)

    // ——— toggle ———

    /** Collapse duplicate activations: stacked layers from hot-reloads fire
     * run() twice per keypress (ON then instantly OFF). */
    let lastRun = 0
    async function run(input?: unknown): Promise<void> {
      const now = Date.now()
      if (now - lastRun < 500) return
      lastRun = now

      try {
        const cur = ctx?.ui?.router?.current?.()
        const sessionID = cur?.sessionID ?? cur?.params?.sessionID
        if (!sessionID || typeof sessionID !== "string") {
          toast("No active session found", "warning")
          return
        }

        const st = loadState()
        const arg = extractArg(input).trim()
        const res = validateDir(arg || st.defaultDir || pwd(), pwd())
        if (!res.ok) {
          toast(`Invalid dir "${arg || st.defaultDir}": ${res.error}`, "error")
          return
        }
        if (arg) st.defaultDir = res.abs // remember explicitly requested dirs

        const file = join(res.abs, `${sessionID}_link.md`)
        if (isEnabled(st, sessionID)) {
          const oldDir = st.sessions[sessionID]
          disableSession(st, sessionID)
          for (const dir of new Set([oldDir, res.abs])) {
            try { rmSync(join(dir ?? "", `${sessionID}_link.md`), { force: true }) } catch {}
          }
          toast(`Live mirror OFF (${short(sessionID)})`, "warning")
          return
        }

        st.sessions[sessionID] = res.abs
        saveState(st)
        touchMirror(file)
        const backfilled = await backfillLatestTurn(sessionID, file, st.keep, Date.now())
        toast(backfilled ? `Live mirror ON, latest reply backfilled → ${short(file)}` : `Live mirror ON → ${file}`)
      } catch (e: any) {
        toast(`Failed: ${e?.message ?? e}`, "error")
      }
    }

    // ——— dialogs ———

    async function openSetDirDialog(): Promise<void> {
      try {
        const v = await ctx.ui.dialog.prompt({
          title: "md-link output directory",
          placeholder: `relative to project (${pwd()}) or absolute path`,
          value: loadState().defaultDir ?? "",
        })
        if (typeof v !== "string") return // cancelled
        const res = validateDir(v, pwd())
        if (!res.ok) {
          toast(`Invalid dir: ${res.error}`, "error")
          return
        }
        const st = loadState()
        st.defaultDir = res.abs
        saveState(st)
        toast(`Default output dir set → ${res.abs}`)
      } catch (e: any) {
        toast(`Cannot open dialog: ${e?.message ?? e}`, "error")
      }
    }

    async function openKeepDialog(): Promise<void> {
      try {
        const cur = loadState().keep
        const v = await ctx.ui.dialog.prompt({
          title: "md-link: show last N messages",
          placeholder: "number of recent messages to keep (empty = unlimited)",
          value: cur != null ? String(cur) : "",
        })
        if (typeof v !== "string") return // cancelled
        const t = v.trim()
        let keep: number | null = null
        if (t.length > 0) {
          const n = Number(t)
          if (!Number.isInteger(n) || n < 1 || n > 500) {
            toast(`Invalid count "${t}" — use 1..500 or empty`, "error")
            return
          }
          keep = n
        }
        const st = loadState()
        st.keep = keep
        saveState(st)
        toast(keep == null ? "Mirror keeps all messages" : `Mirror shows only the last ${keep}`)
      } catch (e: any) {
        toast(`Cannot open dialog: ${e?.message ?? e}`, "error")
      }
    }

    // ——— transient cleanup on TUI close ———

    let cleaned = false
    function cleanupOnExit(): void {
      if (cleaned) return
      cleaned = true
      try {
        const root = pwd()
        const st = loadState()
        for (const [sid, dir] of Object.entries(st.sessions)) {
          // only remove mirrors owned by THIS project — other TUIs keep theirs
          if (root && !dir.startsWith(root)) continue
          try { rmSync(join(dir || ".", `${sid}_link.md`), { force: true }) } catch {}
          delete st.sessions[sid]
        }
        saveState(st)
      } catch {}
    }
    try { ctx.lifecycle?.onDispose?.(cleanupOnExit) } catch {}
    try { ctx.lifecycle?.signal?.addEventListener("abort", cleanupOnExit, { once: true }) } catch {}
    try { process.once("exit", cleanupOnExit) } catch {}

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
              id: "md-link.toggle",
              title: "md-link: toggle live mirror",
              description: 'Toggle Obsidian live mirror. Optional arg: output dir (/md-link "6 Study")',
              group: "md-link",
              bind: "ctrl+alt+m",
              palette: true,
              slash: { name: "md-link" },
              run,
            },
            {
              id: "md-link.setdir",
              title: "md-link: set output directory…",
              description: "Edit the default directory where mirror files are created",
              group: "md-link",
              palette: true,
              slash: { name: "md-link-dir" },
              run: () => openSetDirDialog(),
            },
            {
              id: "md-link.keep",
              title: "md-link: show last N messages…",
              description: "Prune the mirror to the N most recent replies (empty = all)",
              group: "md-link",
              palette: true,
              slash: { name: "md-link-keep" },
              run: () => openKeepDialog(),
            },
          ],
        }))
        return null // layer carrier renders nothing
      },
    })

    return undefined
  },
}
