// Competitors → SEO → Competitor watch: the competitors whose websites DealTrack checks. They come
// from Google Ads (the advertisers in our Auction insights downloads, and the ones Competitor ads
// sees) and anyone added by hand. Listing sites (Zillow, Redfin...) and our own site are left out.
// Each has a tier: 1 for the markets that matter most (San Francisco, San Mateo, Santa Clara), 2 for
// the rest. Saved in .data/seo-competitors.json.
import { readSamples } from "@/lib/competitors/ad-samples"
import { getAuctionUploads } from "@/lib/competitors/auction-insights"
import { jsonFileStore } from "@/lib/json-file-store"
import { siteOf } from "@/lib/research/site"
import { isDirectory } from "@/lib/research/serp-analysis"
import { OUR_SITES } from "@/lib/research/serp"

export type WatchedSite = {
  site: string // "maplehomebuyers.com"
  name: string
  url: string // where checks start: "https://www.maplehomebuyers.com/"
  tier: 1 | 2 | null
  on: boolean
  from: "auction" | "ads" | "manual"
  addedAt: string
  by: string
}

const file = jsonFileStore<{ sites: WatchedSite[] }>("seo-competitors.json", () => ({ sites: [] }))
export const getWatchList = async () => (await file.read()).sites ?? []

const skip = (site: string) => !site || OUR_SITES.includes(site) || isDirectory(site)

// A computer on this network (the router, this computer) rather than a website: never checked. The
// tests run fake competitor sites on this computer, with DEALTRACK_LOCAL_SITES=1.
const isLocal = (host: string) =>
  host === "localhost" || !host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || /\.(local|internal|lan|home)$/.test(host)

// "https://www.maplehomebuyers.com/sell" or "maplehomebuyers.com" → the site and a start address.
export function siteFromInput(input: string): { site: string; url: string } | null {
  const raw = input.trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null
  const host = u.hostname.replace(/^\[|\]$/g, "")
  if (isLocal(host)) return process.env.DEALTRACK_LOCAL_SITES === "1" ? { site: u.host, url: `${u.protocol}//${u.host}/` } : null
  const site = siteOf(u.href)
  if (!site) return null
  return { site, url: `${u.protocol}//${u.host}/` }
}

// Advertisers seen in Google Ads (Auction insights and Competitor ads) that aren't on the list yet,
// most seen first.
export async function suggestedCompetitors(): Promise<{ site: string; from: "auction" | "ads"; seen: number }[]> {
  const listed = new Set((await getWatchList()).map((s) => s.site))
  const by = new Map<string, { site: string; from: "auction" | "ads"; seen: number }>()
  for (const upload of (await getAuctionUploads()).slice(0, 6))
    for (const r of upload.rows) {
      const site = r.you ? "" : siteOf(r.domain)
      if (skip(site) || listed.has(site)) continue
      const had = by.get(site)
      by.set(site, { site, from: "auction", seen: (had?.seen ?? 0) + 1 })
    }
  for (const s of await readSamples(90))
    for (const a of s.ads) {
      if (skip(a.d) || listed.has(a.d)) continue
      const had = by.get(a.d)
      by.set(a.d, { site: a.d, from: had?.from ?? "ads", seen: (had?.seen ?? 0) + 1 })
    }
  return [...by.values()].sort((a, b) => Number(b.from === "auction") - Number(a.from === "auction") || b.seen - a.seen).slice(0, 40)
}

export async function addCompetitor(input: { url: string; name?: string; tier?: 1 | 2 | null; from?: WatchedSite["from"] }, by: string) {
  const found = siteFromInput(input.url)
  if (!found) return { ok: false, message: "That isn't a website address." }
  if (skip(found.site)) return { ok: false, message: `${found.site} is a listing site or ours, so it isn't watched.` }
  return file.update((f) => {
    f.sites ??= []
    if (f.sites.some((s) => s.site === found.site)) return { ok: false, message: `${found.site} is already on the list.` }
    f.sites.push({
      site: found.site,
      name: (input.name ?? "").trim().slice(0, 80) || found.site,
      url: found.url,
      tier: input.tier ?? null,
      on: true,
      from: input.from ?? "manual",
      addedAt: new Date().toISOString(),
      by: by.slice(0, 60),
    })
    return { ok: true, message: `Added ${found.site}. Its first check is the starting point; changes show from the check after.` }
  })
}

export async function updateCompetitor(site: string, patch: Partial<Pick<WatchedSite, "name" | "tier" | "on">>) {
  await file.update((f) => {
    const s = (f.sites ?? []).find((x) => x.site === site)
    if (!s) return
    if (patch.name !== undefined) s.name = patch.name.trim().slice(0, 80) || s.site
    if (patch.tier !== undefined) s.tier = patch.tier
    if (patch.on !== undefined) s.on = patch.on
  })
}

export async function removeCompetitor(site: string) {
  await file.update((f) => {
    f.sites = (f.sites ?? []).filter((s) => s.site !== site)
  })
}
