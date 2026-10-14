// Competitors → SEO → Keywords: our own Semrush-style keyword numbers for one place (California or
// a city). Every keyword gets an estimated monthly search count with a range, how sure it is, and
// what it came from, the way Semrush shows one number (its local numbers are estimates too):
//   1. Keyword Planner: the city's own number when it was run for that city; else California's
//      number × the city's share of California's searches. A month or two behind, and rounded.
//   2. Adjusted to now: Google Trends (this month against the year) when it was checked; else
//      Keyword Planner's latest month against its year.
//   3. Never below what we know for real: our ads' searches in our area (Google Ads) and our own
//      views in Google's results (Search Console), for California.
// Then who ranks there (from the searches DealTrack makes), where we rank, and estimated monthly
// visits: searches × the share of clicks a position gets (ours from Search Console where we have it).
// No I/O: the page gathers the inputs.
import { placeOf, topicOf } from "@/lib/research/classify"
import type { ResearchKeyword } from "@/lib/research/keywords"
import { normalizeKeyword } from "@/lib/research/parse"
import { isDirectory } from "@/lib/research/serp-analysis"
import type { AdsSearches } from "@/lib/seo/ads-searches"
import { rankKey, type Idea, type Ranking } from "@/lib/seo/rankings"
import { ctrAt, type ScReport } from "@/lib/seo/search-console"
import type { TrendEntry } from "@/lib/seo/trends"

export const CA = "California"

export type Confidence = "high" | "medium" | "low"
export type EstimateRow = {
  k: string
  topic: string
  named: string | null // the city the keyword names, if any
  searches: number | null // estimated a month, in this place
  low: number | null
  high: number | null
  confidence: Confidence | null
  basis: string[] // how it was worked out, step by step
  trend: number[] // Keyword Planner's last 12 months for this place (estimated for a share)
  now: number | null // this month against the year: 1.2 = 20% above
  nowFrom: "Google Trends" | "Keyword Planner" | null
  trendsAt: string | null // when Google Trends was last asked (an answer or not)
  ads: AdsSearches | null // our ads, in our area, last 30 days
  sc: { clicks: number; impressions: number; position: number; page?: string } | null // all places, Search Console's period
  rank: { ours: number | null; top: string[]; at: string } | null // a search made from this place
  ourPosition: number | null
  ourPositionFrom: "Google" | "Search Console" | null // a search from this place, or Search Console's average
  visits: number | null // estimated a month, to us
  leader: { site: string; position: number; visits: number | null } | null // the first business ranked here, not us
}

