// The keyword list behind Competitors → Keyword explorer: every keyword we research, where it came
// from, and its search volume and bids from Keyword Planner. Saved in .data/research-keywords.json.
// Only keyword data lives here, never our own ad results (those are in Google Ads already).
import { GoogleAdsError, adsPost } from "@/lib/google-ads/client"
import { jsonFileStore } from "@/lib/json-file-store"
import type { ParsedKeyword } from "@/lib/research/parse"
import { normalizeKeyword } from "@/lib/research/parse"

export type KeywordSource = "ads-report" | "planner" | "suggest" | "upload" | "manual"
export const SOURCE_LABELS: Record<KeywordSource, string> = {
  "ads-report": "Our Google Ads keywords",
  planner: "Keyword Planner",
  suggest: "Google suggestions",
  upload: "Uploaded file",
  manual: "Added by hand",
}

export type ResearchKeyword = {
  text: string
  sources: KeywordSource[]
  addedAt: string
  volume?: number // average monthly searches
  cpcLow?: number // top-of-page bid range, dollars
  cpcHigh?: number
  competition?: string // Low / Medium / High
  trend?: number[] // monthly searches, oldest first
  volumeFrom?: "api" | "csv"
  volumeAt?: string
  // Keyword Planner run for one city (or several added together), by that place's name: "San Francisco".
  // The fields above are for all of California.
  local?: Record<string, LocalVolume>
}

export type LocalVolume = { volume?: number; cpcLow?: number; cpcHigh?: number; competition?: string; trend?: number[]; at: string }

export const STATEWIDE_VOLUMES = "California"
const isStatewide = (location?: string) => !location || location.toLowerCase() === STATEWIDE_VOLUMES.toLowerCase()

// The places with their own volumes, most keywords first.
export function volumeLocations(keywords: ResearchKeyword[]) {
  const count = new Map<string, number>()
  for (const k of keywords)
    for (const [place, v] of Object.entries(k.local ?? {})) if (v.volume !== undefined) count.set(place, (count.get(place) ?? 0) + 1)
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([place, keywords]) => ({ place, keywords }))
}

type Store = {
  keywords: Record<string, ResearchKeyword>
  imports: { at: string; what: string; added: number; updated: number }[]
  volumesNote?: string
}
const file = jsonFileStore<Store>("research-keywords.json", () => ({ keywords: {}, imports: [] }))

export async function getResearch() {
  const s = await file.read()
  // Keyword lists uploaded before "Uploaded file" existed were saved as added by hand; their
  // import's time matches the keywords' addedAt exactly.
  const uploads = new Set((s.imports ?? []).filter((i) => i.what.startsWith("Keyword list")).map((i) => i.at))
  for (const k of Object.values(s.keywords ?? {})) {
    if (uploads.has(k.addedAt) && k.sources.includes("manual")) k.sources = k.sources.map((x) => (x === "manual" ? "upload" : x))
  }
  return { keywords: Object.values(s.keywords ?? {}), imports: s.imports ?? [], volumesNote: s.volumesNote }
}

const MAX_KEYWORDS = 20_000

// Adds keywords (and, from Keyword Planner, their volumes: California's, or a city's when the export
// was run for one). Returns how many were new and updated.
export async function addKeywords(rows: ParsedKeyword[], source: KeywordSource, what: string, location?: string) {
  const now = new Date().toISOString()
  return file.update((s) => {
    s.keywords ??= {}
    s.imports ??= []
    let added = 0
    let updated = 0
    for (const r of rows.slice(0, MAX_KEYWORDS)) {
      const text = normalizeKeyword(r.text)
      if (!text) continue
      let k = s.keywords[text]
      if (!k) {
        if (Object.keys(s.keywords).length >= MAX_KEYWORDS) break
        k = s.keywords[text] = { text, sources: [], addedAt: now }
        added++
      } else if (r.volume !== undefined) updated++
      if (!k.sources.includes(source)) k.sources.push(source)
      if (r.volume !== undefined && !isStatewide(location)) {
        k.local ??= {}
        k.local[location!] = { volume: r.volume, cpcLow: r.cpcLow, cpcHigh: r.cpcHigh, competition: r.competition, trend: r.trend, at: now }
      } else if (r.volume !== undefined) {
        Object.assign(k, {
          volume: r.volume,
          cpcLow: r.cpcLow,
          cpcHigh: r.cpcHigh,
          competition: r.competition,
          trend: r.trend,
          volumeFrom: "csv",
          volumeAt: now,
        })
      }
    }
    s.imports.unshift({ at: now, what, added, updated })
    s.imports = s.imports.slice(0, 20)
    return { added, updated }
  })
}

export async function removeKeywords(texts: string[]) {
  const drop = new Set(texts)
  return file.update((s) => {
    let removed = 0
    for (const t of drop) if (s.keywords?.[t] && delete s.keywords[t]) removed++
    return removed
  })
}

