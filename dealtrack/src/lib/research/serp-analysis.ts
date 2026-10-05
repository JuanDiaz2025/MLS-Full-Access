// Turns a scan's results into what Competitors → Google rankings shows: each site's share of the
// searches, how often it's in the top 3 and the ads, an estimate of its visits, and for each
// keyword who ranks where (and us). No I/O, so it can be checked on its own.
import { pointsOutOfState, siteOutOfState } from "@/lib/research/out-of-state"
import type { MapHit, SerpResult } from "@/lib/research/serp"

// Of 100 people who search, about how many click each organic position (industry averages,
// rounded). Used for share of voice and estimated visits, so both are estimates.
export const CTR = [0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.03, 0.025, 0.02]
const ctr = (p: number) => CTR[p - 1] ?? 0

// Listing sites, directories and articles: they rank for everything but don't buy houses.
const DIRECTORIES =
  /^(zillow|redfin|realtor|trulia|homes|movoto|yelp|bbb|reddit|quora|facebook|instagram|youtube|tiktok|linkedin|x|twitter|nextdoor|craigslist|angi|angieslist|thumbtack|homeadvisor|houzz|yellowpages|mapquest|google|apple|wikipedia|forbes|bankrate|nerdwallet|investopedia|rocketmortgage|rocket|chase|wellsfargo|bankofamerica|usnews|nolo|lawinfo|justia|avvo|ca|nar|realtors|biggerpockets|fastexpert|clever|clevergroup|apartments|loopnet|landwatch|landsearch|indeed|glassdoor|wsj|nytimes|cnbc|latimes|sfgate|sacbee|patch)\.(com|org|net|gov|ca\.gov)$/
export const isDirectory = (site: string) => DIRECTORIES.test(site) || site.endsWith(".gov") || site.endsWith(".edu")

export type SiteRow = {
  site: string
  directory: boolean
  ours: boolean
  outOfState: boolean // its pages point outside California (see out-of-state.ts)
  results: number // searches it was in the top 10 for
  top3: number
  best: number
  avg: number
  ads: number // searches it ran an ad on
  share: number // share of voice, 0 to 1
  visits: number | null // estimated monthly visits from these searches (needs volumes)
  change: number | null // share of voice now minus in the scan compared against
}

export type KeywordRow = {
  k: string
  loc: string
  volume: number | null
  ours: number | null // our position, if in the top 10
  oursBefore: number | null | undefined // undefined: not searched in the compared scan
  top: string[] // sites in positions 1-10
  ads: string[]
  err?: string
}

export type SitePage = { k: string; loc: string; p: number; u: string; ad?: boolean }

export type Analysis = { sites: SiteRow[]; keywords: KeywordRow[]; pages: Record<string, SitePage[]>; byVolume: boolean; ourShare: number }

// Keyword Planner's volume is for all of California; a keyword searched in several places counts
// a part of it in each, so totals don't add up to more than the real searches.
function weights(results: SerpResult[], volumes: Map<string, number>) {
  const places = new Map<string, number>()
  for (const r of results) places.set(r.k, (places.get(r.k) ?? 0) + 1)
  const known = results.filter((r) => volumes.has(r.k)).length
  const byVolume = results.length > 0 && known / results.length >= 0.5
  const weight = (r: SerpResult) => (byVolume ? (volumes.get(r.k) ?? 0) / (places.get(r.k) ?? 1) : 1)
  return { byVolume, weight }
}

function shares(results: SerpResult[], volumes: Map<string, number>) {
  const { byVolume, weight } = weights(results, volumes)
  const clicks = new Map<string, number>()
  let total = 0
  for (const r of results) {
    const w = weight(r)
    total += w
    const seen = new Set<string>()
    for (const h of r.org) {
      if (!h.d || seen.has(h.d)) continue // a site's best position only
      seen.add(h.d)
      clicks.set(h.d, (clicks.get(h.d) ?? 0) + w * ctr(h.p))
    }
  }
  return { byVolume, weight, clicks, total }
}

