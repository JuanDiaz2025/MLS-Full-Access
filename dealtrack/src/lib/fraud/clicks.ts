// Click patterns that point at click fraud: days with far more clicks than normal, a burst of
// invalid clicks, clicks at night, or most of a day's clicks in one hour. Google already filters
// the clicks it calls invalid (and doesn't charge for them); these checks look for what it may
// have missed, so a refund claim can be filed. Alert only: nothing here changes the account.

import { addDays, eachDay, type DateRange } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import type { DayFlag } from "@/lib/fraud/flags"
import { chunkRange, geoNames } from "@/lib/google-ads/reports"

type Num = string | number | undefined
const num = (v: Num) => Number(v ?? 0) || 0

// The days before each day that count as "normal" for it.
const BASELINE_DAYS = 28
// Google keeps click-level data (click_view) for 90 days.
export const CLICK_DETAIL_DAYS = 90
// Midnight to 5am Pacific: few home sellers search then.
const NIGHT_HOURS = new Set([0, 1, 2, 3, 4])

export { FLAG_LABELS, type DayFlag } from "@/lib/fraud/flags"

export type DayCampaign = { id: string; name: string; clicks: number; invalid: number; cost: number; conversions: number; impressions: number }

export type FraudDay = {
  date: string
  clicks: number
  invalid: number
  cost: number
  conversions: number
  impressions: number
  normalClicks: number // median of the 28 days before
  normalInvalid: number
  nightClicks: number
  peak: { hour: number; clicks: number; conversions: number } | null
  hours: number[] // clicks per hour, 0–23 Pacific
  flags: DayFlag[]
  reasons: string[]
  campaigns: DayCampaign[]
}

export type ClickPatterns = {
  days: FraudDay[] // every day in the range, oldest first
  flagged: FraudDay[] // most suspicious first
  totals: { clicks: number; invalid: number; cost: number; conversions: number }
}

