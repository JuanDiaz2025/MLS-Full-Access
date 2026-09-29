import type { Metadata } from "next"
import Link from "next/link"

import { formatDate, formatNumber, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import { DataTable, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import {
  BASELINE_WEEKS,
  Z_ALERT,
  adsOutliers,
  brokenDestinations,
  clarityIssues,
  internalTraffic,
  siteOutliers,
  softConversions,
  type HealthIssue,
  type Outlier,
} from "@/lib/alerts"
import { getClarity } from "@/lib/clarity"
import { addDays, today, type DateRange } from "@/lib/date-range"
import { getAdDestinations, getConversionActions, getWeekly } from "@/lib/google-ads/reports"
import { load, type Loaded, type Problem } from "@/lib/load"
import { getSiteWeeks } from "@/lib/posthog"

export const metadata: Metadata = { title: "Alerts · DealTrack" }

const WEEKS = 26
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, info: 3 } as const
const severityTone = { critical: "red", high: "red", medium: "amber", info: "gray" } as const

export default async function AlertsPage() {
  const end = today()
  // Complete weeks only: stop at the last Sunday before today (0 = Sunday).
  const weekday = new Date(`${end}T00:00:00Z`).getUTCDay()
  const lastSunday = addDays(end, -(weekday === 0 ? 7 : weekday))
  const range: DateRange = { from: addDays(lastSunday, -7 * WEEKS + 1), to: lastSunday, label: `Last ${WEEKS} weeks` }

  const [destinations, conversions, weekly, clarity, siteWeeks] = await Promise.all([
    load(() => getAdDestinations().then(brokenDestinations)),
    load(() => getConversionActions(range)),
    load(() => getWeekly(range)),
    load(() => getClarity()),
    load(() => getSiteWeeks(WEEKS)),
  ])

  const issues: HealthIssue[] = [
    ...(destinations.ok ? destinations.data : []),
    ...(conversions.ok ? softConversions(conversions.data) : []),
    ...(clarity.ok ? clarityIssues(clarity.data) : []),
    ...(siteWeeks.ok ? internalTraffic(siteWeeks.data) : []),
  ].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  const found: Outlier[] = [
    ...(weekly.ok ? adsOutliers(weekly.data) : []),
    ...(siteWeeks.ok ? siteOutliers(siteWeeks.data) : []),
  ].sort((a, b) => b.week.localeCompare(a.week) || Math.abs(b.z) - Math.abs(a.z))

  const problems = [destinations, conversions, weekly, clarity, siteWeeks].filter((r): r is Extract<Loaded<unknown>, { ok: false }> => !r.ok)

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Things that are broken or unusual: ads pointing at dead pages, conversions that aren't leads, site errors, and weeks where a number jumped or dropped far outside its normal range."
      />
      {problems.map((p, i) => (
        <ReportProblem key={i} problem={p as Problem} />
      ))}

      <Section
        title={issues.length ? `${issues.length} health ${issues.length === 1 ? "issue" : "issues"}` : "Health checks"}
        description="Checked on every visit (page checks are cached for an hour, Clarity for 3 hours)."
      >
        {issues.length ? (
          <ul className="flex flex-col divide-y">
            {issues.map((issue) => (
              <li key={issue.title} className="flex items-start gap-3 py-3">
                <Pill tone={severityTone[issue.severity]}>{issue.severity === "critical" ? "Critical" : issue.severity === "high" ? "High" : issue.severity === "medium" ? "Medium" : "Info"}</Pill>
                <span className="flex flex-col gap-0.5 text-sm">
                  {issue.href ? (
                    <Link href={issue.href} className="font-medium hover:underline">
                      {issue.title}
                    </Link>
                  ) : (
                    <span className="font-medium">{issue.title}</span>
                  )}
                  <span className="text-muted-foreground">{issue.detail}</span>
                  {issue.items && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-medium text-primary">Show {issue.items.length}</summary>
                      <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                        {issue.items.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">Nothing broken right now.</p>
        )}
      </Section>

      <Section
        title="Unusual weeks"
        description={`Each complete week (Monday–Sunday) compared with the ${BASELINE_WEEKS} weeks before it. Flagged when it's at least ${Z_ALERT}× further from normal than a typical week varies. Last ${WEEKS} weeks.`}
      >
        <DataTable<Outlier>
          rows={found}
          rowKey={(o) => `${o.week}-${o.source}-${o.metric}`}
          empty="No unusual weeks."
          columns={[
            { key: "week", label: "Week of", render: (o) => <span className="font-medium">{formatDate(o.week)}</span> },
            { key: "source", label: "Source", render: (o) => <span className="text-muted-foreground">{o.source}</span> },
            { key: "metric", label: "Metric", render: (o) => o.metric },
            {
              key: "dir",
              label: "Change",
              render: (o) => <Pill tone={o.z > 0 ? "amber" : "violet"}>{o.z > 0 ? "Spike" : "Drop"}</Pill>,
            },
            { key: "value", label: "That week", align: "right", render: (o) => fmt(o, o.value) },
            { key: "base", label: "Normal", align: "right", render: (o) => fmt(o, o.baseline) },
            {
              key: "x",
              label: "vs normal",
              align: "right",
              render: (o) => (o.baseline ? `${o.value >= o.baseline ? "+" : ""}${Math.round(((o.value - o.baseline) / o.baseline) * 100)}%` : "new"),
            },
          ]}
        />
      </Section>
    </>
  )
}

function fmt(o: Outlier, v: number) {
  if (o.unit === "usd") return o.metric === "Cost per click" ? formatUsdCents(v) : formatUsd(v)
  return formatNumber(v)
}
