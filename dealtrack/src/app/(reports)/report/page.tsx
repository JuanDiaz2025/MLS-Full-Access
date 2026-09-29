import type { Metadata } from "next"
import Link from "next/link"

import CopyButton from "@/components/copy-button"
import { formatConversions, formatDate, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import TrendKpis from "@/components/dashboard/trend-kpis"
import PrintButton from "@/components/print-button"
import { DataTable, PageHeader, Pill, ReportProblem, Section, StatusPill, enumLabel } from "@/components/report"
import { bySeverity } from "@/lib/alert-rules"
import { getPacing, type Pacing } from "@/lib/budget"
import { addDays, dayOf, formatDay, today, type DateRange } from "@/lib/date-range"
import { getChangeHistory, type ChangeEvent } from "@/lib/google-ads/changes"
import { getInvalidClicks, type InvalidRow } from "@/lib/google-ads/invalid-clicks"
import { getOverview, type Overview } from "@/lib/google-ads/overview"
import { getCampaigns, getSearchTerms, rates, type CampaignRow, type SearchTermRow } from "@/lib/google-ads/reports"
import { load, type Loaded } from "@/lib/load"
import { completeWeeks, stageOf } from "@/lib/negative-batches"
import { delta, formatUnit, metricById } from "@/lib/overview-metrics"
import { readData, type AlertRecord, type Data, type NegativeBatch } from "@/lib/store"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Weekly report · DealTrack" }

type Params = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const shortDay = (iso: string) => formatDate(iso)
const CHANGE_HISTORY_DAYS = 30 // Google keeps change history for 30 days
function leadsText(n: number) {
  const shown = Math.round(n * 10) / 10
  return `${formatConversions(shown)} lead${shown === 1 ? "" : "s"}`
}

const batchStatus = {
  empty: "Nothing to add",
  proving: "Waiting for Seth's proof",
  approving: "Waiting for the PPC owner's approval",
  ready: "Approved, waiting for an admin to push",
  "nothing-approved": "Nothing approved",
  pushed: "Pushed",
  checked: "Pushed, result checked",
} as const

export default async function WeeklyReportPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const weeks = completeWeeks(8)
  const week = weeks.find((w) => w.id === first(params.week)) ?? weeks[0]
  const range: DateRange = { from: week.from, to: week.to, label: `${formatDay(week.from)} – ${formatDay(week.to)}` }
  const changesKnown = week.from >= addDays(today(), -(CHANGE_HISTORY_DAYS - 1))

  const [overview, campaigns, terms, invalid, changes, saved] = await Promise.all([
    load(() => getOverview(range)),
    load(() => getCampaigns(range)),
    load(() => getSearchTerms(range)),
    load(() => getInvalidClicks(`${addDays(today(), -182).slice(0, 7)}-01`, today())),
    changesKnown ? load(() => getChangeHistory(range.from, range.to)) : Promise.resolve(null),
    load(() => readData()),
  ])
  const pacing = saved.ok ? await load(() => getPacing(saved.data.budget)) : saved

  return (
    <div className="print-report flex flex-col gap-6">
      <PageHeader
        title={`Weekly report: ${range.label}`}
        description="One week of Google Ads for the team: the headline numbers against the week before, the month's pacing, campaigns, searches that cost money without a lead, invalid clicks, alerts, the week's negative keywords, and what changed in the account. Print it, or copy the summary into Slack or an email."
      />
      <nav aria-label="Week" className="flex flex-wrap gap-1.5 print:hidden">
        {weeks.map((w, i) => (
          <Link
            key={w.id}
            href={i === 0 ? "/report" : `/report?week=${w.id}`}
            aria-current={w.id === week.id ? "true" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
              w.id === week.id && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
            )}
          >
            {shortDay(w.from)} – {shortDay(w.to)}
          </Link>
        ))}
      </nav>
      {!overview.ok ? (
        <ReportProblem problem={overview} />
      ) : (
        <Body
          range={range}
          overview={overview.data}
          campaigns={campaigns}
          terms={terms}
          invalid={invalid}
          changes={changes}
          saved={saved.ok ? saved.data : null}
          pacing={pacing}
          weekId={week.id}
        />
      )}
    </div>
  )
}

