// Competitors → Google rankings: who shows up on Google for our keywords, city by city. A scan
// searches each keyword (in each chosen place) once and keeps the top 10 results (and any ads
// above them): just the site, address, title and position, never the snippets.
//
// Searches come from Serper (SERPER_API_KEY: real Google results set to a city, plus ads when
// Google shows it some, which is rare; 2,500 free once, then paid packs) or Brave (BRAVE_SEARCH_API_KEY: free every month, regular
// results only, US-wide). One search = one keyword in one place = one credit, so a scan never
// starts with more searches than the account has left.
//
// Each scan is saved in .data/serp/<id>.json with its plan, so a scan stopped by hand, by running
// out of credits or by the app closing can continue where it left off. The list of scans is in
// .data/serp-scans.json.
import { rm } from "node:fs/promises"
import path from "node:path"

import { jsonFileStore } from "@/lib/json-file-store"
import { placeOf, topicOf } from "@/lib/research/classify"
import { getResearch } from "@/lib/research/keywords"
import { CALIFORNIA_PLACES } from "@/lib/service-area"
import { shared } from "@/lib/shared-state"
import { DATA_DIR } from "@/lib/store"

export type SerpEngine = "serper" | "brave"
export const ENGINE_LABELS: Record<SerpEngine, string> = { serper: "Serper (Google)", brave: "Brave Search" }

export type Hit = { d: string; u: string; t: string; p: number } // site, address, title, position
export type SerpResult = { k: string; loc: string; at: string; org: Hit[]; ads: Hit[]; err?: string }
export type Planned = { k: string; loc: string }

export type Scan = {
  id: string
  at: string
  engine: SerpEngine
  what: string // which keywords, e.g. "Sell my house, Cash & offers"
  locations: string[]
  planned: number
  done: number
  failed: number
  status: "running" | "done" | "stopped"
  finishedAt?: string
  note?: string
}

type ScanFile = { plan: Planned[]; results: SerpResult[] }

export const STATEWIDE = "California"
export const OUR_SITES = ["twinhomebuyer.com"]

// Places in our keyword list that aren't cities Google can search from: these use the whole state.
const REGIONS = new Set(
  [
    "California",
    "Bay Area",
    "Northern California",
    "Southern California",
    "Central Valley",
    "Central Coast",
    "Inland Empire",
    "Peninsula",
    "East Bay",
    "South Bay",
    "North Bay",
    "Silicon Valley",
    "Norcal",
    "Socal",
    "Marin",
    "Contra Costa",
    "Solano",
    "Orange County",
  ].map((p) => p.toLowerCase()),
)
const isRegion = (place: string) => REGIONS.has(place.toLowerCase())

// The places a scan can search from: the whole state, or one of our cities.
export const PLACE_CHOICES = [STATEWIDE, ...CALIFORNIA_PLACES.filter((p) => !isRegion(p))]

const index = jsonFileStore<{ scans: Scan[] }>("serp-scans.json", () => ({ scans: [] }))
const scanFile = (id: string) => jsonFileStore<ScanFile>(`serp/${id}.json`, () => ({ plan: [], results: [] }))

// The one scan running right now (one at a time for the whole app), and the account balance.
const job = shared("serp-job", () => ({ id: null as string | null, stop: false }))
const balanceCache = shared("serp-balance", () => ({ at: 0, value: null as number | null, error: "" }))

export const serperKey = () => (process.env.SERPER_API_KEY ?? "").trim()
export const braveKey = () => (process.env.BRAVE_SEARCH_API_KEY ?? "").trim()
export const enginesReady = (): SerpEngine[] => [...(serperKey() ? (["serper"] as const) : []), ...(braveKey() ? (["brave"] as const) : [])]

// "www.sacramento.example.co.uk/page" → "example.co.uk"; "www.opendoor.com" → "opendoor.com".
export function siteOf(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
    const parts = host.split(".")
    const keep = parts.length > 2 && /^(co|com|org|net|gov|ac)$/.test(parts.at(-2) ?? "") ? 3 : 2
    return parts.slice(-keep).join(".")
  } catch {
    return ""
  }
}