export function analyze(results: SerpResult[], volumes: Map<string, number>, before?: SerpResult[], ourSites: string[] = []): Analysis {
  const good = results.filter((r) => !r.err)
  const now = shares(good, volumes)
  const then = before
    ? shares(
        before.filter((r) => !r.err),
        volumes,
      )
    : null
  const share = (s: ReturnType<typeof shares>, site: string) => (s.total ? (s.clicks.get(site) ?? 0) / s.total : 0)

  const sites = new Map<string, { results: number; top3: number; best: number; posSum: number; ads: number; visits: number }>()
  const pages: Record<string, SitePage[]> = {}
  const titles = new Map<string, { d: string; t: string }[]>()
  const get = (d: string) => {
    let s = sites.get(d)
    if (!s) sites.set(d, (s = { results: 0, top3: 0, best: 99, posSum: 0, ads: 0, visits: 0 }))
    return s
  }
  for (const r of good) {
    const seen = new Set<string>()
    for (const h of r.org) {
      if (!h.d) continue
      titles.set(h.d, [...(titles.get(h.d) ?? []), { d: h.d, t: h.t }])
      if (!seen.has(h.d)) {
        seen.add(h.d)
        const s = get(h.d)
        s.results++
        s.posSum += h.p
        s.best = Math.min(s.best, h.p)
        if (h.p <= 3) s.top3++
        s.visits += now.weight(r) * ctr(h.p)
      }
      ;(pages[h.d] ??= []).push({ k: r.k, loc: r.loc, p: h.p, u: h.u })
    }
    for (const d of new Set(r.ads.map((h) => h.d).filter(Boolean))) {
      get(d).ads++
      ;(pages[d] ??= []).push({ k: r.k, loc: r.loc, p: r.ads.find((h) => h.d === d)!.p, u: r.ads.find((h) => h.d === d)!.u, ad: true })
    }
  }

  const siteRows: SiteRow[] = [...sites.entries()].map(([site, s]) => ({
    site,
    directory: isDirectory(site),
    ours: ourSites.includes(site),
    outOfState: !ourSites.includes(site) && siteOutOfState(titles.get(site) ?? []),
    results: s.results,
    top3: s.top3,
    best: s.results ? s.best : 0,
    avg: s.results ? Math.round((s.posSum / s.results) * 10) / 10 : 0,
    ads: s.ads,
    share: share(now, site),
    visits: now.byVolume ? Math.round(s.visits) : null,
    change: then ? share(now, site) - share(then, site) : null,
  }))
  siteRows.sort((a, b) => b.share - a.share || b.ads - a.ads || b.results - a.results)

  // Each site's pages, best positions first, kept for the sites people are likely to open.
  const keep = new Set(siteRows.slice(0, 80).map((s) => s.site))
  for (const s of siteRows) if (s.ours) keep.add(s.site)
  for (const d of Object.keys(pages)) {
    if (!keep.has(d)) delete pages[d]
    else pages[d] = pages[d].sort((a, b) => Number(!!a.ad) - Number(!!b.ad) || a.p - b.p).slice(0, 300)
  }

  const ourPos = (r: SerpResult) => r.org.find((h) => ourSites.includes(h.d))?.p ?? null
  const old = new Map((before ?? []).filter((r) => !r.err).map((r) => [`${r.k}|${r.loc}`, ourPos(r)]))
  const keywords: KeywordRow[] = results.map((r) => ({
    k: r.k,
    loc: r.loc,
    volume: volumes.get(r.k) ?? null,
    ours: ourPos(r),
    oursBefore: before ? old.get(`${r.k}|${r.loc}`) : undefined,
    top: r.org.map((h) => h.d),
    ads: [...new Set(r.ads.map((h) => h.d))],
    ...(r.err ? { err: r.err } : {}),
  }))

  return { sites: siteRows, keywords, pages, byVolume: now.byVolume, ourShare: ourSites.reduce((s, d) => s + share(now, d), 0) }
}

