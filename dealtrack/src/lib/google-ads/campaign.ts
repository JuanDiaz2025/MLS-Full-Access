// One campaign, everything about it: its settings and Google's status, its ads with every headline
// and description (and how Google rates each), the images, sitelinks and callouts that show with
// them, its keywords with Quality Score, and when its clicks come in. Read-only.

import { addDays, today, type DateRange } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { cleanUrl, emptyMetrics, weekdays, type Metrics, type ScheduleGrid } from "@/lib/google-ads/reports"

type Num = string | number | undefined
const num = (v: Num) => Number(v ?? 0) || 0
const during = (r: DateRange) => `segments.date BETWEEN '${r.from}' AND '${r.to}'`
const METRICS = "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions"
type MetricsRow = { costMicros?: Num; clicks?: Num; impressions?: Num; conversions?: Num }

function addRow(into: Metrics, m: MetricsRow | undefined) {
  into.cost += num(m?.costMicros) / 1_000_000
  into.clicks += num(m?.clicks)
  into.impressions += num(m?.impressions)
  into.conversions += num(m?.conversions)
  return into
}

// Only digits reach a query.
export const validCampaignId = (id: string) => /^\d{1,20}$/.test(id)

// ---- Settings -------------------------------------------------------------------------------

export type CampaignInfo = {
  id: string
  name: string
  status: string
  channel: string
  bidding: string
  biddingStatus: string // LEARNING_NEW, ENABLED, LIMITED_BY_BUDGET…
  primaryStatus: string // ELIGIBLE, LIMITED, LEARNING, PAUSED…
  primaryReasons: string[]
  dailyBudget: number | null
  targetCpa: number | null
  monthSpent: number // this calendar month so far
}