// Which place a keyword is searched from: the city it names, if any; otherwise each chosen place.
export function planSearches(keywords: string[], locations: string[]): Planned[] {
  const plan: Planned[] = []
  const seen = new Set<string>()
  const add = (k: string, loc: string) => {
    const key = `${k}|${loc}`
    if (seen.has(key)) return
    seen.add(key)
    plan.push({ k, loc })
  }
  const places = locations.length ? locations : [STATEWIDE]
  for (const k of keywords) {
    const named = placeOf(k)
    if (named) add(k, isRegion(named) ? STATEWIDE : named)
    else for (const loc of places) add(k, loc)
  }
  return plan
}

// The keywords a scan would search, picked on the app's side from the saved list: by topic, then
// at least `minVolume` searches a month (when volumes are known), most searched first.
export async function pickKeywords(req: { topics: string[]; minVolume: number; max: number }) {
  const { keywords } = await getResearch()
  const topics = new Set(req.topics)
  return keywords
    .filter((k) => topics.has(topicOf(k.text)) && (!req.minVolume || (k.volume ?? 0) >= req.minVolume))
    .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || a.text.localeCompare(b.text))
    .slice(0, Math.max(1, Math.min(20_000, req.max || 20_000)))
    .map((k) => k.text)
}

// ---- The search services ----------------------------------------------------------------------

class SearchError extends Error {
  constructor(
    message: string,
    readonly fatal = false, // stops the scan (bad key, out of credits)
    readonly retry = false, // try again after a pause (too many at once)
  ) {
    super(message)
  }
}

const hit = (u: string, t: string, p: number): Hit => ({ d: siteOf(u), u: u.slice(0, 300), t: (t ?? "").slice(0, 140), p })

async function serperSearch(k: string, loc: string): Promise<Pick<SerpResult, "org" | "ads">> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": serperKey(), "content-type": "application/json" },
    body: JSON.stringify({ q: k, location: `${loc === STATEWIDE ? "" : `${loc}, `}California, United States`, gl: "us", hl: "en", num: 10 }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => null)) as {
    message?: string
    organic?: { link?: string; title?: string; position?: number }[]
    ads?: { link?: string; title?: string; position?: number }[]
  } | null
  if (res.status === 429) throw new SearchError("Too many searches at once", false, true)
  if (res.status === 401 || res.status === 403) throw new SearchError("Serper didn't accept the key in SERPER_API_KEY. Check it in .env.local.", true)
  if (!res.ok) {
    const msg = body?.message ?? `Serper answered ${res.status}`
    throw new SearchError(
      /credit|balance/i.test(msg) ? "Out of Serper searches. Buy more at serper.dev, then continue the scan." : msg,
      /credit|balance/i.test(msg),
    )
  }
  const org = (body?.organic ?? []).filter((r) => r.link).map((r, i) => hit(r.link!, r.title ?? "", r.position ?? i + 1))
  const ads = (body?.ads ?? []).filter((r) => r.link).map((r, i) => hit(r.link!, r.title ?? "", r.position ?? i + 1))
  return { org: org.slice(0, 10), ads: ads.slice(0, 8) }
}

