// Quality Score: today's score for each keyword with its three parts, and weekly history from
// Google's historical Quality Score metrics (impression-weighted).

import type { DateRange } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { emptyMetrics, type Metrics } from "@/lib/google-ads/reports"

type Num = string | number | undefined
const num = (v: Num) => Number(v ?? 0) || 0

// Brand campaigns (people searching for Twin Home Buyer) score high by nature, which hides how
// the seller keywords are doing. Pages show non-brand by default.
export const isBrand = (campaign: string) => /\bbrand/i.test(campaign)

export type Rating = "ABOVE_AVERAGE" | "AVERAGE" | "BELOW_AVERAGE" | "UNKNOWN"

export type QualityKeyword = {
  id: string // ad group criterion resource name
  text: string
  matchType: string
  campaign: string
  campaignStatus: string
  adGroup: string
  score: number
  expectedCtr: Rating
  adRelevance: Rating
  landingPage: Rating
  metrics: Metrics
}

const rating = (v: string | undefined): Rating =>
  v === "ABOVE_AVERAGE" || v === "AVERAGE" || v === "BELOW_AVERAGE" ? v : "UNKNOWN"

export async function getQualityKeywords(range: DateRange): Promise<QualityKeyword[]> {
  const [list, stats] = await Promise.all([
    gaql<{
      campaign: { name?: string; status?: string }
      adGroup: { name?: string }
      adGroupCriterion: {
        resourceName: string
        keyword?: { text?: string; matchType?: string }
        qualityInfo?: { qualityScore?: number; creativeQualityScore?: string; postClickQualityScore?: string; searchPredictedCtr?: string }
      }
    }>(
      `SELECT campaign.name, campaign.status, ad_group.name, ad_group_criterion.resource_name,
         ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
         ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score,
         ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr
       FROM keyword_view
       WHERE ad_group_criterion.status = 'ENABLED' AND ad_group.status = 'ENABLED'
         AND campaign.status IN ('ENABLED', 'PAUSED') AND ad_group_criterion.quality_info.quality_score > 0`,
    ),
    gaql<{ adGroupCriterion: { resourceName: string }; metrics?: { costMicros?: Num; clicks?: Num; impressions?: Num; conversions?: Num } }>(
      `SELECT ad_group_criterion.resource_name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
       FROM keyword_view WHERE segments.date BETWEEN '${range.from}' AND '${range.to}' AND metrics.impressions > 0`,
    ),
  ])
  const byId = new Map<string, Metrics>()
  for (const s of stats) {
    const m = byId.get(s.adGroupCriterion.resourceName) ?? emptyMetrics()
    m.cost += num(s.metrics?.costMicros) / 1_000_000
    m.clicks += num(s.metrics?.clicks)
    m.impressions += num(s.metrics?.impressions)
    m.conversions += num(s.metrics?.conversions)
    byId.set(s.adGroupCriterion.resourceName, m)
  }
  return list.map((r) => {
    const q = r.adGroupCriterion.qualityInfo
    return {
      id: r.adGroupCriterion.resourceName,
      text: r.adGroupCriterion.keyword?.text ?? "",
      matchType: r.adGroupCriterion.keyword?.matchType ?? "",
      campaign: r.campaign.name ?? "",
      campaignStatus: r.campaign.status ?? "",
      adGroup: r.adGroup.name ?? "",
      score: num(q?.qualityScore),
      expectedCtr: rating(q?.searchPredictedCtr),
      adRelevance: rating(q?.creativeQualityScore),
      landingPage: rating(q?.postClickQualityScore),
      metrics: byId.get(r.adGroupCriterion.resourceName) ?? emptyMetrics(),
    }
  })
}

export type QualityWeek = {
  week: string // Monday, YYYY-MM-DD
  score: number | null // impression-weighted average
  impressions: number
  // Share of impressions rated below average, per part.
  belowCtr: number
  belowRelevance: number
  belowLandingPage: number
}

export async function getQualityHistory(range: DateRange, include: (campaign: string) => boolean): Promise<QualityWeek[]> {
  const rows = await gaql<{
    segments: { week: string }
    campaign: { name?: string }
    metrics?: {
      historicalQualityScore?: Num
      historicalCreativeQualityScore?: string
      historicalLandingPageQualityScore?: string
      historicalSearchPredictedCtr?: string
      impressions?: Num
    }
  }>(
    `SELECT segments.week, campaign.name, metrics.historical_quality_score, metrics.historical_creative_quality_score,
       metrics.historical_landing_page_quality_score, metrics.historical_search_predicted_ctr, metrics.impressions
     FROM keyword_view WHERE segments.date BETWEEN '${range.from}' AND '${range.to}' AND metrics.impressions > 0`,
  )
  const weeks = new Map<string, { scored: number; weight: number; imps: number; ctr: number; rel: number; lp: number; rated: number }>()
  for (const r of rows) {
    if (!include(r.campaign.name ?? "")) continue
    const imps = num(r.metrics?.impressions)
    const w = weeks.get(r.segments.week) ?? { scored: 0, weight: 0, imps: 0, ctr: 0, rel: 0, lp: 0, rated: 0 }
    w.imps += imps
    const qs = num(r.metrics?.historicalQualityScore)
    if (qs) {
      w.scored += qs * imps
      w.weight += imps
      w.rated += imps
      if (r.metrics?.historicalSearchPredictedCtr === "BELOW_AVERAGE") w.ctr += imps
      if (r.metrics?.historicalCreativeQualityScore === "BELOW_AVERAGE") w.rel += imps
      if (r.metrics?.historicalLandingPageQualityScore === "BELOW_AVERAGE") w.lp += imps
    }
    weeks.set(r.segments.week, w)
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, w]) => ({
      week,
      score: w.weight ? w.scored / w.weight : null,
      impressions: w.imps,
      belowCtr: w.rated ? w.ctr / w.rated : 0,
      belowRelevance: w.rated ? w.rel / w.rated : 0,
      belowLandingPage: w.rated ? w.lp / w.rated : 0,
    }))
}