export async function getCampaignInfo(id: string): Promise<CampaignInfo | null> {
  if (!validCampaignId(id)) return null
  const monthStart = `${today().slice(0, 7)}-01`
  const [rows, month] = await Promise.all([
    gaql<{
      campaign: {
        id?: Num
        name?: string
        status?: string
        advertisingChannelType?: string
        biddingStrategyType?: string
        biddingStrategySystemStatus?: string
        primaryStatus?: string
        primaryStatusReasons?: string[]
        maximizeConversions?: { targetCpaMicros?: Num }
        targetCpa?: { targetCpaMicros?: Num }
      }
      campaignBudget?: { amountMicros?: Num }
    }>(
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type,
         campaign.bidding_strategy_system_status, campaign.primary_status, campaign.primary_status_reasons,
         campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros, campaign_budget.amount_micros
       FROM campaign WHERE campaign.id = ${id}`,
    ),
    gaql<{ metrics?: MetricsRow }>(
      `SELECT ${METRICS} FROM campaign WHERE campaign.id = ${id} AND segments.date BETWEEN '${monthStart}' AND '${today()}'`,
    ),
  ])
  const r = rows[0]
  if (!r) return null
  const c = r.campaign
  const cpa = num(c.maximizeConversions?.targetCpaMicros) || num(c.targetCpa?.targetCpaMicros)
  return {
    id: String(c.id ?? id),
    name: c.name ?? "(no name)",
    status: c.status ?? "UNKNOWN",
    channel: c.advertisingChannelType ?? "",
    bidding: c.biddingStrategyType ?? "",
    biddingStatus: c.biddingStrategySystemStatus ?? "",
    primaryStatus: c.primaryStatus ?? "",
    primaryReasons: c.primaryStatusReasons ?? [],
    dailyBudget: r.campaignBudget?.amountMicros === undefined ? null : num(r.campaignBudget.amountMicros) / 1_000_000,
    targetCpa: cpa ? cpa / 1_000_000 : null,
    monthSpent: month.reduce((s, m) => s + num(m.metrics?.costMicros) / 1_000_000, 0),
  }
}

// ---- Ads ------------------------------------------------------------------------------------

// BEST, GOOD, LOW, LEARNING, PENDING, UNKNOWN: Google's rating of a headline or description.
export type AdText = { text: string; pinned: string; label: string }

export type CampaignAd = {
  id: string
  adGroup: string
  status: string
  type: string
  strength: string
  approval: string
  topics: string[]
  finalUrl: string
  displayUrl: string // domain/path1/path2, as the ad shows it
  headlines: AdText[]
  descriptions: AdText[]
  metrics: Metrics
}

type TextAsset = { text?: string; pinnedField?: string }

export async function getCampaignAds(id: string, range: DateRange): Promise<CampaignAd[]> {
  if (!validCampaignId(id)) return []
  const [list, stats, labels] = await Promise.all([
    gaql<{
      adGroup: { name?: string }
      adGroupAd: {
        resourceName: string
        status?: string
        adStrength?: string
        policySummary?: { approvalStatus?: string; policyTopicEntries?: { topic?: string }[] }
        ad: {
          id?: Num
          type?: string
          finalUrls?: string[]
          responsiveSearchAd?: { headlines?: TextAsset[]; descriptions?: TextAsset[]; path1?: string; path2?: string }
        }
      }
    }>(
      `SELECT ad_group.name, ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status,
         ad_group_ad.policy_summary.policy_topic_entries, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
         ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
         ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2
       FROM ad_group_ad
       WHERE campaign.id = ${id} AND ad_group_ad.status IN ('ENABLED', 'PAUSED') AND ad_group.status IN ('ENABLED', 'PAUSED')`,
    ),
    gaql<{ adGroupAd: { ad: { id?: Num } }; metrics?: MetricsRow }>(
      `SELECT ad_group_ad.ad.id, ${METRICS} FROM ad_group_ad WHERE campaign.id = ${id} AND ${during(range)} AND metrics.impressions > 0`,
    ),
    gaql<{ adGroupAdAssetView: { adGroupAd?: string; fieldType?: string; performanceLabel?: string }; asset: { textAsset?: { text?: string } } }>(
      `SELECT ad_group_ad_asset_view.ad_group_ad, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label, asset.text_asset.text
       FROM ad_group_ad_asset_view
       WHERE campaign.id = ${id} AND ad_group_ad_asset_view.enabled = TRUE AND ad_group_ad_asset_view.field_type IN ('HEADLINE', 'DESCRIPTION')`,
    ).catch(() => []), // ratings are a nice-to-have; the ads still show without them
  ])
  const metrics = new Map<string, Metrics>()
  for (const s of stats) {
    const adId = String(s.adGroupAd.ad.id ?? "")
    metrics.set(adId, addRow(metrics.get(adId) ?? emptyMetrics(), s.metrics))
  }
  const label = new Map(
    labels.map((l) => [`${l.adGroupAdAssetView.adGroupAd}|${l.asset.textAsset?.text}`, l.adGroupAdAssetView.performanceLabel ?? "UNKNOWN"]),
  )
  return list
    .map((r) => {
      const ad = r.adGroupAd.ad
      const rsa = ad.responsiveSearchAd
      const finalUrl = ad.finalUrls?.[0] ?? ""
      const host = finalUrl ? new URL(finalUrl).hostname.replace(/^www\./, "") : ""
      const texts = (items: TextAsset[] | undefined): AdText[] =>
        (items ?? []).map((t) => ({
          text: t.text ?? "",
          pinned: t.pinnedField ?? "",
          label: label.get(`${r.adGroupAd.resourceName}|${t.text}`) ?? "UNKNOWN",
        }))
      const adId = String(ad.id ?? "")
      return {
        id: adId,
        adGroup: r.adGroup.name ?? "",
        status: r.adGroupAd.status ?? "",
        type: ad.type ?? "",
        strength: r.adGroupAd.adStrength ?? "UNSPECIFIED",
        approval: r.adGroupAd.policySummary?.approvalStatus ?? "UNKNOWN",
        topics: [...new Set((r.adGroupAd.policySummary?.policyTopicEntries ?? []).map((t) => t.topic ?? "").filter(Boolean))],
        finalUrl: finalUrl ? cleanUrl(finalUrl) : "",
        displayUrl: [host, rsa?.path1, rsa?.path2].filter(Boolean).join("/"),
        headlines: texts(rsa?.headlines),
        descriptions: texts(rsa?.descriptions),
        metrics: metrics.get(adId) ?? emptyMetrics(),
      }
    })
    .sort((a, b) => (a.status === "ENABLED" ? 0 : 1) - (b.status === "ENABLED" ? 0 : 1) || b.metrics.impressions - a.metrics.impressions)
}

// ---- Assets (images, sitelinks, callouts…) ---------------------------------------------------

export type CampaignAssets = {
  businessName: string
  logo: string | null
  images: { url: string; level: string }[]
  sitelinks: { text: string; line1: string; line2: string; url: string }[]
  callouts: string[]
  snippets: { header: string; values: string[] }[]
  phone: string
}

type AssetRow = {
  campaignAsset?: { fieldType?: string }
  adGroupAsset?: { fieldType?: string }
  customerAsset?: { fieldType?: string }
  asset: {
    type?: string
    finalUrls?: string[]
    textAsset?: { text?: string }
    imageAsset?: { fullSize?: { url?: string } }
    sitelinkAsset?: { linkText?: string; description1?: string; description2?: string }
    calloutAsset?: { calloutText?: string }
    structuredSnippetAsset?: { header?: string; values?: string[] }
    callAsset?: { phoneNumber?: string }
  }
}

const ASSET_FIELDS = `asset.type, asset.final_urls, asset.text_asset.text, asset.image_asset.full_size.url, asset.sitelink_asset.link_text,
  asset.sitelink_asset.description1, asset.sitelink_asset.description2, asset.callout_asset.callout_text,
  asset.structured_snippet_asset.header, asset.structured_snippet_asset.values, asset.call_asset.phone_number`

// What shows with the ads: the campaign's and its ad groups' own assets, and the account-wide ones
// for any kind the campaign doesn't set itself (that's how Google picks them too).
export async function getCampaignAssets(id: string): Promise<CampaignAssets> {
  const out: CampaignAssets = { businessName: "", logo: null, images: [], sitelinks: [], callouts: [], snippets: [], phone: "" }
  if (!validCampaignId(id)) return out
  const [campaign, groups, account] = await Promise.all([
    gaql<AssetRow>(
      `SELECT campaign_asset.field_type, campaign.id, ${ASSET_FIELDS} FROM campaign_asset WHERE campaign.id = ${id} AND campaign_asset.status = 'ENABLED'`,
    ),
    gaql<AssetRow>(
      `SELECT ad_group_asset.field_type, campaign.id, ad_group.status, ${ASSET_FIELDS} FROM ad_group_asset
       WHERE campaign.id = ${id} AND ad_group_asset.status = 'ENABLED' AND ad_group.status = 'ENABLED'`,
    ),
    gaql<AssetRow>(`SELECT customer_asset.field_type, ${ASSET_FIELDS} FROM customer_asset WHERE customer_asset.status = 'ENABLED'`),
  ])
  const tagged = [
    ...campaign.map((r) => ({ r, field: r.campaignAsset?.fieldType ?? "", level: "Campaign" })),
    ...groups.map((r) => ({ r, field: r.adGroupAsset?.fieldType ?? "", level: "Ad group" })),
  ]
  const own = new Set(tagged.map((t) => t.field))
  for (const r of account) {
    const field = r.customerAsset?.fieldType ?? ""
    if (!own.has(field)) tagged.push({ r, field, level: "Account" })
  }
  const seen = new Set<string>()
  for (const { r, field, level } of tagged) {
    const a = r.asset
    const key = `${field}|${a.textAsset?.text ?? a.imageAsset?.fullSize?.url ?? a.sitelinkAsset?.linkText ?? a.calloutAsset?.calloutText ?? a.callAsset?.phoneNumber ?? a.structuredSnippetAsset?.header}`
    if (seen.has(key)) continue
    seen.add(key)
    if (field === "BUSINESS_NAME" && a.textAsset?.text) out.businessName ||= a.textAsset.text
    else if ((field === "BUSINESS_LOGO" || field === "LOGO") && a.imageAsset?.fullSize?.url) out.logo ||= a.imageAsset.fullSize.url
    else if (a.imageAsset?.fullSize?.url) out.images.push({ url: a.imageAsset.fullSize.url, level })
    else if (field === "SITELINK" && a.sitelinkAsset)
      out.sitelinks.push({
        text: a.sitelinkAsset.linkText ?? "",
        line1: a.sitelinkAsset.description1 ?? "",
        line2: a.sitelinkAsset.description2 ?? "",
        url: a.finalUrls?.[0] ? cleanUrl(a.finalUrls[0]) : "",
      })
    else if (field === "CALLOUT" && a.calloutAsset?.calloutText) out.callouts.push(a.calloutAsset.calloutText)
    else if (field === "STRUCTURED_SNIPPET" && a.structuredSnippetAsset)
      out.snippets.push({ header: a.structuredSnippetAsset.header ?? "", values: a.structuredSnippetAsset.values ?? [] })
    else if (field === "CALL" && a.callAsset?.phoneNumber) out.phone ||= a.callAsset.phoneNumber
  }
  return out
}

// ---- Keywords -------------------------------------------------------------------------------

export type CampaignKeyword = {
  id: string
  text: string
  matchType: string
  status: string
  adGroup: string
  quality: number | null
  metrics: Metrics
}

export async function getCampaignKeywords(id: string, range: DateRange): Promise<CampaignKeyword[]> {
  if (!validCampaignId(id)) return []
  const [list, stats] = await Promise.all([
    gaql<{
      adGroup: { name?: string }
      adGroupCriterion: {
        resourceName: string
        status?: string
        keyword?: { text?: string; matchType?: string }
        qualityInfo?: { qualityScore?: Num }
      }
    }>(
      `SELECT ad_group.name, ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.keyword.text,
         ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score
       FROM ad_group_criterion
       WHERE campaign.id = ${id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE
         AND ad_group_criterion.status IN ('ENABLED', 'PAUSED') AND ad_group.status IN ('ENABLED', 'PAUSED')`,
    ),
    gaql<{ adGroupCriterion: { resourceName: string }; metrics?: MetricsRow }>(
      `SELECT ad_group_criterion.resource_name, ${METRICS} FROM keyword_view
       WHERE campaign.id = ${id} AND ${during(range)} AND metrics.impressions > 0`,
    ),
  ])
  const metrics = new Map<string, Metrics>()
  for (const s of stats) {
    const key = s.adGroupCriterion.resourceName
    metrics.set(key, addRow(metrics.get(key) ?? emptyMetrics(), s.metrics))
  }
  return list
    .map((r) => {
      const c = r.adGroupCriterion
      const q = num(c.qualityInfo?.qualityScore)
      return {
        id: c.resourceName,
        text: c.keyword?.text ?? "",
        matchType: c.keyword?.matchType ?? "",
        status: c.status ?? "",
        adGroup: r.adGroup.name ?? "",
        quality: q || null,
        metrics: metrics.get(c.resourceName) ?? emptyMetrics(),
      }
    })
    .sort((a, b) => b.metrics.cost - a.metrics.cost || b.metrics.impressions - a.metrics.impressions)
}

// ---- Day and hour ---------------------------------------------------------------------------

export async function getCampaignSchedule(id: string, range: DateRange): Promise<ScheduleGrid> {
  const grid: ScheduleGrid = weekdays.map(() => Array.from({ length: 24 }, emptyMetrics))
  if (!validCampaignId(id)) return grid
  const rows = await gaql<{ segments: { dayOfWeek?: string; hour?: Num }; metrics?: MetricsRow }>(
    `SELECT segments.day_of_week, segments.hour, ${METRICS} FROM campaign WHERE campaign.id = ${id} AND ${during(range)}`,
  )
  for (const r of rows) {
    const day = weekdays.indexOf(r.segments.dayOfWeek as (typeof weekdays)[number])
    const hour = num(r.segments.hour)
    if (day >= 0 && hour >= 0 && hour < 24) addRow(grid[day][hour], r.metrics)
  }
  return grid
}

// How many days of the month have gone by, for pacing a daily budget.
export function monthDays() {
  const now = today()
  const [y, m] = now.split("-").map(Number)
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const gone = Number(now.slice(8, 10))
  return { gone, total, left: total - gone, yesterday: addDays(now, -1) }
}
