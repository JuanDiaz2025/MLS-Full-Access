// Bright Data's SERP API: a real Google search made from a chosen California city, on a computer or
// a phone, read by Bright Data into JSON: the top 10 results and the ads above and below them
// (headline, text, shown address, sitelinks, phone). DealTrack never searches Google itself.
// Settings: BRIGHTDATA_API_KEY (Bright Data → Account settings → API keys) and
// BRIGHTDATA_SERP_ZONE (the name of the SERP API zone). Only the free tier is used: each search is
// taken from free-searches.ts first, and none is made once it's used up.
import { takeFreeSearches, freeCap, WINDOW_DAYS } from "@/lib/competitors/free-searches"
import { siteOf } from "@/lib/research/site"

const STATEWIDE = "California"

export type Device = "desktop" | "mobile"
export type AdBlock = "top" | "bottom"
// One ad as Google showed it: advertiser's site, block, order in the block (1 = first), headline,
// text, shown address, landing page (without its tracking), phone and sitelink texts.
export type SeenAd = { d: string; block: AdBlock; r: number; t: string; desc?: string; dl?: string; u?: string; phone?: string; links?: string[] }
// questions: "People also ask"; related: "Related searches" (both what people search around it).
export type GoogleResult = {
  organic: { u: string; t: string; p: number }[]
  ads: SeenAd[]
  questions: string[]
  related: string[]
  aiOverview: boolean
  mapPack: boolean
}

export const brightKey = () => (process.env.BRIGHTDATA_API_KEY ?? "").trim()
export const brightZone = () => (process.env.BRIGHTDATA_SERP_ZONE ?? "").trim()
export const brightReady = () => Boolean(brightKey() && brightZone())

export class BrightDataError extends Error {
  constructor(
    message: string,
    readonly fatal = false, // stop: bad key or zone, or the free searches are used up
    readonly retry = false, // try again after a pause
  ) {
    super(message)
  }
}

// The free searches are used up: no search was made.
export class FreeSearchesUsedUp extends BrightDataError {}

// The shown address ("https://www.example.com › sell" or "example.com/Sell-Fast") is the
// advertiser's own site; the ad's link can go through a tracking service first.
const shownSite = (display: string) => siteOf((display.split(/\s|›/)[0] ?? "").trim())

// Google's name for a place, which Bright Data takes as the search's location:
// "Oakland,California,United States".
export const canonicalPlace = (place: string) => (place === STATEWIDE ? "California,United States" : `${place},California,United States`)

export function searchUrl(keyword: string, place: string, device: Device) {
  // Nothing may come before q= (Bright Data's rule); spaces as "+", commas as they are.
  const uule = encodeURIComponent(canonicalPlace(place)).replace(/%2C/g, ",").replace(/%20/g, "+")
  return `https://www.google.com/search?q=${encodeURIComponent(keyword).replace(/%20/g, "+")}&gl=us&hl=en&uule=${uule}&brd_json=1${device === "mobile" ? "&brd_mobile=1" : ""}`
}

type RawAd = {
  title?: string
  link?: string
  display_link?: string
  description?: string
  phone?: string
  extensions?: { type?: string; text?: string }[]
  global_rank?: number
}
type RawRelated = { text?: string; items?: RawRelated[] }
type Raw = {
  organic?: { link?: string; title?: string; rank?: number; global_rank?: number }[]
  top_ads?: RawAd[]
  bottom_ads?: RawAd[]
  people_also_ask?: { question?: string }[]
  related?: RawRelated[]
  ai_overview?: unknown
  snack_pack?: unknown[]
}

// Related searches can hold more inside ("expanded" groups); all of them, once each, in order.
function relatedTexts(list: RawRelated[] | undefined, out: string[] = []) {
  for (const r of Array.isArray(list) ? list : []) {
    const t = text(r?.text, 100).toLowerCase()
    if (t && !out.includes(t)) out.push(t)
    if (r?.items) relatedTexts(r.items, out)
  }
  return out.slice(0, 20)
}

const text = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "")

