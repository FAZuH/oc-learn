import { Plugin } from "@opencode-ai/plugin"

/**
 * learn-quiz — GRADED question pair for the teaching system (v2 port of the
 * pi quiz extension's server side).
 *
 * Two tools, because the v2 TUI displays raw tool-call arguments to the user
 * while a tool runs. Splitting at the answer boundary keeps the correct answer
 * invisible until AFTER the user has answered (pi's exact information flow):
 *
 *   quiz_ask   — pose the question. Input carries ONLY question/options/etc.
 *                Creates a session form (forms API), waits for the answer,
 *                stashes the raw selection per-session, returns it ungraded.
 *   quiz_grade — called after quiz_ask. Carries correctAnswer + explanation
 *                (safe to show now — the user already answered). Grades the
 *                stashed selection (exact-set match; "I don't know" is its own
 *                outcome) and returns the verdict + explanation.
 *
 * Transport: the server-plugin ctx exposes no form API, so form calls go
 * through the `opencode2 api` CLI (port discovery + auth handled). Wire
 * protocol in ocv2-findings:
 *   POST /api/session/:sid/form            {title, fields:[{key,type,label,options}]}
 *   GET  /api/session/:sid/form/:fid/state {status: pending|answered|cancelled, answer}
 *   POST /api/session/:sid/form/:fid/reply {answer: {key: value}}
 */

const DONT_KNOW = "__dont_know__"
const POLL_MS = 400
const TIMEOUT_MS = 10 * 60_000

interface QuizOption {
  label: string
  value: string
  description?: string
}

/** Per-session pending quiz state between quiz_ask and quiz_grade. */
interface PendingQuiz {
  question: string
  details?: string
  mode: "single-select" | "multi-select"
  /** Display order (post-shuffle), 1-based. */
  options: QuizOption[]
  status: "answered" | "cancelled" | "timeout"
  selectedIndices: number[]
  dontKnow: boolean
  note?: string
}

const pending = new Map<string, PendingQuiz>()

function api(method: string, path: string, body?: unknown): Promise<any> {
  const args = ["opencode2", "api", method, path]
  if (body !== undefined) args.push("-d", JSON.stringify(body))
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  return new Response(proc.stdout).text().then(async (out) => {
    await proc.exited
    try {
      return JSON.parse(out)
    } catch {
      return undefined
    }
  })
}

function normalizeOptions(raw: any): QuizOption[] {
  const seen = new Set<string>()
  const out: QuizOption[] = []
  for (const o of Array.isArray(raw) ? raw : []) {
    const label = String(o?.label ?? "").trim()
    if (!label) continue
    const value = String(o?.value ?? "").trim() || label
    if (seen.has(value)) throw new Error(`duplicate option value "${value}"`)
    seen.add(value)
    const description = String(o?.description ?? "").trim() || undefined
    out.push({ label, value, description })
  }
  return out
}

function shuffleOptions(options: QuizOption[]): QuizOption[] {
  const out = [...options]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Multi-select correctAnswer sometimes arrives JSON-stringified; coerce. */
function coerceCorrectAnswer(correctAnswer: unknown): string[] {
  if (Array.isArray(correctAnswer)) return correctAnswer.map((v) => String(v))
  const s = String(correctAnswer ?? "").trim()
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return parsed.map((v) => String(v))
    } catch {}
  }
  return s ? [s] : []
}

function optionRef(options: QuizOption[], index: number): string {
  const opt = options[index - 1]
  return `${index}. ${opt ? opt.label : "(unknown)"}`
}

