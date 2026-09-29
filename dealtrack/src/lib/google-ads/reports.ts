// The reports the dashboard shows, each a read-only GAQL query against the configured account.
// Google returns money in micros (1,000,000 = $1) and counts as strings; everything here is
// converted to plain dollars and numbers.

import { eachDay, type DateRange } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { matchRule, suggestedNegative, type NegativeRule } from "@/lib/negatives"
import { serviceAreaStatus, type AreaStatus } from "@/lib/service-area"

type Num = string | number | undefined
type MetricsRow = { costMicros?: Num; clicks?: Num; impressions?: Num; conversions?: Num }

export type Metrics = { cost: number; clicks: number; impressions: number; conversions: number }

const num = (v: Num) => Number(v ?? 0) || 0

export const emptyMetrics = (): Metrics => ({ cost: 0, clicks: 0, impressions: 0, conversions: 0 })

function toMetrics(m: MetricsRow | undefined): Metrics {
  return {
    cost: num(m?.costMicros) / 1_000_000,
    clicks: num(m?.clicks),
    impressions: num(m?.impressions),
    conversions: num(m?.conversions),
  }
}

function add(into: Metrics, m: Metrics) {
  into.cost += m.cost
  into.clicks += m.clicks
  into.impressions += m.impressions
  into.conversions += m.conversions
  return into
}

export function sumMetrics(items: { metrics: Metrics }[]): Metrics {
  return items.reduce((total, item) => add(total, item.metrics), emptyMetrics())
}

// Derived rates. Cost per conversion is null when there were no conversions.
export function rates(m: Metrics) {
  return {
    ctr: m.impressions ? m.clicks / m.impressions : 0,
    cpc: m.clicks ? m.cost / m.clicks : 0,
    costPerConversion: m.conversions ? m.cost / m.conversions : null,
    conversionRate: m.clicks ? m.conversions / m.clicks : 0,
  }
}

// A term or city that cost money and brought no conversions.
export const isWaste = (m: Metrics) => m.cost > 0 && m.conversions === 0

const METRICS = "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions"
const during = (r: DateRange) => `segments.date BETWEEN '${r.from}' AND '${r.to}'`

// ---- Account --------------------------------------------------------------------------------

export type Account = { id: string; name: string; currency: string; timeZone: string }

export async function getAccount(): Promise<Account> {
  const [row] = await gaql<{
    customer: { id?: Num; descriptiveName?: string; currencyCode?: string; timeZone?: string }
  }>("SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1")
  return {
    id: String(row?.customer.id ?? ""),
    name: row?.customer.descriptiveName || "Google Ads account",
    currency: row?.customer.currencyCode || "USD",
    timeZone: row?.customer.timeZone || "America/Los_Angeles",
  }
}

// ---- Daily totals ---------------------------------------------------------------------------

export type DailyPoint = { date: string; metrics: Metrics }

export async function getDaily(range: DateRange): Promise<DailyPoint[]> {
  const rows = await gaql<{ segments: { date: string }; metrics?: MetricsRow }>(
    `SELECT segments.date, ${METRICS} FROM customer WHERE ${during(range)}`,
  )
  const byDate = new Map(rows.map((r) => [r.segments.date, toMetrics(r.metrics)]))
  return eachDay(range).map((date) => ({ date, metrics: byDate.get(date) ?? emptyMetrics() }))
}

// ---- Campaigns ------------------------------------------------------------------------------

export type CampaignRow = {
  id: string
  name: string
  status: string
  channel: string
  bidding: string
  metrics: Metrics
}

