// Competitors → SEO: our own site's Google numbers from Search Console. Every search that showed
// twinhomebuyer.com in Google's free results, with clicks, views and average position, by search
// and by page. Google publishes it about two days late and leaves out rare searches (privacy), and
// it has no city or county breakdown: a city only shows when the search names it.
//
// It uses the "Connect Google" sign-in (lib/conversions/connect.ts), which now also asks for
// Search Console (read only). The property to read is picked once on the SEO page and saved in
// .data/search-console.json. The Search Console API has to be on in DealTrack's Google Cloud project.
import { SEARCH_CONSOLE_SCOPE, accessToken, getConnection } from "@/lib/conversions/google"
import { jsonFileStore } from "@/lib/json-file-store"
import { topicOf } from "@/lib/research/classify"
import { CTR } from "@/lib/research/serp-analysis"
import { shared } from "@/lib/shared-state"

export const SEARCH_CONSOLE_LIBRARY = "https://console.cloud.google.com/apis/library/searchconsole.googleapis.com"
const API = "https://searchconsole.googleapis.com/webmasters/v3"

// What to do about it: connect Google, connect again (for the new permission), turn the API on,
// get access to the property, pick a property, or try again later.
export type SearchConsoleCode = "NOT_CONNECTED" | "NEEDS_PERMISSION" | "API_OFF" | "NO_ACCESS" | "NO_SITE" | "TRANSIENT"
export class SearchConsoleError extends Error {
  constructor(
    message: string,
    readonly code: SearchConsoleCode,
  ) {
    super(message)
  }
}

const settings = jsonFileStore<{ site?: string; by?: string; at?: string }>("search-console.json", () => ({}))
export const searchConsoleSite = async () => (await settings.read()).site ?? null
export async function setSearchConsoleSite(site: string, by: string) {
  await settings.update((s) => {
    s.site = site
    s.by = by
    s.at = new Date().toISOString()
  })
  cache.reports.clear()
}

async function connection() {
  const c = await getConnection().catch(() => null)
  // DealTrack's own Google Ads key (from .env.local) can't read Search Console: an admin connects.
  if (!c || (c.source === "env" && !c.scopes.includes(SEARCH_CONSOLE_SCOPE)))
    throw new SearchConsoleError("Connect Google (an admin, once) so DealTrack can read Search Console.", "NOT_CONNECTED")
  if (!c.scopes.includes(SEARCH_CONSOLE_SCOPE))
    throw new SearchConsoleError(`Connect Google again so DealTrack can read Search Console (connected as ${c.email}).`, "NEEDS_PERMISSION")
  return c
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const c = await connection()
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${await accessToken(c)}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {
    throw new SearchConsoleError("Couldn't reach Search Console. Try again in a minute.", "TRANSIENT")
  })
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string; details?: { reason?: string }[] } }
  if (res.ok) return json
  const message = json.error?.message ?? `Search Console answered ${res.status}`
  if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(`${message} ${JSON.stringify(json.error?.details ?? "")}`))
    throw new SearchConsoleError("Turn on the Search Console API in DealTrack's Google Cloud project, then try again.", "API_OFF")
  if (res.status === 401 || /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message))
    throw new SearchConsoleError(`Connect Google again so DealTrack can read Search Console (connected as ${c.email}).`, "NEEDS_PERMISSION")
  if (res.status === 403)
    throw new SearchConsoleError(`${c.email} can't open that Search Console property. Add it as a user there (Settings → Users and permissions).`, "NO_ACCESS")
  if (res.status === 429 || res.status >= 500) throw new SearchConsoleError("Search Console is busy. Try again in a few minutes.", "TRANSIENT")
  throw new SearchConsoleError(message.slice(0, 200), "TRANSIENT")
}

