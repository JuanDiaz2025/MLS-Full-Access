import type { Metadata } from "next"
import Link from "next/link"
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, CircleCheck } from "lucide-react"

import CompareChart from "@/components/dashboard/compare-chart"
import { formatConversions, formatDate, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import TrendKpis from "@/components/dashboard/trend-kpis"
import MetricPicker from "@/components/metric-picker"
import RefreshButton from "@/components/refresh-button"
import { DataTable, PageHeader, Pill, ReportProblem, Section, StatusPill } from "@/components/report"
import { bySeverity, checkAlerts, googleAdsRules } from "@/lib/alert-rules"
import { getPacing, type Pacing } from "@/lib/budget"
import { isOpen } from "@/lib/compliance-rules"
import { formatDay, parseRange, rangeQuery, today, type DateRange } from "@/lib/date-range"
import { getCalls, type Call } from "@/lib/google-ads/calls"
import { daysIn, getOverview, type Bucket, type Grain } from "@/lib/google-ads/overview"
import { getAccount, getCampaigns, getLocations, getSearchTerms, isWaste, rates, type CampaignRow } from "@/lib/google-ads/reports"
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
  const [result, saved, pacing, alerts, calls] = await Promise.all([
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
  const todos = doToday({
    q,
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
  const grade = gradeOf(todos)
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

      <AtAGlance grade={grade} totals={totals} before={before} range={range} />

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

// ---- At a glance ----------------------------------------------------------------------------

type Todo = { key: string; severity: "critical" | "high" | "medium" | "low"; title: string; detail: string; href: string; cost: number }

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const

// Everything worth doing, worst first: broken tracking, open alerts, money spent on searches,
// places, and campaigns that brought nothing back, missed calls, and changes waiting for approval.
function doToday(input: {
  q: string
  totalsCost: number
  leads: number
  attention: {
    wastedTermCost: number
    wastedTerms: number
    suggested: number
    outsideCost: number
    outsideTop: string[]
    deadCampaigns: CampaignRow[]
  }
  alerts: AlertRecord[]
  missedCalls: number
  waitingRequests: number
}): Todo[] {
  const { q, totalsCost, leads, attention: a } = input
  const share = (n: number) => (totalsCost ? n / totalsCost : 0)
  const out: Todo[] = []
  if (totalsCost >= 200 && leads === 0) {
    out.push({
      key: "no-leads",
      severity: "critical",
      title: `${formatUsd(totalsCost)} spent and Google recorded no leads`,
      detail: "Either the ads aren't bringing sellers or conversion tracking is broken. Check tracking first.",
      href: "/conversions",
      cost: totalsCost,
    })
  }
  for (const r of input.alerts.filter((r) => r.severity !== "info")) {
    out.push({
      key: `alert:${r.key}`,
      severity: r.severity === "info" ? "low" : r.severity,
      title: r.title,
      detail: r.detail,
      href: r.href ?? "/alerts",
      cost: 0,
    })
  }
  if (a.wastedTermCost > 0) {
    out.push({
      key: "wasted-terms",
      severity: share(a.wastedTermCost) >= 0.2 ? "high" : "medium",
      title: `Block wasted searches: ${formatUsd(a.wastedTermCost)} on ${formatNumber(a.wastedTerms)} search terms with no leads`,
      detail: `${formatPercent(share(a.wastedTermCost), 0)} of spend.${a.suggested ? ` ${a.suggested} negative keyword${a.suggested === 1 ? "" : "s"} suggested.` : ""}`,
      href: `/search-terms${q}`,
      cost: a.wastedTermCost,
    })
  }
  if (a.outsideCost > 0) {
    out.push({
      key: "outside",
      severity: share(a.outsideCost) >= 0.1 ? "high" : "medium",
      title: `Stop spend outside California: ${formatUsd(a.outsideCost)} (${formatPercent(share(a.outsideCost), 0)} of spend)`,
      detail: a.outsideTop.length ? `Top: ${a.outsideTop.join(", ")}.` : "",
      href: `/locations${q}`,
      cost: a.outsideCost,
    })
  }
  if (a.deadCampaigns.length) {
    const cost = a.deadCampaigns.reduce((s, c) => s + c.metrics.cost, 0)
    out.push({
      key: "dead-campaigns",
      severity: share(cost) >= 0.25 ? "high" : "medium",
      title: `${a.deadCampaigns.length} campaign${a.deadCampaigns.length === 1 ? "" : "s"} spent ${formatUsd(cost)} with no leads`,
      detail: a.deadCampaigns
        .slice(0, 3)
        .map((c) => c.name)
        .join(", "),
      href: `/campaigns${q}`,
      cost,
    })
  }
  if (input.missedCalls) {
    out.push({
      key: "missed-calls",
      severity: input.missedCalls >= 3 ? "high" : "medium",
      title: `Call back ${input.missedCalls} missed call${input.missedCalls === 1 ? "" : "s"} from the ads`,
      detail: "Each one may be a seller who didn't get through.",
      href: "/leads#calls",
      cost: 0,
    })
  }
  if (input.waitingRequests) {
    out.push({
      key: "compliance",
      severity: "low",
      title: `${input.waitingRequests} change${input.waitingRequests === 1 ? "" : "s"} waiting for a check or approval`,
      detail: "Turning ads on or off, or changes held while Google is learning.",
      href: "/compliance",
      cost: 0,
    })
  }
  // The same problem can come in as an alert and from this period's numbers; keep one.
  const seen = new Set<string>()
  return out
    .filter((t) => {
      const k = t.title.toLowerCase().slice(0, 40)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || y.cost - x.cost)
}

// A grade for the account, like One Marketing Command Center's: every problem costs points,
// more for worse ones.
function gradeOf(todos: Todo[]) {
  const cost = { critical: 25, high: 15, medium: 5, low: 0 } as const
  const score = Math.max(0, 100 - todos.reduce((s, t) => s + cost[t.severity], 0))
  const letter = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F"
  const words = { A: "Healthy", B: "Mostly fine", C: "Needs work", D: "Losing money", F: "Urgent fixes needed" }[letter]
  const tone = letter === "A" || letter === "B" ? "good" : letter === "C" ? "warn" : "bad"
  return { score, letter, words, tone }
}

type Totals = { cost: number; leads: number; clicks: number }
const change = (now: number, before: number) => (before ? (now - before) / before : null)

function AtAGlance({ grade, totals, before, range }: { grade: ReturnType<typeof gradeOf>; totals: Totals; before: Totals; range: DateRange }) {
  const period = range.preset ? range.label.toLowerCase().replace(/^last/, "in the last") : `from ${formatDay(range.from)} to ${formatDay(range.to)}`
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  const cpl = totals.leads ? totals.cost / totals.leads : null
  const beforeCpl = before.leads ? before.cost / before.leads : null
  const story = !totals.cost
    ? `Your ads didn't spend anything ${period}.`
    : totals.leads
      ? `${cap(period)} you spent ${formatUsd(totals.cost)} and got ${formatConversions(totals.leads)} lead${totals.leads === 1 ? "" : "s"} from Google Ads, at ${formatUsd(cpl!)} each.`
      : `${cap(period)} you spent ${formatUsd(totals.cost)} but Google Ads recorded no leads.`
  const leadsChange = change(totals.leads, before.leads)
  const cplChange = cpl !== null && beforeCpl ? (cpl - beforeCpl) / beforeCpl : null
  const trend =
    leadsChange === null || !totals.leads
      ? null
      : Math.abs(leadsChange) < 0.02
        ? { text: "About the same number of leads as the period before.", good: null }
        : {
            text: `${formatPercent(Math.abs(leadsChange), 0)} ${leadsChange > 0 ? "more" : "fewer"} leads than the period before${
              cplChange !== null && Math.abs(cplChange) >= 0.02
                ? `, each ${formatPercent(Math.abs(cplChange), 0)} ${cplChange < 0 ? "cheaper" : "dearer"}`
                : ""
            }.`,
            good: leadsChange > 0,
          }
  const Icon = trend?.good === null || !trend ? ArrowRight : trend.good ? ArrowUp : ArrowDown
  return (
    <section aria-label="At a glance" className="flex items-center gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <div
        className={cn(
          "flex size-20 shrink-0 flex-col items-center justify-center rounded-2xl border-2",
          grade.tone === "good" && "border-emerald-300 bg-emerald-50 text-emerald-800",
          grade.tone === "warn" && "border-amber-300 bg-amber-50 text-amber-800",
          grade.tone === "bad" && "border-red-300 bg-red-50 text-red-800",
        )}
        title={`${grade.score} out of 100`}
      >
        <span className="text-4xl leading-none font-bold">{grade.letter}</span>
        <span className="mt-1 text-[10px] font-semibold tracking-wide uppercase">Grade</span>
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          Your ads at a glance:{" "}
          <span className={cn(grade.tone === "good" ? "text-emerald-700" : grade.tone === "warn" ? "text-amber-700" : "text-destructive")}>
            {grade.words}
          </span>
        </h2>
        <p className="text-sm">{story}</p>
        {trend && (
          <p
            className={cn(
              "flex items-center gap-1 text-sm font-medium",
              trend.good === null ? "text-muted-foreground" : trend.good ? "text-emerald-700" : "text-destructive",
            )}
          >
            <Icon className="size-4" aria-hidden /> {trend.text}
          </p>
        )}
      </div>
    </section>
  )
}

const TODO_SHOWN = 3

function TodoList({ todos, start }: { todos: Todo[]; start: number }) {
  return (
    <ol className="flex flex-col divide-y">
      {todos.map((t, i) => (
        <li key={t.key}>
          <Link href={t.href} className="group flex items-start gap-3 py-3">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white",
                t.severity === "critical" || t.severity === "high" ? "bg-red-500" : t.severity === "medium" ? "bg-amber-500" : "bg-slate-400",
              )}
            >
              {start + i + 1}
            </span>
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="font-medium">{t.title}</span>
              {t.detail && <span className="text-sm text-muted-foreground">{t.detail}</span>}
            </span>
            <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ol>
  )
}

function DoToday({ todos }: { todos: Todo[] }) {
  const rest = todos.slice(TODO_SHOWN)
  return (
    <Section title="Do these today" description={todos.length ? "The worst first. Each one opens the page that fixes it." : undefined}>
      {todos.length ? (
        <TodoList todos={todos.slice(0, TODO_SHOWN)} start={0} />
      ) : (
        <p className="flex items-center gap-2 py-1 text-sm text-emerald-700">
          <CircleCheck className="size-4" aria-hidden /> Nothing to fix right now.
        </p>
      )}
      {rest.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-sm font-medium text-primary hover:underline">
            <span className="group-open:hidden">Show {rest.length} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <TodoList todos={rest} start={TODO_SHOWN} />
        </details>
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
  const card = (tone: "good" | "bad", title: string, name: string, line: string) => (
    <Link
      href={`/campaigns${q}`}
      className={cn(
        "flex flex-col gap-1 rounded-2xl border p-4 shadow-xs hover:border-primary/40",
        tone === "good" ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50/60",
      )}
    >
      <span className={cn("text-xs font-medium", tone === "good" ? "text-emerald-800" : "text-red-800")}>{title}</span>
      <span className="font-semibold">{name}</span>
      <span className="text-sm text-muted-foreground">{line}</span>
    </Link>
  )
  return (
    <section aria-label="Best and worst campaign" className="grid gap-3 sm:grid-cols-2">
      {best &&
        card(
          "good",
          "Cheapest leads",
          best.name,
          `${formatConversions(best.metrics.conversions)} lead${best.metrics.conversions === 1 ? "" : "s"} at ${formatUsd(best.metrics.cost / best.metrics.conversions)} each (${formatUsd(best.metrics.cost)} spent).`,
        )}
      {leak && card("bad", "Biggest leak", leak.name, `${formatUsd(leak.metrics.cost)} spent and no leads.`)}
    </section>
  )
}

const WORDS: [string, string][] = [
  ["Spend", "What Google charged for clicks in the period."],
  [
    "Leads",
    "Form fills, calls and lead stages Google counted as conversions. Soft conversions (page views, clicks to call that didn't connect) are left out.",
  ],
  ["Cost per lead (CPL)", "Spend divided by leads: what one seller lead cost. Lower is better."],
  ["Clicks", "People who clicked an ad. Google already takes out the clicks it decides are invalid."],
  ["Click-through rate (CTR)", "Clicks divided by impressions: how often people who saw an ad clicked it."],
  ["Impressions", "How many times the ads were shown."],
  [
    "Search impression share",
    "Of all the times the ads could have shown, how often they did. Lost to budget means the money ran out; lost to rank means bids or ad quality were too low.",
  ],
  ["Conversion", "Something Google counts as a result: a form sent, a call, or a lead stage sent back from the CRM."],
  ["Negative keyword", 'A word or phrase that stops ads showing for searches that contain it, e.g. "rent" or "jobs".'],
  ["Search term", "What someone actually typed into Google before seeing the ad."],
  ["Quality Score", "Google's 1–10 rating of a keyword's ad and landing page. Higher means cheaper clicks."],
  ["Learning period", "The week or two after a big change while Google's bidding adjusts. Results swing, so changes are held then."],
]

function Glossary() {
  return (
    <details className="group rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
        What do these words mean?
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {WORDS.map(([word, meaning]) => (
          <div key={word}>
            <dt className="font-medium">{word}</dt>
            <dd className="text-muted-foreground">{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