export async function getCampaigns(range: DateRange): Promise<CampaignRow[]> {
  const rows = await gaql<{
    campaign: {
      id?: Num
      name?: string
      status?: string
      advertisingChannelType?: string
      biddingStrategyType?: string
    }
    metrics?: MetricsRow
  }>(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
       campaign.bidding_strategy_type, ${METRICS}
     FROM campaign
     WHERE ${during(range)} AND metrics.impressions > 0
     ORDER BY metrics.cost_micros DESC`,
  )
  return rows.map((r) => ({
    id: String(r.campaign.id ?? ""),
    name: r.campaign.name ?? "(no name)",
    status: r.campaign.status ?? "UNKNOWN",
    channel: r.campaign.advertisingChannelType ?? "",
    bidding: r.campaign.biddingStrategyType ?? "",
    metrics: toMetrics(r.metrics),
  }))
}

// ---- Search terms ---------------------------------------------------------------------------

export type SearchTermRow = {
  term: string
  // ADDED, EXCLUDED, ADDED_EXCLUDED or NONE: whether it's already a keyword or a negative.
  status: string
  campaigns: string[]
  adGroups: string[]
  metrics: Metrics
  rule?: NegativeRule
  suggestion?: string
}

export async function getSearchTerms(range: DateRange): Promise<SearchTermRow[]> {
  const rows = await gaql<{
    searchTermView: { searchTerm?: string; status?: string }
    campaign?: { name?: string }
    adGroup?: { name?: string }
    metrics?: MetricsRow
  }>(
    `SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, ${METRICS}
     FROM search_term_view
     WHERE ${during(range)}
     ORDER BY metrics.cost_micros DESC
     LIMIT 5000`,
  )

  // The same search can show up under several ad groups; combine them into one row.
  const byTerm = new Map<string, SearchTermRow>()
  for (const r of rows) {
    const term = (r.searchTermView.searchTerm ?? "").trim()
    if (!term) continue
    const key = term.toLowerCase()
    let row = byTerm.get(key)
    if (!row) {
      row = { term, status: r.searchTermView.status ?? "NONE", campaigns: [], adGroups: [], metrics: emptyMetrics() }
      byTerm.set(key, row)
    }
    if (r.searchTermView.status?.includes("EXCLUDED")) row.status = r.searchTermView.status
    if (r.campaign?.name && !row.campaigns.includes(r.campaign.name)) row.campaigns.push(r.campaign.name)
    if (r.adGroup?.name && !row.adGroups.includes(r.adGroup.name)) row.adGroups.push(r.adGroup.name)
    add(row.metrics, toMetrics(r.metrics))
  }

  return [...byTerm.values()]
    .map((row) => {
      const rule = matchRule(row.term)
      return rule ? { ...row, rule, suggestion: suggestedNegative(row.term, rule) } : row
    })
    .sort((a, b) => b.metrics.cost - a.metrics.cost)
}

// ---- Keywords -------------------------------------------------------------------------------

export type KeywordRow = {
  id: string
  text: string
  matchType: string
  status: string
  campaign: string
  adGroup: string
  metrics: Metrics
}

export async function getKeywords(range: DateRange): Promise<KeywordRow[]> {
  const rows = await gaql<{
    adGroupCriterion: { criterionId?: Num; status?: string; keyword?: { text?: string; matchType?: string } }
    campaign?: { name?: string }
    adGroup?: { name?: string }
    metrics?: MetricsRow
  }>(
    `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
       ad_group_criterion.status, campaign.name, ad_group.name, ${METRICS}
     FROM keyword_view
     WHERE ${during(range)} AND ad_group_criterion.negative = FALSE AND metrics.impressions > 0
     ORDER BY metrics.cost_micros DESC
     LIMIT 2000`,
  )
  return rows.map((r) => ({
    id: `${r.adGroup?.name}:${r.adGroupCriterion.criterionId}`,
    text: r.adGroupCriterion.keyword?.text ?? "",
    matchType: r.adGroupCriterion.keyword?.matchType ?? "",
    status: r.adGroupCriterion.status ?? "",
    campaign: r.campaign?.name ?? "",
    adGroup: r.adGroup?.name ?? "",
    metrics: toMetrics(r.metrics),
  }))
}

// ---- Locations ------------------------------------------------------------------------------

export type LocationRow = {
  key: string
  city: string
  region: string // "California, United States"
  status: AreaStatus
  county?: string
  metrics: Metrics
}

export const GEO_RESOURCE = /^geoTargetConstants\/\d+$/

// City names for geo target resource names ("geoTargetConstants/1014221"), looked up in batches.
export async function geoNames(ids: string[]): Promise<Map<string, { name: string; canonical: string }>> {
  const names = new Map<string, { name: string; canonical: string }>()
  const valid = ids.filter((id) => GEO_RESOURCE.test(id))
  for (let i = 0; i < valid.length; i += 200) {
    const batch = valid.slice(i, i + 200).map((id) => `'${id}'`).join(", ")
    const geo = await gaql<{ geoTargetConstant: { resourceName: string; name?: string; canonicalName?: string } }>(
      `SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.canonical_name
       FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${batch})`,
    )
    for (const g of geo) {
      names.set(g.geoTargetConstant.resourceName, {
        name: g.geoTargetConstant.name ?? "",
        canonical: g.geoTargetConstant.canonicalName ?? "",
      })
    }
  }
  return names
}

export async function getLocations(range: DateRange): Promise<LocationRow[]> {
  const rows = await gaql<{ segments?: { geoTargetCity?: string }; metrics?: MetricsRow }>(
    `SELECT segments.geo_target_city, ${METRICS} FROM geographic_view WHERE ${during(range)}`,
  )

  const byCity = new Map<string, Metrics>()
  for (const r of rows) {
    const key = r.segments?.geoTargetCity && GEO_RESOURCE.test(r.segments.geoTargetCity) ? r.segments.geoTargetCity : "unknown"
    byCity.set(key, add(byCity.get(key) ?? emptyMetrics(), toMetrics(r.metrics)))
  }

  const names = await geoNames([...byCity.keys()].filter((k) => k !== "unknown"))

  return [...byCity.entries()]
    .map(([key, metrics]) => {
      const geo = names.get(key)
      if (!geo) return { key, city: "Unknown location", region: "", status: "unknown" as const, metrics }
      const { status, county } = serviceAreaStatus(geo.canonical)
      return {
        key,
        city: geo.name || geo.canonical.split(",")[0],
        region: geo.canonical
          .split(",")
          .slice(1)
          .filter((part) => part !== "United States")
          .join(", "),
        status,
        county,
        metrics,
      }
    })
    .sort((a, b) => b.metrics.cost - a.metrics.cost)
}

// ---- Day and hour ---------------------------------------------------------------------------

export const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const

// grid[weekday index][hour 0-23]
export type ScheduleGrid = Metrics[][]

export async function getSchedule(range: DateRange): Promise<ScheduleGrid> {
  const rows = await gaql<{ segments: { dayOfWeek?: string; hour?: Num }; metrics?: MetricsRow }>(
    `SELECT segments.day_of_week, segments.hour, ${METRICS} FROM customer WHERE ${during(range)}`,
  )
  const grid: ScheduleGrid = weekdays.map(() => Array.from({ length: 24 }, emptyMetrics))
  for (const r of rows) {
    const day = weekdays.indexOf(r.segments.dayOfWeek as (typeof weekdays)[number])
    const hour = num(r.segments.hour)
    if (day >= 0 && hour >= 0 && hour < 24) add(grid[day][hour], toMetrics(r.metrics))
  }
  return grid
}

// ---- Conversions ----------------------------------------------------------------------------

export type ConversionActionRow = {
  id: string
  name: string
  status: string
  type: string
  category: string
  primary: boolean
  counting: string
  conversions: number
  allConversions: number
}

export async function getConversionActions(range: DateRange): Promise<ConversionActionRow[]> {
  const [actions, counts] = await Promise.all([
    gaql<{
      conversionAction: {
        id?: Num
        name?: string
        status?: string
        type?: string
        category?: string
        primaryForGoal?: boolean
        countingType?: string
      }
    }>(
      `SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type,
         conversion_action.category, conversion_action.primary_for_goal, conversion_action.counting_type
       FROM conversion_action`,
    ),
    gaql<{ segments: { conversionActionName?: string }; metrics?: { conversions?: Num; allConversions?: Num } }>(
      `SELECT segments.conversion_action_name, metrics.conversions, metrics.all_conversions
       FROM campaign WHERE ${during(range)}`,
    ),
  ])

  const totals = new Map<string, { conversions: number; all: number }>()
  for (const c of counts) {
    const name = c.segments.conversionActionName ?? ""
    const t = totals.get(name) ?? { conversions: 0, all: 0 }
    t.conversions += num(c.metrics?.conversions)
    t.all += num(c.metrics?.allConversions)
    totals.set(name, t)
  }

  return actions
    .map((a) => {
      const name = a.conversionAction.name ?? "(no name)"
      const t = totals.get(name)
      return {
        id: String(a.conversionAction.id ?? name),
        name,
        status: a.conversionAction.status ?? "",
        type: a.conversionAction.type ?? "",
        category: a.conversionAction.category ?? "",
        primary: !!a.conversionAction.primaryForGoal,
        counting: a.conversionAction.countingType ?? "",
        conversions: t?.conversions ?? 0,
        allConversions: t?.all ?? 0,
      }
    })
    .sort((a, b) => b.allConversions - a.allConversions || a.name.localeCompare(b.name))
}
