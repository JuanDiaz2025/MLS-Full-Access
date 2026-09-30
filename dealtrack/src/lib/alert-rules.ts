// Alert rules, checked whenever the Alerts page or the Overview opens (DealTrack only runs while
// someone has it open, so there's no background schedule). Each check updates the alert history
// saved on this computer: a new alert gets a first-seen time, one that is still there gets its
// last-seen time bumped, and one that went away is marked resolved.
//
// Thresholds come from the alert settings (admins edit them on the Alerts page); the budget's
// alert and pause lines come from the Budget & pacing page.

import { formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { getPacing } from "@/lib/budget"
import { addDays, formatDay, today } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { getSeries, type Bucket } from "@/lib/google-ads/overview"
import { load, type Problem } from "@/lib/load"
import { updateData, type AlertRecord, type Data } from "@/lib/store"

export type Fired = Pick<AlertRecord, "key" | "severity" | "title" | "detail" | "href">

// A set of rules that load their data together. Only alerts whose key starts with the group's
// prefix can be resolved by it, so a group that failed to load never marks its alerts resolved.
// `skip` leaves a group out entirely (its data didn't load), so its alerts stay as they were.
export type RuleGroup = { prefix: string; run: () => Promise<Fired[]>; skip?: boolean }

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, info: 3 } as const
const KEEP_RESOLVED = 300

const median = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// How far `value` is from the baseline days, in robust standard deviations (median absolute
// deviation). Null when the baseline is too flat to judge.
function robustZ(value: number, baseline: number[]) {
  const base = median(baseline)
  const mad = median(baseline.map((v) => Math.abs(v - base))) * 1.4826
  return { base, z: mad ? (value - base) / mad : null }
}

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`

// ---- Rules ----------------------------------------------------------------------------------

function budgetRules(data: Data): RuleGroup {
  return {
    prefix: "budget:",
    run: async () => {
      const p = await getPacing(data.budget)
      const b = p.budget
      const out: Fired[] = []
      const month = p.month
      if (data.alerts.monthNoLeadSpend > 0 && p.spent >= data.alerts.monthNoLeadSpend && p.leads === 0) {
        out.push({
          key: `budget:nothing-back:${month}`,
          severity: "critical",
          title: `${formatUsd(p.spent)} spent in ${p.monthLabel} with no leads`,
          detail: `${formatUsd(data.alerts.monthNoLeadSpend)}+ in a month with nothing back. Check tracking, search terms, and the landing page before spending more.`,
          href: "/budget",
        })
      }
      if (b.pauseLine && p.spent >= b.pauseLine) {
        out.push({
          key: `budget:pause-line:${month}`,
          severity: "critical",
          title: `Spend reached the pause line: ${formatUsd(p.spent)} of ${formatUsd(b.pauseLine)}`,
          detail: "An admin decides whether to pause the campaigns (Budget & pacing page). Nothing pauses on its own.",
          href: "/budget",
        })
      } else if (b.alertLine && p.spent >= b.alertLine) {
        out.push({
          key: `budget:alert-line:${month}`,
          severity: "high",
          title: `Spend passed the alert line: ${formatUsd(p.spent)} of ${formatUsd(b.alertLine)}`,
          detail: `${b.pauseLine ? `The pause line is ${formatUsd(b.pauseLine)}. ` : ""}Check that the leads are worth the spend.`,
          href: "/budget",
        })
      }
      if (p.pauseLineDate && !(b.pauseLine && p.spent >= b.pauseLine)) {
        out.push({
          key: `budget:pause-projected:${month}`,
          severity: "medium",
          title: `At the recent pace, spend reaches the pause line around ${formatDay(p.pauseLineDate)}`,
          detail: `That's before ${p.monthLabel} ends. Lower daily budgets, or raise the pause line if the spend is planned.`,
          href: "/budget",
        })
      }
      if (b.monthly && p.projectedByPace > b.monthly * 1.1) {
        out.push({
          key: `budget:over-pace:${month}`,
          severity: "medium",
          title: `${p.monthLabel} is heading for ${formatUsd(p.projectedByPace)}, over the ${formatUsd(b.monthly)} budget`,
          detail: `Spending ${formatUsd(p.avgDaily7)}/day over the last 7 days; about ${formatUsd(p.neededDaily ?? 0)}/day lands on budget.`,
          href: "/budget",
        })
      }
      return out
    },
  }
}

