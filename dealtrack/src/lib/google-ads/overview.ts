// The Overview page's numbers: the period's totals against the same number of days just before
// it, and the same numbers over time (by day, week, or month, depending on the range's length)
// for the sparklines and the two-metric chart.
//
// Leads count lead conversions only (forms, calls, lead stages), not soft actions such as map
// directions, which Google also calls conversions.

import { addDays, eachDay, type DateRange } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { isLeadConversion } from "@/lib/google-ads/reports"

type Num = string | number | undefined
const num = (v: Num) => Number(v ?? 0) || 0
const share = (v: Num) => (v === undefined || v === null || v === "" ? null : Number(v))

export type Grain = "day" | "week" | "month"

export type Totals = {
  cost: number
  clicks: number
  impressions: number
  conversions: number // everything Google counts, soft actions included
  leads: number
  invalidClicks: number
  impressionShare: number | null // search campaigns; null when nothing was eligible to show
  lostToBudget: number | null
  lostToRank: number | null
}

export type Bucket = Totals & { start: string } // the day, the week's Monday, or the month's 1st

export type Overview = {
  grain: Grain
  buckets: Bucket[]
  totals: Totals
  previous: { range: DateRange; totals: Totals }
}

const blank = (): Totals => ({
  cost: 0,
  clicks: 0,
  impressions: 0,
  conversions: 0,
  leads: 0,
  invalidClicks: 0,
  impressionShare: null,
  lostToBudget: null,
  lostToRank: null,
})

export function daysIn(range: DateRange) {
  return Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1
}

// Days for up to about six weeks, then weeks, then months: enough points to see a trend without
// every day's noise.
export function grainFor(range: DateRange): Grain {
  const days = daysIn(range)
  return days <= 45 ? "day" : days <= 200 ? "week" : "month"
}

// The same number of days just before `range`.
export function previousRange(range: DateRange): DateRange {
  const days = daysIn(range)
  const to = addDays(range.from, -1)
  return { from: addDays(to, -(days - 1)), to, label: `the ${days} days before` }
}

function bucketStarts(range: DateRange, grain: Grain): string[] {
  if (grain === "day") return eachDay(range)
  const starts: string[] = []
  if (grain === "week") {
    const weekday = (new Date(`${range.from}T00:00:00Z`).getUTCDay() + 6) % 7 // Monday = 0
    for (let d = addDays(range.from, -weekday); d <= range.to; d = addDays(d, 7)) starts.push(d)
    return starts
  }
  for (let d = `${range.from.slice(0, 7)}-01`; d <= range.to; ) {
    starts.push(d)
    const [y, m] = d.split("-").map(Number)
    d = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`
  }
  return starts
}

const SEGMENT = { day: "segments.date", week: "segments.week", month: "segments.month" } as const

type Row = {
  segments?: { date?: string; week?: string; month?: string; conversionActionName?: string }
  metrics?: {
    costMicros?: Num
    clicks?: Num
    impressions?: Num
    conversions?: Num
    invalidClicks?: Num
    searchImpressionShare?: Num
    searchBudgetLostImpressionShare?: Num
    searchRankLostImpressionShare?: Num
  }
}

// Totals for the whole range (grain null) or per day/week/month; the whole account, or one
// campaign when `campaignId` is given.
async function collect(range: DateRange, grain: Grain | null, campaignId?: string): Promise<Map<string, Totals>> {
  const seg = grain ? `${SEGMENT[grain]}, ` : ""
  const one = campaignId && /^\d+$/.test(campaignId) ? campaignId : null
  const from = one ? "campaign" : "customer"
  const where = `segments.date BETWEEN '${range.from}' AND '${range.to}'${one ? ` AND campaign.id = ${one}` : ""}`
  const [rows, byAction, actions] = await Promise.all([
    gaql<Row>(
      `SELECT ${seg}metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.invalid_clicks,
         metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
       FROM ${from} WHERE ${where}`,
    ),
    gaql<Row>(`SELECT ${seg}segments.conversion_action_name, metrics.conversions FROM ${from} WHERE ${where}`),
    gaql<{ conversionAction: { name?: string; category?: string } }>(
      "SELECT conversion_action.name, conversion_action.category FROM conversion_action",
    ),
  ])
  const key = (r: Row) =>
    (grain === "day" ? r.segments?.date : grain === "week" ? r.segments?.week : grain === "month" ? r.segments?.month : "all") ?? ""
  const out = new Map<string, Totals>()
  const at = (k: string) => {
    const t = out.get(k) ?? blank()
    out.set(k, t)
    return t
  }
  for (const r of rows) {
    const t = at(key(r))
    t.cost += num(r.metrics?.costMicros) / 1_000_000
    t.clicks += num(r.metrics?.clicks)
    t.impressions += num(r.metrics?.impressions)
    t.conversions += num(r.metrics?.conversions)
    t.invalidClicks += num(r.metrics?.invalidClicks)
    t.impressionShare = share(r.metrics?.searchImpressionShare)
    t.lostToBudget = share(r.metrics?.searchBudgetLostImpressionShare)
    t.lostToRank = share(r.metrics?.searchRankLostImpressionShare)
  }
  const category = new Map(actions.map((a) => [a.conversionAction.name ?? "", a.conversionAction.category ?? ""]))
  for (const r of byAction) {
    const name = r.segments?.conversionActionName ?? ""
    if (isLeadConversion(name, category.get(name) ?? "")) at(key(r)).leads += num(r.metrics?.conversions)
  }
  return out
}

// One row per day, week, or month of `range`, including the ones with no activity.
export async function getSeries(range: DateRange, grain: Grain, campaignId?: string): Promise<Bucket[]> {
  const series = await collect(range, grain, campaignId)
  return bucketStarts(range, grain).map((start) => ({ ...(series.get(start) ?? blank()), start }))
}

export async function getOverview(range: DateRange, campaignId?: string): Promise<Overview> {
  const grain = grainFor(range)
  const prev = previousRange(range)
  const [buckets, totals, before] = await Promise.all([
    getSeries(range, grain, campaignId),
    collect(range, null, campaignId),
    collect(prev, null, campaignId),
  ])
  return {
    grain,
    buckets,
    totals: totals.get("all") ?? blank(),
    previous: { range: prev, totals: before.get("all") ?? blank() },
  }
}
