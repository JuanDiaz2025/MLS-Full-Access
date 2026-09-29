// Ads and their assets, for the Ads & creatives QA page: approval status and the policy topics
// behind it, ad strength, headline and description counts, pinning, and final URLs.

import type { DateRange } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { cleanUrl, emptyMetrics, type Metrics } from "@/lib/google-ads/reports"

type Num = string | number | undefined
const num = (v: Num) => Number(v ?? 0) || 0

export type AdRow = {
  id: string
  campaignId: string
  campaign: string
  campaignStatus: string
  adGroup: string
  type: string
  strength: string // EXCELLENT, GOOD, AVERAGE, POOR, PENDING, UNSPECIFIED…
  approval: string // APPROVED, APPROVED_LIMITED, DISAPPROVED, AREA_OF_INTEREST_ONLY, UNKNOWN
  review: string
  topics: string[] // policy topics, e.g. DESTINATION_NOT_WORKING
  finalUrl: string
  headlines: number
  descriptions: number
  pinned: number // pinned headlines
  metrics: Metrics
}

type TextAsset = { text?: string; pinnedField?: string }

export async function getAds(range: DateRange): Promise<AdRow[]> {
  const [list, stats] = await Promise.all([
    gaql<{
      campaign: { id?: Num; name?: string; status?: string }
      adGroup: { name?: string }
      adGroupAd: {
        adStrength?: string
        policySummary?: { approvalStatus?: string; reviewStatus?: string; policyTopicEntries?: { topic?: string }[] }
        ad: { id?: Num; type?: string; finalUrls?: string[]; responsiveSearchAd?: { headlines?: TextAsset[]; descriptions?: TextAsset[] } }
      }
    }>(
      `SELECT campaign.id, campaign.name, campaign.status, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type,
         ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status,
         ad_group_ad.policy_summary.policy_topic_entries, ad_group_ad.ad.final_urls,
         ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions
       FROM ad_group_ad
       WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status IN ('ENABLED', 'PAUSED')`,
    ),
    gaql<{ adGroupAd: { ad: { id?: Num } }; metrics?: { costMicros?: Num; clicks?: Num; impressions?: Num; conversions?: Num } }>(
      `SELECT ad_group_ad.ad.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
       FROM ad_group_ad WHERE segments.date BETWEEN '${range.from}' AND '${range.to}' AND metrics.impressions > 0`,
    ),
  ])
  const byId = new Map<string, Metrics>()
  for (const s of stats) {
    const id = String(s.adGroupAd.ad.id ?? "")
    const m = byId.get(id) ?? emptyMetrics()
    m.cost += num(s.metrics?.costMicros) / 1_000_000
    m.clicks += num(s.metrics?.clicks)
    m.impressions += num(s.metrics?.impressions)
    m.conversions += num(s.metrics?.conversions)
    byId.set(id, m)
  }
  return list.map((r) => {
    const ad = r.adGroupAd.ad
    const rsa = ad.responsiveSearchAd
    const id = String(ad.id ?? "")
    return {
      id,
      campaignId: String(r.campaign.id ?? ""),
      campaign: r.campaign.name ?? "(no name)",
      campaignStatus: r.campaign.status ?? "",
      adGroup: r.adGroup.name ?? "",
      type: ad.type ?? "",
      strength: r.adGroupAd.adStrength ?? "UNSPECIFIED",
      approval: r.adGroupAd.policySummary?.approvalStatus ?? "UNKNOWN",
      review: r.adGroupAd.policySummary?.reviewStatus ?? "",
      topics: [...new Set((r.adGroupAd.policySummary?.policyTopicEntries ?? []).map((t) => t.topic ?? "").filter(Boolean))],
      finalUrl: ad.finalUrls?.[0] ? cleanUrl(ad.finalUrls[0]) : "",
      headlines: rsa?.headlines?.length ?? 0,
      descriptions: rsa?.descriptions?.length ?? 0,
      pinned: rsa?.headlines?.filter((h) => h.pinnedField).length ?? 0,
      metrics: byId.get(id) ?? emptyMetrics(),
    }
  })
}

export type AssetRow = { text: string; field: string; label: string; campaign: string }

// Google rates each headline and description (Best, Good, Low) once it has enough data.
export async function getAssetRatings(): Promise<AssetRow[]> {
  const rows = await gaql<{
    campaign: { name?: string }
    asset: { textAsset?: { text?: string } }
    adGroupAdAssetView: { fieldType?: string; performanceLabel?: string }
  }>(
    `SELECT campaign.name, asset.text_asset.text, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label
     FROM ad_group_ad_asset_view
     WHERE ad_group_ad_asset_view.enabled = TRUE AND campaign.status = 'ENABLED'
       AND ad_group_ad_asset_view.field_type IN ('HEADLINE', 'DESCRIPTION')`,
  )
  return rows.map((r) => ({
    text: r.asset.textAsset?.text ?? "",
    field: r.adGroupAdAssetView.fieldType ?? "",
    label: r.adGroupAdAssetView.performanceLabel ?? "UNKNOWN",
    campaign: r.campaign.name ?? "",
  }))
}

// Plain-English reasons and fixes for the policy topics this account runs into.
export const POLICY_TOPICS: Record<string, { reason: string; fix: string }> = {
  DESTINATION_NOT_WORKING: {
    reason: "The landing page doesn't load (404 or the domain is gone)",
    fix: "Fix or redirect the page, or point the ad at a working page.",
  },
  DESTINATION_MISMATCH: { reason: "The display URL doesn't match the landing page's domain", fix: "Use the landing page's own domain." },
  CONSUMER_FINANCE: {
    reason: "Google's consumer finance rules (wording about loans, credit, or financing)",
    fix: "Remove finance wording, or complete Google's financial services verification.",
  },
  UNAVAILABLE_VIDEO: { reason: "The YouTube video is private or deleted", fix: "Make the video public or unlisted, or swap it." },
  STALE_DISAPPROVAL: { reason: "An old disapproval Google hasn't re-reviewed", fix: "Edit and save the ad to ask for a new review." },
  HOUSING: { reason: "Housing ad rules limit targeting (no age, gender, or ZIP targeting)", fix: "Nothing to fix; targeting options are limited." },
}
