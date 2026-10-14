// Competitors → SEO → Our Google numbers: what to look at in a Search Console report. Searches
// almost on page 1 (the quickest wins), searches new this period, searches losing clicks or
// places, the cities people name, and how each seller situation is doing. No I/O.
import { TOPICS, placeOf, topicOf } from "@/lib/research/classify"
import type { ScQuery, ScReport } from "@/lib/seo/search-console"

export const SELLER_TOPICS = new Set(["inherited", "distress", "life", "condition", "buyers", "sell", "cash", "near-me"])
export const isSellerSearch = (q: string) => SELLER_TOPICS.has(topicOf(q))

// Positions 8 to 20: on the bottom of page 1 or on page 2, where a better page moves the most.
export function almostPageOne(r: ScReport, min = 10) {
  return r.queries
    .filter((q) => q.position >= 8 && q.position <= 20 && q.impressions >= min && topicOf(q.q) !== "brand")
    .sort((a, b) => b.impressions - a.impressions)
}

// Searches that showed us this period and not the one before.
export function newSearches(r: ScReport, min = 5) {
  return r.queries.filter((q) => !q.prev && q.impressions >= min).sort((a, b) => b.impressions - a.impressions)
}

// Searches losing clicks (half or more, from at least 3) or dropping 3+ places with real views.
export function droppingSearches(r: ScReport) {
  return r.queries
    .filter((q) => q.prev && ((q.prev.clicks >= 3 && q.clicks <= q.prev.clicks / 2) || (q.impressions >= 20 && q.position - q.prev.position >= 3)))
    .sort((a, b) => (b.prev?.clicks ?? 0) - b.clicks - ((a.prev?.clicks ?? 0) - a.clicks) || b.impressions - a.impressions)
}

export type Group = { name: string; clicks: number; impressions: number; position: number; searches: number; top: ScQuery[] }

function group(rows: ScQuery[], keyOf: (q: ScQuery) => string | undefined): Group[] {
  const by = new Map<string, ScQuery[]>()
  for (const q of rows) {
    const k = keyOf(q)
    if (!k) continue
    by.set(k, [...(by.get(k) ?? []), q])
  }
  return [...by.entries()]
    .map(([name, list]) => {
      const impressions = list.reduce((s, q) => s + q.impressions, 0)
      return {
        name,
        clicks: list.reduce((s, q) => s + q.clicks, 0),
        impressions,
        position: impressions ? list.reduce((s, q) => s + q.position * q.impressions, 0) / impressions : 0,
        searches: list.length,
        top: [...list].sort((a, b) => b.impressions - a.impressions).slice(0, 3),
      }
    })
    .sort((a, b) => b.impressions - a.impressions)
}

// Search Console has no city: these are searches that name one ("sell my house fast hayward").
export const byCity = (r: ScReport) => group(r.queries, (q) => placeOf(q.q))

const TOPIC_LABEL = Object.fromEntries(TOPICS.map((t) => [t.id, t.label])) as Record<string, string>
export const byTopic = (r: ScReport) => group(r.queries, (q) => TOPIC_LABEL[topicOf(q.q)])

// Change from the period before, as a share (+0.2 = 20% more); null when there was nothing before.
export const changeOf = (now: number, before: number) => (before > 0 ? (now - before) / before : null)
