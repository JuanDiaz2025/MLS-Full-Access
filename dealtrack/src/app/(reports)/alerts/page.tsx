import type { Metadata } from "next"
import Link from "next/link"

import { saveAlertSettings } from "@/app/actions/settings"
import { formatDate, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import NotifySettings from "@/components/alerts/notify-settings"
import { AdminLink, DataTable, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import SettingsForm from "@/components/settings-form"
import { bySeverity, checkAlerts, googleAdsRules, type Fired, type RuleGroup } from "@/lib/alert-rules"
import {
  BASELINE_WEEKS,
  Z_ALERT,
  adsOutliers,
  brokenDestinations,
  clarityIssues,
  internalTraffic,
  posthogErrorIssues,
  siteOutliers,
  softConversions,
  type HealthIssue,
  type Outlier,
} from "@/lib/alerts"
import { isAdmin } from "@/lib/auth"
import { getClarity } from "@/lib/clarity"
import { addDays, today, type DateRange } from "@/lib/date-range"
import { getAdDestinations, getConversionActions, getWeekly } from "@/lib/google-ads/reports"
import { load, type Loaded, type Problem } from "@/lib/load"
import { getNotifySettings, sender, type NotifySettings as Notify } from "@/lib/notify"
import { currentName } from "@/lib/people"
import { getErrorTracking, getSiteWeeks } from "@/lib/posthog"
import { readData, type AlertRecord, type AlertSettings } from "@/lib/store"

export const metadata: Metadata = { title: "Alerts · DealTrack" }

const WEEKS = 26
const severityTone = { critical: "red", high: "red", medium: "amber", info: "gray" } as const
const severityLabel = { critical: "Critical", high: "High", medium: "Medium", info: "Info" } as const

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

function lasted(from: string, to: string) {
  const mins = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000))
  if (mins < 60) return mins <= 1 ? "under a minute" : `${mins} minutes`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`
  return `${Math.round(hours / 24)} days`
}

// A rule group built from data the page already loaded. If the load failed, the group is
// skipped, so its alerts aren't marked resolved just because the data didn't arrive (the page
// shows the load problem itself).
function fromLoaded<T>(prefix: string, loaded: Loaded<T>, fired: (data: T) => Fired[]): RuleGroup {
  return { prefix, skip: !loaded.ok, run: async () => (loaded.ok ? fired(loaded.data) : []) }
}

const asFired = ({ key, severity, title, detail, href }: HealthIssue): Fired => ({ key, severity, title, detail, href })

export default async function AlertsPage() {
  const end = today()
  // Complete weeks only: stop at the last Sunday before today (0 = Sunday).
  const weekday = new Date(`${end}T00:00:00Z`).getUTCDay()
  const lastSunday = addDays(end, -(weekday === 0 ? 7 : weekday))
  const lastWeek = addDays(lastSunday, -6)
  const range: DateRange = { from: addDays(lastSunday, -7 * WEEKS + 1), to: lastSunday, label: `Last ${WEEKS} weeks` }

  const [data, destinations, conversions, weekly, clarity, siteWeeks, errors] = await Promise.all([
    load(() => readData()),
    load(() => getAdDestinations().then(brokenDestinations)),
    load(() => getConversionActions(range)),
    load(() => getWeekly(range)),
    load(() => getClarity()),
    load(() => getSiteWeeks(WEEKS)),
    load(() => getErrorTracking()),
  ])
  // JavaScript errors come from PostHog once its error tracking is on; Clarity's number until then.
  const posthogErrors = errors.ok && errors.data.enabled && errors.data.ready
  const posthogFrom =
    errors.ok && errors.data.since && !errors.data.ready
      ? new Date(errors.data.since + 3 * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" })
      : ""
  if (!data.ok) {
    return (
      <>
        <PageHeader title="Alerts" description="What needs attention in the account, the website, and tracking." />
        <ReportProblem problem={data} />
      </>
    )
  }

  const adsWeeks = weekly.ok ? adsOutliers(weekly.data) : []
  const siteFound = siteWeeks.ok ? siteOutliers(siteWeeks.data) : []
  const found: Outlier[] = [...adsWeeks, ...siteFound].sort((a, b) => b.week.localeCompare(a.week) || Math.abs(b.z) - Math.abs(a.z))

  // Last complete week's jumps and drops become alerts; older ones stay in the table below.
  const weekAlerts = (list: Outlier[], source: string): Fired[] =>
    list
      .filter((o) => o.week === lastWeek)
      .map((o) => {
        const drop = o.z < 0
        const important = drop && /conversions|form submits/i.test(o.metric)
        return {
          key: `weekly:${source}:${o.metric}:${o.week}`,
          severity: important ? "high" : source === "ads" ? "medium" : "info",
          title: `${o.metric} ${drop ? "dropped" : "jumped"} to ${fmt(o, o.value)} in the week of ${formatDate(o.week)}`,
          detail: `A normal week is about ${fmt(o, o.baseline)} (${o.source}).`,
        }
      })

  const healthIssues: HealthIssue[] = [
    ...(destinations.ok ? destinations.data : []),
    ...(conversions.ok ? softConversions(conversions.data) : []),
    ...(clarity.ok ? clarityIssues(clarity.data, { posthogErrors, posthogFrom }) : []),
    ...(errors.ok ? posthogErrorIssues(errors.data) : []),
    ...(siteWeeks.ok ? internalTraffic(siteWeeks.data) : []),
  ]
  const items = new Map(healthIssues.filter((i) => i.items).map((i) => [i.key, i.items!]))

  const checked = await load(() =>
    checkAlerts([
      ...googleAdsRules(data.data),
      fromLoaded("health:broken", destinations, (d) => d.map(asFired)),
      fromLoaded("health:soft-conversions", conversions, (c) => softConversions(c).map(asFired)),
      fromLoaded("health:clarity:", clarity, (c) => clarityIssues(c, { posthogErrors, posthogFrom }).map(asFired)),
      fromLoaded("health:posthog:", errors, (e) => posthogErrorIssues(e).map(asFired)),
      fromLoaded("health:internal-traffic", siteWeeks, (w) => internalTraffic(w).map(asFired)),
      fromLoaded("weekly:ads:", weekly, () => weekAlerts(adsWeeks, "ads")),
      fromLoaded("weekly:site:", siteWeeks, () => weekAlerts(siteFound, "site")),
    ]),
  )

  const loadProblems = [destinations, conversions, weekly, clarity, siteWeeks, errors].filter((r) => !r.ok) as Problem[]
  // The same missing key or error can come from several sources; show it once.
  const problemId = (p: Problem) => (p.kind === "missing" ? `missing:${p.service ?? ""}` : `error:${p.message}`)
  const problems = [...loadProblems, ...(checked.ok ? checked.data.problems : [checked as Problem])].filter(
    (p, i, all) => all.findIndex((q) => problemId(q) === problemId(p)) === i,
  )
  const log = checked.ok ? checked.data.log : data.data.alertLog
  const open = log.filter((r) => !r.resolvedAt).sort(bySeverity)
  const resolved = log.filter((r) => r.resolvedAt).slice(0, 50)
  const [admin, personName, notify, from] = await Promise.all([isAdmin(), currentName(), getNotifySettings(), sender()])

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Checked each time this page or the Overview opens: budget lines, leads, daily jumps, disapproved ads, invalid clicks, broken landing pages, and tracking. Today's spend (over budget, expensive clicks, running far ahead of normal) is also checked every 15 minutes while DealTrack is running. Every alert goes into a history saved on this computer, with when it started and when it cleared."
      />
      {problems.map((p, i) => (
        <ReportProblem key={i} problem={p} />
      ))}

      <Section title={open.length ? `${open.length} open ${open.length === 1 ? "alert" : "alerts"}` : "Open alerts"} description="Most serious first.">
        {open.length ? (
          <ul className="flex flex-col divide-y">
            {open.map((r) => (
              <AlertItem key={r.key} record={r} items={items.get(r.key)} />
            ))}
          </ul>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">Nothing needs attention right now.</p>
        )}
      </Section>

      <Section
        title="Unusual weeks"
        description={`Each complete week (Monday–Sunday) compared with the ${BASELINE_WEEKS} weeks before it. Flagged when it's at least ${Z_ALERT}× further from normal than a typical week varies. Last ${WEEKS} weeks; the latest week's also appear as alerts.`}
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

      <Rules settings={data.data.alerts} admin={admin} personName={personName} />

      <Emails notify={notify} admin={admin} personName={personName} from={from} />

      <Section
        title="History"
        description={
          resolved.length > 1 ? `The last ${resolved.length} alerts that cleared, newest first.` : resolved.length ? "The one alert that has cleared." : "Alerts that cleared show up here."
        }
      >
        <DataTable<AlertRecord>
          rows={resolved}
          rowKey={(r) => `${r.key}|${r.firstSeen}`}
          empty="No alerts have cleared yet."
          columns={[
            {
              key: "alert",
              label: "Alert",
              className: "min-w-72",
              render: (r) => (
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{r.title}</span>
                  <span className="text-xs text-muted-foreground">{r.detail}</span>
                </span>
              ),
            },
            { key: "sev", label: "Severity", render: (r) => <Pill tone={severityTone[r.severity]}>{severityLabel[r.severity]}</Pill> },
            { key: "start", label: "First seen", render: (r) => <span className="whitespace-nowrap">{when(r.firstSeen)}</span> },
            { key: "end", label: "Cleared", render: (r) => <span className="whitespace-nowrap">{when(r.resolvedAt!)}</span> },
            { key: "for", label: "Lasted", render: (r) => <span className="whitespace-nowrap text-muted-foreground">{lasted(r.firstSeen, r.resolvedAt!)}</span> },
          ]}
        />
      </Section>
    </>
  )
}

function AlertItem({ record: r, items }: { record: AlertRecord; items?: string[] }) {
  return (
    <li className="flex items-start gap-3 py-3">
      <Pill tone={severityTone[r.severity]}>{severityLabel[r.severity]}</Pill>
      <span className="flex min-w-0 flex-col gap-0.5 text-sm">
        {r.href ? (
          <Link href={r.href} className="font-medium hover:underline">
            {r.title}
          </Link>
        ) : (
          <span className="font-medium">{r.title}</span>
        )}
        <span className="text-muted-foreground">{r.detail}</span>
        <span className="text-xs text-muted-foreground">
          Since {when(r.firstSeen)} · seen {r.times} {r.times === 1 ? "time" : "times"}
        </span>
        {items && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs font-medium text-primary">Show {items.length}</summary>
            <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
        )}
      </span>
    </li>
  )
}

function Rules({ settings: s, admin, personName }: { settings: AlertSettings; admin: boolean; personName: string }) {
  const rules = [
    `Spend reaches the budget's alert or pause line, or is heading past the monthly budget (set on the Budget & pacing page).`,
    `${formatUsd(s.monthNoLeadSpend)} or more spent in a month with no leads.`,
    `${formatUsd(s.noLeadSpend)} or more spent over the last ${s.noLeadDays} ${s.noLeadDays === 1 ? "day" : "days"} with no leads.`,
    s.maxCostPerLead ? `Cost per lead over the last 14 days above ${formatUsd(s.maxCostPerLead)}.` : "Cost per lead limit: off until a limit is set.",
    s.clickCostAlert ? `Today: one click costing more than ${formatUsd(s.clickCostAlert)}, spend over a campaign's daily budget, or far ahead of normal for the time of day (every 15 minutes).` : "Expensive click alert: off until a line is set.",
    "Yesterday's spend, clicks, or cost per click far above the 28 days before it, or ads that spent nothing after a week of spending.",
    "Disapproved ads in running campaigns, and ads pointing at pages that don't load.",
    `More than ${formatPercent(s.invalidClickRate, 0)} of the last 30 days' clicks invalid.`,
    "Primary conversions that aren't leads, website script errors, and last week's unusual numbers.",
  ]
  return (
    <Section
      title="Alert rules"
      description={
        s.updatedAt
          ? `Limits set by ${s.updatedBy ?? "someone"} on ${when(s.updatedAt)}. Saved on this computer.`
          : "Default limits. Admins can change them. Saved on this computer."
      }
    >
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {admin ? (
        <SettingsForm
          action={saveAlertSettings}
          personName={personName}
          fields={[
            { name: "maxCostPerLead", label: "Cost per lead limit", prefix: "$", value: s.maxCostPerLead?.toString() ?? "", placeholder: "Off", hint: "Last 14 days. Leave empty to turn off." },
            { name: "clickCostAlert", label: "Alert when one click costs more than", prefix: "$", value: s.clickCostAlert?.toString() ?? "", placeholder: "Off", hint: "Checked today, every 15 minutes. Leave empty to turn off." },
            { name: "noLeadDays", label: "Days with no leads", value: String(s.noLeadDays), hint: "How many days in a row…" },
            { name: "noLeadSpend", label: "…while spending at least", prefix: "$", value: String(s.noLeadSpend) },
            { name: "monthNoLeadSpend", label: "Monthly spend with nothing back", prefix: "$", value: String(s.monthNoLeadSpend), hint: "Default: $20,000." },
            { name: "invalidClickRate", label: "Invalid clicks above", suffix: "%", value: String(Math.round(s.invalidClickRate * 100)), hint: "Share of the last 30 days' clicks." },
          ]}
        />
      ) : (
        <AdminLink />
      )}
    </Section>
  )
}

