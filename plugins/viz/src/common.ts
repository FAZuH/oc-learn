/**
 * Shared helpers for the learn visual authoring loops (write_/edit_/render_
 * trios for SVG and Mermaid, registered by plugins/learn-viz-tools.ts):
 * subprocess runner, per-session managed source file, exact-match editor,
 * and publishing a chosen render into <worktree>/viz with a unique filename.
 *
 * Ported from the pi visual-tools extension's _common.ts. Differences vs the
 * original: macOS PATH extras dropped (Linux binaries live in /usr/bin),
 * staging moved under /tmp/opencode, and sessions are keyed by OpenCode
 * sessionID (one server process serves many sessions) instead of pid.
 */

import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

export const RENDER_TIMEOUT_MS_DEFAULT = 120_000

/** Transient session/preview files live outside any vault: only PUBLISHED
 *  PNGs ever land inside the learner's project (viz/). */
export const STAGING_ROOT = join(tmpdir(), "opencode", "viz-tools")
export const FILES_DIRNAME = "viz"

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, opts.timeoutMs ?? RENDER_TIMEOUT_MS_DEFAULT)
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolveRun({ code: null, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr, timedOut })
    })
  })
}

/** Per-session managed source file state. */
export interface Session {
  workDir: string
  bodyPath: string
}

const sessions = new Map<string, Session>()

function sessionKey(group: string, sessionID: string): string {
  // Sanitize: sessionIDs are [A-Za-z0-9_] but never trust wire data for paths.
  const sid = sessionID.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "anon"
  return `${group}-${sid}`
}

/** Write the full source to the session's managed file, creating its work dir. */
export function writeBody(
  group: string,
  bodyFileName: string,
  source: string,
  sessionID: string,
): Session {
  const key = sessionKey(group, sessionID)
  const workDir = join(STAGING_ROOT, key)
  mkdirSync(workDir, { recursive: true })
  const bodyPath = join(workDir, bodyFileName)
  writeFileSync(bodyPath, source, "utf8")
  const s: Session = { workDir, bodyPath }
  sessions.set(key, s)
  return s
}

/** Current managed file for this group+session, or undefined if none yet. */
export function currentBody(group: string, sessionID: string): Session | undefined {
  return sessions.get(sessionKey(group, sessionID))
}

/**
 * Exact-match single replacement on the current source: old_text must appear
 * exactly once. Returns the updated content and the match offset, or throws
 * a precise error.
 */
export function applyEdit(current: string, oldText: string, newText: string): { updated: string; index: number } {
  if (oldText === "") throw new Error("`old_text` must be non-empty.")
  if (oldText === newText) throw new Error("`old_text` and `new_text` are identical.")
  const first = current.indexOf(oldText)
  if (first === -1) {
    throw new Error("`old_text` not found in the current source — match it exactly.")
  }
  const second = current.indexOf(oldText, first + 1)
  if (second !== -1) {
    let n = 0
    let i = current.indexOf(oldText)
    while (i !== -1) {
      n++
      i = current.indexOf(oldText, i + oldText.length)
    }
    throw new Error(`\`old_text\` appears ${n} times — add surrounding context to make it unique.`)
  }
  const updated = current.slice(0, first) + newText + current.slice(first + oldText.length)
  return { updated, index: first }
}

/** A small numbered window of `content` around char offset `index`. */
export function snippetAround(content: string, index: number, contextLines = 3): string {
  const before = content.slice(0, index)
  const hitLine = before.split("\n").length - 1
  const lines = content.split("\n")
  const start = Math.max(0, hitLine - contextLines)
  const end = Math.min(lines.length - 1, hitLine + contextLines)
  const width = String(end + 1).length
  const out: string[] = []
  for (let i = start; i <= end; i++) out.push(`${String(i + 1).padStart(width)}  ${lines[i]}`)
  return out.join("\n")
}

/** Copy a rendered PNG into `filesDir` (the exact output directory) with a unique, slugified name. */
export function publish(pngPath: string, slug: string, filesDir?: string): { filename: string; path: string } {
  const dir = filesDir || join(process.cwd(), FILES_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const clean =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "viz"
  const filename = `viz-${clean}-${Date.now()}.png`
  const dest = join(dir, filename)
  copyFileSync(pngPath, dest)
  return { filename, path: dest }
}

export { existsSync, join, mkdirSync, readFileSync, writeFileSync }