// ---- Google Maps ------------------------------------------------------------------------------
// Google shows 3 businesses in the map box above the results ("the local pack"); being in the top
// 3 is what brings calls.

export type Business = {
  key: string
  name: string
  site: string
  cid: string
  ours: boolean
  outOfState: boolean // its address, name or website points outside California
  results: number // searches it showed up in
  top3: number
  best: number
  avg: number
  rating: number | null
  reviews: number | null
  type: string
  phone: string
  cities: string[]
  change: number | null // top-3 count now minus in the scan compared against
}

export type MapsRow = { k: string; loc: string; ours: number | null; oursBefore: number | null | undefined; top: string[]; err?: string }

export type MapsAnalysis = { businesses: Business[]; rows: MapsRow[]; stars: boolean }

const businessKey = (h: MapHit) => h.cid || h.n.toLowerCase()
export const isOurBusiness = (h: Pick<MapHit, "n" | "d">, ourSites: string[]) => ourSites.includes(h.d) || /twin ?home ?buyer/i.test(h.n)

function top3Counts(results: SerpResult[]) {
  const m = new Map<string, number>()
  for (const r of results) for (const h of r.maps ?? []) if (h.p <= 3) m.set(businessKey(h), (m.get(businessKey(h)) ?? 0) + 1)
  return m
}

export function analyzeMaps(results: SerpResult[], before?: SerpResult[], ourSites: string[] = []): MapsAnalysis {
  const good = results.filter((r) => !r.err && r.t === "maps")
  const then = before ? top3Counts(before.filter((r) => !r.err && r.t === "maps")) : null
  const map = new Map<string, Business & { posSum: number; places: Set<string> }>()
  for (const r of good) {
    const seen = new Set<string>()
    for (const h of r.maps ?? []) {
      const key = businessKey(h)
      if (seen.has(key)) continue
      seen.add(key)
      let b = map.get(key)
      if (!b) {
        b = {
          key,
          name: h.n,
          site: h.d,
          cid: h.cid,
          ours: isOurBusiness(h, ourSites),
          outOfState: !isOurBusiness(h, ourSites) && pointsOutOfState(h.d, `${h.n} · ${h.addr ?? ""}`),
          results: 0,
          top3: 0,
          best: 99,
          avg: 0,
          rating: null,
          reviews: null,
          type: h.type ?? "",
          phone: h.phone ?? "",
          cities: [],
          change: null,
          posSum: 0,
          places: new Set(),
        }
        map.set(key, b)
      }
      b.results++
      b.posSum += h.p
      b.best = Math.min(b.best, h.p)
      if (h.p <= 3) b.top3++
      if (h.r !== undefined) b.rating = h.r
      if (h.c !== undefined) b.reviews = Math.max(b.reviews ?? 0, h.c)
      b.places.add(r.loc)
    }
  }
  const businesses: Business[] = [...map.values()]
    .map(({ posSum, places, ...b }) => ({
      ...b,
      avg: Math.round((posSum / b.results) * 10) / 10,
      cities: [...places].sort(),
      change: then ? b.top3 - (then.get(b.key) ?? 0) : null,
    }))
    .sort((a, b) => b.top3 - a.top3 || b.results - a.results || a.avg - b.avg)

  const ourPos = (r: SerpResult) => (r.maps ?? []).find((h) => isOurBusiness(h, ourSites))?.p ?? null
  const old = new Map((before ?? []).filter((r) => !r.err && r.t === "maps").map((r) => [`${r.k}|${r.loc}`, ourPos(r)]))
  const rows: MapsRow[] = results
    .filter((r) => r.t === "maps")
    .map((r) => ({
      k: r.k,
      loc: r.loc,
      ours: ourPos(r),
      oursBefore: before ? old.get(`${r.k}|${r.loc}`) : undefined,
      top: (r.maps ?? []).slice(0, 3).map((h) => h.n),
      ...(r.err ? { err: r.err } : {}),
    }))
  return { businesses, rows, stars: good.some((r) => r.s) }
}