// The properties the connected account can read, ours first.
export async function listSites(): Promise<{ site: string; level: string }[]> {
  const body = await call<{ siteEntry?: { siteUrl?: string; permissionLevel?: string }[] }>("/sites")
  return (body.siteEntry ?? [])
    .filter((s) => s.siteUrl && s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => ({ site: s.siteUrl!, level: s.permissionLevel ?? "" }))
    .sort((a, b) => Number(/twinhomebuyer/i.test(b.site)) - Number(/twinhomebuyer/i.test(a.site)) || a.site.localeCompare(b.site))
}

// ---- The report ---------------------------------------------------------------------------------

type Row = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }
export type Numbers = { clicks: number; impressions: number; ctr: number; position: number }
export type ScQuery = Numbers & { q: string; page?: string; prev?: Numbers }
export type ScPage = Numbers & { page: string; prev?: Numbers }
export type ScReport = {
  site: string
  days: number
  current: { from: string; to: string }
  previous: { from: string; to: string }
  totals: Numbers
  prevTotals: Numbers
  daily: { date: string; clicks: number; impressions: number }[]
  queries: ScQuery[]
  pages: ScPage[]
  // Of 100 people who see us at positions 1 to 10, how many click: ours where we have enough views
  // (not counting searches for our name), Google's usual numbers where we don't.
  ctrCurve: { position: number; ctr: number; ours: boolean }[]
  fetchedAt: string
}

const cache = shared("search-console-cache", () => ({ reports: new Map<string, { at: number; report: ScReport }>() }))
const KEEP_MS = 60 * 60_000

// A day in Pacific time (Search Console's days), `offset` days from today: "2026-10-12".
function pacificDay(offset: number, from = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    from + offset * 86_400_000,
  )
}

const numbers = (r?: Row): Numbers => ({
  clicks: r?.clicks ?? 0,
  impressions: r?.impressions ?? 0,
  ctr: r?.ctr ?? 0,
  position: r?.position ?? 0,
})

function total(rows: Row[]): Numbers {
  const clicks = rows.reduce((s, r) => s + (r.clicks ?? 0), 0)
  const impressions = rows.reduce((s, r) => s + (r.impressions ?? 0), 0)
  const weighted = rows.reduce((s, r) => s + (r.position ?? 0) * (r.impressions ?? 0), 0)
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? weighted / impressions : 0 }
}

export async function searchConsoleReport(days = 28, fresh = false): Promise<ScReport> {
  const site = await searchConsoleSite()
  if (!site) throw new SearchConsoleError("Pick the Search Console property to read.", "NO_SITE")
  const key = `${site}|${days}`
  const hit = cache.reports.get(key)
  if (!fresh && hit && Date.now() - hit.at < KEEP_MS) return hit.report

  // Google's numbers settle about two days after the day.
  const current = { from: pacificDay(-(days + 1)), to: pacificDay(-2) }
  const previous = { from: pacificDay(-(days * 2 + 1)), to: pacificDay(-(days + 2)) }
  const path = `/sites/${encodeURIComponent(site)}/searchAnalytics/query`
  const ask = (range: { from: string; to: string }, dimensions: string[], rowLimit: number) =>
    call<{ rows?: Row[] }>(path, { startDate: range.from, endDate: range.to, dimensions, rowLimit, type: "web" }).then((b) => b.rows ?? [])
  const [daily, queries, prevQueries, pages, prevPages, queryPages] = await Promise.all([
    ask({ from: previous.from, to: current.to }, ["date"], 500),
    ask(current, ["query"], 5000),
    ask(previous, ["query"], 5000),
    ask(current, ["page"], 1000),
    ask(previous, ["page"], 1000),
    ask(current, ["query", "page"], 5000),
  ])

  const prevQ = new Map(prevQueries.map((r) => [r.keys?.[0] ?? "", numbers(r)]))
  const prevP = new Map(prevPages.map((r) => [r.keys?.[0] ?? "", numbers(r)]))
  // The page that got the most views for each search.
  const bestPage = new Map<string, Row>()
  for (const r of queryPages) {
    const q = r.keys?.[0] ?? ""
    if ((bestPage.get(q)?.impressions ?? -1) < (r.impressions ?? 0)) bestPage.set(q, r)
  }
  const inRange = (d: string, range: { from: string; to: string }) => d >= range.from && d <= range.to
  const dailyRows = daily.map((r) => ({ date: r.keys?.[0] ?? "", clicks: r.clicks ?? 0, impressions: r.impressions ?? 0 }))

  const report: ScReport = {
    site,
    days,
    current,
    previous,
    totals: total(daily.filter((r) => inRange(r.keys?.[0] ?? "", current))),
    prevTotals: total(daily.filter((r) => inRange(r.keys?.[0] ?? "", previous))),
    daily: dailyRows.filter((r) => inRange(r.date, current)).sort((a, b) => a.date.localeCompare(b.date)),
    queries: queries.map((r) => {
      const q = r.keys?.[0] ?? ""
      return { q, ...numbers(r), page: bestPage.get(q)?.keys?.[1], prev: prevQ.get(q) }
    }),
    pages: pages.map((r) => ({ page: r.keys?.[0] ?? "", ...numbers(r), prev: prevP.get(r.keys?.[0] ?? "") })),
    ctrCurve: ctrCurve(queries),
    fetchedAt: new Date().toISOString(),
  }
  cache.reports.set(key, { at: Date.now(), report })
  return report
}

