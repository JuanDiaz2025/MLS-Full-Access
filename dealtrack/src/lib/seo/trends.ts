// Competitors → SEO → Keywords: is a search rising or falling right now? Google Trends, through
// Bright Data, for California: a week-by-week line for the last 12 months (0 to 100, Google's
// scale, not a count), and the rising searches around it when Google gives them. Keyword Planner's
// numbers are a month or two behind; this is this week's.
//
// Each keyword checked uses one of Bright Data's free searches, so it only runs when someone asks,
// in the background, one keyword at a time (up to 2 minutes each: Trends is slow), at most 10 a
// check, and only 1 after a check that got nothing back, so a check that doesn't work can't use
// up searches. A line is kept 30 days in .data/seo-trends.json; a keyword that got none is tried
// again after 7 days, or when picked. Bright Data's documentation doesn't show its Trends answer,
// so any list of dated values in it is read as the line, and when there is none, what the answer
// held is saved with the keyword (it's shown on the page), never guessed.
import { after } from "next/server"

import { BrightDataError, FreeSearchesUsedUp, brightRequest } from "@/lib/competitors/brightdata"
import { jsonFileStore } from "@/lib/json-file-store"
import { normalizeKeyword } from "@/lib/research/parse"
import { shared } from "@/lib/shared-state"

export const TRENDS_GEO = "US-CA"
const KEEP_DAYS = 30
const RETRY_DAYS = 7
export const TRENDS_PER_RUN = 10
const TIMEOUT_MS = 120_000
const DAY = 86_400_000

// points: weekly 0-100 values, oldest first; now: the last 4 weeks against the year's average
// (1.2 = 20% above); rising: rising searches Google listed, if any.
export type TrendLine = { at: string; points: number[]; now: number | null; rising: string[] }
export type TrendEntry = TrendLine | { at: string; error: string }
// The last check: how many were asked and got a line, and why the others didn't.
export type TrendsRun = { at: string; by: string; asked: number; got: number; reasons: Record<string, number>; stopped?: string }

const file = jsonFileStore<{ keywords: Record<string, TrendEntry>; lastRun?: TrendsRun }>("seo-trends.json", () => ({ keywords: {} }))
export const getTrends = async () => (await file.read()).keywords ?? {}

// The last check; for checks made before DealTrack kept it, worked out from the answers kept.
export async function getTrendsRun(): Promise<TrendsRun | null> {
  const f = await file.read()
  if (f.lastRun) return f.lastRun
  const entries = Object.values(f.keywords ?? {})
  if (!entries.length) return null
  const reasons: Record<string, number> = {}
  for (const e of entries) if ("error" in e) reasons[reasonOf(e.error)] = (reasons[reasonOf(e.error)] ?? 0) + 1
  return { at: entries.map((e) => e.at).sort().at(-1)!, by: "", asked: entries.length, got: entries.filter((e) => "points" in e).length, reasons }
}

export const trendsUrl = (keyword: string, geo = TRENDS_GEO) =>
  `https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}&geo=${geo}&date=today%2012-m&brd_trends=timeseries&brd_json=1`

// ---- Reading Bright Data's answer -----------------------------------------------------------------

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null

// A point's value, as Google writes it ({value: [52]}) or as others do ({values: [{extracted_value: 52}]}, {value: 52}).
function valueOf(x: Record<string, unknown>): number | null {
  for (const v of [x.value, x.values, x.extracted_value]) {
    const n = num(v)
    if (n !== null) return n
    if (Array.isArray(v) && v.length) {
      const m = num(v[0])
      if (m !== null) return m
      if (v[0] && typeof v[0] === "object") {
        const o = v[0] as Record<string, unknown>
        const e = num(o.extracted_value) ?? num(o.value)
        if (e !== null) return e
      }
    }
  }
  return null
}
const isPoint = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && ["time", "date", "formattedTime", "formattedAxisTime", "timestamp"].some((k) => k in x) && valueOf(x as Record<string, unknown>) !== null

// Every list in the answer, a few levels down.
function lists(raw: unknown, depth = 0, out: unknown[][] = []): unknown[][] {
  if (depth > 7 || !raw || typeof raw !== "object") return out
  if (Array.isArray(raw)) {
    out.push(raw)
    for (const x of raw.slice(0, 60)) lists(x, depth + 1, out)
  } else for (const v of Object.values(raw)) lists(v, depth + 1, out)
  return out
}

