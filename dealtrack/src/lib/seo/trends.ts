// Competitors → SEO → Keywords: is a search rising or falling right now? Google Trends, through
// Bright Data, for California: a week-by-week line for the last 12 months (0 to 100, Google's
// scale, not a count), and the rising searches around it when Google gives them. Keyword Planner's
// numbers are a month or two behind; this is this week's.
//
// Each keyword checked uses one of Bright Data's free searches, so it only runs when someone asks
// (a few at a time), and an answer is kept 30 days in .data/seo-trends.json. Bright Data's
// documentation is thin on Trends: an answer without the line is kept as "no answer", not guessed.
import { BrightDataError, FreeSearchesUsedUp, brightRequest } from "@/lib/competitors/brightdata"
import { jsonFileStore } from "@/lib/json-file-store"
import { normalizeKeyword } from "@/lib/research/parse"

export const TRENDS_GEO = "US-CA"
const KEEP_DAYS = 30
export const TRENDS_PER_RUN = 10

// points: weekly 0-100 values, oldest first; now: the last 4 weeks against the year's average
// (1.2 = 20% above); rising: rising searches Google listed, if any.
export type TrendLine = { at: string; points: number[]; now: number | null; rising: string[] }
export type TrendEntry = TrendLine | { at: string; error: string }

const file = jsonFileStore<{ keywords: Record<string, TrendEntry> }>("seo-trends.json", () => ({ keywords: {} }))
export const getTrends = async () => (await file.read()).keywords ?? {}

export const trendsUrl = (keyword: string, geo = TRENDS_GEO) =>
  `https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}&geo=${geo}&date=today%2012-m&brd_trends=timeseries&brd_json=1`

type Widget = { id?: string; type?: string; data?: { default?: { timelineData?: { value?: number[]; hasData?: boolean[] }[]; rankedList?: { rankedKeyword?: { query?: string }[] }[] } } }

// The weekly line (and rising searches) out of Bright Data's Trends answer.
export function readTrends(raw: unknown): TrendLine | null {
  const widgets = (raw as { widgets?: Widget[] })?.widgets
  if (!Array.isArray(widgets)) return null
  const line = widgets.find((w) => w?.id === "TIMESERIES" || w?.type === "fe_line_chart")?.data?.default?.timelineData
  if (!Array.isArray(line) || line.length < 8) return null
  const points = line.map((p) => Number(p?.value?.[0] ?? 0)).map((n) => (Number.isFinite(n) ? n : 0))
  const avg = points.reduce((s, n) => s + n, 0) / points.length
  const last = points.slice(-4)
  const recent = last.reduce((s, n) => s + n, 0) / last.length
  const rising = widgets
    .flatMap((w) => w?.data?.default?.rankedList ?? [])
    .flatMap((l) => l?.rankedKeyword ?? [])
    .map((k) => String(k?.query ?? "").trim())
    .filter(Boolean)
    .slice(0, 10)
  return { at: new Date().toISOString(), points, now: avg > 0 ? recent / avg : null, rising }
}

// Asked in the last 30 days (an answer or not): not asked again yet.
export const trendsFresh = (at: string | null | undefined) => !!at && Date.now() - Date.parse(at) < KEEP_DAYS * 86_400_000
const fresh = (e: TrendEntry | undefined) => trendsFresh(e?.at)

// Checks up to TRENDS_PER_RUN keywords that have no answer from the last 30 days, one at a time.
export async function checkTrends(keywords: string[]): Promise<{ ok: boolean; message: string }> {
  const saved = await getTrends()
  const todo = [...new Set(keywords.map((k) => normalizeKeyword(k)).filter((k): k is string => Boolean(k)))]
    .filter((k) => !fresh(saved[k]))
    .slice(0, TRENDS_PER_RUN)
  if (!todo.length) return { ok: true, message: "Those keywords were all checked in the last 30 days." }
  let got = 0
  let none = 0
  let stop = ""
  for (const k of todo) {
    let entry: TrendEntry
    try {
      const line = readTrends(await brightRequest(trendsUrl(k), "trends"))
      entry = line ?? { at: new Date().toISOString(), error: "Google Trends gave no line for this search (too few searches, or Bright Data didn't return it)." }
      if (line) got++
      else none++
    } catch (e) {
      if (e instanceof FreeSearchesUsedUp || (e instanceof BrightDataError && e.fatal)) {
        stop = e.message
        break
      }
      entry = { at: new Date().toISOString(), error: e instanceof Error ? e.message.slice(0, 160) : String(e) }
      none++
    }
    await file.update((f) => {
      f.keywords ??= {}
      f.keywords[k] = entry
    })
  }
  const parts = [`${got} checked`, none ? `${none} without a line` : "", stop].filter(Boolean)
  return { ok: !stop || got > 0, message: `Google Trends: ${parts.join(", ")}.` }
}
