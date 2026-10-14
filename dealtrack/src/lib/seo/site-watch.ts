// Competitors → SEO → Competitor watch: a polite look at each watched competitor's website, once a
// week by default, for what they're building: new city and seller-situation pages, pages taken
// down, and changes to titles, headlines, headings, offers, cities and phone numbers.
//
// The rules (Leo's): robots.txt is read first and followed, crawl delay included (two seconds
// between visits at the least); a site that blocks or slows us down is left until the next check,
// never got around (after three checks in a row it waits for "Check now"); public pages only, read
// as "DealTrackBot" with our website as the contact. Pages come from the site's sitemap (else the
// links on its home page): its home page, then new pages, then city, situation and selling pages,
// at most 150 a check, the rest in the checks after. No Bright Data searches: ordinary visits to
// public pages, from this computer.
//
// A site's first check is the starting point; changes show from the check after. Each change waits
// for someone to mark it Act, Watch or Ignore. Patterns: the same city, seller situation or offer
// at two or more competitors within four weeks.
//
// Files in .data/seo-watch/: settings.json (the settings and each site's last check),
// changes.json, and one file of pages per site.
import { rm } from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"

import { after } from "next/server"

import { jsonFileStore } from "@/lib/json-file-store"
import { getWatchList, type WatchedSite } from "@/lib/seo/competitors"
import { USER_AGENT, allowed, isPageUrl, linksIn, pagePriority, parseRobots, parseSitemap, readPage, refusalOf, urlFacts, type PageSnap, type Robots } from "@/lib/seo/page-read"
import { shared } from "@/lib/shared-state"
import { DATA_DIR } from "@/lib/store"

export type WatchSettings = { on: boolean; every: number; maxPages: number; by?: string; at?: string }
export const EVERY_CHOICES = [3, 7, 14] // days
export const PAGE_CHOICES = [50, 150, 300]
const DEFAULT_SETTINGS: WatchSettings = { on: true, every: 7, maxPages: 150 }

export type SiteRun = {
  at: string
  took: number // seconds
  source: "sitemap" | "links" | null
  listed: number // pages the site has: in its sitemap, else linked from its home page
  read: number // pages read in this check
  notAllowed: number // pages its robots.txt asks robots not to read: left out
  changes: number
  baseline?: boolean // the first check: the starting point
  blocked?: string // the site blocked or slowed us down: stopped there
  blockedRuns?: number // checks in a row it blocked us; after 3, it waits for "Check now"
  problem?: string // couldn't finish (the site was down...): tried again the next day
  note?: string
  places?: Record<string, number> // pages about each city (all pages so far, not just this check)
  situations?: Record<string, number>
}

type WatchFile = { settings: WatchSettings; runs: Record<string, SiteRun>; asked?: string[] }
type StoredPage = { first: string; lastmod?: string; read?: string; snap?: PageSnap; unlisted?: boolean; gone?: string; movedTo?: string }
type SiteFile = { site: string; source?: "sitemap" | "links"; at?: string; pages: Record<string, StoredPage> }

export type Facts = Pick<PageSnap, "title" | "h1" | "desc" | "offers" | "places" | "situations" | "phones" | "words">
export type Diff = { headings: string[]; offers: string[]; places: string[]; situations: string[]; phones: string[] }
export type ChangeStatus = "new" | "act" | "watch" | "ignore"
export type Change = {
  id: string
  at: string
  site: string
  url: string
  kind: "new" | "removed" | "changed"
  what: string[] // "New page", "Title", "Headline", "Offers"...
  before?: Facts
  after?: Facts
  added?: Diff
  removed?: Diff
  movedTo?: string
  tags: { places: string[]; situations: string[]; offers: string[] } // what it's about, for patterns
  status: ChangeStatus
  note?: string
  by?: string
  decidedAt?: string
}

const MAX_CHANGES = 2000
const MAX_CHANGES_A_CHECK = 300 // a site redesign changes every page: the first 300 are kept
const MAX_LISTED = 2000
const GONE_CHECKS = 25 // pages gone from the sitemap, looked at a check
const SITE_MINUTES = 25
const TICK_MINUTES = 50
const MAX_BYTES = 3_000_000
const TIMEOUT_MS = 20_000
const DAY = 86_400_000
// The fake competitor sites the tests run may go faster; real sites never.
const minGap = () => (process.env.DEALTRACK_LOCAL_SITES === "1" && process.env.DEALTRACK_WATCH_GAP_MS ? Math.max(0, Number(process.env.DEALTRACK_WATCH_GAP_MS) || 0) : 2000)

