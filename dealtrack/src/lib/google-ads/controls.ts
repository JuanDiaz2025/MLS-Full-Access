// Campaign controls DealTrack can change in Google Ads: campaign status (pause/enable), daily
// budget, ad schedule, and the text of responsive search ads. Each change reads the current
// value fresh from Google first, checks the input, and returns the previous value so the page
// can offer an undo.

import type { DateRange } from "@/lib/date-range"
import { customerResource, gaql, mutate } from "@/lib/google-ads/client"
import { cleanAdText, type AdText } from "@/lib/ad-text"
import { METRICS, during, emptyMetrics, toMetrics, weekdays, type Metrics } from "@/lib/google-ads/reports"

export type { AdText }

type Num = string | number | undefined
const micros = (v: Num) => Number(v ?? 0) / 1_000_000

// Local Services campaigns are managed in the Local Services Ads dashboard instead.
const NOT_CONTROLLABLE = new Set(["LOCAL_SERVICES"])

// Upper limit for a daily budget set from DealTrack. Set MAX_DAILY_BUDGET to change it.
export function maxDailyBudget() {
  const n = Number(process.env.MAX_DAILY_BUDGET)
  return Number.isFinite(n) && n > 0 ? n : 1000
}

// ---- Campaigns and budgets ----------------------------------------------------------------

export type CampaignControl = {
  id: string
  name: string
  status: string // ENABLED or PAUSED
  channel: string
  budget: {
    resourceName: string
    amount: number // dollars per day
    shared: boolean
    campaigns: string[] // names of every campaign using this budget
  } | null
}

type CampaignRow = {
  campaign: { id?: Num; name?: string; status?: string; advertisingChannelType?: string }
  campaignBudget?: {
    resourceName?: string
    amountMicros?: Num
    explicitlyShared?: boolean
    period?: string
  }
}

async function readCampaigns({ fresh = false } = {}): Promise<CampaignControl[]> {
  const rows = await gaql<CampaignRow>(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared,
            campaign_budget.period
     FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`,
    { fresh },
  )
  const byBudget = new Map<string, string[]>()
  for (const r of rows) {
    const b = r.campaignBudget?.resourceName
    if (b) byBudget.set(b, [...(byBudget.get(b) ?? []), r.campaign.name ?? ""])
  }
  return rows
    .map((r) => {
      const b = r.campaignBudget
      const daily = b?.resourceName && b.period !== "CUSTOM_PERIOD"
      return {
        id: String(r.campaign.id ?? ""),
        name: r.campaign.name ?? "(no name)",
        status: r.campaign.status ?? "",
        channel: r.campaign.advertisingChannelType ?? "",
        budget: daily
          ? {
              resourceName: b.resourceName!,
              amount: micros(b.amountMicros),
              shared: !!b.explicitlyShared,
              campaigns: byBudget.get(b.resourceName!) ?? [],
            }
          : null,
      }
    })
    .filter((c) => c.id && !NOT_CONTROLLABLE.has(c.channel))
    .sort((a, b) => Number(b.status === "ENABLED") - Number(a.status === "ENABLED") || a.name.localeCompare(b.name))
}

// Campaigns that can be paused, enabled, and budgeted from DealTrack. Running ones first.
export const getCampaignControls = () => readCampaigns()

async function findCampaign(campaignId: string) {
  const campaign = (await readCampaigns({ fresh: true })).find((c) => c.id === campaignId)
  if (!campaign) throw new Error("That campaign isn't in the account, or it's removed or a Local Services campaign.")
  return campaign
}

export async function setCampaignStatus(
  campaignId: string,
  status: "ENABLED" | "PAUSED",
  { validateOnly = false } = {},
): Promise<{ name: string; previous: string; changed: boolean }> {
  const campaign = await findCampaign(campaignId)
  if (campaign.status === status) return { name: campaign.name, previous: campaign.status, changed: false }
  await mutate(
    "campaigns",
    [{ update: { resourceName: `${customerResource()}/campaigns/${campaignId}`, status }, updateMask: "status" }],
    { validateOnly, atomic: true },
  )
  return { name: campaign.name, previous: campaign.status, changed: true }
}

export async function setDailyBudget(
  campaignId: string,
  amount: number,
  { validateOnly = false } = {},
): Promise<{ name: string; previous: number; campaigns: string[]; changed: boolean }> {
  const max = maxDailyBudget()
  if (!Number.isFinite(amount) || amount < 1) throw new Error("A daily budget has to be at least $1.")
  if (amount > max) throw new Error(`DealTrack won't set a daily budget above $${max.toLocaleString("en-US")}.`)
  const campaign = await findCampaign(campaignId)
  if (!campaign.budget) throw new Error(`${campaign.name} doesn't have a daily budget DealTrack can change.`)

  // Google wants micros in whole cents.
  const amountMicros = Math.round(amount * 100) * 10_000
  const previous = campaign.budget.amount
  if (Math.round(previous * 100) === Math.round(amount * 100)) {
    return { name: campaign.name, previous, campaigns: campaign.budget.campaigns, changed: false }
  }
  await mutate(
    "campaignBudgets",
    [{ update: { resourceName: campaign.budget.resourceName, amountMicros: String(amountMicros) }, updateMask: "amountMicros" }],
    { validateOnly, atomic: true },
  )
  return { name: campaign.name, previous, campaigns: campaign.budget.campaigns, changed: true }
}

// ---- Ad schedule --------------------------------------------------------------------------

export type Weekday = (typeof weekdays)[number]

// A time range when ads run, in minutes after midnight in the account's time zone. to can be
// 1440 (midnight at the end of the day).
export type Slot = { day: Weekday; from: number; to: number }
export type ScheduleSlot = Slot & { resourceName: string; bidModifier: number | null }

const MINUTE_ENUM = { 0: "ZERO", 15: "FIFTEEN", 30: "THIRTY", 45: "FORTY_FIVE" } as const
const MINUTE_VALUE: Record<string, number> = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 }

