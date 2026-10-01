import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

import CompareChart from "@/components/dashboard/compare-chart"
import { formatConversions, formatDate, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import TrendKpis from "@/components/dashboard/trend-kpis"
import MetricPicker from "@/components/metric-picker"
import RefreshButton from "@/components/refresh-button"
import { DataTable, PageHeader, Pill, ReportProblem, Section, StatusPill } from "@/components/report"
import { bySeverity, checkAlerts, googleAdsRules } from "@/lib/alert-rules"
import { getPacing, type Pacing } from "@/lib/budget"
import { formatDay, parseRange, rangeQuery } from "@/lib/date-range"
import { daysIn, getOverview, type Bucket, type Grain } from "@/lib/google-ads/overview"
import {
  getAccount,
  getCampaigns,
  getLocations,
  getSearchTerms,
  isWaste,
  rates,
  type CampaignRow,
} from "@/lib/google-ads/reports"
import { lastFetchedAt } from "@/lib/google-ads/client"
import { load, type Loaded } from "@/lib/load"
import { OVERVIEW_METRICS, delta, formatUnit, metricById, type MetricDef } from "@/lib/overview-metrics"
import { completeWeeks, stageOf } from "@/lib/negative-batches"
import { readData, type AlertRecord, type NegativeBatch } from "@/lib/store"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Overview · DealTrack" }

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function bucketLabel(start: string, grain: Grain) {
  if (grain === "day") return formatDate(start)
  if (grain === "week") return `Week of ${formatDate(start)}`
  return new Date(`${start}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const range = parseRange(params)
  const q = rangeQuery(range)
  const m1 = metricById(first(params.m1)) ?? metricById("cost")!
  const m2 = first(params.m2) === "none" ? null : (metricById(first(params.m2)) ?? (m1.id === "leads" ? metricById("cost")! : metricById("leads")!))
  // Everything at once; identical Google Ads queries from different parts share one request.
  const savedData = load(() => readData())
  const [result, saved, pacing, alerts] = await Promise.all([
    load(async () => {
      const [account, overview, campaigns, terms, locations] = await Promise.all([
        getAccount(),
        getOverview(range),
        getCampaigns(range),
        getSearchTerms(range),
        getLocations(range),
      ])
      return { account, overview, campaigns, terms, locations }
    }),
    savedData,
    savedData.then((s) => (s.ok ? load(() => getPacing(s.data.budget)) : s)),
    savedData.then((s) => (s.ok ? load(() => checkAlerts(googleAdsRules(s.data))) : s)),
  ])

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Overview" description="Spend, leads, and what needs attention." range={range} />
        <ReportProblem problem={result} />
      </>
    )
  }

  const { account, overview, campaigns, terms, locations } = result.data
  const fetchedAt = lastFetchedAt()
  const totals = overview.totals
  const before = overview.previous.totals
  const series = (m: MetricDef) => overview.buckets.map((b: Bucket) => m.value(b))
  const kpi = (id: string, note?: string) => {
    const m = metricById(id)!
    return { label: m.label, value: formatUnit(m.unit, m.value(totals)), delta: delta(m, m.value(totals), m.value(before)), note, spark: series(m) }
  }
  const prev = overview.previous.range

  const wastedTerms = terms.filter((t) => isWaste(t.metrics))
  const wastedTermCost = wastedTerms.reduce((s, t) => s + t.metrics.cost, 0)
  const suggested = new Set(terms.filter((t) => t.suggestion && t.status === "NONE").map((t) => t.suggestion))
  const outside = locations.filter((l) => l.status === "outside")
  const outsideCost = outside.reduce((s, l) => s + l.metrics.cost, 0)
  const deadCampaigns = campaigns.filter((c) => isWaste(c.metrics))

  const attention = [
    {
      href: `/search-terms${q}`,
      title: `${formatUsd(wastedTermCost)} on ${formatNumber(wastedTerms.length)} search terms with no conversions`,
      detail: `${formatPercent(totals.cost ? wastedTermCost / totals.cost : 0, 0)} of all spend. ${suggested.size} negative keywords suggested.`,
      show: wastedTermCost > 0,
    },
    {
      href: `/locations${q}`,
      title: `${formatUsd(outsideCost)} spent outside the buy area (${formatPercent(totals.cost ? outsideCost / totals.cost : 0, 0)} of spend)`,
      detail: outside.length
        ? `Top: ${outside.slice(0, 3).map((l) => l.city).join(", ")}.`
        : "",
      show: outsideCost > 0,
    },
    {
      href: `/campaigns${q}`,
      title: `${deadCampaigns.length} campaign${deadCampaigns.length === 1 ? "" : "s"} spent money with no conversions`,
      detail: deadCampaigns.length
        ? `${formatUsd(deadCampaigns.reduce((s, c) => s + c.metrics.cost, 0))} in total.`
        : "",
      show: deadCampaigns.length > 0,
    },
  ].filter((a) => a.show)

  return (
    <>
      <PageHeader
        title={account.name}
        description={`Google Ads account ${account.id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}. Read-only: nothing here changes your ads.`}
        range={range}
      />

      <p className="-mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
        <span>
          <span className="font-medium text-emerald-700">Connected to Google Ads.</span>{" "}
          {fetchedAt
            ? `Data fetched at ${new Date(fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })} Pacific. Older than 10 minutes, it's updated in the background.`
            : "Live data."}
        </span>
        <RefreshButton />
      </p>

      <StatusCards pacing={pacing} alerts={alerts} batches={saved.ok ? saved.data.batches : null} />

      <TrendKpis
        caption={`Changes compare with the ${formatNumber(daysIn(range))} days before (${formatDay(prev.from)} – ${formatDay(prev.to)}). Leads are Google lead conversions: forms, calls, and lead stages.`}
        items={[
          kpi("cost"),
          kpi("leads", totals.conversions > totals.leads ? `${formatConversions(totals.conversions)} incl. soft` : undefined),
          kpi("cpl"),
          kpi("clicks", totals.clicks ? `${formatUsdCents(totals.cost / totals.clicks)} each` : undefined),
          kpi("ctr", `${formatNumber(totals.impressions)} impr.`),
          kpi(
            "is",
            totals.lostToBudget !== null && totals.lostToRank !== null
              ? `lost ${formatPercent(totals.lostToBudget, 0)} budget, ${formatPercent(totals.lostToRank, 0)} rank`
              : undefined,
          ),
        ]}
      />

      {attention.length > 0 && (
        <Section title="Needs attention" description="Money that didn't bring in leads during this period.">
          <ul className="flex flex-col divide-y">
            {attention.map((a) => (
              <li key={a.href}>
                <Link href={a.href} className="group flex items-center justify-between gap-4 py-3">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{a.title}</span>
                    {a.detail && <span className="text-sm text-muted-foreground">{a.detail}</span>}
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Compare two metrics"
        description={`By ${overview.grain} over the date range, each on its own scale: ${m1.label.toLowerCase()} on the left${m2 ? `, ${m2.label.toLowerCase()} (dashed) on the right` : ""}.`}
        actions={<MetricPicker options={OVERVIEW_METRICS.map((m) => ({ id: m.id, label: m.label }))} m1={m1.id} m2={m2?.id ?? "none"} />}
      >
        <CompareChart
          labels={overview.buckets.map((b) => bucketLabel(b.start, overview.grain))}
          series={[m1, ...(m2 ? [m2] : [])].map((m) => ({ label: m.label, unit: m.unit, values: series(m) }))}
        />
      </Section>

      <Section
        title="Campaigns"
        description="Campaigns with impressions in this period, highest spend first."
        actions={
          <Link href={`/campaigns${q}`} className="text-sm font-medium text-primary hover:underline">
            All campaigns
          </Link>
        }
      >
        <DataTable<CampaignRow>
          rows={campaigns.slice(0, 8)}
          rowKey={(c) => c.id}
          columns={[
            { key: "name", label: "Campaign", render: (c) => <span className="font-medium">{c.name}</span> },
            { key: "status", label: "Status", render: (c) => <StatusPill status={c.status} /> },
            { key: "cost", label: "Spend", align: "right", render: (c) => formatUsd(c.metrics.cost) },
            { key: "clicks", label: "Clicks", align: "right", render: (c) => formatNumber(c.metrics.clicks) },
            { key: "conv", label: "Conversions", align: "right", render: (c) => formatConversions(c.metrics.conversions) },
            {
              key: "cpa",
              label: "Cost / conv.",
              align: "right",
              render: (c) => {
                const cpa = rates(c.metrics).costPerConversion
                return cpa === null ? <span className="text-destructive">None</span> : formatUsd(cpa)
              },
            },
          ]}
        />
      </Section>
    </>
  )
}

const paceTone = { "no-budget": "gray", under: "amber", on: "green", over: "red" } as const
const paceLabel = { "no-budget": "No budget set", under: "Under pace", on: "On pace", over: "Over pace" } as const

type Card = { href: string; title: string; value: string; note: string; pill?: { tone: "green" | "amber" | "red" | "gray" | "violet"; label: string } }

// Where things stand right now, whatever the date range: open alerts, this month's pacing, and
// the go-live grade.
function StatusCards({
  pacing,
  alerts,
  batches,
}: {
  pacing: Loaded<Pacing>
  alerts: Loaded<{ log: AlertRecord[] }>
  batches: NegativeBatch[] | null
}) {
  const cards: Card[] = []
  if (alerts.ok) {
    const open = alerts.data.log.filter((r) => !r.resolvedAt).sort(bySeverity)
    const top = open[0]
    cards.push({
      href: "/alerts",
      title: "Alerts",
      value: open.length ? `${open.length} open` : "All clear",
      note: top ? top.title : "Nothing needs attention right now",
      pill: top ? { tone: top.severity === "medium" ? "amber" : top.severity === "info" ? "gray" : "red", label: top.severity === "critical" ? "Critical" : top.severity === "high" ? "High" : top.severity === "medium" ? "Medium" : "Info" } : { tone: "green", label: "OK" },
    })
  } else {
    cards.push({ href: "/alerts", title: "Alerts", value: "Couldn't check", note: alerts.kind === "missing" ? "Keys missing" : alerts.message })
  }
  if (pacing.ok) {
    const p = pacing.data
    cards.push({
      href: "/budget",
      title: "Budget & pacing",
      value: `${formatUsd(p.spent)} in ${p.monthLabel.split(" ")[0]}`,
      note: p.budget.monthly
        ? `of ${formatUsd(p.budget.monthly)}; month ends near ${formatUsd(p.projectedByPace)} at the recent pace`
        : "No monthly budget set yet",
      pill: { tone: paceTone[p.status], label: paceLabel[p.status] },
    })
  } else {
    cards.push({ href: "/budget", title: "Budget & pacing", value: "Couldn't load", note: pacing.kind === "missing" ? "Keys missing" : pacing.message })
  }
  if (batches) {
    const lastWeek = completeWeeks(1)[0]
    const current = batches.find((b) => b.id === lastWeek.id)
    const open = batches.filter((b) => ["proving", "approving", "ready"].includes(stageOf(b)))
    const next = open[0] ?? current
    const stage = next ? stageOf(next) : null
    const text = {
      empty: "Nothing to add last week",
      proving: "Waiting for review",
      approving: "Waiting for approval",
      ready: "Ready to push",
      "nothing-approved": "Nothing approved",
      pushed: "Pushed",
      checked: "Result checked",
    } as const
    cards.push({
      href: "/negatives",
      title: "Weekly negatives",
      value: !current && !open.length ? "Draft last week's batch" : stage ? text[stage] : "Up to date",
      note: next ? `${formatDate(next.from)} – ${formatDate(next.to)}${next.campaignName ? ` (${next.campaignName})` : ""}: ${next.items.length} line${next.items.length === 1 ? "" : "s"}` : `Search terms from ${formatDate(lastWeek.from)} – ${formatDate(lastWeek.to)}`,
      pill: stage === "ready" ? { tone: "amber", label: "Action" } : stage === "proving" || stage === "approving" ? { tone: "violet", label: "In review" } : undefined,
    })
  }
  cards.push({ href: "/audit", title: "Go-live audit", value: "Grade the account", note: "Tracking, targeting, keywords, ads, pages, and budget, A to F" })

  return (
    <section aria-label="Status" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <Link key={c.href} href={c.href} className="group flex flex-col gap-1 rounded-2xl border bg-card p-4 shadow-xs hover:border-primary/40">
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            {c.title}
            {c.pill ? <Pill tone={c.pill.tone}>{c.pill.label}</Pill> : <ArrowRight className="size-3.5 group-hover:text-foreground" aria-hidden />}
          </span>
          <span className={cn("text-lg font-semibold tracking-tight tabular-nums")}>{c.value}</span>
          <span className="text-xs text-muted-foreground">{c.note}</span>
        </Link>
      ))}
    </section>
  )
}