export type EstimateInput = {
  keywords: ResearchKeyword[]
  shares: Map<string, number> // each city's share of California's searches (Keyword Planner totals)
  ads: Map<string, AdsSearches>
  sc: ScReport | null
  rankings: Ranking[]
  trends: Record<string, TrendEntry>
  ourSites: string[]
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
// Round the way an estimate should read: 1,234 → 1,230; 87 → 87.
const nice = (n: number) => (n >= 1000 ? Math.round(n / 10) * 10 : n >= 100 ? Math.round(n / 5) * 5 : Math.round(n))
const pct = (n: number) => `${Math.round(n * 100)}%`

export function estimates(input: EstimateInput, place: string): EstimateRow[] {
  const sc = input.sc
  const scBy = new Map((sc?.queries ?? []).map((q) => [normalizeKeyword(q.q) ?? q.q, q]))
  const rankBy = new Map(input.rankings.map((r) => [rankKey(r.loc, r.k), r]))
  const scale = sc ? 30 / sc.days : 1
  const ca = place.toLowerCase() === CA.toLowerCase()

  return input.keywords.map((k) => {
    const basis: string[] = []
    const named = placeOf(k.text) ?? null
    let n: number | null = null
    let width = 0.5
    let confidence: Confidence | null = null
    let trend: number[] = []

    // 1. Keyword Planner.
    const local = ca ? undefined : k.local?.[place]
    const share = ca ? undefined : input.shares.get(place)
    if (ca && k.volume !== undefined) {
      n = k.volume
      width = 0.25
      confidence = "medium"
      trend = k.trend ?? []
      basis.push(`Keyword Planner, California: ${k.volume.toLocaleString("en-US")} a month`)
    } else if (local?.volume !== undefined) {
      n = local.volume
      width = 0.25
      confidence = "medium"
      trend = local.trend ?? []
      basis.push(`Keyword Planner, ${place}: ${local.volume.toLocaleString("en-US")} a month`)
    } else if (!ca && named && named.toLowerCase() === place.toLowerCase() && k.volume !== undefined) {
      n = k.volume
      width = 0.3
      confidence = "medium"
      trend = k.trend ?? []
      basis.push(`Keyword Planner: the search names ${named}, so California's ${k.volume.toLocaleString("en-US")} is mostly from there`)
    } else if (!ca && !named && share && k.volume !== undefined) {
      n = k.volume * share
      width = 0.5
      confidence = "low"
      trend = (k.trend ?? []).map((v) => Math.round(v * share))
      basis.push(`California's ${k.volume.toLocaleString("en-US")} × ${place}'s share of California's searches (${pct(share)})`)
    }

    // 2. Adjusted to now.
    const t = input.trends[normalizeKeyword(k.text) ?? k.text]
    const fromTrends = t && "points" in t && t.now !== null ? t.now : null
    const fromPlanner = trend.length >= 6 && trend.some((v) => v > 0) ? (trend.at(-1) ?? 0) / (trend.reduce((s, v) => s + v, 0) / trend.length) : null
    const now = fromTrends ?? (fromPlanner !== null && Number.isFinite(fromPlanner) ? fromPlanner : null)
    const nowFrom = fromTrends !== null ? ("Google Trends" as const) : now !== null ? ("Keyword Planner" as const) : null
    if (n !== null && now !== null && Math.abs(now - 1) >= 0.05) {
      const f = clamp(now, 0.5, 2)
      n *= f
      basis.push(`Adjusted to now: ${f > 1 ? "+" : ""}${Math.round((f - 1) * 100)}% (${nowFrom === "Google Trends" ? "Google Trends, this month vs. the year" : "Keyword Planner's latest month vs. its year"})`)
    }

    // 3. What we know for real, for California.
    const ads = input.ads.get(normalizeKeyword(k.text) ?? k.text) ?? null
    const s = scBy.get(normalizeKeyword(k.text) ?? k.text)
    if (ca && ads?.searches) {
      if (n === null || ads.searches > n) {
        basis.push(`Raised to our ads' ${ads.searches.toLocaleString("en-US")} searches in our area (Google Ads, 30 days${ads.exact ? "" : ", with similar searches"})`)
        n = ads.searches
        width = 0.3
        confidence = "medium"
      } else if (Math.abs(ads.searches / n - 1) <= 0.4) {
        confidence = "high"
        basis.push(`Google Ads agrees: ${ads.searches.toLocaleString("en-US")} searches in our area`)
      }
    }
    if (ca && s && s.position > 0 && s.position <= 10 && s.impressions > 0) {
      const seen = s.impressions * scale
      if (n === null || seen > n) {
        basis.push(`Raised to our ${Math.round(seen).toLocaleString("en-US")} views a month on page 1 (Search Console)`)
        n = seen
        width = Math.min(width, 0.4)
        confidence ??= "low"
      }
    }

    // Who ranks here, and where we are.
    const r = rankBy.get(rankKey(place, k.text)) ?? null
    const rank = r ? { ours: r.now.ours, top: r.now.top, at: r.now.at } : null
    let ourPosition: number | null = null
    let ourPositionFrom: EstimateRow["ourPositionFrom"] = null
    if (rank) {
      ourPosition = rank.ours
      ourPositionFrom = "Google"
    } else if (ca && s) {
      ourPosition = Math.round(s.position * 10) / 10
      ourPositionFrom = "Search Console"
    }
    const searches = n === null ? null : nice(n)
    const visits = searches !== null && ourPosition ? Math.round(searches * ctrAt(sc?.ctrCurve ?? null, ourPosition)) : null
    const leaderAt = rank?.top.findIndex((d) => !input.ourSites.includes(d) && !isDirectory(d)) ?? -1
    const leader =
      rank && leaderAt >= 0
        ? { site: rank.top[leaderAt], position: leaderAt + 1, visits: searches !== null ? Math.round(searches * ctrAt(sc?.ctrCurve ?? null, leaderAt + 1)) : null }
        : null

    return {
      k: k.text,
      topic: topicOf(k.text),
      named,
      searches,
      low: n === null ? null : nice(n * (1 - width)),
      high: n === null ? null : nice(n * (1 + width)),
      confidence: n === null ? null : confidence,
      basis,
      trend,
      now,
      nowFrom,
      trendsAt: t?.at ?? null,
      ads,
      sc: s ? { clicks: s.clicks, impressions: s.impressions, position: s.position, page: s.page } : null,
      rank,
      ourPosition,
      ourPositionFrom,
      visits,
      leader,
    }
  })
}

export type SiteTraffic = { visits: number; results: number; top3: number }

// Each site's estimated visits a month from Google's free results, over the keyword × city
// searches checked: that keyword's searches in that city × the share of clicks its position gets.
// Semrush's "traffic" works the same way; like it, this covers only the searches checked.
export function siteTraffic(input: EstimateInput, rankings: Ranking[]): Map<string, SiteTraffic> {
  const out = new Map<string, SiteTraffic>()
  const byText = new Map(input.keywords.map((k) => [normalizeKeyword(k.text) ?? k.text, k]))
  const byPlace = new Map<string, Ranking[]>()
  for (const r of rankings) byPlace.set(r.loc, [...(byPlace.get(r.loc) ?? []), r])
  for (const [place, list] of byPlace) {
    const keywords = [...new Set(list.map((r) => byText.get(normalizeKeyword(r.k) ?? r.k)).filter((k): k is ResearchKeyword => Boolean(k)))]
    const searches = new Map(estimates({ ...input, keywords }, place).map((e) => [normalizeKeyword(e.k) ?? e.k, e.searches]))
    for (const r of list) {
      const n = searches.get(normalizeKeyword(r.k) ?? r.k) ?? null
      r.now.top.forEach((site, i) => {
        const t = out.get(site) ?? { visits: 0, results: 0, top3: 0 }
        t.results++
        if (i < 3) t.top3++
        if (n) t.visits += n * ctrAt(input.sc?.ctrCurve ?? null, i + 1)
        out.set(site, t)
      })
    }
  }
  for (const t of out.values()) t.visits = Math.round(t.visits)
  return out
}

export type KeywordIdea = { text: string; from: string; detail: string; weight: number }

// New keywords to add: searches that showed us (Search Console), "People also ask" and related
// searches, and rising searches from Google Trends, that aren't in the list yet. Most seen first.
export function keywordIdeas(sc: ScReport | null, ideas: Idea[], trends: Record<string, TrendEntry>, known: Set<string>): KeywordIdea[] {
  const out = new Map<string, KeywordIdea>()
  const add = (idea: KeywordIdea) => {
    // A question mark can't be in a keyword (Google Ads and Keyword Planner refuse it).
    const key = normalizeKeyword(idea.text.replace(/[?!.]+$/, ""))
    if (!key || known.has(key) || out.has(key) || topicOf(key) === "brand") return
    out.set(key, { ...idea, text: key })
  }
  for (const q of sc?.queries ?? [])
    if (q.impressions >= 5)
      add({ text: q.q, from: "Search Console", detail: `${q.impressions.toLocaleString("en-US")} views, position ${q.position.toFixed(1)}`, weight: q.impressions })
  for (const i of ideas)
    add({
      text: i.text,
      from: i.kind === "question" ? "People also ask" : "Related searches",
      detail: `Seen ${i.seen}× · on “${i.keywords[0]}”${i.places.length > 1 ? ` in ${i.places.length} places` : ` in ${i.places[0]}`}`,
      weight: i.seen * 10,
    })
  for (const [k, t] of Object.entries(trends))
    if ("rising" in t) for (const q of t.rising) add({ text: q, from: "Google Trends (rising)", detail: `Rising with “${k}”`, weight: 50 })
  return [...out.values()].sort((a, b) => b.weight - a.weight).slice(0, 200)
}
