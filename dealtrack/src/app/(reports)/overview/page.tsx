import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { saveGradeSettings } from "@/app/actions/settings"
import CompareChart from "@/components/dashboard/compare-chart"
import { formatConversions, formatDate, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import { AtAGlance, DoToday, Glossary, doToday, gradeOf } from "@/components/dashboard/glance"
import TrendKpis from "@/components/dashboard/trend-kpis"
import MetricPicker from "@/components/metric-picker"
import RefreshButton from "@/components/refresh-button"
import { AdminLink, DataTable, PageHeader, Pill, ReportProblem, Section, StatusPill } from "@/components/report"
import SettingsForm from "@/components/settings-form"
import { bySeverity, checkAlerts, googleAdsRules } from "@/lib/alert-rules"
import { isAdmin } from "@/lib/auth"
import { getPacing, type Pacing } from "@/lib/budget"
import { isOpen } from "@/lib/compliance-rules"
import { formatDay, parseRange, rangeQuery, today } from "@/lib/date-range"
import { getCalls, type Call } from "@/lib/google-ads/calls"
import { daysIn, getOverview, type Bucket, type Grain } from "@/lib/google-ads/overview"
import { getAccount, getCampaigns, getLocations, getSearchTerms, isWaste, rates, type CampaignRow } from "@/lib/google-ads/reports"
import { lastFetchedAt } from "@/lib/google-ads/client"
import { load, type Loaded } from "@/lib/load"
import { OVERVIEW_METRICS, delta, formatUnit, metricById, type MetricDef } from "@/lib/overview-metrics"
import { completeWeeks, stageOf } from "@/lib/negative-batches"
import { currentName } from "@/lib/people"
import { DEFAULT_GRADE, readData, type AlertRecord, type GradeSettings, type NegativeBatch } from "@/lib/store"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Overview · DealTrack" }

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function bucketLabel(start: string, grain: Grain) {
  if (grain === "day") return formatDate(start)
  if (grain === "week") return `Week of ${formatDate(start)}`
  return new Date(`${start}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const range = parseRange(params)
  const q = rangeQuery(range)
  const m1 = metricById(first(params.m1)) ?? metricById("cost")!
  const m2 = first(params.m2) === "none" ? null : (metricById(first(params.m2)) ?? (m1.id === "leads" ? metricById("cost")! : metricById("leads")!))
  // Everything at once; identical Google Ads queries from different parts share one request.
  const savedData = load(() => readData())
  // Calls Google counted in the period (it lists them by time, counted back from today).
  const callDays = Math.min(365, Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000))
  const [result, saved, pacing, alerts, calls, admin, personName] = await Promise.all([
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
    load(async () => (await getCalls(callDays)).filter((c) => c.start.slice(0, 10) >= range.from && c.start.slice(0, 10) <= range.to)),
    isAdmin(),
    currentName(),
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

  const openAlerts = alerts.ok ? alerts.data.log.filter((r) => !r.resolvedAt).sort(bySeverity) : []
  const waitingRequests = saved.ok ? saved.data.changeRequests.filter(isOpen) : []
  const callList: Call[] | null = calls.ok ? calls.data : null
  const missedCalls = callList ? callList.filter((c) => c.missed).length : 0
  const gradeSettings = saved.ok ? saved.data.grade : DEFAULT_GRADE
  const todos = doToday({
    q,
    grade: gradeSettings,
    totalsCost: totals.cost,
    leads: totals.leads,
    attention: {
      wastedTermCost,
      wastedTerms: wastedTerms.length,
      suggested: suggested.size,
      outsideCost,
      outsideTop: outside.slice(0, 3).map((l) => l.city),
      deadCampaigns,
    },
    alerts: openAlerts,
    missedCalls,
    waitingRequests: waitingRequests.length,
  })
  const grade = gradeOf(todos, gradeSettings)
  const callsTile = {
    label: "Calls from ads",
    value: callList ? formatNumber(callList.length) : "—",
    note: callList ? (missedCalls ? `${formatNumber(missedCalls)} missed` : "None missed") : "Couldn't load",
    spark: [] as (number | null)[],
  }

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

      <AtAGlance grade={grade} totals={totals} before={before} range={range} leadCost={gradeSettings.leadCost} />

      <DoToday todos={todos} />

      <TrendKpis
        cols="md:grid-cols-4 xl:grid-cols-7"
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
          callsTile,
        ]}
      />

      <BestWorst campaigns={campaigns} q={q} />

      <StatusCards pacing={pacing} alerts={alerts} batches={saved.ok ? saved.data.batches : null} />

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
        description="Campaigns with impressions in this period, highest spend first. Click one for everything about it."
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
            {
              key: "name",
              label: "Campaign",
              render: (c) => (
                <Link href={`/campaigns/${c.id}${q}`} className="font-medium text-primary hover:underline">
                  {c.name}
                </Link>
              ),
            },
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

      <GradeSettingsSection settings={gradeSettings} admin={admin} personName={personName} />

      <Glossary />
    </>
  )
}

const paceTone = { "no-budget": "gray", under: "amber", on: "green", over: "red" } as const
const paceLabel = { "no-budget": "No budget set", under: "Under pace", on: "On pace", over: "Over pace" } as const

type Card = {
  href: string
  title: string
  value: string
  note: string
  pill?: { tone: "green" | "amber" | "red" | "gray" | "violet"; label: string }
}

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
      pill: top
        ? {
            tone: top.severity === "medium" ? "amber" : top.severity === "info" ? "gray" : "red",
            label: top.severity === "critical" ? "Critical" : top.severity === "high" ? "High" : top.severity === "medium" ? "Medium" : "Info",
          }
        : { tone: "green", label: "OK" },
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
    cards.push({
      href: "/budget",
      title: "Budget & pacing",
      value: "Couldn't load",
      note: pacing.kind === "missing" ? "Keys missing" : pacing.message,
    })
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
      note: next
        ? `${formatDate(next.from)} – ${formatDate(next.to)}${next.campaignName ? ` (${next.campaignName})` : ""}: ${next.items.length} line${next.items.length === 1 ? "" : "s"}`
        : `Search terms from ${formatDate(lastWeek.from)} – ${formatDate(lastWeek.to)}`,
      pill:
        stage === "ready"
          ? { tone: "amber", label: "Action" }
          : stage === "proving" || stage === "approving"
            ? { tone: "violet", label: "In review" }
            : undefined,
    })
  }
  cards.push({
    href: "/audit",
    title: "Go-live audit",
    value: "Grade the account",
    note: "Tracking, targeting, keywords, ads, pages, and budget, A to F",
  })

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

const STRICTNESS_LABEL = {
  relaxed: "Relaxed: half the points off",
  normal: "Normal",
  strict: "Strict: half again more points off",
} as const

function GradeSettingsSection({ settings, admin, personName }: { settings: GradeSettings; admin: boolean; personName: string }) {
  return (
    <Section
      id="grade"
      title="How the grade works"
      description={
        <>
          Every item in “Do these today” takes points off 100: urgent 25, big 15, small 5, minor 0. A is 90+, B 75+, C 60+, D 40+, below that F. Spend
          with no leads only counts once it passes what a lead usually costs, so one expensive click doesn&apos;t sink the grade. Alerts have their
          own thresholds on the{" "}
          <Link href="/alerts" className="text-primary hover:underline">
            Alerts page
          </Link>
          .{settings.updatedBy && ` Last changed by ${settings.updatedBy}.`}
        </>
      }
    >
      {admin ? (
        <SettingsForm
          action={saveGradeSettings}
          personName={personName}
          fields={[
            {
              name: "leadCost",
              label: "What a lead usually costs",
              prefix: "$",
              value: String(settings.leadCost),
              hint: "In San Francisco this can be well over $1,000. Spend with no leads below this is “too early”, not a problem.",
            },
            {
              name: "strictness",
              label: "How strict",
              value: settings.strictness,
              options: (["relaxed", "normal", "strict"] as const).map((v) => ({ value: v, label: STRICTNESS_LABEL[v] })),
              hint: "How many points each problem takes off.",
            },
          ]}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          A lead is counted as costing about {formatUsd(settings.leadCost)}; strictness is {settings.strictness}. <AdminLink />
        </p>
      )}
    </Section>
  )
}

// The campaign bringing the cheapest leads, and the one losing the most money.
function BestWorst({ campaigns, q }: { campaigns: CampaignRow[]; q: string }) {
  const withLeads = campaigns.filter((c) => c.metrics.conversions >= 1)
  const best = withLeads.length
    ? withLeads.reduce((a, b) => (a.metrics.cost / a.metrics.conversions <= b.metrics.cost / b.metrics.conversions ? a : b))
    : null
  const leak = campaigns.filter((c) => c.metrics.cost > 0 && c.metrics.conversions < 0.5).sort((a, b) => b.metrics.cost - a.metrics.cost)[0]
  if (!best && !leak) return null
  const card = (tone: "good" | "bad", title: string, c: CampaignRow, line: string) => (
    <Link
      href={`/campaigns/${c.id}${q}`}
      className={cn(
        "flex flex-col gap-1 rounded-2xl border p-4 shadow-xs hover:border-primary/40",
        tone === "good" ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50/60",
      )}
    >
      <span className={cn("text-xs font-medium", tone === "good" ? "text-emerald-800" : "text-red-800")}>{title}</span>
      <span className="font-semibold">{c.name}</span>
      <span className="text-sm text-muted-foreground">{line}</span>
    </Link>
  )
  return (
    <section aria-label="Best and worst campaign" className="grid gap-3 sm:grid-cols-2">
      {best &&
        card(
          "good",
          "Cheapest leads",
          best,
          `${formatConversions(best.metrics.conversions)} lead${best.metrics.conversions === 1 ? "" : "s"} at ${formatUsd(best.metrics.cost / best.metrics.conversions)} each (${formatUsd(best.metrics.cost)} spent).`,
        )}
      {leak && card("bad", "Biggest leak", leak, `${formatUsd(leak.metrics.cost)} spent and no leads.`)}
    </section>
  )
}
