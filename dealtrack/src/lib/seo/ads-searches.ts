// Competitors → SEO → Keywords: real search counts from our own ads. For each keyword we bid on,
// Google Ads says how many times our ad showed and what share of the searches it could have shown
// in it got (impression share) over the last 30 days. Showed ÷ share ≈ how many people searched it,
// in the places our running campaigns target. An exact-match keyword is that search; phrase and
// broad also count close searches. Under a 10% share Google only says "under 10%", too rough to use.
import { gaql, missingKeys } from "@/lib/google-ads/client"
import { normalizeKeyword } from "@/lib/research/parse"
import { shared } from "@/lib/shared-state"

export type AdsSearches = { impressions: number; share: number | null; searches: number | null; exact: boolean }

type Row = {
  adGroupCriterion?: { keyword?: { text?: string; matchType?: string } }
  metrics?: { impressions?: string | number; searchImpressionShare?: string | number }
}

// Kept an hour: one Google Ads API operation, not one per page view.
const cache = shared("ads-searches", () => ({ at: 0, value: null as Map<string, AdsSearches> | null }))

export async function adsSearches(): Promise<Map<string, AdsSearches>> {
  if (cache.value && Date.now() - cache.at < 60 * 60_000) return cache.value
  const out = new Map<string, AdsSearches>()
  if (missingKeys().length) return out
  const rows = await gaql<Row>(
    `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.impressions, metrics.search_impression_share
     FROM keyword_view
     WHERE segments.date DURING LAST_30_DAYS AND ad_group_criterion.negative = FALSE AND metrics.impressions > 0`,
  ).catch(() => [] as Row[])
  for (const r of rows) {
    const text = normalizeKeyword(r.adGroupCriterion?.keyword?.text ?? "")
    if (!text) continue
    const exact = r.adGroupCriterion?.keyword?.matchType === "EXACT"
    const impressions = Number(r.metrics?.impressions ?? 0)
    const raw = Number(r.metrics?.searchImpressionShare)
    const share = Number.isFinite(raw) && raw > 0 ? raw : null
    // The same search in two ad groups: both could have shown for it, so the larger count, not the sum.
    const searches = share !== null && share >= 0.1 ? Math.round(impressions / share) : null
    const had = out.get(text)
    // An exact-match row beats a broader one for the same words.
    if (had && had.exact && !exact) continue
    if (had && had.exact === exact) {
      had.impressions += impressions
      had.searches = Math.max(had.searches ?? 0, searches ?? 0) || null
      had.share = had.searches ? had.impressions / had.searches : had.share
      continue
    }
    out.set(text, { impressions, share, searches, exact })
  }
  if (rows.length) Object.assign(cache, { at: Date.now(), value: out })
  return out
}