// Our own click rate at each position 1 to 10, from searches that aren't for our name (those get
// clicked far more). A position needs 50 views of ours to count; otherwise Google's usual rate.
function ctrCurve(rows: Row[]) {
  const sum = Array.from({ length: 10 }, () => ({ clicks: 0, impressions: 0 }))
  for (const r of rows) {
    const p = Math.round(r.position ?? 0)
    if (p < 1 || p > 10 || topicOf(r.keys?.[0] ?? "") === "brand") continue
    sum[p - 1].clicks += r.clicks ?? 0
    sum[p - 1].impressions += r.impressions ?? 0
  }
  return sum.map((s, i) =>
    s.impressions >= 50 ? { position: i + 1, ctr: s.clicks / s.impressions, ours: true } : { position: i + 1, ctr: CTR[i], ours: false },
  )
}

// Our click rate for a position (1 to 10), else 0: what estimated visits use.
export function ctrAt(curve: ScReport["ctrCurve"] | null, position: number | null | undefined) {
  if (!position || position < 1) return 0
  const p = Math.round(position)
  if (p > 10) return 0
  return curve?.[p - 1]?.ctr ?? CTR[p - 1] ?? 0
}

// What the page shows for Search Console: connected or what's missing, the property, the report.
export type SearchConsoleState =
  | { ok: true; site: string; email: string; report: ScReport }
  | { ok: false; code: SearchConsoleCode; message: string; email?: string; site?: string | null; sites?: { site: string; level: string }[] }

export async function searchConsoleState(days = 28): Promise<SearchConsoleState> {
  const c = await getConnection().catch(() => null)
  // The Google account an admin connected (not DealTrack's own Google Ads key).
  const email = c?.source === "connected" ? c.email : undefined
  const site = await searchConsoleSite()
  try {
    if (!site) {
      const sites = await listSites()
      return { ok: false, code: "NO_SITE", message: "Pick the Search Console property to read.", email, site: null, sites }
    }
    return { ok: true, site, email: email ?? "", report: await searchConsoleReport(days) }
  } catch (e) {
    if (e instanceof SearchConsoleError) {
      const sites = e.code === "NO_ACCESS" ? await listSites().catch(() => undefined) : undefined
      return { ok: false, code: e.code, message: e.message, email, site, sites }
    }
    return { ok: false, code: "TRANSIENT", message: e instanceof Error ? e.message : String(e), email, site }
  }
}
