// Competitors → Google rankings: who shows up on Google for our keywords, city by city. Three
// kinds of scan:
//   Google results  each keyword (in each chosen place) once: the top 10 results and any ads
//                   above them, just the site, address, title and position, never the snippets.
//   Google Maps     the businesses Google Maps lists for each keyword in each city, in order,
//                   optionally with their stars and number of reviews.
//   Brand check     what someone sees when they look us up ("twin home buyer reviews"...), and
//                   our own Google Maps listing.
// Plus the newest Google reviews of businesses picked from a Maps scan (serp-reviews.json).
//
// Searches come from Serper (SERPER_API_KEY: real Google results set to a city, plus ads when
// Google shows it some, which is rare; 2,500 free once, then paid packs) or, for Google results
// only, Brave (BRAVE_SEARCH_API_KEY: free every month, regular results only, US-wide). Serper
// charges 1 credit per search, 3 for a Maps search with stars, 1 per 10 reviews; a scan never
// starts with more credits than the account has left.
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

export type ScanKind = "web" | "maps" | "brand"
export const KIND_LABELS: Record<ScanKind, string> = { web: "Google results", maps: "Google Maps", brand: "Brand check" }

export type Hit = { d: string; u: string; t: string; p: number } // site, address, title, position
// A business on Google Maps: name, position, website's site, Google's id, stars and reviews (when
// asked for), category, phone and address.
export type MapHit = { n: string; p: number; d: string; cid: string; r?: number; c?: number; type?: string; phone?: string; addr?: string }
// t: "maps" for a Google Maps search; s: with stars (Serper's dearer Maps search).
export type Planned = { k: string; loc: string; t?: "maps"; s?: boolean }
export type SerpResult = Planned & { at: string; org: Hit[]; ads: Hit[]; maps?: MapHit[]; err?: string }

const keyOf = (p: Planned) => `${p.t ?? ""}|${p.k}|${p.loc}`
export const creditsFor = (p: Planned) => (p.t === "maps" && p.s ? 3 : 1)