function readAds(list: RawAd[] | undefined, block: AdBlock): SeenAd[] {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && (a.link || a.display_link))
    .slice(0, 8)
    .map((a, i) => {
      const ad: SeenAd = { d: shownSite(a.display_link ?? "") || siteOf(a.link ?? ""), block, r: i + 1, t: text(a.title, 140) }
      const desc = text(a.description, 300)
      if (desc) ad.desc = desc
      const dl = text(a.display_link, 100)
      if (dl) ad.dl = dl
      const u = text((a.link ?? "").split(/[?#]/)[0], 200)
      if (u) ad.u = u
      const phone = text(a.phone, 30)
      if (phone) ad.phone = phone
      const links = (Array.isArray(a.extensions) ? a.extensions : [])
        .filter((x) => x?.type === "site_link" && x.text)
        .map((x) => text(x.text, 60))
        .slice(0, 8)
      if (links.length) ad.links = links
      return ad
    })
    .filter((a) => a.d)
}

export function readGoogleResult(raw: Raw): GoogleResult {
  const organic = (Array.isArray(raw.organic) ? raw.organic : [])
    .filter((r) => r?.link)
    .slice(0, 10)
    .map((r, i) => ({ u: r.link!.slice(0, 300), t: text(r.title, 140), p: r.rank ?? i + 1 }))
  const questions = (Array.isArray(raw.people_also_ask) ? raw.people_also_ask : [])
    .map((q) => text(q?.question, 160))
    .filter(Boolean)
    .slice(0, 10)
  return {
    organic,
    ads: [...readAds(raw.top_ads, "top"), ...readAds(raw.bottom_ads, "bottom")],
    questions,
    related: relatedTexts(raw.related),
    aiOverview: Boolean(raw.ai_overview),
    mapPack: Array.isArray(raw.snack_pack) && raw.snack_pack.length > 0,
  }
}

// One request through Bright Data (a Google search, or Google Trends), as parsed JSON. Takes one
// free search first; refuses once they're used up.
export async function brightRequest(url: string): Promise<unknown> {
  if (!brightReady()) throw new BrightDataError("Add BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE to .env.local first.", true)
  if (!(await takeFreeSearches(1))) {
    throw new FreeSearchesUsedUp(
      `The free Bright Data searches are used up (${freeCap().toLocaleString("en-US")} in the last ${WINDOW_DAYS} days). DealTrack makes no more until some free up, so nothing is charged.`,
      true,
    )
  }
  let res: Response
  try {
    res = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: { authorization: `Bearer ${brightKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ zone: brightZone(), url, format: "raw" }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    })
  } catch (e) {
    throw new BrightDataError(e instanceof Error && e.name === "TimeoutError" ? "Took too long" : "Couldn't reach Bright Data")
  }
  const body = await res.text().catch(() => "")
  const why = (res.headers.get("x-brd-error") ?? body).replace(/\s+/g, " ").trim().slice(0, 160)
  if (res.status === 429) throw new BrightDataError("Too many searches at once", false, true)
  if (res.status === 401 || res.status === 403)
    throw new BrightDataError(`Bright Data refused the search${why ? ` (${why})` : ""}. Check BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE in .env.local.`, true)
  if (res.status === 402) throw new BrightDataError("Bright Data asked for payment, so DealTrack stopped. Nothing was charged.", true)
  if (res.status >= 400 && res.status < 500) throw new BrightDataError(`Bright Data refused the search (${res.status}${why ? `: ${why}` : ""}).`, true)
  if (!res.ok) throw new BrightDataError(`Bright Data answered ${res.status}`)
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new BrightDataError("Bright Data sent a page instead of results. Check that the zone is a SERP API zone.")
  }
  if (!raw || typeof raw !== "object") throw new BrightDataError("Bright Data sent no results.")
  return raw
}

// One Google search from a place.
export async function searchGoogle(keyword: string, place: string, device: Device = "desktop"): Promise<GoogleResult> {
  return readGoogleResult((await brightRequest(searchUrl(keyword, place, device))) as Raw)
}