async function braveSearch(k: string): Promise<Pick<SerpResult, "org" | "ads">> {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(k)}&country=US&search_lang=en&count=10`, {
    headers: { "X-Subscription-Token": braveKey(), accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 429) throw new SearchError("Brave's limit for now is used up", false, true)
  if (res.status === 401 || res.status === 403)
    throw new SearchError("Brave didn't accept the key in BRAVE_SEARCH_API_KEY. Check it in .env.local.", true)
  if (!res.ok) throw new SearchError(`Brave answered ${res.status}`)
  const body = (await res.json().catch(() => null)) as { web?: { results?: { url?: string; title?: string }[] } } | null
  const org = (body?.web?.results ?? []).filter((r) => r.url).map((r, i) => hit(r.url!, r.title ?? "", i + 1))
  return { org: org.slice(0, 10), ads: [] }
}

// Searches left on the Serper account (checked at most every 30 seconds).
export async function serperBalance(fresh = false): Promise<{ value: number | null; error: string }> {
  if (!serperKey()) return { value: null, error: "" }
  if (!fresh && Date.now() - balanceCache.at < 30_000) return balanceCache
  try {
    const res = await fetch("https://google.serper.dev/account", {
      headers: { "X-API-KEY": serperKey() },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => null)) as { balance?: number } | null
    Object.assign(balanceCache, {
      at: Date.now(),
      value: typeof body?.balance === "number" ? body.balance : null,
      error: res.ok ? "" : res.status === 401 || res.status === 403 ? "Serper didn't accept the key." : `Serper answered ${res.status}.`,
    })
  } catch {
    Object.assign(balanceCache, { at: Date.now(), error: "Couldn't reach Serper." })
  }
  return balanceCache
}

// ---- Scans ----------------------------------------------------------------------------------

// The saved scans, newest first. One marked running that isn't (the app closed) shows as stopped.
export async function getScans(): Promise<Scan[]> {
  const { scans } = await index.read()
  return (scans ?? []).map((s) =>
    s.status === "running" && job.id !== s.id ? { ...s, status: "stopped", note: s.note ?? "The app was closed during the scan." } : s,
  )
}

export async function getScanResults(id: string): Promise<ScanFile | null> {
  if (!/^[a-z0-9-]+$/.test(id)) return null
  const scans = await getScans()
  return scans.some((s) => s.id === id) ? scanFile(id).read() : null
}

export const scanRunning = () => job.id

const updateScan = (id: string, change: (s: Scan) => void) =>
  index.update((x) => {
    const s = x.scans.find((s) => s.id === id)
    if (s) change(s)
  })

export async function startScan(opts: {
  engine: SerpEngine
  keywords: string[]
  locations: string[]
  what: string
}): Promise<{ ok: boolean; message: string }> {
  if (job.id) return { ok: false, message: "A scan is already running. Wait for it or stop it first." }
  if (!enginesReady().includes(opts.engine)) return { ok: false, message: `Add the ${ENGINE_LABELS[opts.engine]} key to .env.local first.` }
  const locations = opts.engine === "brave" ? ["United States"] : opts.locations.length ? opts.locations : [STATEWIDE]
  const plan = opts.engine === "brave" ? opts.keywords.map((k) => ({ k, loc: "United States" })) : planSearches(opts.keywords, locations)
  if (!plan.length) return { ok: false, message: "No keywords picked." }
  if (opts.engine === "serper") {
    const { value } = await serperBalance(true)
    if (value !== null && plan.length > value) {
      return {
        ok: false,
        message: `This scan needs ${plan.length.toLocaleString("en-US")} searches and Serper has ${value.toLocaleString("en-US")} left. Pick fewer keywords or places.`,
      }
    }
  }
  const at = new Date().toISOString()
  const id = `${at.slice(0, 19).replace(/[^0-9]/g, "")}-${Math.random().toString(36).slice(2, 6)}`
  await scanFile(id).update((f) => {
    f.plan = plan
    f.results = []
  })
  await index.update((x) => {
    x.scans ??= []
    x.scans.unshift({
      id,
      at,
      engine: opts.engine,
      what: opts.what.slice(0, 200),
      locations,
      planned: plan.length,
      done: 0,
      failed: 0,
      status: "running",
    })
  })
  void run(id, opts.engine)
  return { ok: true, message: `Scan started: ${plan.length.toLocaleString("en-US")} searches.` }
}

// Picks a stopped scan back up, searching only what it hadn't done (or what failed).
export async function continueScan(id: string): Promise<{ ok: boolean; message: string }> {
  if (job.id) return { ok: false, message: "A scan is already running." }
  const scan = (await getScans()).find((s) => s.id === id)
  if (!scan) return { ok: false, message: "That scan is gone." }
  if (!enginesReady().includes(scan.engine)) return { ok: false, message: `Add the ${ENGINE_LABELS[scan.engine]} key to .env.local first.` }
  const f = await scanFile(id).read()
  const done = new Set(f.results.filter((r) => !r.err).map((r) => `${r.k}|${r.loc}`))
  const left = f.plan.filter((p) => !done.has(`${p.k}|${p.loc}`)).length
  if (!left) return { ok: false, message: "That scan has nothing left to search." }
  if (scan.engine === "serper") {
    const { value } = await serperBalance(true)
    if (value !== null && value < 1) return { ok: false, message: "Serper has no searches left." }
  }
  await updateScan(id, (s) => {
    s.status = "running"
    delete s.note
    delete s.finishedAt
  })
  void run(id, scan.engine)
  return { ok: true, message: `Continuing: ${left.toLocaleString("en-US")} searches left.` }
}

export function stopScan() {
  if (job.id) job.stop = true
}

export async function deleteScan(id: string) {
  if (job.id === id || !/^[a-z0-9-]+$/.test(id)) return false
  await index.update((x) => {
    x.scans = (x.scans ?? []).filter((s) => s.id !== id)
  })
  await rm(path.join(DATA_DIR, "serp", `${id}.json`), { force: true }).catch(() => {})
  return true
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Runs a scan's remaining searches in the background: Serper 3 at a time (its free plan allows 5 a
// second), Brave one a second (its free plan's limit). Progress is saved every 20 searches.
async function run(id: string, engine: SerpEngine) {
  job.id = id
  job.stop = false
  const store = scanFile(id)
  let note: string | undefined
  try {
    const f = await store.read()
    const ok = new Set(f.results.filter((r) => !r.err).map((r) => `${r.k}|${r.loc}`))
    // Failed searches are tried again; their old failure is dropped once it's redone.
    const todo = f.plan.filter((p) => !ok.has(`${p.k}|${p.loc}`))
    const fresh: SerpResult[] = []
    let next = 0
    let failedInARow = 0
    const save = async () => {
      const batch = fresh.splice(0)
      if (!batch.length) return
      const redone = new Set(batch.map((r) => `${r.k}|${r.loc}`))
      const all = await store.update((x) => {
        x.results = [...x.results.filter((r) => !redone.has(`${r.k}|${r.loc}`)), ...batch]
        return x.results
      })
      await updateScan(id, (s) => {
        s.done = all.filter((r) => !r.err).length
        s.failed = all.filter((r) => r.err).length
      })
    }
    const worker = async () => {
      while (!job.stop && !note && next < todo.length) {
        const p = todo[next++]
        let result: SerpResult | null = null
        for (let attempt = 0; attempt < 4 && !result; attempt++) {
          const started = Date.now()
          try {
            const found = engine === "serper" ? await serperSearch(p.k, p.loc) : await braveSearch(p.k)
            result = { ...p, at: new Date().toISOString(), ...found }
            failedInARow = 0
          } catch (e) {
            if (e instanceof SearchError && e.fatal) {
              note = e.message
              return
            }
            if (e instanceof SearchError && e.retry && attempt < 3) {
              await pause(3000 * (attempt + 1))
              continue
            }
            const message = e instanceof Error ? (e.name === "TimeoutError" ? "Took too long" : e.message) : String(e)
            result = { ...p, at: new Date().toISOString(), org: [], ads: [], err: message.slice(0, 200) }
            if (++failedInARow >= 10) note = `Stopped after 10 failed searches in a row (last: ${message.slice(0, 120)}).`
          }
          const wait = (engine === "serper" ? 650 : 1100) - (Date.now() - started)
          if (wait > 0) await pause(wait)
        }
        if (result) fresh.push(result)
        if (fresh.length >= 20) await save()
      }
    }
    await Promise.all(Array.from({ length: engine === "serper" ? 3 : 1 }, worker))
    await save()
    const stopped = job.stop || Boolean(note)
    await updateScan(id, (s) => {
      s.status = stopped ? "stopped" : "done"
      s.finishedAt = new Date().toISOString()
      if (note) s.note = note
      else if (job.stop) s.note = "Stopped by hand."
    })
  } catch (e) {
    await updateScan(id, (s) => {
      s.status = "stopped"
      s.note = `The scan hit a problem: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)
    })
  } finally {
    job.id = null
    job.stop = false
    balanceCache.at = 0
  }
}