const LEVEL_TEXT = { critical: "critical alerts", high: "high and critical alerts", medium: "medium, high and critical alerts", info: "every alert" } as const

function Emails({ notify: n, admin, personName, from }: { notify: Notify; admin: boolean; personName: string; from: Awaited<ReturnType<typeof sender>> }) {
  const status = n.enabled && n.emails.length ? `On: ${LEVEL_TEXT[n.minSeverity]} go to ${n.emails.join(", ")}.` : "Off: alerts only show here."
  return (
    <Section
      title="Alert emails"
      description={`When a new alert opens (on a page or in the 15-minute check), the people below get an email with what happened and a link here. The same alert is emailed at most once a day. ${status}`}
    >
      {n.lastError && !n.lastError.test && (!n.lastSent || n.lastError.at > n.lastSent.at) && (
        <p className="text-sm font-medium text-destructive">
          The last email didn&apos;t go out ({when(n.lastError.at)}): {n.lastError.message}
        </p>
      )}
      {n.lastSent && (!n.lastError || n.lastSent.at > n.lastError.at) && (
        <p className="text-xs text-muted-foreground">
          Last {n.lastSent.test ? "test email" : `email (${n.lastSent.count} ${n.lastSent.count === 1 ? "alert" : "alerts"})`} sent {when(n.lastSent.at)} to{" "}
          {n.lastSent.to.join(", ")}.
          {n.updatedBy && n.updatedAt ? ` Settings changed by ${n.updatedBy} on ${when(n.updatedAt)}.` : ""}
        </p>
      )}
      {admin ? (
        <NotifySettings enabled={n.enabled} emails={n.emails} minSeverity={n.minSeverity} sender={from} personName={personName} />
      ) : (
        <AdminLink />
      )}
    </Section>
  )
}

function fmt(o: Outlier, v: number) {
  if (o.unit === "usd") return o.metric === "Cost per click" ? formatUsdCents(v) : formatUsd(v)
  return formatNumber(v)
}