const slotKey = (s: Slot) => `${s.day}|${s.from}|${s.to}`

// Ad schedules on the given campaigns (all campaigns when none are given), keyed by campaign ID.
export async function getAdSchedules(campaignIds?: string[], { fresh = false } = {}): Promise<Map<string, ScheduleSlot[]>> {
  const ids = campaignIds?.filter((id) => /^\d+$/.test(id))
  if (ids && !ids.length) return new Map()
  const rows = await gaql<{
    campaign: { id?: Num }
    campaignCriterion: {
      resourceName: string
      bidModifier?: number
      adSchedule?: { dayOfWeek?: string; startHour?: number; startMinute?: string; endHour?: number; endMinute?: string }
    }
  }>(
    `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.bid_modifier,
            campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour,
            campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour,
            campaign_criterion.ad_schedule.end_minute
     FROM campaign_criterion
     WHERE campaign_criterion.type = AD_SCHEDULE AND campaign.status != 'REMOVED'
       ${ids ? `AND campaign.id IN (${ids.join(", ")})` : ""}`,
    { fresh },
  )
  const out = new Map<string, ScheduleSlot[]>()
  for (const r of rows) {
    const s = r.campaignCriterion.adSchedule
    const day = s?.dayOfWeek as Weekday
    if (!s || !weekdays.includes(day)) continue
    const id = String(r.campaign.id ?? "")
    const slot: ScheduleSlot = {
      resourceName: r.campaignCriterion.resourceName,
      day,
      from: (s.startHour ?? 0) * 60 + (MINUTE_VALUE[s.startMinute ?? "ZERO"] ?? 0),
      to: (s.endHour ?? 0) * 60 + (MINUTE_VALUE[s.endMinute ?? "ZERO"] ?? 0),
      bidModifier: r.campaignCriterion.bidModifier ?? null,
    }
    out.set(id, [...(out.get(id) ?? []), slot])
  }
  for (const slots of out.values()) slots.sort((a, b) => weekdays.indexOf(a.day) - weekdays.indexOf(b.day) || a.from - b.from)
  return out
}

