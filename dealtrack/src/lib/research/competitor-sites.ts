// Competitors → Competitor sites: the keywords Google ties to a competitor's website, from Keyword
// Planner's "start with a website" (needs Basic access), with each one's searches for California
// or one of our cities. Compared with our own list, it shows what they go after that we don't:
// like Ahrefs' or Semrush's content gap. One API operation per site. Saved in .data/competitor-sites.json.

import { keywordIdeas } from "@/lib/google-ads/client"
import { jsonFileStore } from "@/lib/json-file-store"
import { analyze } from "@/lib/research/serp-analysis"
import { OUR_SITES, getScanResults, getScans, siteOf } from "@/lib/research/serp"
import { CALIFORNIA, STATEWIDE_VOLUMES, isExplorerRefusal } from "@/lib/research/keywords"

export type SiteIdea = { text: string; volume?: number; cpcLow?: number; cpcHigh?: number; competition?: string }
export type SiteReport = { id: string; site: string; place: string; geo: string; at: string; by: string; ideas: SiteIdea[] }

const file = jsonFileStore<{ reports: SiteReport[] }>("competitor-sites.json", () => ({ reports: [] }))
const KEEP = 40
const ENGLISH = "languageConstants/1000"
const COMPETITION: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" }

export const getSiteReports = async () => (await file.read()).reports ?? []

// "https://www.SellFast.com/sell-house/" → "sellfast.com"; a bare domain works too.
export function cleanSite(input: string) {
  const text = input.trim().toLowerCase()
  if (!text) return ""
  return siteOf(/^https?:\/\//.test(text) ? text : `https://${text}`)
}

export async function analyzeSite(
  input: string,
  place: { name: string; geo: string },
  by: string,
): Promise<{ ok: boolean; message: string; id?: string }> {
  const site = cleanSite(input)
  if (!site || !site.includes(".")) return { ok: false, message: "Type a website, like sellfast.com." }
  if (OUR_SITES.includes(site)) return { ok: false, message: "That's our own site." }
  let body: { results?: { text?: string; keywordIdeaMetrics?: Record<string, string | number | undefined> }[] }
  try {
    body = (await keywordIdeas({
      language: ENGLISH,
      geoTargetConstants: [place.geo || CALIFORNIA],
      keywordPlanNetwork: "GOOGLE_SEARCH",
      includeAdultKeywords: false,
      siteSeed: { site },
      pageSize: 2000,
    })) as typeof body
  } catch (e) {
    return {
      ok: false,
      message: isExplorerRefusal(e)
        ? "Google only answers this with Basic API access."
        : `Keyword Planner didn't answer: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  const micros = (v?: string | number) => (v === undefined ? undefined : Math.round(Number(v) / 10_000) / 100)
  const seen = new Set<string>()
  const ideas: SiteIdea[] = []
  for (const r of body.results ?? []) {
    const text = r.text?.toLowerCase().replace(/\s+/g, " ").trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    const m = r.keywordIdeaMetrics ?? {}
    ideas.push({
      text,
      volume: m.avgMonthlySearches === undefined ? undefined : Number(m.avgMonthlySearches),
      cpcLow: micros(m.lowTopOfPageBidMicros),
      cpcHigh: micros(m.highTopOfPageBidMicros),
      competition: COMPETITION[String(m.competition)],
    })
  }
  if (!ideas.length) return { ok: false, message: `Google has no keywords for ${site} (too new or too small a site, or a typo).` }
  ideas.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
  const id = `${site}|${place.name}`
  await file.update((f) => {
    f.reports = [
      { id, site, place: place.name, geo: place.geo, at: new Date().toISOString(), by, ideas },
      ...(f.reports ?? []).filter((r) => r.id !== id),
    ].slice(0, KEEP)
  })
  return { ok: true, message: `${ideas.length.toLocaleString("en-US")} keywords for ${site} (${place.name}).`, id }
}

export async function deleteSiteReport(id: string) {
  await file.update((f) => {
    f.reports = (f.reports ?? []).filter((r) => r.id !== id)
  })
}

// Competitors worth a look: the sites with the most share in the newest Google rankings scan that
// buy houses (no listing sites, directories, out-of-state sites, or us).
export async function suggestedSites(): Promise<{ site: string; share: number }[]> {
  const scan = (await getScans()).find((s) => (s.kind ?? "web") === "web" && s.done > 0)
  const results = scan ? (await getScanResults(scan.id))?.results : null
  if (!results?.length) return []
  return analyze(results, new Map(), undefined, OUR_SITES)
    .sites.filter((s) => !s.directory && !s.ours && !s.outOfState)
    .slice(0, 15)
    .map((s) => ({ site: s.site, share: s.share }))
}

export { STATEWIDE_VOLUMES }