export type Scan = {
  id: string
  at: string
  kind?: ScanKind // older scans are Google results
  engine: SerpEngine
  what: string // which keywords, e.g. "Sell my house, Cash & offers"
  locations: string[]
  planned: number
  credits?: number // what the whole plan costs on Serper
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

// What the brand check searches: how people look us up, and our Google Maps listing.
export const BRAND_QUERIES = [
  "twin home buyer",
  "twin home buyers",
  "twinhomebuyer",
  "twin home buyer reviews",
  "twin home buyer complaints",
  "twin home buyer scam",
]
export const BRAND_MAPS_QUERY = "twin home buyer"
export const brandPlan = (): Planned[] => [
  ...BRAND_QUERIES.map((k) => ({ k, loc: STATEWIDE })),
  { k: BRAND_MAPS_QUERY, loc: STATEWIDE, t: "maps" as const, s: true },
]

// The places a scan can search from: the whole state, or one of our cities.
export const PLACE_CHOICES = [STATEWIDE, ...CALIFORNIA_PLACES.filter((p) => !isRegion(p))]

// What a scan can search from: California, the places our running campaigns target (by Google's
// names, kept by the city volumes run: "Santa Clara County", "Los Altos Hills"), and the other
// California places we know.
export async function scanPlaces(): Promise<{ all: string[]; targeted: string[] }> {
  const { getCityVolumes } = await import("@/lib/research/city-volumes")
  const targeted = Object.keys((await getCityVolumes()).places)
    .filter((p) => p !== STATEWIDE)
    .sort()
  return { all: [...new Set([...PLACE_CHOICES, ...targeted])], targeted }
}

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
// Google Maps needs a city, so a Maps scan searches keywords that name a region (or none) from each
// chosen city, and never from the whole state.
export function planSearches(keywords: string[], locations: string[], maps?: { stars: boolean }): Planned[] {
  const plan: Planned[] = []
  const seen = new Set<string>()
  const add = (k: string, loc: string) => {
    const p: Planned = maps ? { k, loc, t: "maps", ...(maps.stars ? { s: true } : {}) } : { k, loc }
    if (seen.has(keyOf(p))) return
    seen.add(keyOf(p))
    plan.push(p)
  }
  const cities = locations.filter((l) => l !== STATEWIDE)
  const places = maps ? cities : locations.length ? locations : [STATEWIDE]
  for (const k of keywords) {
    const named = placeOf(k)
    if (named && !isRegion(named)) add(k, named)
    else if (named && !maps) add(k, STATEWIDE)
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

const serperLocation = (loc: string) => `${loc === STATEWIDE ? "" : `${loc}, `}California, United States`

const hit = (u: string, t: string, p: number): Hit => ({ d: siteOf(u), u: u.slice(0, 300), t: (t ?? "").slice(0, 140), p })

// One request to Serper; turns its errors into ones the scan knows what to do with.
async function serper<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://google.serper.dev/${endpoint}`, {
    method: "POST",
    headers: { "X-API-KEY": serperKey(), "content-type": "application/json" },
    body: JSON.stringify({ gl: "us", hl: "en", ...payload }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null
  if (res.status === 429) throw new SearchError("Too many searches at once", false, true)
  if (res.status === 401 || res.status === 403) throw new SearchError("Serper didn't accept the key in SERPER_API_KEY. Check it in .env.local.", true)
  if (!res.ok || !body) {
    const msg = body?.message ?? `Serper answered ${res.status}`
    throw new SearchError(
      /credit|balance/i.test(msg) ? "Out of Serper searches. Buy more at serper.dev, then continue the scan." : msg,
      /credit|balance/i.test(msg),
    )
  }
  return body
}

async function serperSearch(k: string, loc: string): Promise<Pick<SerpResult, "org" | "ads">> {
  const body = await serper<{
    organic?: { link?: string; title?: string; position?: number }[]
    ads?: { link?: string; title?: string; position?: number }[]
  }>("search", { q: k, location: serperLocation(loc), num: 10 })
  const org = (body?.organic ?? []).filter((r) => r.link).map((r, i) => hit(r.link!, r.title ?? "", r.position ?? i + 1))
  const ads = (body?.ads ?? []).filter((r) => r.link).map((r, i) => hit(r.link!, r.title ?? "", r.position ?? i + 1))
  return { org: org.slice(0, 10), ads: ads.slice(0, 8) }
}

// Google Maps: "places" lists the businesses in order (1 credit); "maps" adds their stars, number
// of reviews and category (3 credits).
async function mapsSearch(k: string, loc: string, stars: boolean): Promise<MapHit[]> {
  type Place = {
    position?: number
    title?: string
    website?: string
    cid?: string
    rating?: number
    ratingCount?: number
    type?: string
    phoneNumber?: string
    address?: string
  }
  const body = await serper<{ places?: Place[] }>(stars ? "maps" : "places", { q: k, location: serperLocation(loc) })
  return (body.places ?? [])
    .filter((pl) => pl.title)
    .slice(0, 20)
    .map((pl, i) => ({
      n: pl.title!.slice(0, 120),
      p: pl.position ?? i + 1,
      d: pl.website ? siteOf(pl.website) : "",
      cid: String(pl.cid ?? ""),
      ...(typeof pl.rating === "number" ? { r: pl.rating } : {}),
      ...(typeof pl.ratingCount === "number" ? { c: pl.ratingCount } : {}),
      ...(pl.type ? { type: pl.type.slice(0, 60) } : {}),
      ...(pl.phoneNumber ? { phone: pl.phoneNumber.slice(0, 30) } : {}),
      ...(pl.address ? { addr: pl.address.slice(0, 160) } : {}),
    }))
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
  kind: ScanKind
  engine: SerpEngine
  keywords: string[]
  locations: string[]
  stars?: boolean
  what: string
}): Promise<{ ok: boolean; message: string }> {
  if (job.id) return { ok: false, message: "A scan is already running. Wait for it or stop it first." }
  const engine: SerpEngine = opts.kind === "web" ? opts.engine : "serper"
  if (!enginesReady().includes(engine)) return { ok: false, message: `Add the ${ENGINE_LABELS[engine]} key to .env.local first.` }
  let locations = engine === "brave" ? ["United States"] : opts.locations.length ? opts.locations : [STATEWIDE]
  if (opts.kind === "maps") locations = locations.filter((l) => l !== STATEWIDE)
  if (opts.kind === "brand") locations = [STATEWIDE]
  const plan =
    opts.kind === "brand"
      ? brandPlan()
      : engine === "brave"
        ? opts.keywords.map((k) => ({ k, loc: "United States" }))
        : planSearches(opts.keywords, locations, opts.kind === "maps" ? { stars: Boolean(opts.stars) } : undefined)
  if (!plan.length) return { ok: false, message: opts.kind === "maps" ? "Add at least one city: Google Maps needs one." : "No keywords picked." }
  const credits = plan.reduce((n, p) => n + creditsFor(p), 0)
  if (engine === "serper") {
    const { value } = await serperBalance(true)
    if (value !== null && credits > value) {
      return {
        ok: false,
        message: `This scan needs ${credits.toLocaleString("en-US")} Serper credits and ${value.toLocaleString("en-US")} are left. Pick fewer keywords or places.`,
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
      kind: opts.kind,
      engine,
      what: opts.what.slice(0, 200),
      locations,
      planned: plan.length,
      credits: engine === "serper" ? credits : undefined,
      done: 0,
      failed: 0,
      status: "running",
    })
  })
  void run(id, engine)
  return { ok: true, message: `Scan started: ${plan.length.toLocaleString("en-US")} searches.` }
}

// Picks a stopped scan back up, searching only what it hadn't done (or what failed).
export async function continueScan(id: string): Promise<{ ok: boolean; message: string }> {
  if (job.id) return { ok: false, message: "A scan is already running." }
  const scan = (await getScans()).find((s) => s.id === id)
  if (!scan) return { ok: false, message: "That scan is gone." }
  if (!enginesReady().includes(scan.engine)) return { ok: false, message: `Add the ${ENGINE_LABELS[scan.engine]} key to .env.local first.` }
  const f = await scanFile(id).read()
  const done = new Set(f.results.filter((r) => !r.err).map((r) => keyOf(r)))
  const left = f.plan.filter((p) => !done.has(keyOf(p))).length
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
    const ok = new Set(f.results.filter((r) => !r.err).map((r) => keyOf(r)))
    // Failed searches are tried again; their old failure is dropped once it's redone.
    const todo = f.plan.filter((p) => !ok.has(keyOf(p)))
    const fresh: SerpResult[] = []
    let next = 0
    let failedInARow = 0
    const save = async () => {
      const batch = fresh.splice(0)
      if (!batch.length) return
      const redone = new Set(batch.map((r) => keyOf(r)))
      const all = await store.update((x) => {
        x.results = [...x.results.filter((r) => !redone.has(keyOf(r))), ...batch]
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
            const found =
              p.t === "maps"
                ? { org: [], ads: [], maps: await mapsSearch(p.k, p.loc, Boolean(p.s)) }
                : engine === "serper"
                  ? await serperSearch(p.k, p.loc)
                  : await braveSearch(p.k)
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

// ---- Google reviews of businesses from a Maps scan ---------------------------------------------
// The newest reviews (stars, date, words; never the reviewer's name), 10 per credit. Saved in
// .data/serp-reviews.json by the business's Google id, replacing what was there before.

export type Review = { r: number; at: string; text: string }
export type PlaceReviews = { cid: string; name: string; site: string; at: string; reviews: Review[] }

const reviewsFile = jsonFileStore<{ places: Record<string, PlaceReviews> }>("serp-reviews.json", () => ({ places: {} }))

export async function getReviews() {
  return Object.values((await reviewsFile.read()).places ?? {}).sort((a, b) => a.name.localeCompare(b.name))
}

export async function fetchReviews(places: { cid: string; name: string; site: string }[], pages: number): Promise<{ ok: boolean; message: string }> {
  if (!serperKey()) return { ok: false, message: "Add SERPER_API_KEY to .env.local first." }
  const list = places.filter((p) => /^\d{1,30}$/.test(p.cid)).slice(0, 30)
  if (!list.length) return { ok: false, message: "Pick businesses from a Google Maps scan first." }
  const per = Math.max(1, Math.min(5, pages))
  const { value } = await serperBalance(true)
  if (value !== null && list.length * per > value)
    return { ok: false, message: `That needs up to ${list.length * per} credits and ${value} are left.` }
  type Raw = { reviews?: { rating?: number; isoDate?: string; snippet?: string }[]; nextPageToken?: string }
  let got = 0
  const failed: string[] = []
  for (const place of list) {
    const reviews: Review[] = []
    let token = ""
    try {
      for (let page = 0; page < per; page++) {
        const body = await serper<Raw>("reviews", { cid: place.cid, sortBy: "newest", ...(token ? { nextPageToken: token } : {}) })
        for (const r of body.reviews ?? []) {
          if (typeof r.rating !== "number") continue
          reviews.push({ r: r.rating, at: r.isoDate ?? "", text: (r.snippet ?? "").slice(0, 600) })
        }
        token = body.nextPageToken ?? ""
        if (!token) break
        await pause(300)
      }
    } catch (e) {
      if (e instanceof SearchError && e.fatal) return { ok: false, message: e.message }
      failed.push(place.name)
      continue
    }
    got++
    await reviewsFile.update((x) => {
      x.places ??= {}
      x.places[place.cid] = { cid: place.cid, name: place.name.slice(0, 120), site: place.site.slice(0, 80), at: new Date().toISOString(), reviews }
    })
  }
  balanceCache.at = 0
  return {
    ok: got > 0,
    message: `Reviews for ${got} business${got === 1 ? "" : "es"}.${failed.length ? ` Couldn't get: ${failed.slice(0, 5).join(", ")}.` : ""}`,
  }
}