// ---- Keyword Planner (Google Ads API): volume, bids and competition for a list --------------
// California, English, Google Search. Up to 10,000 keywords per request, one API operation each.
// Needs Basic access on the developer token; with Explorer access Google refuses, and the page
// offers the CSV route instead.
const CALIFORNIA = "geoTargetConstants/21137"
const ENGLISH = "languageConstants/1000"

type Metrics = {
  avgMonthlySearches?: string | number
  competition?: string
  lowTopOfPageBidMicros?: string | number
  highTopOfPageBidMicros?: string | number
  monthlySearchVolumes?: { year?: string | number; month?: string; monthlySearches?: string | number }[]
}

const COMPETITION: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" }
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"]

export async function fetchVolumes(): Promise<{ ok: boolean; message: string }> {
  const { keywords } = await getResearch()
  const texts = keywords.map((k) => k.text).filter((t) => t.split(" ").length <= 10)
  if (!texts.length) return { ok: false, message: "Add keywords first." }
  const now = new Date().toISOString()
  const found = new Map<string, Metrics>()
  try {
    for (let i = 0; i < texts.length; i += 10_000) {
      const body = await adsPost<{ results?: { text?: string; closeVariants?: string[]; keywordMetrics?: Metrics }[] }>(
        ":generateKeywordHistoricalMetrics",
        {
          keywords: texts.slice(i, i + 10_000),
          geoTargetConstants: [CALIFORNIA],
          language: ENGLISH,
          keywordPlanNetwork: "GOOGLE_SEARCH",
        },
      )
      for (const r of body.results ?? []) {
        if (!r.keywordMetrics) continue
        for (const t of [r.text, ...(r.closeVariants ?? [])]) {
          const k = t && normalizeKeyword(t)
          if (k && !found.has(k)) found.set(k, r.keywordMetrics)
        }
      }
    }
  } catch (e) {
    const explorer = e instanceof GoogleAdsError && /explorer|basic or standard|not allowed|permission/i.test(`${e.message} ${e.detail ?? ""}`)
    const message = explorer
      ? "Google only gives Keyword Planner numbers to apps with Basic access, and ours has Explorer access for now. Use the Keyword Planner CSV instead (steps below)."
      : `Keyword Planner didn't answer: ${e instanceof Error ? e.message : String(e)}`
    await file.update((s) => {
      s.volumesNote = message
    })
    return { ok: false, message }
  }
  const micros = (v?: string | number) => (v === undefined ? undefined : Math.round(Number(v) / 10_000) / 100)
  await file.update((s) => {
    for (const [text, m] of found) {
      const k = s.keywords[text]
      if (!k) continue
      const trend = (m.monthlySearchVolumes ?? [])
        .map((v) => ({ at: Number(v.year) * 12 + MONTHS.indexOf(String(v.month)), n: Number(v.monthlySearches ?? 0) }))
        .sort((a, b) => a.at - b.at)
        .map((v) => v.n)
      Object.assign(k, {
        volume: Number(m.avgMonthlySearches ?? 0),
        cpcLow: micros(m.lowTopOfPageBidMicros),
        cpcHigh: micros(m.highTopOfPageBidMicros),
        competition: COMPETITION[String(m.competition)] ?? undefined,
        trend: trend.length ? trend : undefined,
        volumeFrom: "api",
        volumeAt: now,
      })
      if (!k.sources.includes("planner")) k.sources.push("planner")
    }
    delete s.volumesNote
  })
  return {
    ok: true,
    message: `Keyword Planner returned numbers for ${found.size.toLocaleString("en-US")} of ${texts.length.toLocaleString("en-US")} keywords (California).`,
  }
}

// ---- Google suggestions: more keyword ideas from what Google offers as people type -----------
// The seed on its own, then the seed followed by each letter, like keyword tools do. A few dozen
// light requests per seed, one at a time. Only suggestions about selling a home are kept.
const SELLER_WORDS = /sell|buy|house|home|cash|propert|offer|investor|probate|inherit|foreclos|land|condo|realtor|as is|fixer|fast|quick/

export async function suggestKeywords(seed: string): Promise<{ ok: boolean; message: string; added?: number }> {
  const base = normalizeKeyword(seed)
  if (!base) return { ok: false, message: "Type a keyword to start from." }
  const queries = [base, ...[..."abcdefghijklmnopqrstuvwxyz"].map((c) => `${base} ${c}`)]
  const found = new Set<string>()
  for (const q of queries) {
    try {
      const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=${encodeURIComponent(q)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
        headers: { "user-agent": "Mozilla/5.0" },
      })
      if (!res.ok) continue
      const body = (await res.json().catch(() => null)) as [string, string[]] | null
      for (const s of body?.[1] ?? []) {
        const k = normalizeKeyword(s)
        if (k && SELLER_WORDS.test(k)) found.add(k)
      }
    } catch {
      // one slow letter doesn't stop the rest
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  if (!found.size) return { ok: false, message: `Google had no home-selling suggestions for “${base}”.` }
  const { added } = await addKeywords(
    [...found].map((text) => ({ text })),
    "suggest",
    `Google suggestions for “${base}”`,
  )
  return { ok: true, added, message: `${found.size} suggestions for “${base}”, ${added} of them new.` }
}