// Spend, leads, clicks, and invalid clicks by day, for the last 35 days.
function dailyRules(data: Data, days: () => Promise<Bucket[]>): RuleGroup[] {
  const a = data.alerts
  const end = today()
  const yesterday = addDays(end, -1)
  const lastDays = (series: Bucket[], n: number) => series.filter((d) => d.start > addDays(end, -n))
  const sum = (rows: Bucket[], f: (d: Bucket) => number) => rows.reduce((s, d) => s + f(d), 0)

  return [
    {
      prefix: "leads:",
      run: async () => {
        const series = await days()
        const out: Fired[] = []
        const lastLead = [...series].reverse().find((d) => d.leads > 0)?.start
        const since = lastLead ? `The last lead was on ${formatDay(lastLead)}.` : "No leads in the last 5 weeks."

        const recent = lastDays(series, a.noLeadDays)
        const recentSpend = sum(recent, (d) => d.cost)
        if (a.noLeadSpend > 0 && recentSpend >= a.noLeadSpend && sum(recent, (d) => d.leads) === 0) {
          out.push({
            key: "leads:no-leads",
            severity: "high",
            title: `${formatUsd(recentSpend)} in the last ${plural(a.noLeadDays, "day")} with no leads`,
            detail: `${since} Check search terms, the landing page, and that forms and calls are still tracked.`,
            href: "/search-terms",
          })
        }

        if (a.maxCostPerLead) {
          const two = lastDays(series, 14)
          const cost = sum(two, (d) => d.cost)
          const leads = sum(two, (d) => d.leads)
          if (leads > 0 && cost / leads > a.maxCostPerLead) {
            out.push({
              key: "leads:cpl-over",
              severity: "high",
              title: `Cost per lead is ${formatUsd(cost / leads)} over the last 14 days, above the ${formatUsd(a.maxCostPerLead)} limit`,
              detail: `${formatUsd(cost)} for ${formatNumber(Math.round(leads * 10) / 10)} leads.`,
              href: "/overview?m1=cpl&m2=cost",
            })
          } else if (!leads && cost > a.maxCostPerLead) {
            out.push({
              key: "leads:cpl-over",
              severity: "high",
              title: `${formatUsd(cost)} in the last 14 days and no leads, more than the ${formatUsd(a.maxCostPerLead)} cost-per-lead limit`,
              detail: since,
              href: "/overview?m1=cpl&m2=cost",
            })
          }
        }
        return out
      },
    },
    {
      // Yesterday against the 28 days before it.
      prefix: "daily:",
      run: async () => {
        const series = await days()
        const out: Fired[] = []
        const day = series.find((d) => d.start === yesterday)
        const baseline = series.filter((d) => d.start < yesterday && d.start >= addDays(yesterday, -28))
        const spending = baseline.filter((d) => d.cost > 0)
        if (!day || spending.length < 7) return out

        const spend = robustZ(day.cost, spending.map((d) => d.cost))
        if (day.cost >= 100 && ((spend.z !== null && spend.z >= 3) || (spend.z === null && day.cost > spend.base * 3))) {
          out.push({
            key: `daily:spend-spike:${yesterday}`,
            severity: "medium",
            title: `Spend jumped to ${formatUsd(day.cost)} on ${formatDay(yesterday)}`,
            detail: `A normal day was about ${formatUsd(spend.base)}. Check for a budget change, a new campaign, or a burst of expensive clicks.`,
            href: "/overview?range=30d&m1=cost&m2=cpc",
          })
        }
        const clicks = robustZ(day.clicks, spending.map((d) => d.clicks))
        if (day.clicks >= 10 && ((clicks.z !== null && clicks.z >= 3) || (clicks.z === null && day.clicks > clicks.base * 3))) {
          out.push({
            key: `daily:click-spike:${yesterday}`,
            severity: "medium",
            title: `${plural(day.clicks, "click")} on ${formatDay(yesterday)}, far above normal`,
            detail: `A normal day had about ${formatNumber(clicks.base)}. If leads didn't rise with them, look at search terms and invalid clicks.`,
            href: "/search-terms?range=7d",
          })
        }
        const cpcs = spending.filter((d) => d.clicks).map((d) => d.cost / d.clicks)
        if (day.clicks >= 3 && cpcs.length >= 7) {
          const cpc = robustZ(day.cost / day.clicks, cpcs)
          if (cpc.z !== null && cpc.z >= 3 && day.cost / day.clicks > cpc.base * 1.5) {
            out.push({
              key: `daily:cpc-spike:${yesterday}`,
              severity: "medium",
              title: `Clicks cost ${formatUsd(day.cost / day.clicks)} each on ${formatDay(yesterday)}`,
              detail: `A normal day was about ${formatUsd(cpc.base)} a click. Competitors may be bidding up, or a bid strategy changed.`,
              href: "/overview?range=30d&m1=cpc&m2=clicks",
            })
          }
        }
        const lastWeek = spending.filter((d) => d.start >= addDays(yesterday, -7))
        const weekMedian = median(lastWeek.map((d) => d.cost))
        if (day.cost === 0 && lastWeek.length >= 5 && weekMedian >= 50) {
          out.push({
            key: `daily:stopped:${yesterday}`,
            severity: "high",
            title: `Ads spent nothing on ${formatDay(yesterday)}`,
            detail: `They had been spending about ${formatUsd(weekMedian)} a day. If nobody paused them, check billing, disapprovals, and budgets in Google Ads.`,
            href: "/campaigns",
          })
        }
        return out
      },
    },
    {
      prefix: "clicks:",
      run: async () => {
        const month = lastDays(await days(), 30)
        const invalid = sum(month, (d) => d.invalidClicks)
        const total = invalid + sum(month, (d) => d.clicks)
        if (invalid < 10 || !total || invalid / total <= a.invalidClickRate) return []
        return [
          {
            key: "clicks:invalid-rate",
            severity: "medium",
            title: `${formatPercent(invalid / total, 0)} of clicks in the last 30 days were invalid`,
            detail: `Google filtered ${plural(invalid, "click")} of ${formatNumber(total)} and didn't charge for them. A jump can mean bots or someone clicking on purpose; see the Invalid clicks section of the weekly report.`,
            href: "/report#invalid-clicks",
          },
        ]
      },
    },
  ]
}