const DIR = "seo-watch"
const settingsFile = jsonFileStore<WatchFile>(`${DIR}/settings.json`, () => ({ settings: DEFAULT_SETTINGS, runs: {} }))
const changesFile = jsonFileStore<{ changes: Change[] }>(`${DIR}/changes.json`, () => ({ changes: [] }))
const siteFileName = (site: string) => `${DIR}/site-${site.toLowerCase().replace(/[^a-z0-9.-]+/g, "_")}.json`
const siteFile = (site: string) => jsonFileStore<SiteFile>(siteFileName(site), () => ({ site, pages: {} }))

const live = shared("site-watch", () => ({ busy: false, site: "", started: 0, read: 0, total: 0 }))
export const watchProgress = () =>
  live.busy && live.site ? { site: live.site, started: new Date(live.started).toISOString(), read: live.read, total: live.total } : null

// ---- Visiting a site ----------------------------------------------------------------------------

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const errText = (e: unknown) => {
  const cause = (e as { cause?: { code?: string } })?.cause?.code
  if ((e as Error)?.name === "TimeoutError") return "no answer in 20 seconds"
  return cause ?? (e instanceof Error ? e.message : String(e)).slice(0, 120)
}

type Got = { status: number; url: string; type: string; text: string; location: string | null; movedTo?: string }

async function bodyOf(res: Response, gz: boolean) {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      size += value.byteLength
      if (size >= MAX_BYTES) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  let buf = Buffer.concat(parts)
  // A sitemap.xml.gz sent as a file, not as a compressed page.
  if (gz && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf)
    } catch {
      // cut off at the size limit: read as is
    }
  }
  return buf.toString("utf8")
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "")
  } catch {
    return ""
  }
}
const sameSite = (a: string, b: string) => hostOf(a) !== "" && hostOf(a) === hostOf(b)
// The same page, give or take https, www and a closing slash.
const pageKey = (url: string) => {
  try {
    const u = new URL(url)
    return `${hostOf(url)}${u.pathname.toLowerCase().replace(/\/+$/, "")}${u.search}`
  } catch {
    return url
  }
}

export function cleanUrl(url: string) {
  try {
    const u = new URL(url)
    u.hash = ""
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid$|fbclid$|msclkid$)/i.test(k)) u.searchParams.delete(k)
    return u.href
  } catch {
    return ""
  }
}

// One per site check: it waits `gap()` between visits and follows moves within the site.
function visitor(gap: () => number) {
  let last = 0
  async function get(url: string): Promise<Got> {
    const wait = last + gap() - Date.now()
    if (wait > 0) await pause(wait)
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.8" },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const type = res.headers.get("content-type") ?? ""
      const ok = res.status >= 200 && res.status < 300
      // A robot check comes as a page with a 403 or 503: read to tell it from a plain refusal.
      const text = ok || res.status === 403 || res.status === 503 ? await bodyOf(res, /\.gz($|\?)/i.test(url) || /gzip/i.test(type)) : ""
      if (!text) await res.body?.cancel().catch(() => {})
      return { status: res.status, url, type, text, location: res.headers.get("location") }
    } finally {
      last = Date.now()
    }
  }
  async function visit(url: string, robots: Robots | null): Promise<Got> {
    let current = url
    for (let hop = 0; ; hop++) {
      const got = await get(current)
      if (![301, 302, 303, 307, 308].includes(got.status)) return got
      const next = cleanUrl(new URL(got.location ?? "", current).href)
      // Off to another site, somewhere robots.txt doesn't allow, or round and round: not followed.
      if (!next || hop >= 4 || !sameSite(next, url) || (robots && !allowed(robots, next))) return { ...got, movedTo: next || undefined }
      current = next
    }
  }
  return { visit }
}
type Visitor = ReturnType<typeof visitor>

class Refused extends Error {}

