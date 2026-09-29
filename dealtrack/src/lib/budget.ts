// Budget pacing for the current month: spend so far against the monthly budget, where the month
// is heading, and the alert and pause lines (decision d3). Settings come from the local store.

import { addDays, today, type DateRange } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { getAllCampaigns, getDaily, getMonthlyAds } from "@/lib/google-ads/reports"
import type { BudgetSettings } from "@/lib/store"

export type CampaignPace = {
  id: string
  name: string
  status: string
  channel: string
  dailyBudget: number | null
  spent: number // this month
  expected: number | null // daily budget × days so far
  lostToBudget: number | null // search impression share lost to budget this month (0–1)
}

export type PaceStatus = "no-budget" | "under" | "on" | "over"

export type Pacing = {
  month: string // YYYY-MM
  monthLabel: string
  dayOfMonth: number
  daysInMonth: number
  daysLeft: number // after today
  spent: number
  leads: number // Google lead conversions this month
  cumulative: { date: string; spent: number }[] // one point per day so far
  avgDaily7: number // average of the last 7 complete days
  runningDaily: number // daily budgets of enabled campaigns
  projectedByPace: number
  projectedByBudgets: number
  budget: BudgetSettings
  expectedSoFar: number | null // monthly budget × share of the month gone
  neededDaily: number | null // daily spend needed from tomorrow to land on the monthly budget
  status: PaceStatus
  pauseLineDate: string | null // when the recent pace crosses the pause line, if this month
  campaigns: CampaignPace[]
}

type Num = string | number | undefined
const num = (v: Num) => Number(v ?? 0) || 0

export async function getPacing(budget: BudgetSettings): Promise<Pacing> {
  const end = today()
  const month = end.slice(0, 7)
  const first = `${month}-01`
  const [y, m] = month.split("-").map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const dayOfMonth = Number(end.slice(8, 10))
  const daysLeft = daysInMonth - dayOfMonth
  const range: DateRange = { from: first, to: end, label: "This month" }
  // The 7 complete days before today, which may reach into last month.
  const week: DateRange = { from: addDays(end, -7), to: addDays(end, -1), label: "Last 7 days" }

  const [daily, lastWeek, campaigns, ads, lost] = await Promise.all([
    getDaily(range),
    getDaily(week),
    getAllCampaigns(range),
    getMonthlyAds(first, end),
    gaql<{ campaign: { id?: Num }; metrics?: { searchBudgetLostImpressionShare?: Num } }>(
      `SELECT campaign.id, metrics.search_budget_lost_impression_share FROM campaign
       WHERE segments.date BETWEEN '${first}' AND '${end}' AND campaign.advertising_channel_type = 'SEARCH'
         AND metrics.impressions > 0`,
    ),
  ])

  let running = 0
  const cumulative = daily.map((d) => ({ date: d.date, spent: (running += d.metrics.cost) }))
  const spent = running
  const avgDaily7 = lastWeek.reduce((s, d) => s + d.metrics.cost, 0) / 7
  const lostById = new Map(lost.map((r) => [String(r.campaign.id ?? ""), num(r.metrics?.searchBudgetLostImpressionShare)]))

  const live = campaigns.filter((c) => c.status === "ENABLED")
  const runningDaily = live.reduce((s, c) => s + (c.dailyBudget ?? 0), 0)
  const projectedByPace = spent + avgDaily7 * daysLeft
  const projectedByBudgets = spent + runningDaily * daysLeft

  const monthly = budget.monthly
  const expectedSoFar = monthly ? (monthly * dayOfMonth) / daysInMonth : null
  const neededDaily = monthly ? Math.max(0, monthly - spent) / Math.max(daysLeft, 1) : null
  let status: PaceStatus = "no-budget"
  if (expectedSoFar) {
    const ratio = spent / expectedSoFar
    status = ratio < 0.9 ? "under" : ratio > 1.1 ? "over" : "on"
  }

  // The day the recent pace would reach the pause line, if it's still ahead and this month.
  let pauseLineDate: string | null = null
  if (budget.pauseLine && spent < budget.pauseLine && avgDaily7 > 0) {
    const days = Math.ceil((budget.pauseLine - spent) / avgDaily7)
    if (days <= daysLeft) pauseLineDate = addDays(end, days)
  }

  return {
    month,
    monthLabel: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    dayOfMonth,
    daysInMonth,
    daysLeft,
    spent,
    leads: ads.reduce((s, a) => s + a.leads, 0),
    cumulative,
    avgDaily7,
    runningDaily,
    projectedByPace,
    projectedByBudgets,
    budget,
    expectedSoFar,
    neededDaily,
    status,
    pauseLineDate,
    campaigns: campaigns
      .filter((c) => c.status === "ENABLED" || c.metrics.cost > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        channel: c.channel,
        dailyBudget: c.dailyBudget,
        spent: c.metrics.cost,
        expected: c.dailyBudget !== null && c.status === "ENABLED" ? c.dailyBudget * dayOfMonth : null,
        lostToBudget: lostById.has(c.id) ? lostById.get(c.id)! : null,
      }))
      .sort((a, b) => Number(b.status === "ENABLED") - Number(a.status === "ENABLED") || b.spent - a.spent),
  }
}
