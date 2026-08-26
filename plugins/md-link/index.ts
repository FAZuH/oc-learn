/**
 * md-link — Obsidian live-mirror (server side).
 *
 * Mirrors a session to `<dir>/<sessionID>_link.md` for sessions enabled in
 * the state file (see core.ts for the contracts). Sessions are toggled
 * exclusively by the TUI plugin — this plugin never enables anything.
 *
 * Mirrors are transient by default — with persistence ON (/md-link-persist),
 * session entries survive TUI exit and this poller resumes them on next launch.
 *
 * What gets mirrored (teaching-session parity with the pi md-log):
 *   - assistant replies   → poller (2.5 s) over `opencode2 api get …/message`
 *   - user prompts        → poller, as `> [!quote] YOU` callouts
 *   - quiz_ask / question → tool hooks: question callout written at
 *                           execute.before (pre-answer, sanitized input),
 *                           feedback callout at execute.after (quiz_grade /
 *                           question results)
 * We deliberately do NOT use plugin event delivery — as of the 2026-08-25
 * beta, external server plugins receive no session events through any
 * mechanism (hooks.event, ctx.event.subscribe); see ocv2-findings/findings.md.
 * Tool hooks DO fire externally and carry {tool, sessionID, id, input,
 * status, result}. The poller only runs while at least one session is enabled.
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

/** Legacy fallback dir for sessions with no recorded path. */
const FALLBACK_DIR = "/home/fazuh/Workspaces/Notes/6 Study"
const POLL_MS = 2_500
/** Cap on how many historical messages a single sync may backfill. */
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

/** Skill declarations are system-injected context, not learner prose. */
function stripSkillBlocks(text: string): string {
  return text.replace(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g, (_m, attrs: string) => {
    const name = /name="([^"]+)"/.exec(attrs)?.[1]
    return `[SKILL loaded: ${name ?? "(unknown)"}]`
  })
}

function callout(type: string, title: string, bodyLines: string[]): string {
  const lines = [`> [!${type}] ${title}`]
  for (const line of bodyLines) lines.push(line.length === 0 ? ">" : `> ${line}`)
  return lines.join("\n")
}

async function syncSession(sessionID: string): Promise<void> {
  const st = loadState()
  if (!isEnabled(st, sessionID)) return
  const file = mirrorFile(st, sessionID, FALLBACK_DIR)
  if (!file) return

  touchMirror(file)

  // Walk newest → oldest, collecting until we hit an already-mirrored
  // message; then append oldest-first so chronology is preserved.
  const pending: { id: string; text: string }[] = []
  for (const m of await fetchMessages(sessionID)) {
    if (m?.type !== "assistant" && m?.type !== "user") continue
    let text = messageText(m)
    if (!text) continue
    if (m.type === "user") {
      text = stripSkillBlocks(text.trim())
      if (text) text = callout("quote", "YOU", text.split("\n"))
    }
    if (!text) continue
    if (hasBlock(file, `${m.id}`)) break
    pending.push({ id: `${m.id}`, text })
    if (pending.length >= MAX_CATCHUP) break
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    appendMessage(file, { text: pending[i].text, markerKey: pending[i].id, replace: true }, st.keep)
  }
}

// ── Q&A callouts via tool hooks ─────────────────────────────────────────────

/** Resolve the mirror file for a session, or null if not enabled. */
function mirrorFor(sessionID: unknown): string | null {
  if (typeof sessionID !== "string" || !sessionID) return null
  const st = loadState()
  if (!isEnabled(st, sessionID)) return null
  return mirrorFile(st, sessionID, FALLBACK_DIR)
}

function appendQa(file: string, markerKey: string, text: string, keep: number | null): void {
  const res = appendMessage(file, { text, markerKey, replace: true }, keep)
  // "duplicate" is the expected steady state on service restarts / re-reads.
  if (res === "failed") console.error("[md-link] qa append failed:", markerKey)
}

function questionCallout(label: string, question: string, details: string | undefined, options: any[]): string {
  const body: string[] = []
  for (const line of String(question || "").split("\n")) body.push(line)
  if (details) {
    body.push("")
    for (const line of details.split("\n")) body.push(line)
  }
  const opts = Array.isArray(options) ? options : []
  if (opts.length > 0) {
    body.push("")
    opts.forEach((o, i) => body.push(`${i + 1}. ${o?.label ?? ""}`))
  }
  return callout("question", label, body)
}

function resultText(result: any): string {
  if (typeof result === "string") return result
  if (typeof result?.content === "string") return result.content
  if (Array.isArray(result?.content)) {
    return result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
  }
  return String(result?.output ?? "")
}

/** Feedback callout from quiz_grade's result text (we control that format). */
function gradeCallout(content: string): string {
  const lines = content
    .split("\n")
    .filter((l) => l.trim().length > 0 && !/^Relay the verdict/i.test(l.trim()))
  const first = lines[0] ?? ""
  if (/answered correctly/i.test(first)) {
    return callout("success", "Quiz — correct ✓", lines.slice(1))
  }
  if (/answered incorrectly/i.test(first)) {
    return callout("failure", "Quiz — incorrect ✗", lines.slice(1))
  }
  if (/I don't know/i.test(content)) {
    return callout("question", "Quiz — I don't know", lines.slice(1))
  }
  if (/dismissed|not answered in time/i.test(content)) {
    return callout("warning", "Quiz — dismissed", ["(no answer given)"])
  }
  return callout("example", "Quiz", lines)
}

export const mdLinkPlugin = {
  id: "vault.md-link",

  setup: async (ctx: any) => {
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

    // ── Q&A capture ─────────────────────────────────────────────────────────
    // execute.before: write the question callout BEFORE the learner answers
    // (quiz_ask/question inputs are sanitized — no answer material).
    if (typeof ctx?.tool?.hook === "function") {
      await ctx.tool.hook("execute.before", async (event: any) => {
      try {
        const file = mirrorFor(event.sessionID)
        if (!file) return
        const { keep } = loadState()
        if (event.tool === "quiz_ask") {
          const input = event.input ?? {}
          const block = questionCallout("Quiz", input.question, input.details, input.options)
          appendQa(file, `qa-ask-${event.id}`, block, keep)
        } else if (event.tool === "question") {
          const q = event.input?.questions?.[0] ?? {}
          const block = questionCallout("Question", q.question ?? q.header ?? "", undefined, q.options)
          appendQa(file, `qa-ask-${event.id}`, block, keep)
        }
      } catch {}
    })

    // execute.after: write the feedback callout (answer already given).
    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        const file = mirrorFor(event.sessionID)
        if (!file) return
        const { keep } = loadState()
        if (event.tool === "quiz_grade") {
          const content = resultText(event.result)
          if (content) appendQa(file, `qa-grade-${event.id}`, gradeCallout(content), keep)
        } else if (event.tool === "question" && event.status === "completed") {
          const content = resultText(event.result)
          if (content) appendQa(file, `qa-grade-${event.id}`, callout("example", "Answer", content.split("\n")), keep)
        }
      } catch {}
    })

    } else {
      console.error("[md-link] ctx.tool.hook unavailable — Q&A capture disabled")
    }

    return () => {
      if (timer) clearInterval(timer)
    }
  },
} as const

export default mdLinkPlugin