const SKIP_SITEMAP = /(image|video|tag|categor|author|attachment|format|taxonom|users)[^/]*sitemap|sitemap[^/]*(image|video|tag|categor|author|taxonom|users)/i
const sitemapRank = (url: string) => (/page|location|city|cities|area|service|landing/i.test(url) ? 0 : /post|blog|news|article/i.test(url) ? 2 : 1)

// The site's pages from its sitemaps: the ones robots.txt names, else the usual addresses.
async function readSitemaps(v: Visitor, home: string, robots: Robots) {
  const host = new URL(home).host
  const declared = robots.sitemaps.map(cleanUrl).filter((u) => u && sameSite(u, home))
  const queue = [...declared]
  const guesses = declared.length ? [] : ["/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml"].map((p) => new URL(p, home).href)
  const pages = new Map<string, string | undefined>()
  const seen = new Set<string>()
  let found = false
  let fetched = 0
  for (;;) {
    if (!queue.length && !found && guesses.length) queue.push(guesses.shift()!)
    const url = queue.shift()
    if (!url || fetched >= 12 || pages.size >= MAX_LISTED * 2) break
    if (seen.has(url) || !allowed(robots, url)) continue
    seen.add(url)
    fetched++
    const got = await v.visit(url, robots)
    const refused = refusalOf(got.status, got.text)
    if (refused?.blocked) throw new Refused(refused.blocked)
    if (got.status < 200 || got.status >= 300) continue
    const map = parseSitemap(got.text)
    if (!map.entries.length) continue
    found = true
    if (map.index) {
      const children = map.entries.map((e) => cleanUrl(e.url)).filter((u) => u && sameSite(u, home) && !SKIP_SITEMAP.test(u))
      queue.push(...children.sort((a, b) => sitemapRank(a) - sitemapRank(b)).slice(0, 10))
      continue
    }
    for (const e of map.entries) {
      const u = cleanUrl(e.url)
      if (u && isPageUrl(u, host)) pages.set(u, e.lastmod)
    }
  }
  return pages
}

// ---- Comparing ----------------------------------------------------------------------------------

const facts = (s: PageSnap): Facts => ({ title: s.title, h1: s.h1, desc: s.desc, offers: s.offers, places: s.places, situations: s.situations, phones: s.phones, words: s.words })
const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x))
const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase()

