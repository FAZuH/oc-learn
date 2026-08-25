/**
 * md-link — Obsidian live-mirror (server side).
 *
 * Mirrors assistant replies to `<dir>/<sessionID>.md` for sessions enabled in
 * the state file (see core.ts for the contracts). Sessions are
 * toggled exclusively by the TUI plugin — this plugin never enables anything.
 *
 * How it syncs: a 2.5 s poller pulls each enabled session's messages via
 * `opencode2 api get /api/session/<sid>/message` and upserts replies into the
 * mirror (deduped/upserted by message id, pruned to state.keep). We
 * deliberately do NOT use plugin event delivery — as of the 2026-08-25 beta,
 * external server plugins receive no session events through any mechanism
 * (hooks.event, ctx.event.subscribe); see ocv2-findings/findings.md.
 * The poller only runs while at least one session is enabled.
 */

import {
  appendMessage,
  hasBlock,
  isEnabled,
  loadState,
  mirrorFile,
  messageText,
  touchMirror,
} from "./core.ts"
import { join } from "path"

/** Legacy fallback dir for sessions with no recorded path. */
const FALLBACK_DIR = "/home/fazuh/Workspaces/Notes/6 Study"
const POLL_MS = 2_500
/** Cap on how many historical replies a single sync may backfill. */
const MAX_CATCHUP = 10

async function fetchMessages(sessionID: string): Promise<any[]> {
  const proc = Bun.spawn(["opencode2", "api", "get", `/api/session/${sessionID}/message`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const parsed = JSON.parse(out)
  const items = Array.isArray(parsed) ? parsed : parsed?.data
  return Array.isArray(items) ? items : [] // newest-first
}

async function syncSession(sessionID: string): Promise<void> {
  const st = loadState()
  if (!isEnabled(st, sessionID)) return
  const file = mirrorFile(st, sessionID, FALLBACK_DIR)
  if (!file) return

  touchMirror(file)

  // Walk newest → oldest, collecting until we hit an already-mirrored reply;
  // then append oldest-first so chronology is preserved.
  const pending: { id: string; text: string }[] = []
  for (const m of await fetchMessages(sessionID)) {
    if (m?.type !== "assistant") continue
    const text = messageText(m)
    if (!text) continue
    if (hasBlock(file, `${m.id}`)) break
    pending.push({ id: `${m.id}`, text })
    if (pending.length >= MAX_CATCHUP) break
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    appendMessage(file, { text: pending[i].text, markerKey: pending[i].id, replace: true }, st.keep)
  }
}

export const mdLinkPlugin = {
  id: "vault.md-link",

  setup: async () => {
    let busy = false
    let timer: ReturnType<typeof setInterval> | undefined

    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const st = loadState()
        for (const sid of Object.keys(st.sessions)) {
          try {
            await syncSession(sid)
          } catch {} // one failing session must not starve the others
        }
      } finally {
        busy = false
      }
    }

    setTimeout(tick, 500)
    timer = setInterval(tick, POLL_MS)

    return () => {
      if (timer) clearInterval(timer)
    }
  },
} as const

export default mdLinkPlugin