// Checks a schedule: quarter-hour times, no overlaps, at most 6 ranges a day (Google's limit).
export function checkSlots(slots: Slot[]): string | null {
  for (const s of slots) {
    if (!weekdays.includes(s.day)) return "Unknown day in the schedule."
    if (![s.from, s.to].every((m) => Number.isInteger(m) && m % 15 === 0 && m >= 0 && m <= 1440)) {
      return "Schedule times have to be on the quarter hour."
    }
    if (s.from >= s.to) return "Each time range has to end after it starts."
  }
  for (const day of weekdays) {
    const ranges = slots.filter((s) => s.day === day).sort((a, b) => a.from - b.from)
    if (ranges.length > 6) return "Google allows at most 6 time ranges a day."
    if (ranges.some((r, i) => i > 0 && r.from < ranges[i - 1].to)) return "Time ranges on the same day can't overlap."
  }
  return null
}

// Replaces a campaign's ad schedule. An empty schedule means ads can run at any time. Ranges
// that stay the same are left alone, so their bid adjustments are kept.
export async function setAdSchedule(
  campaignId: string,
  slots: Slot[],
  { validateOnly = false } = {},
): Promise<{ name: string; previous: Slot[]; added: number; removed: number }> {
  const problem = checkSlots(slots)
  if (problem) throw new Error(problem)
  const campaign = await findCampaign(campaignId)
  const current = (await getAdSchedules([campaignId], { fresh: true })).get(campaignId) ?? []

  const wanted = new Set(slots.map(slotKey))
  const have = new Set(current.map(slotKey))
  const remove = current.filter((s) => !wanted.has(slotKey(s)))
  const create = slots.filter((s) => !have.has(slotKey(s)))
  const previous = current.map(({ day, from, to }) => ({ day, from, to }))
  if (!remove.length && !create.length) return { name: campaign.name, previous, added: 0, removed: 0 }

  const campaignResource = `${customerResource()}/campaigns/${campaignId}`
  const time = (m: number) => ({ hour: Math.floor(m / 60), minute: MINUTE_ENUM[(m % 60) as 0 | 15 | 30 | 45] })
  await mutate(
    "campaignCriteria",
    [
      ...remove.map((s) => ({ remove: s.resourceName })),
      ...create.map((s) => {
        const start = time(s.from)
        const end = time(s.to)
        return {
          create: {
            campaign: campaignResource,
            adSchedule: { dayOfWeek: s.day, startHour: start.hour, startMinute: start.minute, endHour: end.hour, endMinute: end.minute },
          },
        }
      }),
    ],
    // All or nothing, so a campaign is never left with half a schedule.
    { validateOnly, atomic: true },
  )
  return { name: campaign.name, previous, added: create.length, removed: remove.length }
}

// ---- Responsive search ads ----------------------------------------------------------------

export type SearchAd = {
  id: string
  adGroup: string
  status: string
  approval: string
  finalUrl: string
  path: string
  headlines: AdText[]
  descriptions: AdText[]
  metrics: Metrics
}

type AdRow = {
  adGroup?: { name?: string }
  adGroupAd: {
    status?: string
    policySummary?: { approvalStatus?: string }
    ad: {
      id?: Num
      finalUrls?: string[]
      responsiveSearchAd?: {
        headlines?: { text?: string; pinnedField?: string }[]
        descriptions?: { text?: string; pinnedField?: string }[]
        path1?: string
        path2?: string
      }
    }
  }
  metrics?: { costMicros?: Num; clicks?: Num; impressions?: Num; conversions?: Num }
}

const AD_FIELDS = `ad_group.name, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.id,
  ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
  ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1,
  ad_group_ad.ad.responsive_search_ad.path2`

const texts = (items?: { text?: string; pinnedField?: string }[]): AdText[] =>
  (items ?? []).map((i) => ({ text: i.text ?? "", ...(i.pinnedField ? { pin: i.pinnedField } : {}) }))