function firstLine(text: string, max = 80): string {
  const line = text.split("\n")[0].trim()
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

export default Plugin.define({
  id: "fazuh.learn-quiz",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      // ── quiz_ask ──────────────────────────────────────────────────────────
      tools.add({
        name: "quiz_ask",
        description:
          "Pose ONE graded quiz question to the user and wait for their answer. Options-only (single-select or " +
          "multi-select); an 'I don't know' choice is added automatically, plus an optional free-text note. " +
          "Returns the user's raw selection UNGRADED — always follow with quiz_grade (correctAnswer + explanation) " +
          "to reveal the verdict. For non-graded questions use the built-in question tool instead.",
        input: {
          type: "object",
          properties: {
            question: { type: "string", description: "The single quiz question to ask. Ask exactly one question per tool call." },
            details: { type: "string", description: "Optional extra context or instructions shown under the question." },
            options: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Display label for the answer option." },
                  value: { type: "string", description: "Stable machine-readable value; defaults to the label. quiz_grade references this." },
                  description: { type: "string", description: "Optional extra detail shown below the option." },
                },
                required: ["label"],
                additionalProperties: false,
              },
              description:
                "The answer options (2 or more). Give each a stable `value`. Never add your own 'I don't know' option — it is added automatically.",
            },
            multiSelect: { type: "boolean", description: "Set to true when more than one option is correct and the user must select all of them." },
            shuffle: { type: "boolean", description: "Default true: options are reordered before display. Set false only when order is meaningful." },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
        execute: async (input: any, tctx: any) => {
          try {
            const question = String(input.question ?? "").trim()
            const details = String(input.details ?? "").trim() || undefined
            const multiSelect = input.multiSelect === true
            const sessionID = typeof tctx?.sessionID === "string" ? tctx.sessionID : ""

            if (!question) return { content: "quiz_ask failed: `question` is required." }
            if (!sessionID) return { content: "quiz_ask failed: no session context (sessionID missing)." }

            let options: QuizOption[]
            try {
              options = normalizeOptions(input.options)
            } catch (e) {
              return { content: `quiz_ask failed: ${(e as Error).message}` }
            }
            if (options.length < 2) return { content: "quiz_ask failed: at least two options are required." }

            if (input.shuffle !== false) options = shuffleOptions(options)

            // Form payload: question only — nothing answer-revealing.
            const displayOptions = options.map((o, i) => ({
              label: `${i + 1}. ${o.label}`,
              value: String(i + 1),
              ...(o.description ? { description: o.description } : {}),
            }))
            displayOptions.push({ label: "I don't know", value: DONT_KNOW })

            const created = await api("post", `/api/session/${sessionID}/form`, {
              title: firstLine(question),
              fields: [
                {
                  key: "answer",
                  type: multiSelect ? "multiselect" : "string",
                  label: details ? `${question}\n\n${details}` : question,
                  options: displayOptions,
                },
                { key: "note", type: "string", label: "Note (optional)" },
              ],
            })
            const formID = created?.data?.id
            if (!formID) return { content: `quiz_ask failed: could not create the question form (${JSON.stringify(created).slice(0, 200)})` }

            const deadline = Date.now() + TIMEOUT_MS
            let state: any
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, POLL_MS))
              try {
                state = (await api("get", `/api/session/${sessionID}/form/${formID}/state`))?.data
              } catch {}
              if (state && state.status !== "pending") break
            }

            if (!state || state.status === "pending") {
              await api("post", `/api/session/${sessionID}/form/${formID}/cancel`).catch(() => {})
              pending.set(sessionID, {
                question, details, mode: multiSelect ? "multi-select" : "single-select", options,
                status: "timeout", selectedIndices: [], dontKnow: false,
              })
              return { content: "User did not answer the quiz in time. Call quiz_grade to close it out (or move on)." }
            }
            if (state.status === "cancelled") {
              pending.set(sessionID, {
                question, details, mode: multiSelect ? "multi-select" : "single-select", options,
                status: "cancelled", selectedIndices: [], dontKnow: false,
              })
              return { content: "User dismissed the quiz without answering. Call quiz_grade to close it out (or move on)." }
            }

            // Answered: extract raw selection + note, stash, return ungraded.
            const rawAnswer = state.answer?.answer
            const selectedValues: string[] = Array.isArray(rawAnswer)
              ? rawAnswer.map((v: any) => String(v))
              : rawAnswer !== undefined && rawAnswer !== null && rawAnswer !== ""
                ? [String(rawAnswer)]
                : []
            const dontKnow = selectedValues.includes(DONT_KNOW)
            const selectedIndices = [...new Set(
              selectedValues
                .filter((v) => v !== DONT_KNOW)
                .map((v) => parseInt(v, 10))
                .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length),
            )].sort((a, b) => a - b)
            const note = String(state.answer?.note ?? "").trim() || undefined

            pending.set(sessionID, {
              question, details, mode: multiSelect ? "multi-select" : "single-select", options,
              status: "answered", selectedIndices, dontKnow, note,
            })

            let text: string
            if (dontKnow) {
              text = 'User selected "I don\'t know" — they did not attempt an answer.'
            } else {
              text = `User selected: ${selectedIndices.map((i) => optionRef(options, i)).join(", ") || "(nothing)"}`
            }
            if (note) text += `\nUser's note: ${note}`
            text += "\nNow call quiz_grade with correctAnswer (the option value(s) you intended) and explanation to reveal the verdict."
            return { content: text }
          } catch (error) {
            return { content: `❌ quiz_ask failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })

      // ── quiz_grade ─────────────────────────────────────────────────────────
      tools.add({
        name: "quiz_grade",
        description:
          "Grade the quiz the user just answered via quiz_ask. REQUIRED afterwards: pass correctAnswer (the option " +
          "value(s) you intended — single string or array for multi-select, exact-set match) and explanation (why the " +
          "correct answer is correct — always required). Returns right/wrong, the correct answer, the user's note, and " +
          "your explanation; relay all of it to the user. 'I don't know' grades as its own outcome, never as wrong.",
        input: {
          type: "object",
          properties: {
            correctAnswer: {
              description:
                'REQUIRED. The correct answer as option value(s) from quiz_ask\'s options. Single-select: one string ("mercury"). Multi-select: array (["belize","niue"]) — exact-set match. Always the value, never a position number.',
              oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            },
            explanation: { type: "string", description: "REQUIRED. Why the correct answer is correct — shown to the user after answering." },
          },
          required: ["correctAnswer", "explanation"],
          additionalProperties: false,
        },
        execute: async (input: any, tctx: any) => {
          try {
            const sessionID = typeof tctx?.sessionID === "string" ? tctx.sessionID : ""
            const explanation = String(input.explanation ?? "").trim()
            const pq = sessionID ? pending.get(sessionID) : undefined
            if (!pq) return { content: "quiz_grade failed: no pending quiz — call quiz_ask first." }

            pending.delete(sessionID)

            if (pq.status !== "answered") {
              return {
                content: `Quiz was ${pq.status === "cancelled" ? "dismissed by the user" : "not answered in time"} — no grade. Correct answer for your reference: ${pq.options.map((_, i) => i + 1).join(", ") ? "" : ""}ask again later if needed.`,
              }
            }

            // Resolve correctAnswer against the DISPLAY order stashed by quiz_ask.
            const arr = coerceCorrectAnswer(input.correctAnswer)
            if (arr.length === 0) return { content: "quiz_grade failed: correctAnswer is required." }
            const byValue = new Map(pq.options.map((o, i) => [o.value, i + 1]))
            const correctIndices: number[] = []
            for (const raw of arr) {
              const idx = byValue.get(String(raw).trim())
              if (idx === undefined) {
                const known = pq.options.map((o) => `"${o.value}"`).join(", ")
                return { content: `quiz_grade failed: correctAnswer "${raw}" does not match any quiz_ask option value (${known})` }
              }
              correctIndices.push(idx)
            }
            const uniqCorrect = Array.from(new Set(correctIndices)).sort((a, b) => a - b)

            const correctSet = new Set(uniqCorrect)
            const correct = !pq.dontKnow &&
              pq.selectedIndices.length === uniqCorrect.length &&
              pq.selectedIndices.every((v, i) => v === uniqCorrect[i])

            const selectedStr = pq.selectedIndices.map((i) => optionRef(pq.options, i)).join(", ") || "(none)"
            const correctStr = uniqCorrect.map((i) => optionRef(pq.options, i)).join(", ")

            let text: string
            if (pq.dontKnow) {
              text = `User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).\nCorrect: ${correctStr}`
            } else {
              text = `User answered ${correct ? "correctly" : "incorrectly"}.\nSelected: ${selectedStr}\nCorrect: ${correctStr}`
            }
            if (pq.note) text += `\nUser's note: ${pq.note}`
            if (explanation) text += `\nExplanation: ${explanation}`
            text += "\nRelay the verdict, the correct answer, and the explanation to the user now."
            return { content: text }
          } catch (error) {
            return { content: `❌ quiz_grade failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })
    })
  },
})