function Body({
  range,
  overview,
  campaigns,
  terms,
  invalid,
  changes,
  saved,
  pacing,
  weekId,
}: {
  range: DateRange
  overview: Overview
  campaigns: Loaded<CampaignRow[]>
  terms: Loaded<SearchTermRow[]>
  invalid: Loaded<{ months: InvalidRow[]; campaigns: InvalidRow[] }>
  changes: Loaded<ChangeEvent[]> | null
  saved: Data | null
  pacing: Loaded<Pacing>
  weekId: string
}) {
  const t = overview.totals
  const before = overview.previous.totals
  const kpi = (id: string, note?: string) => {
    const m = metricById(id)!
    return { label: m.label, value: formatUnit(m.unit, m.value(t)), delta: delta(m, m.value(t), m.value(before)), note, spark: overview.buckets.map((b) => m.value(b)) }
  }
  const change = (id: string) => {
    const m = metricById(id)!
    return delta(m, m.value(t), m.value(before))?.text ?? "no week before to compare"
  }

  const waste = terms.ok ? terms.data.filter((s) => s.metrics.cost > 0 && s.metrics.conversions === 0).slice(0, 10) : []
  const wasteCost = waste.reduce((s, x) => s + x.metrics.cost, 0)
  const weekInvalid = t.invalidClicks
  const weekInvalidRate = t.clicks + weekInvalid ? weekInvalid / (t.clicks + weekInvalid) : null

  const log = saved?.alertLog ?? []
  const inWeek = (iso: string) => {
    const d = dayOf(iso)
    return d >= range.from && d <= range.to
  }
  const open = log.filter((r) => !r.resolvedAt).sort(bySeverity)
  const weekAlerts = log.filter((r) => inWeek(r.firstSeen) || (r.resolvedAt && inWeek(r.resolvedAt)))
  const batches = saved?.batches ?? []
  const batch = batches.find((b) => b.id === weekId)
  const pushedThisWeek = batches.filter((b) => b.pushed && inWeek(b.pushed.at))

  const summary = [
    `Google Ads weekly report, ${range.label}`,
    `Spend ${formatUsd(t.cost)} (${change("cost")} vs the week before), ${leadsText(t.leads)} (${change("leads")}), cost per lead ${formatUnit("usd", t.leads ? t.cost / t.leads : null)}.`,
    `Clicks ${formatNumber(t.clicks)}, click-through rate ${formatUnit("percent", t.impressions ? t.clicks / t.impressions : null)}, search impression share ${formatUnit("percent", t.impressionShare)}${
      t.lostToBudget !== null && t.lostToRank !== null ? ` (lost ${formatPercent(t.lostToBudget, 0)} to budget, ${formatPercent(t.lostToRank, 0)} to rank)` : ""
    }.`,
    pacing.ok
      ? `${pacing.data.monthLabel.split(" ")[0]} so far: ${formatUsd(pacing.data.spent)} spent${pacing.data.budget.monthly ? ` of ${formatUsd(pacing.data.budget.monthly)}, heading for ${formatUsd(pacing.data.projectedByPace)}` : " (no monthly budget set)"}, ${leadsText(pacing.data.leads)}.`
      : null,
    waste.length ? `Most spend with no conversions: ${waste.slice(0, 3).map((w) => `"${w.term}" ${formatUsd(w.metrics.cost)}`).join(", ")}.` : "No search spent money without a conversion.",
    weekInvalid ? `Invalid clicks: ${formatNumber(weekInvalid)} of ${formatNumber(t.clicks + weekInvalid)} (${formatPercent(weekInvalidRate ?? 0, 0)}), filtered by Google and not charged.` : null,
    `Open alerts: ${open.length}${open[0] ? ` (most serious: ${open[0].title})` : ""}.`,
    `Weekly negatives: ${batch ? batchStatus[stageOf(batch)] : "not drafted yet"}${pushedThisWeek.length ? `; pushed this week: ${pushedThisWeek.map((b) => `week of ${shortDay(b.from)}`).join(", ")}` : ""}.`,
    changes?.ok ? `Changes in Google Ads: ${changes.data.length}.` : null,
  ]
    .filter(Boolean)
    .join("\n")

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <CopyButton text={summary} label="Copy summary" />
        <PrintButton />
        <span className="text-xs text-muted-foreground">The summary is plain text, ready for Slack or an email.</span>
      </div>

      <TrendKpis
        caption={`Changes compare with the week before (${formatDay(overview.previous.range.from)} – ${formatDay(overview.previous.range.to)}). Leads are Google lead conversions.`}
        items={[
          kpi("cost"),
          kpi("leads"),
          kpi("cpl"),
          kpi("clicks"),
          kpi("ctr"),
          kpi("is", t.lostToBudget !== null && t.lostToRank !== null ? `lost ${formatPercent(t.lostToBudget, 0)} budget, ${formatPercent(t.lostToRank, 0)} rank` : undefined),
        ]}
      />

      <Section title="Summary" description="What the copy button puts on the clipboard.">
        <pre className="whitespace-pre-wrap rounded-xl bg-muted/40 p-3 font-sans text-sm leading-relaxed">{summary}</pre>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="This month so far" description="As of today, whatever week is shown.">
          {pacing.ok ? (
            <p className="text-sm">
              <span className="font-medium">{formatUsd(pacing.data.spent)}</span> spent in {pacing.data.monthLabel}
              {pacing.data.budget.monthly ? (
                <>
                  {" "}
                  of {formatUsd(pacing.data.budget.monthly)}; at the recent pace the month ends near {formatUsd(pacing.data.projectedByPace)}.
                </>
              ) : (
                ". No monthly budget is set yet."
              )}{" "}
              {leadsText(pacing.data.leads)}.{" "}
              <Link href="/budget" className="font-medium text-primary hover:underline print:hidden">
                Budget & pacing
              </Link>
            </p>
          ) : (
            <ReportProblem problem={pacing} />
          )}
        </Section>

        <Section title="Weekly negatives" description="This week's batch of negative keywords.">
          {batch ? (
            <p className="text-sm">
              <span className="font-medium">{batchStatus[stageOf(batch)]}.</span> {batch.items.length} line{batch.items.length === 1 ? "" : "s"}
              {batch.items.length ? ` for searches that cost ${formatUsd(batch.items.reduce((s, i) => s + i.cost, 0))}` : ""}.{" "}
              <Link href="/negatives" className="font-medium text-primary hover:underline print:hidden">
                Weekly negatives
              </Link>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not drafted yet.{" "}
              <Link href="/negatives" className="font-medium text-primary hover:underline print:hidden">
                Draft it
              </Link>
            </p>
          )}
          {pushedThisWeek.map((b: NegativeBatch) => (
            <p key={b.id} className="text-xs text-muted-foreground">
              Pushed this week: the batch for the week of {shortDay(b.from)} ({b.pushed!.added} added by {b.pushed!.by}
              {b.pushed!.dryRun ? ", dry run" : ""}).
            </p>
          ))}
        </Section>
      </div>

      <Section title="Campaigns" description="Campaigns with impressions this week, most spend first.">
        {!campaigns.ok ? (
          <ReportProblem problem={campaigns} />
        ) : (
          <DataTable<CampaignRow>
            rows={campaigns.data}
            rowKey={(c) => c.id}
            empty="No campaign showed ads this week."
            columns={[
              { key: "name", label: "Campaign", render: (c) => <span className="font-medium">{c.name}</span> },
              { key: "status", label: "Status now", render: (c) => <StatusPill status={c.status} /> },
              { key: "cost", label: "Spend", align: "right", render: (c) => formatUsd(c.metrics.cost) },
              { key: "clicks", label: "Clicks", align: "right", render: (c) => formatNumber(c.metrics.clicks) },
              { key: "conv", label: "Conversions", align: "right", render: (c) => formatConversions(c.metrics.conversions) },
              {
                key: "cpa",
                label: "Cost / conv.",
                align: "right",
                render: (c) => {
                  const cpa = rates(c.metrics).costPerConversion
                  return cpa === null ? <span className="text-muted-foreground">—</span> : formatUsd(cpa)
                },
              },
            ]}
          />
        )}
      </Section>

      <Section
        title="Searches that cost money without a conversion"
        description={waste.length ? `The ${waste.length} costliest: ${formatUsd(wasteCost)} together. Candidates for this week's negatives.` : undefined}
      >
        {!terms.ok ? (
          <ReportProblem problem={terms} />
        ) : (
          <DataTable<SearchTermRow>
            rows={waste}
            rowKey={(s) => s.term}
            empty="No search spent money without a conversion this week."
            columns={[
              { key: "term", label: "Search", render: (s) => <span className="font-medium">{s.term}</span> },
              { key: "campaign", label: "Campaign", render: (s) => <span className="text-muted-foreground">{s.campaigns.join(", ")}</span> },
              { key: "clicks", label: "Clicks", align: "right", render: (s) => formatNumber(s.metrics.clicks) },
              { key: "cost", label: "Spend", align: "right", render: (s) => formatUsd(s.metrics.cost) },
              { key: "rule", label: "Suggested negative", render: (s) => (s.suggestion ? <Pill tone="amber">{s.suggestion}</Pill> : <span className="text-muted-foreground">—</span>) },
            ]}
          />
        )}
      </Section>

      <Section
        id="invalid-clicks"
        title="Invalid clicks"
        description="Clicks Google filtered as accidental or fraudulent (bots, repeat clicks). They aren't charged, but a high share can mean someone is clicking the ads on purpose. Last 6 months."
      >
        {!invalid.ok ? (
          <ReportProblem problem={invalid} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <DataTable<InvalidRow>
              rows={invalid.data.months}
              rowKey={(r) => r.key}
              empty="No clicks in the last 6 months."
              columns={[
                { key: "m", label: "Month", render: (r) => <span className="font-medium">{r.label}</span> },
                { key: "c", label: "Valid clicks", align: "right", render: (r) => formatNumber(r.clicks) },
                { key: "i", label: "Invalid", align: "right", render: (r) => formatNumber(r.invalid) },
                { key: "r", label: "Invalid share", align: "right", render: (r) => <Rate rate={r.rate} /> },
              ]}
            />
            <DataTable<InvalidRow>
              rows={invalid.data.campaigns.slice(0, 10)}
              rowKey={(r) => r.key}
              empty="No invalid clicks in the last 6 months."
              columns={[
                { key: "n", label: "Campaign (most invalid clicks)", render: (r) => <span className="font-medium">{r.label}</span> },
                { key: "c", label: "Valid", align: "right", render: (r) => formatNumber(r.clicks) },
                { key: "i", label: "Invalid", align: "right", render: (r) => formatNumber(r.invalid) },
                { key: "r", label: "Share", align: "right", render: (r) => <Rate rate={r.rate} /> },
              ]}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          This week: {formatNumber(weekInvalid)} invalid of {formatNumber(t.clicks + weekInvalid)} clicks
          {weekInvalidRate !== null ? ` (${formatPercent(weekInvalidRate, 0)})` : ""}. Above 25% is unusual; an alert fires when the last 30 days pass the
          limit set on the Alerts page.
        </p>
      </Section>

      <Section title="Alerts" description={`${open.length} open now; ${weekAlerts.length} started or cleared during the week.`}>
        <AlertList records={[...new Map([...open, ...weekAlerts].map((r) => [`${r.key}|${r.firstSeen}`, r])).values()].sort(bySeverity)} range={range} />
      </Section>

      <Section title="Changes in Google Ads" description="Everything changed in the account this week, by anyone. Google keeps 30 days of history.">
        {!changes ? (
          <p className="text-sm text-muted-foreground">This week is more than 30 days ago, so Google no longer has its change history.</p>
        ) : !changes.ok ? (
          <ReportProblem problem={changes} />
        ) : (
          <DataTable<ChangeEvent>
            rows={changes.data.slice(0, 50)}
            rowKey={(c) => c.id}
            empty="Nothing was changed this week."
            columns={[
              { key: "at", label: "When", render: (c) => <span className="whitespace-nowrap">{c.at.slice(0, 16)}</span> },
              { key: "who", label: "Who", render: (c) => <span className="text-muted-foreground">{c.user || enumLabel(c.client)}</span> },
              { key: "what", label: "What", render: (c) => `${enumLabel(c.operation)} ${enumLabel(c.resourceType).toLowerCase()}` },
              { key: "campaign", label: "Campaign", render: (c) => <span className="text-muted-foreground">{c.campaign || "—"}</span> },
              { key: "detail", label: "Detail", className: "min-w-48", render: (c) => <span className="text-xs">{c.detail || "—"}</span> },
            ]}
          />
        )}
      </Section>
    </>
  )
}

function Rate({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-muted-foreground">—</span>
  return <span className={cn(rate > 0.25 && "font-medium text-destructive")}>{formatPercent(rate, 0)}</span>
}

const severityTone = { critical: "red", high: "red", medium: "amber", info: "gray" } as const

function AlertList({ records, range }: { records: AlertRecord[]; range: DateRange }) {
  if (!records.length) return <p className="text-sm text-muted-foreground">No alerts.</p>
  return (
    <ul className="flex flex-col divide-y">
      {records.map((r) => (
        <li key={`${r.key}|${r.firstSeen}`} className="flex items-start gap-3 py-2 text-sm">
          <Pill tone={severityTone[r.severity]}>{enumLabel(r.severity.toUpperCase())}</Pill>
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{r.title}</span>
            <span className="text-xs text-muted-foreground">
              {r.resolvedAt ? `Cleared ${formatDay(dayOf(r.resolvedAt))}` : "Still open"} · first seen {formatDay(dayOf(r.firstSeen))}
              {dayOf(r.firstSeen) < range.from ? " (before this week)" : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}