// Search campaigns, for choosing whose ads to show. Running ones first.
export async function getSearchCampaigns() {
  return (await readCampaigns()).filter((c) => c.channel === "SEARCH").map(({ id, name, status }) => ({ id, name, status }))
}

// Responsive search ads in a campaign, with results for the period.
export async function getSearchAds(campaignId: string, range: DateRange): Promise<SearchAd[]> {
  if (!/^\d+$/.test(campaignId)) return []
  const where = `campaign.id = ${campaignId} AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD AND ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'`
  // Ads with no results in the period don't come back from a query with metrics, so read the ads
  // and their results separately.
  const [ads, results] = await Promise.all([
    gaql<AdRow>(`SELECT ${AD_FIELDS} FROM ad_group_ad WHERE ${where}`),
    gaql<AdRow>(`SELECT ad_group_ad.ad.id, ${METRICS} FROM ad_group_ad WHERE ${where} AND ${during(range)}`),
  ])
  const metricsById = new Map(results.map((r) => [String(r.adGroupAd.ad.id), toMetrics(r.metrics)]))
  return ads
    .map((r) => {
      const ad = r.adGroupAd.ad
      const rsa = ad.responsiveSearchAd
      const id = String(ad.id ?? "")
      return {
        id,
        adGroup: r.adGroup?.name ?? "",
        status: r.adGroupAd.status ?? "",
        approval: r.adGroupAd.policySummary?.approvalStatus ?? "",
        finalUrl: ad.finalUrls?.[0] ?? "",
        path: [rsa?.path1, rsa?.path2].filter(Boolean).join("/"),
        headlines: texts(rsa?.headlines),
        descriptions: texts(rsa?.descriptions),
        metrics: metricsById.get(id) ?? emptyMetrics(),
      }
    })
    .sort((a, b) => Number(b.status === "ENABLED") - Number(a.status === "ENABLED") || b.metrics.impressions - a.metrics.impressions)
}

// Replaces a responsive search ad's headlines and descriptions. Google reviews the ad again.
export async function updateSearchAdText(
  adId: string,
  input: { headlines: AdText[]; descriptions: AdText[] },
  { validateOnly = false } = {},
): Promise<{ adGroup: string; previous: { headlines: AdText[]; descriptions: AdText[] }; changed: boolean }> {
  if (!/^\d+$/.test(adId)) throw new Error("That ad doesn't exist.")
  const cleaned = cleanAdText(input.headlines, input.descriptions)
  if (typeof cleaned === "string") throw new Error(cleaned)

  const [row] = await gaql<AdRow>(
    `SELECT ${AD_FIELDS} FROM ad_group_ad
     WHERE ad_group_ad.ad.id = ${adId} AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD AND ad_group_ad.status != 'REMOVED'
     LIMIT 1`,
    { fresh: true },
  )
  if (!row) throw new Error("That ad isn't in the account, or it's removed or not a responsive search ad.")
  const rsa = row.adGroupAd.ad.responsiveSearchAd
  const previous = { headlines: texts(rsa?.headlines), descriptions: texts(rsa?.descriptions) }
  const same = (a: AdText[], b: AdText[]) => JSON.stringify(a) === JSON.stringify(b)
  if (same(previous.headlines, cleaned.headlines) && same(previous.descriptions, cleaned.descriptions)) {
    return { adGroup: row.adGroup?.name ?? "", previous, changed: false }
  }

  const asset = (i: AdText) => ({ text: i.text, ...(i.pin ? { pinnedField: i.pin } : {}) })
  await mutate(
    "ads",
    [
      {
        update: {
          resourceName: `${customerResource()}/ads/${adId}`,
          responsiveSearchAd: { headlines: cleaned.headlines.map(asset), descriptions: cleaned.descriptions.map(asset) },
        },
        updateMask: "responsiveSearchAd.headlines,responsiveSearchAd.descriptions",
      },
    ],
    { validateOnly, atomic: true },
  )
  return { adGroup: row.adGroup?.name ?? "", previous, changed: true }
}
