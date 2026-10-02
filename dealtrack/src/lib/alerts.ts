// Anomaly detection: weekly outliers against each metric's own recent history, plus hard checks
// that should never fail (ads pointing at dead pages, fake conversions, broken scripts).

import type { ClaritySnapshot } from "@/lib/clarity"
import { isLeadConversion, type AdDestination, type ConversionActionRow, type WeekPoint } from "@/lib/google-ads/reports"
import { checkPage } from "@/lib/pagespeed"
import type { ErrorTracking, SiteWeek } from "@/lib/posthog"

export const BASELINE_WEEKS = 8
export const Z_ALERT = 3

export type Outlier = {
  week: string
  source: "Google Ads" | "Website"
  metric: string
  value: number
  baseline: number
  z: number
  unit: "usd" | "number"
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Robust z-score: distance from the median of the previous 8 weeks, in units of their median
// absolute deviation. One bad week doesn't distort the baseline the way a mean would.
export function outliers(
  series: { week: string; value: number }[],
  meta: Omit<Outlier, "week" | "value" | "baseline" | "z">,
): Outlier[] {
  const found: Outlier[] = []
  for (let i = 4; i < series.length; i++) {
    const prior = series.slice(Math.max(0, i - BASELINE_WEEKS), i).map((p) => p.value)
    const base = median(prior)
    const mad = median(prior.map((v) => Math.abs(v - base))) * 1.4826
    if (!mad) continue
    const z = (series[i].value - base) / mad
    if (Math.abs(z) >= Z_ALERT) found.push({ ...meta, week: series[i].week, value: series[i].value, baseline: base, z })
  }
  return found
}

export function adsOutliers(weeks: WeekPoint[]): Outlier[] {
  const spent = weeks.filter((w) => w.metrics.cost > 0)
  const s = (f: (w: WeekPoint) => number) => spent.map((w) => ({ week: w.week, value: f(w) }))
  return [
    ...outliers(s((w) => w.metrics.cost), { source: "Google Ads", metric: "Spend", unit: "usd" }),
    ...outliers(s((w) => w.metrics.clicks), { source: "Google Ads", metric: "Clicks", unit: "number" }),
    ...outliers(
      spent.filter((w) => w.metrics.clicks).map((w) => ({ week: w.week, value: w.metrics.cost / w.metrics.clicks })),
      { source: "Google Ads", metric: "Cost per click", unit: "usd" },
    ),
    ...outliers(s((w) => w.metrics.conversions), { source: "Google Ads", metric: "Conversions", unit: "number" }),
  ]
}

export function siteOutliers(weeks: SiteWeek[]): Outlier[] {
  const s = (f: (w: SiteWeek) => number) => weeks.map((w) => ({ week: w.week, value: f(w) }))
  return [
    ...outliers(s((w) => w.publicPageviews), { source: "Website", metric: "Visitor pageviews", unit: "number" }),
    ...outliers(s((w) => w.internalPageviews), { source: "Website", metric: "Team / staging pageviews", unit: "number" }),
    ...outliers(s((w) => w.adLandings), { source: "Website", metric: "Ad click landings", unit: "number" }),
    ...outliers(s((w) => w.formSubmits), { source: "Website", metric: "Form submits", unit: "number" }),
  ]
}

export type HealthIssue = {
  key: string // stable id, so the alert history can follow one issue across visits
  severity: "critical" | "high" | "medium" | "info"
  title: string
  detail: string
  href?: string
  items?: string[] // shown as an expandable list
}

// Enabled ads in enabled or paused campaigns whose page is gone. Critical when the campaign is live.
export async function brokenDestinations(destinations: AdDestination[]): Promise<HealthIssue[]> {
  // Sixteen at a time, so ~100 ad URLs don't hit the website all at once.
  const checks: { d: AdDestination; page: Awaited<ReturnType<typeof checkPage>> }[] = []
  for (let i = 0; i < destinations.length; i += 16) {
    const batch = destinations.slice(i, i + 16)
    checks.push(...(await Promise.all(batch.map(async (d) => ({ d, page: await checkPage(d.url) })))))
  }
  const broken = checks
    .filter(({ page }) => !page.resolves || (page.status !== null && page.status >= 400))
    .map(({ d, page }) => ({
      d,
      live: d.campaigns.some((c) => c.status === "ENABLED"),
      problem: page.resolves ? `returns an error (HTTP ${page.status})` : "doesn't exist any more (the domain doesn't resolve)",
      page: d.url.replace(/^https?:\/\/(www\.)?/, ""),
    }))
  const ads = (d: AdDestination) => `${d.ads} ad${d.ads === 1 ? "" : "s"} in ${d.campaigns.map((c) => c.name).join(", ")}`

  // Running ads on a broken page: one alert each, since every click is wasted now.
  const issues: HealthIssue[] = broken
    .filter((b) => b.live)
    .map((b) => ({
      key: `health:broken:${b.page}`,
      severity: "critical",
      title: `${b.page} ${b.problem}`,
      detail: `${ads(b.d)}. These ads are running now: every click is wasted.`,
    }))
  // Paused campaigns: one grouped alert, to fix before anything is turned back on.
  const paused = broken.filter((b) => !b.live)
  if (paused.length) {
    const adCount = paused.reduce((s, b) => s + b.d.ads, 0)
    issues.push({
      key: "health:broken-paused",
      severity: "medium",
      title: `${paused.length} broken page${paused.length === 1 ? "" : "s"} behind ${adCount} paused ads`,
      detail: "Nothing is wasted today, but these ads would send clicks to an error if their campaigns were turned back on. Fix or redirect the pages, or change the ads' final URLs first.",
      items: paused.sort((a, b) => b.d.ads - a.d.ads).map((b) => `${b.page} ${b.problem}: ${ads(b.d)}`),
    })
  }
  return issues
}

export function softConversions(actions: ConversionActionRow[]): HealthIssue[] {
  const soft = actions.filter((a) => a.status === "ENABLED" && a.primary && !isLeadConversion(a.name, a.category))
  if (!soft.length) return []
  return [
    {
      key: "health:soft-conversions",
      severity: "high",
      title: `${soft.length} primary conversion${soft.length === 1 ? " isn't" : "s aren't"} a lead`,
      detail: `${soft.map((a) => a.name).join(", ")}. Google's bidding learns to find people who do these, not sellers who book appointments.`,
      href: "/conversions",
    },
  ]
}

// `posthogErrors`: PostHog records JavaScript errors itself, so Clarity's number isn't used.
export function clarityIssues(c: ClaritySnapshot, { posthogErrors = false, posthogFrom = "" } = {}): HealthIssue[] {
  const issues: HealthIssue[] = []
  if (!posthogErrors && c.scriptErrorPct !== null && c.scriptErrorPct > 10) {
    issues.push({
      key: "health:clarity:script-errors",
      severity: "high",
      title: `${Math.round(c.scriptErrorPct)}% of visits hit a JavaScript error`,
      detail:
        "Script errors can stop forms from submitting and tracking from firing. Last 3 days, from Microsoft Clarity. " +
        (posthogFrom
          ? `PostHog error tracking is on and takes over on ${posthogFrom}, once it has 3 days of errors (with which errors they are).`
          : "Turn on exception autocapture in PostHog (Settings → Error tracking) to see which errors, without Clarity's daily limit."),
    })
  }
  if (c.sessions && c.botSessions > c.sessions) {
    issues.push({
      key: "health:clarity:bots",
      severity: "info",
      title: `More bot visits than people (${c.botSessions} bots vs ${c.sessions} people)`,
      detail: "Last 3 days, from Microsoft Clarity. Bots inflate traffic reports; they're not counted as sessions here.",
    })
  }
  return issues
}

export function posthogErrorIssues(e: ErrorTracking): HealthIssue[] {
  if (!e.enabled || !e.ready || e.pct === null || e.pct <= 10) return []
  const top = e.top.length ? ` Most common: ${e.top.map((t) => `“${t.message}” (${t.sessions} visits)`).join("; ")}.` : ""
  return [
    {
      key: "health:posthog:script-errors",
      severity: "high",
      title: `${Math.round(e.pct)}% of visits hit a JavaScript error`,
      detail: `${e.errorSessions} of ${e.sessions} visits in the last 3 days, from PostHog error tracking. Script errors can stop forms from submitting and tracking from firing.${top}`,
    },
  ]
}

export function internalTraffic(weeks: SiteWeek[]): HealthIssue[] {
  const recent = weeks.slice(-17)
  const internal = recent.reduce((s, w) => s + w.internalPageviews, 0)
  const total = internal + recent.reduce((s, w) => s + w.publicPageviews, 0)
  if (!total || internal / total < 0.1) return []
  return [
    {
      key: "health:internal-traffic",
      severity: "medium",
      title: `${Math.round((internal / total) * 100)}% of pageviews are the team or the staging site`,
      detail:
        "Last 4 months in PostHog. DealTrack leaves them out, but PostHog's own dashboards count them. Filter internal traffic in PostHog (Settings → Filter out internal and test users).",
    },
  ]
}