export function compare(before: PageSnap, after: PageSnap) {
  const what: string[] = []
  if (!same(before.title, after.title)) what.push("Title")
  if (!same(before.h1, after.h1)) what.push("Headline")
  if (!same(before.desc, after.desc)) what.push("Description")
  const diff = (a: PageSnap, b: PageSnap): Diff => ({
    headings: minus(a.h2, b.h2),
    offers: minus(a.offers, b.offers),
    places: minus(a.places, b.places),
    situations: minus(a.situations, b.situations),
    phones: minus(a.phones, b.phones),
  })
  const added = diff(after, before)
  const removed = diff(before, after)
  const changed = (k: keyof Diff) => added[k].length > 0 || removed[k].length > 0
  if (changed("headings")) what.push("Headings")
  if (changed("offers")) what.push("Offers")
  if (changed("places")) what.push("Cities")
  if (changed("situations")) what.push("Seller situations")
  if (changed("phones")) what.push("Phone")
  const grew = after.words - before.words
  if (before.words >= 100 && Math.abs(grew) >= 150 && Math.abs(grew) / before.words >= 0.25) what.push(grew > 0 ? "More text" : "Less text")
  return what.length ? { what, added, removed } : null
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const noTags = () => ({ places: [] as string[], situations: [] as string[], offers: [] as string[] })

// ---- One site -----------------------------------------------------------------------------------

async function checkSite(w: WatchedSite, settings: WatchSettings) {
  const started = Date.now()
  const at = new Date(started).toISOString()
  const run: SiteRun = { at, took: 0, source: null, listed: 0, read: 0, notAllowed: 0, changes: 0 }
  const changes: Change[] = []
  const store = siteFile(w.site)
  const saved = await store.read()
  saved.pages ??= {}
  const baseline = !saved.at
  let gap = minGap()
  const v = visitor(() => gap)
  const home = cleanUrl(w.url)
  const finish = () => {
    run.took = Math.round((Date.now() - started) / 1000)
    run.changes = changes.length
    return { run, changes: changes.slice(0, MAX_CHANGES_A_CHECK) }
  }
  const add = (kind: Change["kind"], url: string, rest: Partial<Change>) => {
    if (!baseline) changes.push({ id: newId(), at, site: w.site, url, kind, what: [], tags: noTags(), status: "new", ...rest })
  }

  // 1. robots.txt. Not there (404): everything may be read. Can't be read (a server error): nothing
  // may (the robots.txt standard).
  let robots: Robots
  try {
    const got = await v.visit(new URL("/robots.txt", home).href, null)
    const refused = refusalOf(got.status, got.text)
    if (refused?.blocked) {
      run.blocked = refused.blocked
      return finish()
    }
    if (got.status >= 300 && got.status < 400) {
      run.problem = "Its robots.txt sends visitors to another site, so nothing was read."
      return finish()
    }
    if (got.status >= 500) {
      run.problem = `Its robots.txt couldn't be read (error ${got.status}), so nothing was read.`
      return finish()
    }
    robots = got.status >= 200 && got.status < 300 ? parseRobots(got.text) : { rules: [], delay: null, sitemaps: [] }
  } catch (e) {
    run.problem = `The site didn't answer (${errText(e)}).`
    return finish()
  }
  if (!allowed(robots, home)) {
    run.blocked = "Its robots.txt asks robots not to read the site"
    return finish()
  }
  if (robots.delay) gap = Math.max(gap, robots.delay * 1000)
  const budget = Math.max(1, Math.min(settings.maxPages, Math.floor((SITE_MINUTES * 60_000) / Math.max(gap, 1000))))

  // 2. Its pages: the sitemap, else the home page's links.
  let listed = new Map<string, string | undefined>()
  try {
    listed = await readSitemaps(v, home, robots)
  } catch (e) {
    if (e instanceof Refused) {
      run.blocked = e.message
      return finish()
    }
  }
  run.source = listed.size ? "sitemap" : null
  let homeGot: Got | null = null
  if (!listed.size) {
    try {
      homeGot = await v.visit(home, robots)
    } catch (e) {
      run.problem = `The home page didn't answer (${errText(e)}).`
      return finish()
    }
    const refused = refusalOf(homeGot.status, homeGot.text)
    if (refused?.blocked) {
      run.blocked = refused.blocked
      return finish()
    }
    if (homeGot.status >= 200 && homeGot.status < 300) {
      const host = new URL(home).host
      for (const u of linksIn(homeGot.text, homeGot.url)) {
        const c = cleanUrl(u)
        if (c && isPageUrl(c, host)) listed.set(c, undefined)
      }
      run.source = "links"
    }
  }
  if (!listed.has(home)) listed.set(home, undefined)

  let urls = [...listed.keys()]
  const byPriority = (a: string, b: string) => pagePriority(a) - pagePriority(b) || a.length - b.length || a.localeCompare(b)
  if (urls.length > MAX_LISTED) urls = urls.sort(byPriority).slice(0, MAX_LISTED)
  run.listed = urls.length
  run.notAllowed = urls.filter((u) => !allowed(robots, u)).length
  urls = urls.filter((u) => allowed(robots, u))

  // 3. What to read: the home page, new pages, a few gone from the sitemap (taken down, or only
  // left out?), then the ones read longest ago, those whose sitemap date changed first.
  const known = (u: string) => saved.pages[u] !== undefined
  const fresh = urls.filter((u) => u !== home && !known(u)).sort(byPriority)
  const bothSitemaps = run.source === "sitemap" && saved.source === "sitemap"
  const listedSet = new Set(urls)
  const goneMaybe = bothSitemaps
    ? Object.keys(saved.pages).filter((u) => !listedSet.has(u) && !saved.pages[u].gone && !saved.pages[u].unlisted && allowed(robots, u)).slice(0, GONE_CHECKS)
    : []
  const score = (u: string) => {
    const p = saved.pages[u]
    const newDate = listed.get(u) && listed.get(u) !== p.lastmod ? 0 : 1
    return [newDate, p.read ? 1 : 0, pagePriority(u) <= 2 ? 0 : 1, p.gone ? 1 : 0, p.read ?? ""] as const
  }
  const old = urls
    .filter((u) => u !== home && known(u))
    .map((u) => ({ u, s: score(u) }))
    .sort((a, b) => {
      for (let i = 0; i < a.s.length; i++) if (a.s[i] !== b.s[i]) return a.s[i] < b.s[i] ? -1 : 1
      return 0
    })
    .map((x) => x.u)
  const plan = [home, ...fresh, ...goneMaybe, ...old].slice(0, budget)
  live.total = plan.length
  live.read = 0

  // 4. Read them.
  let failsInARow = 0
  for (const url of plan) {
    if (Date.now() - started > SITE_MINUTES * 60_000) {
      run.note = `Stopped after ${SITE_MINUTES} minutes; the rest is read in the next checks.`
      break
    }
    let got: Got
    try {
      got = url === home && homeGot ? homeGot : await v.visit(url, robots)
    } catch (e) {
      if (++failsInARow >= 3) {
        run.problem = `The site stopped answering (${errText(e)}).`
        break
      }
      continue
    }
    live.read++
    const refused = refusalOf(got.status, got.text)
    if (refused?.blocked) {
      run.blocked = refused.blocked
      break
    }
    if (refused?.problem || got.status >= 500) {
      if (++failsInARow >= 3) {
        run.problem = refused?.problem ?? `The site had errors (${got.status}).`
        break
      }
      continue
    }
    failsInARow = 0
    run.read++
    const page = saved.pages[url]
    // Sent to another page of the site (the home page, often): this one is gone. The home page
    // itself may move within the site ("/" to "/en/") and stay the home page.
    const movedTo = got.movedTo ?? (url !== home && pageKey(got.url) !== pageKey(url) ? got.url : undefined)
    if (got.status === 404 || got.status === 410 || movedTo) {
      if (page && !page.gone) add("removed", url, { what: [movedTo ? "Now sends visitors elsewhere" : "Taken down"], before: page.snap ? facts(page.snap) : undefined, movedTo, tags: page.snap ? { places: page.snap.places, situations: page.snap.situations, offers: [] } : { ...urlFacts(url), offers: [] } })
      saved.pages[url] = { ...(page ?? { first: at }), read: at, lastmod: listed.get(url) ?? page?.lastmod, gone: page?.gone ?? at, movedTo }
      continue
    }
    if (got.status < 200 || got.status >= 300 || !/html/i.test(got.type)) continue
    const snap = readPage(got.text, url)
    if (!page || page.gone) {
      add("new", url, { what: [page?.gone ? "Back up" : "New page"], after: facts(snap), tags: { places: snap.places, situations: snap.situations, offers: [] } })
      saved.pages[url] = { first: page?.first ?? at, read: at, lastmod: listed.get(url), snap }
      continue
    }
    if (page.snap) {
      const diff = compare(page.snap, snap)
      if (diff)
        add("changed", url, {
          what: diff.what,
          before: facts(page.snap),
          after: facts(snap),
          added: diff.added,
          removed: diff.removed,
          tags: { places: diff.added.places, situations: diff.added.situations, offers: diff.added.offers },
        })
    }
    saved.pages[url] = { first: page.first, read: at, lastmod: listed.get(url) ?? page.lastmod, snap, ...(listedSet.has(url) || url === home ? {} : { unlisted: true }) }
  }

  // New pages there wasn't time to read: from their addresses, read in the next check.
  for (const url of fresh)
    if (!saved.pages[url]) {
      add("new", url, { what: ["New page (not read yet)"], tags: { ...urlFacts(url), offers: [] } })
      saved.pages[url] = { first: at, lastmod: listed.get(url) }
    }
  if (plan.length < urls.length + goneMaybe.length && !run.note && !run.blocked && !run.problem)
    run.note = `Read ${run.read} of ${urls.length} pages; the rest in the next checks.`

  // What the site's pages are about, for the cities table.
  const places: Record<string, number> = {}
  const situations: Record<string, number> = {}
  for (const [url, p] of Object.entries(saved.pages)) {
    if (p.gone) continue
    const about = p.snap ?? urlFacts(url)
    for (const pl of about.places) places[pl] = (places[pl] ?? 0) + 1
    for (const s of about.situations) situations[s] = (situations[s] ?? 0) + 1
  }
  run.places = places
  run.situations = situations
  run.baseline = baseline || undefined
  if (run.source) {
    saved.source = run.source
    saved.at = at
  }
  await store.write(saved)
  return finish()
}

// ---- Running ------------------------------------------------------------------------------------

function nextDue(run: SiteRun | undefined, settings: WatchSettings): number | null {
  if (!run) return 0
  if ((run.blockedRuns ?? 0) >= 3) return null
  return Date.parse(run.at) + (run.problem && !run.blocked ? DAY : settings.every * DAY)
}

// Checks the sites that are due, one at a time. Called every hour while the app is open, and
// right away for "Check now".
export async function runWatchIfDue() {
  if (live.busy) return
  live.busy = true
  const tickStart = Date.now()
  const tried = new Set<string>()
  try {
    while (Date.now() - tickStart < TICK_MINUTES * 60_000) {
      const state = await settingsFile.read()
      const asked = new Set(state.asked ?? [])
      const settings = { ...DEFAULT_SETTINGS, ...state.settings }
      const due = (await getWatchList())
        .filter((s) => !tried.has(s.site))
        .filter((s) => asked.has(s.site) || (settings.on && s.on && (nextDue(state.runs?.[s.site], settings) ?? Infinity) <= Date.now()))
        .sort(
          (a, b) =>
            Number(asked.has(b.site)) - Number(asked.has(a.site)) ||
            (a.tier ?? 3) - (b.tier ?? 3) ||
            (state.runs?.[a.site]?.at ?? "").localeCompare(state.runs?.[b.site]?.at ?? ""),
        )
      const w = due[0]
      if (!w) break
      tried.add(w.site)
      Object.assign(live, { site: w.site, started: Date.now(), read: 0, total: 0 })
      const result = await checkSite(w, settings).catch((e) => ({
        run: { at: new Date().toISOString(), took: 0, source: null, listed: 0, read: 0, notAllowed: 0, changes: 0, problem: `The check failed: ${errText(e)}` } as SiteRun,
        changes: [] as Change[],
      }))
      if (result.changes.length) await changesFile.update((f) => void (f.changes = [...result.changes, ...(f.changes ?? [])].slice(0, MAX_CHANGES)))
      await settingsFile.update((f) => {
        f.runs ??= {}
        const before = f.runs[w.site]
        f.runs[w.site] = { ...result.run, blockedRuns: result.run.blocked ? (before?.blockedRuns ?? 0) + 1 : 0 }
        f.asked = (f.asked ?? []).filter((s) => s !== w.site)
      })
    }
  } finally {
    Object.assign(live, { busy: false, site: "", read: 0, total: 0 })
  }
}

// "Check now": checked right after the page answers, whatever the schedule.
export async function requestCheck(sites: string[]) {
  await settingsFile.update((f) => void (f.asked = [...new Set([...(f.asked ?? []), ...sites])]))
  after(() => runWatchIfDue().catch(() => undefined))
}

// ---- The page -----------------------------------------------------------------------------------

export async function getWatchSettings() {
  const f = await settingsFile.read()
  return { ...DEFAULT_SETTINGS, ...f.settings }
}

export async function saveWatchSettings(patch: Partial<WatchSettings>, by: string) {
  await settingsFile.update((f) => {
    const s = { ...DEFAULT_SETTINGS, ...f.settings }
    if (patch.on !== undefined) s.on = patch.on
    if (patch.every !== undefined && EVERY_CHOICES.includes(patch.every)) s.every = patch.every
    if (patch.maxPages !== undefined && PAGE_CHOICES.includes(patch.maxPages)) s.maxPages = patch.maxPages
    f.settings = { ...s, by, at: new Date().toISOString() }
  })
}

export type WatchRow = WatchedSite & { run: SiteRun | null; next: string | null; asked: boolean; stopped: boolean }

export async function watchView() {
  const [f, list, { changes }] = await Promise.all([settingsFile.read(), getWatchList(), changesFile.read()])
  const settings = { ...DEFAULT_SETTINGS, ...f.settings }
  const asked = new Set(f.asked ?? [])
  const sites: WatchRow[] = list.map((s) => {
    const run = f.runs?.[s.site] ?? null
    const due = nextDue(run ?? undefined, settings)
    return {
      ...s,
      run,
      next: !settings.on || !s.on || due === null ? null : new Date(Math.max(due, Date.now())).toISOString(),
      asked: asked.has(s.site),
      stopped: due === null,
    }
  })
  const listed = new Set(list.map((s) => s.site))
  return { settings, sites, changes: (changes ?? []).filter((c) => listed.has(c.site)), progress: watchProgress() }
}

export async function decideChanges(ids: string[], status: ChangeStatus, by: string, note?: string) {
  const want = new Set(ids)
  const at = new Date().toISOString()
  return changesFile.update((f) => {
    let n = 0
    for (const c of f.changes ?? []) {
      if (!want.has(c.id)) continue
      c.status = status
      if (note !== undefined) c.note = note.trim().slice(0, 500) || undefined
      if (status === "new") {
        delete c.by
        delete c.decidedAt
      } else {
        c.by = by.slice(0, 60)
        c.decidedAt = at
      }
      n++
    }
    return n
  })
}

// A note on a change, without deciding it.
export async function noteChange(id: string, note: string) {
  return changesFile.update((f) => {
    const c = (f.changes ?? []).find((x) => x.id === id)
    if (!c) return false
    c.note = note.trim().slice(0, 500) || undefined
    return true
  })
}

// A site taken off the list: its pages, changes and checks go too.
export async function forgetSite(site: string) {
  await rm(path.join(DATA_DIR, siteFileName(site)), { force: true }).catch(() => {})
  await changesFile.update((f) => void (f.changes = (f.changes ?? []).filter((c) => c.site !== site)))
  await settingsFile.update((f) => {
    if (f.runs) delete f.runs[site]
    f.asked = (f.asked ?? []).filter((s) => s !== site)
  })
}

export type Pattern = { kind: "place" | "situation" | "offer"; value: string; sites: string[]; changes: number; latest: string }

// The same city, seller situation or offer in new or changed pages at two or more competitors, in
// the last `days` days. Ignored changes and taken-down pages don't count.
export function patternsOf(changes: Change[], days = 28): Pattern[] {
  const since = new Date(Date.now() - days * DAY).toISOString()
  const by = new Map<string, Pattern>()
  for (const c of changes) {
    if (c.at < since || c.status === "ignore" || c.kind === "removed") continue
    const add = (kind: Pattern["kind"], value: string) => {
      const key = `${kind}|${value}`
      const p = by.get(key) ?? { kind, value, sites: [], changes: 0, latest: c.at }
      if (!p.sites.includes(c.site)) p.sites.push(c.site)
      p.changes++
      if (c.at > p.latest) p.latest = c.at
      by.set(key, p)
    }
    for (const v of c.tags.places) add("place", v)
    for (const v of c.tags.situations) add("situation", v)
    for (const v of c.tags.offers) add("offer", v)
  }
  return [...by.values()].filter((p) => p.sites.length >= 2).sort((a, b) => b.sites.length - a.sites.length || b.changes - a.changes || b.latest.localeCompare(a.latest))
}

// Which cities the watched competitors have pages about, most covered first.
export function cityCoverage(rows: WatchRow[]) {
  const by = new Map<string, { site: string; pages: number }[]>()
  for (const r of rows)
    for (const [place, pages] of Object.entries(r.run?.places ?? {})) by.set(place, [...(by.get(place) ?? []), { site: r.site, pages }])
  return [...by.entries()]
    .map(([place, sites]) => ({ place, sites: sites.sort((a, b) => b.pages - a.pages) }))
    .sort((a, b) => b.sites.length - a.sites.length || a.place.localeCompare(b.place))
}

// One site's pages as last read, for its page list.
export async function sitePages(site: string) {
  const f = await siteFile(site).read()
  return Object.entries(f.pages ?? {})
    .map(([url, p]) => ({
      url,
      first: p.first,
      read: p.read ?? null,
      gone: p.gone ?? null,
      title: p.snap?.title ?? "",
      places: p.snap?.places ?? urlFacts(url).places,
      situations: p.snap?.situations ?? urlFacts(url).situations,
      offers: p.snap?.offers ?? [],
      words: p.snap?.words ?? null,
    }))
    .sort((a, b) => Number(!!a.gone) - Number(!!b.gone) || pagePriority(a.url) - pagePriority(b.url) || a.url.localeCompare(b.url))
}