function adRules(): RuleGroup {
  return {
    prefix: "ads:",
    run: async () => {
      const rows = await gaql<{ campaign: { name?: string } }>(
        `SELECT campaign.name, ad_group_ad.ad.id FROM ad_group_ad
         WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED'
           AND ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'`,
      )
      if (!rows.length) return []
      const campaigns = [...new Set(rows.map((r) => r.campaign.name ?? "(no name)"))]
      return [
        {
          key: "ads:disapproved-running",
          severity: "high",
          title: `${plural(rows.length, "disapproved ad")} in running campaigns`,
          detail: `${campaigns.join(", ")}. Disapproved ads don't show, so the ad group may be running on fewer ads than planned.`,
          href: "/ads?problems=1",
        },
      ]
    },
  }
}

// The Google Ads rules. The Alerts page adds its website and landing page checks on top.
export function googleAdsRules(data: Data): RuleGroup[] {
  const end = today()
  let series: Promise<Bucket[]> | null = null
  const days = () => (series ??= getSeries({ from: addDays(end, -34), to: end, label: "Last 35 days" }, "day"))
  return [budgetRules(data), ...dailyRules(data, days), adRules()]
}

// ---- History --------------------------------------------------------------------------------

export function recordAlerts(log: AlertRecord[], fired: Fired[], evaluated: string[], now = new Date().toISOString()): AlertRecord[] {
  const firedKeys = new Set(fired.map((f) => f.key))
  for (const f of fired) {
    const open = log.find((r) => r.key === f.key && !r.resolvedAt)
    if (open) Object.assign(open, f, { lastSeen: now, times: open.times + 1 })
    else log.push({ ...f, firstSeen: now, lastSeen: now, times: 1 })
  }
  for (const r of log) {
    if (!r.resolvedAt && !firedKeys.has(r.key) && evaluated.some((p) => r.key.startsWith(p))) r.resolvedAt = now
  }
  const open = log.filter((r) => !r.resolvedAt)
  const resolved = log.filter((r) => r.resolvedAt).sort((x, y) => y.resolvedAt!.localeCompare(x.resolvedAt!)).slice(0, KEEP_RESOLVED)
  return [...open, ...resolved]
}

export const bySeverity = (a: AlertRecord, b: AlertRecord) =>
  SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.firstSeen.localeCompare(b.firstSeen)

// Runs the rules, saves what they found to the alert history, and returns the history.
export async function checkAlerts(groups: RuleGroup[]): Promise<{ log: AlertRecord[]; problems: Problem[] }> {
  const results = await Promise.all(groups.filter((g) => !g.skip).map(async (g) => ({ g, result: await load(g.run) })))
  const fired = results.flatMap((r) => (r.result.ok ? r.result.data : []))
  const evaluated = results.filter((r) => r.result.ok).map((r) => r.g.prefix)
  const problems = results.flatMap((r) => (r.result.ok ? [] : [r.result as Problem]))
  const saved = await updateData((d) => {
    d.alertLog = recordAlerts(d.alertLog, fired, evaluated)
  })
  return { log: saved.alertLog, problems }
}