// The weekly line (and rising searches) out of Bright Data's Trends answer: the longest list of
// 8 or more dated values in it.
export function readTrends(raw: unknown, keyword = ""): TrendLine | null {
  const all = lists(raw)
  const line = all.filter((a) => a.length >= 8 && a.every(isPoint)).sort((a, b) => b.length - a.length)[0]
  if (!line) return null
  const points = line.map((p) => valueOf(p as Record<string, unknown>) ?? 0)
  const avg = points.reduce((s, n) => s + n, 0) / points.length
  const last = points.slice(-4)
  const recent = last.reduce((s, n) => s + n, 0) / last.length
  const queries = all.flatMap((a) => a.filter((x): x is { query: string } => !!x && typeof x === "object" && typeof (x as { query?: unknown }).query === "string"))
  const rising = [...new Set(queries.map((x) => x.query.trim().toLowerCase()).filter((q) => q && q !== keyword.toLowerCase()))].slice(0, 10)
  return { at: new Date().toISOString(), points, now: avg > 0 ? recent / avg : null, rising }
}

// What an answer without a line held, for the page: "general, input, widgets (3)".
export function describeAnswer(raw: unknown) {
  if (!raw || typeof raw !== "object") return "nothing"
  const parts = Object.entries(raw as Record<string, unknown>).map(([k, v]) => (Array.isArray(v) ? `${k} (${v.length})` : k))
  return parts.length ? parts.join(", ").slice(0, 140) : "an empty answer"
}

// ---- Which keywords, and the check ---------------------------------------------------------------

// A line is good for 30 days; a keyword that got none is tried again after 7.
export const trendsFresh = (e: TrendEntry | undefined | null) => !!e && Date.now() - Date.parse(e.at) < ("error" in e ? RETRY_DAYS : KEEP_DAYS) * DAY

// Keywords a check takes: 10, or 1 while the last check got nothing back (a 1-keyword test that
// got nothing keeps it at 1).
export const trendsLimit = (run: TrendsRun | null) => (run && run.asked > 0 && run.got === 0 ? 1 : TRENDS_PER_RUN)

const job = shared("trends-job", () => ({ running: false, total: 0, done: 0, current: "", started: 0 }))
export const trendsProgress = () =>
  job.running ? { total: job.total, done: job.done, current: job.current, started: new Date(job.started).toISOString() } : null

// A short reason, to count alike ones together: "Bright Data didn't answer in 120 seconds".
export const reasonOf = (error: string) => error.replace(/\s*\(.*$/, "").replace(/\.$/, "")

async function runCheck(todo: string[], by: string) {
  const reasons: Record<string, number> = {}
  let got = 0
  let stopped = ""
  for (const k of todo) {
    job.current = k
    let entry: TrendEntry
    try {
      const raw = await brightRequest(trendsUrl(k), "trends", { timeoutMs: TIMEOUT_MS })
      entry = readTrends(raw, k) ?? { at: new Date().toISOString(), error: `Bright Data's answer had no Trends line (it held: ${describeAnswer(raw)})` }
    } catch (e) {
      if (e instanceof FreeSearchesUsedUp || (e instanceof BrightDataError && e.fatal)) {
        stopped = e.message
        break
      }
      entry = { at: new Date().toISOString(), error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }
    }
    if ("points" in entry) got++
    else reasons[reasonOf(entry.error)] = (reasons[reasonOf(entry.error)] ?? 0) + 1
    job.done++
    await file.update((f) => {
      f.keywords ??= {}
      f.keywords[k] = entry
    })
  }
  const asked = job.done
  await file.update((f) => {
    f.lastRun = { at: new Date().toISOString(), by, asked, got, reasons, ...(stopped ? { stopped } : {}) }
  })
}

// Starts a check in the background: the picked keywords, else the first ones without a fresh
// answer, one at a time. Returns at once; the page shows how far it got.
export async function startTrendsCheck(keywords: string[], picked: boolean, by: string): Promise<{ ok: boolean; message: string }> {
  if (job.running) return { ok: false, message: "A Google Trends check is already running. It shows here as it goes." }
  const saved = await getTrends()
  const todo = [...new Set(keywords.map((k) => normalizeKeyword(k)).filter((k): k is string => Boolean(k)))]
    // A picked keyword is checked again unless it has a line from the last 30 days.
    .filter((k) => (picked ? !(saved[k] && "points" in saved[k] && trendsFresh(saved[k])) : !trendsFresh(saved[k])))
    .slice(0, trendsLimit(await getTrendsRun()))
  if (!todo.length) return { ok: true, message: "Those keywords all have a Google Trends line from the last 30 days." }
  Object.assign(job, { running: true, total: todo.length, done: 0, current: "", started: Date.now() })
  after(() =>
    runCheck(todo, by)
      .catch(() => undefined)
      .finally(() => Object.assign(job, { running: false, current: "" })),
  )
  return {
    ok: true,
    message: `Checking ${todo.length === 1 ? `“${todo[0]}”` : `${todo.length} keywords`} with Google Trends in the background, one at a time (up to 2 minutes each). You can leave this page.`,
  }
}
