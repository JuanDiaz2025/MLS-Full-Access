// Bright Data's free tier: 5,000 Google searches a month. DealTrack keeps itself under it on its
// own: every Bright Data search is counted here before it's made, and none is made once 4,800 were
// made in the last 32 days, so no billing month can go over, whenever it starts and in any time
// zone. BRIGHTDATA_MONTHLY_CAP can lower the limit (2,400 on each of two computers sharing one
// Bright Data account, say), never raise it. A search Bright Data says it couldn't make (it doesn't
// count those) is given back. Saved in .data/brightdata-usage.json, a count per day (UTC), what
// each was for, and the ones given back (the header's Bright Data meter shows all three).
import { jsonFileStore } from "@/lib/json-file-store"

export const FREE_LIMIT = 4800
export const WINDOW_DAYS = 32
const DAY = 86_400_000

// What a search was for: the weekly Competitor ads searches, a Google rankings scan, a Google
// Trends check on the SEO page, or a test search.
export type SearchUse = "sampler" | "scan" | "trends" | "test"
export const SEARCH_USES: SearchUse[] = ["sampler", "scan", "trends", "test"]

type UsageFile = { days: Record<string, number>; uses?: Record<string, Partial<Record<SearchUse, number>>>; failed?: Record<string, number> }
const file = jsonFileStore<UsageFile>("brightdata-usage.json", () => ({ days: {} }))

export function freeCap() {
  const n = Math.floor(Number(process.env.BRIGHTDATA_MONTHLY_CAP))
  return n > 0 ? Math.min(FREE_LIMIT, n) : FREE_LIMIT
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)
const windowDays = (now: number) => Array.from({ length: WINDOW_DAYS }, (_, i) => dayOf(now - i * DAY))
const usedIn = (days: Record<string, number>, now: number) => windowDays(now).reduce((n, d) => n + (days[d] ?? 0), 0)

// used / left: in the last 32 days. week, month: the last 7 days and this calendar month (UTC).
// byUse: what the 32 days' searches were for ("other": counted before DealTrack kept that).
// failed: the ones Bright Data couldn't make, given back (not in used).
// daily: each of the 32 days, oldest first. nextFree: the oldest day's searches, and when they
// leave the 32 days. moreOn: when all are used, the day room comes back.
export type FreeSearches = {
  used: number
  cap: number
  left: number
  today: number
  week: number
  month: number
  byUse: Record<SearchUse | "other", number>
  failed: number
  daily: { day: string; n: number }[]
  nextFree?: { day: string; n: number }
  moreOn?: string
}

export async function freeSearches(): Promise<FreeSearches> {
  const f = await file.read()
  const days = f.days ?? {}
  const now = Date.now()
  const window = windowDays(now)
  const used = usedIn(days, now)
  const cap = freeCap()
  // Room comes back as the oldest days leave the 32.
  const oldest = window.findLast((d) => (days[d] ?? 0) > 0)
  const freeOn = (d: string) => dayOf(Date.parse(d) + WINDOW_DAYS * DAY)
  const byUse = { sampler: 0, scan: 0, trends: 0, test: 0, other: 0 }
  for (const d of window) {
    const uses = f.uses?.[d] ?? {}
    let known = 0
    for (const u of SEARCH_USES) {
      byUse[u] += uses[u] ?? 0
      known += uses[u] ?? 0
    }
    byUse.other += Math.max(0, (days[d] ?? 0) - known)
  }
  const month = dayOf(now).slice(0, 7)
  return {
    used,
    cap,
    left: Math.max(0, cap - used),
    today: days[dayOf(now)] ?? 0,
    week: window.slice(0, 7).reduce((n, d) => n + (days[d] ?? 0), 0),
    month: window.filter((d) => d.startsWith(month)).reduce((n, d) => n + (days[d] ?? 0), 0),
    byUse,
    failed: window.reduce((n, d) => n + (f.failed?.[d] ?? 0), 0),
    daily: [...window].reverse().map((d) => ({ day: d, n: days[d] ?? 0 })),
    ...(oldest ? { nextFree: { day: freeOn(oldest), n: days[oldest] ?? 0 } } : {}),
    ...(used >= cap && oldest ? { moreOn: freeOn(oldest) } : {}),
  }
}

// Takes `n` searches from what's left, for `use`. False, with nothing taken, if that would pass
// the limit. Called before each search, so a search that fails still counts: Bright Data bills
// only the ones that work, so the count can only be on the safe side.
export function takeFreeSearches(n = 1, use?: SearchUse): Promise<boolean> {
  return file.update((x) => {
    x.days ??= {}
    const now = Date.now()
    if (usedIn(x.days, now) + n > freeCap()) return false
    const today = dayOf(now)
    x.days[today] = (x.days[today] ?? 0) + n
    if (use) {
      x.uses ??= {}
      const t = (x.uses[today] ??= {})
      t[use] = (t[use] ?? 0) + n
    }
    const keep = new Set(windowDays(now))
    for (const d of Object.keys(x.days)) if (!keep.has(d)) delete x.days[d]
    for (const d of Object.keys(x.uses ?? {})) if (!keep.has(d)) delete x.uses![d]
    for (const d of Object.keys(x.failed ?? {})) if (!keep.has(d)) delete x.failed![d]
    return true
  })
}

// Gives back a search Bright Data said it couldn't make (an error instead of results): Bright Data
// doesn't count those. Taken from today's count; one taken just before midnight (UTC) stays
// counted, on the safe side.
export function giveBackFreeSearch(use?: SearchUse): Promise<void> {
  return file.update((x) => {
    const today = dayOf(Date.now())
    if (!x.days?.[today]) return
    x.days[today]--
    const t = x.uses?.[today]
    if (use && t?.[use]) t[use]!--
    x.failed ??= {}
    x.failed[today] = (x.failed[today] ?? 0) + 1
  })
}