const median = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const hourLabel = (h: number) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`)

type DailyRow = {
  segments: { date: string }
  campaign: { id?: Num; name?: string }
  metrics?: { clicks?: Num; invalidClicks?: Num; costMicros?: Num; conversions?: Num; impressions?: Num }
}
type HourRow = { segments: { date: string; hour?: Num }; metrics?: { clicks?: Num; conversions?: Num } }

const campaignFilter = (campaignId?: string) => (campaignId && /^\d+$/.test(campaignId) ? ` AND campaign.id = ${campaignId}` : "")

export async function getClickPatterns(range: DateRange, campaignId?: string): Promise<ClickPatterns> {
  const withBaseline: DateRange = { ...range, from: addDays(range.from, -BASELINE_DAYS) }
  const only = campaignFilter(campaignId)
  const [daily, hourly] = await Promise.all([
    Promise.all(
      chunkRange(withBaseline).map((r) =>
        gaql<DailyRow>(
          `SELECT segments.date, campaign.id, campaign.name, metrics.clicks, metrics.invalid_clicks, metrics.cost_micros,
             metrics.conversions, metrics.impressions
           FROM campaign WHERE segments.date BETWEEN '${r.from}' AND '${r.to}' AND metrics.impressions > 0${only}`,
        ),
      ),
    ).then((parts) => parts.flat()),
    // Invalid clicks can't be split by hour, so the hourly view is valid clicks only.
    Promise.all(
      chunkRange(range).map((r) =>
        gaql<HourRow>(
          `SELECT segments.date, segments.hour, metrics.clicks, metrics.conversions
           FROM campaign WHERE segments.date BETWEEN '${r.from}' AND '${r.to}' AND metrics.clicks > 0${only}`,
        ),
      ),
    ).then((parts) => parts.flat()),
  ])

  const byDay = new Map<string, { totals: Omit<DayCampaign, "id" | "name">; campaigns: Map<string, DayCampaign> }>()
  for (const r of daily) {
    const d = byDay.get(r.segments.date) ?? { totals: { clicks: 0, invalid: 0, cost: 0, conversions: 0, impressions: 0 }, campaigns: new Map() }
    const id = String(r.campaign.id ?? "")
    const c = d.campaigns.get(id) ?? { id, name: r.campaign.name ?? "(no name)", clicks: 0, invalid: 0, cost: 0, conversions: 0, impressions: 0 }
    const m = {
      clicks: num(r.metrics?.clicks),
      invalid: num(r.metrics?.invalidClicks),
      cost: num(r.metrics?.costMicros) / 1e6,
      conversions: num(r.metrics?.conversions),
      impressions: num(r.metrics?.impressions),
    }
    for (const k of Object.keys(m) as (keyof typeof m)[]) {
      c[k] += m[k]
      d.totals[k] += m[k]
    }
    d.campaigns.set(id, c)
    byDay.set(r.segments.date, d)
  }

  const hours = new Map<string, { clicks: number[]; conversions: number[] }>()
  for (const r of hourly) {
    const h = hours.get(r.segments.date) ?? { clicks: Array(24).fill(0), conversions: Array(24).fill(0) }
    const hour = num(r.segments.hour)
    h.clicks[hour] += num(r.metrics?.clicks)
    h.conversions[hour] += num(r.metrics?.conversions)
    hours.set(r.segments.date, h)
  }

  const clicksOn = (date: string) => byDay.get(date)?.totals.clicks ?? 0
  const invalidOn = (date: string) => byDay.get(date)?.totals.invalid ?? 0

  const days: FraudDay[] = eachDay(range).map((date) => {
    const d = byDay.get(date)
    const t = d?.totals ?? { clicks: 0, invalid: 0, cost: 0, conversions: 0, impressions: 0 }
    const before = Array.from({ length: BASELINE_DAYS }, (_, i) => addDays(date, -(i + 1)))
    // Only days the ads ran count as normal, so a quiet month doesn't make every day look like a spike.
    const active = before.filter((b) => (byDay.get(b)?.totals.impressions ?? 0) > 0)
    const normalClicks = median(active.map(clicksOn))
    const normalInvalid = median(active.map(invalidOn))
    const enoughHistory = active.length >= 7
    const h = hours.get(date)
    const perHour = h?.clicks ?? Array(24).fill(0)
    const nightClicks = perHour.reduce((s, c, hour) => s + (NIGHT_HOURS.has(hour) ? c : 0), 0)
    const peakHour = perHour.reduce((best, c, hour) => (c > perHour[best] ? hour : best), 0)
    const peak = perHour[peakHour] ? { hour: peakHour, clicks: perHour[peakHour], conversions: h?.conversions[peakHour] ?? 0 } : null

    const flags: DayFlag[] = []
    const reasons: string[] = []
    const lowLeads = t.conversions <= Math.max(1, t.clicks * 0.02)
    if (enoughHistory && t.clicks >= 15 && t.clicks >= Math.max(3 * normalClicks, normalClicks + 15) && lowLeads) {
      flags.push("click-spike")
      reasons.push(
        `${t.clicks} clicks against a normal ${Math.round(normalClicks)}, with ${t.conversions ? Math.round(t.conversions * 10) / 10 : "no"} conversions`,
      )
    }
    if (t.invalid >= 10 && t.invalid >= Math.max(3 * normalInvalid, 0.3 * (t.clicks + t.invalid))) {
      flags.push("invalid-spike")
      reasons.push(`Google filtered ${t.invalid} invalid clicks (normal ${Math.round(normalInvalid)}), so an attack was likely under way`)
    }
    if (nightClicks >= 8 && nightClicks >= 0.3 * t.clicks) {
      flags.push("night-clicks")
      reasons.push(`${nightClicks} of ${t.clicks} clicks between midnight and 5am Pacific`)
    }
    if (peak && peak.clicks >= 10 && peak.clicks >= 0.5 * t.clicks && !peak.conversions) {
      flags.push("burst-hour")
      reasons.push(`${peak.clicks} clicks in one hour (${hourLabel(peak.hour)}) and no conversions from it`)
    }
    return {
      date,
      ...t,
      normalClicks,
      normalInvalid,
      nightClicks,
      peak,
      hours: perHour,
      flags,
      reasons,
      campaigns: [...(d?.campaigns.values() ?? [])]
        .filter((c) => c.clicks || c.invalid)
        .sort((a, b) => b.clicks + b.invalid - (a.clicks + a.invalid)),
    }
  })

  const score = (d: FraudDay) => d.flags.length * 1000 + d.clicks - d.normalClicks + d.invalid
  const sum = (f: (d: FraudDay) => number) => days.reduce((s, d) => s + f(d), 0)
  return {
    days,
    flagged: days.filter((d) => d.flags.length).sort((a, b) => score(b) - score(a)),
    totals: { clicks: sum((d) => d.clicks), invalid: sum((d) => d.invalid), cost: sum((d) => d.cost), conversions: sum((d) => d.conversions) },
  }
}

// ---- Single clicks -----------------------------------------------------------------------------

export type AdClick = {
  gclid: string
  date: string
  campaignId: string
  campaign: string
  adGroup: string
  keyword: string
  matchType: string
  place: string // where the person was, e.g. "Fresno, California, United States"
  inCalifornia: boolean | null
  country: string
  device: string
  slot: string
  page: number
}

type ClickRow = {
  segments: { date?: string; device?: string; slot?: string }
  campaign: { id?: Num; name?: string }
  adGroup?: { name?: string }
  clickView: {
    gclid?: string
    pageNumber?: Num
    keywordInfo?: { text?: string; matchType?: string }
    locationOfPresence?: { city?: string; region?: string; country?: string }
  }
}

export const clickDetailAvailable = (date: string, todayIso: string) => date >= addDays(todayIso, -(CLICK_DETAIL_DAYS - 1))

// Every billed click on these days, with its Google click ID (gclid). Google only answers for one
// day per request and only for the last 90 days; older days are skipped.
export async function getClicks(dates: string[], todayIso: string, campaignId?: string): Promise<AdClick[]> {
  const days = [...new Set(dates)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && clickDetailAvailable(d, todayIso)).sort()
  const only = campaignFilter(campaignId)
  const rows: (ClickRow & { day: string })[] = []
  for (let i = 0; i < days.length; i += 4) {
    const parts = await Promise.all(
      days.slice(i, i + 4).map(async (day) =>
        (
          await gaql<ClickRow>(
            `SELECT click_view.gclid, click_view.page_number, click_view.keyword_info.text, click_view.keyword_info.match_type,
               click_view.location_of_presence.city, click_view.location_of_presence.region, click_view.location_of_presence.country,
               segments.device, segments.slot, campaign.id, campaign.name, ad_group.name
             FROM click_view WHERE segments.date = '${day}'${only}`,
          )
        ).map((r) => ({ ...r, day })),
      ),
    )
    rows.push(...parts.flat())
  }
  const names = await geoNames(
    rows.flatMap(
      (r) =>
        [r.clickView.locationOfPresence?.city, r.clickView.locationOfPresence?.region, r.clickView.locationOfPresence?.country].filter(
          Boolean,
        ) as string[],
    ),
  )
  return rows.map((r) => {
    const loc = r.clickView.locationOfPresence ?? {}
    const city = loc.city ? names.get(loc.city) : undefined
    const region = loc.region ? names.get(loc.region) : undefined
    const country = loc.country ? names.get(loc.country) : undefined
    const place = city?.canonical || region?.canonical || country?.name || "Unknown"
    const known = !!(region || city)
    return {
      gclid: r.clickView.gclid ?? "",
      date: r.day,
      campaignId: String(r.campaign.id ?? ""),
      campaign: r.campaign.name ?? "(no name)",
      adGroup: r.adGroup?.name ?? "",
      keyword: r.clickView.keywordInfo?.text ?? "",
      matchType: r.clickView.keywordInfo?.matchType ?? "",
      place: place.replace(/,/g, ", "),
      inCalifornia: known
        ? /California/.test(city?.canonical ?? region?.canonical ?? "")
        : country && country.name !== "United States"
          ? false
          : null,
      country: country?.name ?? "",
      device: r.segments.device ?? "",
      slot: r.segments.slot ?? "",
      page: num(r.clickView.pageNumber),
    }
  })
}

export type ClickSummary = { label: string; clicks: number }

// The places, keywords, and devices most of these clicks came from.
export function summarizeClicks(clicks: AdClick[]) {
  const top = (f: (c: AdClick) => string, n = 5): ClickSummary[] => {
    const m = new Map<string, number>()
    for (const c of clicks) m.set(f(c) || "—", (m.get(f(c) || "—") ?? 0) + 1)
    return [...m]
      .map(([label, n]) => ({ label, clicks: n }))
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, n)
  }
  return {
    places: top((c) => c.place),
    keywords: top((c) => c.keyword),
    devices: top((c) => c.device.toLowerCase()),
    outside: clicks.filter((c) => c.inCalifornia === false).length,
  }
}
