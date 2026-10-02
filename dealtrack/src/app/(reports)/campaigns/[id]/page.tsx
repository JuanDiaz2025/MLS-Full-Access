import { Suspense } from "react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, ExternalLink, Phone } from "lucide-react"

import AdFixer from "@/components/campaigns/ad-fixer"
import AdPreview, { shownText } from "@/components/campaigns/ad-preview"
import CampaignSwitcher from "@/components/campaigns/campaign-switcher"
import NegativeKeywordPanel from "@/components/changes/negative-keyword-panel"
import CompareChart from "@/components/dashboard/compare-chart"
import { formatConversions, formatDate, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import { AtAGlance, DoToday, doToday, gradeOf, type Todo } from "@/components/dashboard/glance"
import TrendKpis from "@/components/dashboard/trend-kpis"
import MetricPicker from "@/components/metric-picker"
import { AdminLink, PageHeader, Pill, ReportProblem, Section, StatusPill, enumLabel } from "@/components/report"
import { assistantProvider } from "@/lib/assistant/shared"
import { isAdmin } from "@/lib/auth"
import { isOpen, requestStage, requestTitle } from "@/lib/compliance-rules"
import { addDays, formatDay, parseRange, rangeQuery, today, type DateRange } from "@/lib/date-range"
import { getCalls, type Call } from "@/lib/google-ads/calls"
import {
  getCampaignAds,
  getCampaignAssets,
  getCampaignInfo,
  getCampaignKeywords,
  getCampaignSchedule,
  monthDays,
  validCampaignId,
  type CampaignAd,
  type CampaignAssets,
  type CampaignInfo,
  type CampaignKeyword,
} from "@/lib/google-ads/campaign"
import { getCampaignNegatives, getChangeHistory, getEditableCampaigns } from "@/lib/google-ads/changes"
import { daysIn, getOverview, type Bucket, type Grain } from "@/lib/google-ads/overview"
import {
  getAllCampaigns,
  getLocationData,
  getSearchTerms,
  isWaste,
  rates,
  weekdays,
  type LocationRow,
  type ScheduleGrid,
  type SearchTermRow,
} from "@/lib/google-ads/reports"
import { listLeads } from "@/lib/leads/store"
import type { Lead } from "@/lib/leads/types"
import { load, type Loaded } from "@/lib/load"
import { currentName } from "@/lib/people"
import { OVERVIEW_METRICS, delta, formatUnit, metricById, type MetricDef } from "@/lib/overview-metrics"
import { checkPage, getPageSpeed } from "@/lib/pagespeed"
import { DEFAULT_GRADE, readData, type ChangeRequest, type GradeSettings } from "@/lib/store"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Campaign · DealTrack" }

type Params = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function bucketLabel(start: string, grain: Grain) {
  if (grain === "day") return formatDate(start)
  if (grain === "week") return `Week of ${formatDate(start)}`
  return new Date(`${start}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
}

// Leads from this campaign: Google adds the campaign ID to the landing URL (gad_campaignid), and
// tagged links carry it (or the campaign's name) in utm_campaign.
function fromCampaign(lead: Lead, info: CampaignInfo) {
  const t = lead.tracking
  if (!t) return false
  if (t.landingPage && new RegExp(`[?&]gad_campaignid=${info.id}(\\D|$)`).test(t.landingPage)) return true
  const utm = (t.utmCampaign ?? "").trim().toLowerCase()
  return !!utm && (utm === info.id || utm === info.name.toLowerCase())
}

const LEARNING = /^LEARNING/
const leadsText = (n: number) => `${formatConversions(n)} lead${n === 1 ? "" : "s"}`

const TABS = [
  { id: "summary", label: "Summary" },
  { id: "ads", label: "Ads" },
  { id: "landing", label: "Landing page" },
  { id: "searches", label: "Searches & keywords" },
  { id: "where", label: "Where & when" },
  { id: "leads", label: "Leads & budget" },
  { id: "history", label: "History" },
] as const
type TabId = (typeof TABS)[number]["id"]

// Where each to-do points, as a tab of this page.
const TODO_TAB: Record<string, TabId> = {
  "/search-terms": "searches",
  "#searches": "searches",
  "#keywords": "searches",
  "/locations": "where",
  "#where": "where",
  "/leads": "leads",
  "#leads": "leads",
  "#budget": "leads",
  "/compliance": "history",
  "#ads": "ads",
}

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const { id } = await params
  if (!validCampaignId(id)) notFound()
  const sp = await searchParams
  const range = parseRange(sp)
  const q = rangeQuery(range)
  const tab: TabId = TABS.find((t) => t.id === first(sp.tab))?.id ?? "summary"
  const tabHref = (t: TabId, extra = "") => `/campaigns/${id}${q ? `${q}&` : "?"}tab=${t}${extra}`
  const callDays = Math.min(365, Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000))

  // Every tab needs the campaign, the list for the switcher, and the ads (their count is on the
  // tab, and the summary and landing page use them). The rest loads only on its own tab.
  const [info, list, saved, admin, ads] = await Promise.all([
    load(() => getCampaignInfo(id)),
    load(() => getAllCampaigns(range)),
    load(() => readData()),
    isAdmin(),
    load(() => getCampaignAds(id, range)),
  ])
  if (info.ok && !info.data) notFound()

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Link href={`/campaigns${q}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All campaigns
      </Link>
      {list.ok && <CampaignSwitcher current={id} campaigns={list.data} query={q} tab={tab} />}
    </div>
  )
  if (!info.ok) {
    return (
      <>
        {header}
        <PageHeader title="Campaign" description="Everything about one campaign." range={range} />
        <ReportProblem problem={info} />
      </>
    )
  }
  const c = info.data!
  const adList = ads.ok ? ads.data : []
  const requests = saved.ok ? saved.data.changeRequests.filter((r) => r.campaigns.some((x) => x.id === id)) : []
  const callsFor = () =>
    load(async () => (await getCalls(callDays)).filter((call) => call.campaign === c.name && call.start.slice(0, 10) <= range.to))
  const count: Partial<Record<TabId, number>> = { ads: adList.length, history: requests.filter(isOpen).length || undefined }

  return (
    <>
      {header}
      <PageHeader title={c.name} description="One campaign: its numbers, ads, landing page, searches, places, hours, and leads." range={range} />
      <CampaignFacts c={c} />

      <nav aria-label="Campaign sections" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={tabHref(t.id)}
            scroll={false}
            aria-current={t.id === tab ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:border-primary/40 hover:text-foreground",
              t.id === tab && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
            )}
          >
            {t.label}
            {count[t.id] !== undefined && <span className="ml-1 opacity-75">({count[t.id]})</span>}
          </Link>
        ))}
      </nav>

      {tab === "summary" && (
        <SummaryTab
          c={c}
          sp={sp}
          range={range}
          q={q}
          ads={adList}
          requests={requests}
          grade={saved.ok ? saved.data.grade : DEFAULT_GRADE}
          calls={callsFor}
          tabHref={tabHref}
        />
      )}

      {tab === "ads" && (
        <AdsTab
          campaignId={id}
          ads={ads}
          assets={await load(() => getCampaignAssets(id))}
          selected={first(sp.ad)}
          group={first(sp.group)}
          tabHref={tabHref}
          q={q}
          personName={await currentName()}
          aiReady={assistantProvider() !== null}
        />
      )}

      {tab === "landing" && (
        <Suspense fallback={<LandingSkeleton />}>
          <LandingSection
            urls={[
              ...new Set(
                adList
                  .filter((a) => a.status === "ENABLED")
                  .map((a) => a.finalUrl)
                  .filter(Boolean),
              ),
            ]}
          />
        </Suspense>
      )}

      {tab === "searches" && <SearchesTab id={id} range={range} q={q} admin={admin} />}

      {tab === "where" && (
        <WhereWhenTab places={await load(() => getLocationData(range, id))} schedule={await load(() => getCampaignSchedule(id, range))} q={q} />
      )}

      {tab === "leads" && (
        <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <LeadsCard
            leads={await load(async () =>
              (await listLeads()).filter((l) => fromCampaign(l, c) && l.createdAt.slice(0, 10) >= range.from && l.createdAt.slice(0, 10) <= range.to),
            )}
            calls={await callsFor()}
          />
          <BudgetCard c={c} />
        </div>
      )}

      {tab === "history" && (
        <HistoryCard
          history={await load(async () => (await getChangeHistory(addDays(today(), -29), today())).filter((e) => e.campaign === c.name))}
          requests={requests}
        />
      )}
    </>
  )
}

// ---- Tabs -----------------------------------------------------------------------------------

async function SummaryTab({
  c,
  sp,
  range,
  q,
  ads,
  requests,
  grade,
  calls,
  tabHref,
}: {
  c: CampaignInfo
  sp: Params
  range: DateRange
  q: string
  ads: CampaignAd[]
  requests: ChangeRequest[]
  grade: GradeSettings
  calls: () => Promise<Loaded<Call[]>>
  tabHref: (t: TabId, extra?: string) => string
}) {
  const m1 = metricById(first(sp.m1)) ?? metricById("cost")!
  const m2 = first(sp.m2) === "none" ? null : (metricById(first(sp.m2)) ?? (m1.id === "leads" ? metricById("cost")! : metricById("leads")!))
  const [overview, keywords, terms, places, callLoad] = await Promise.all([
    load(() => getOverview(range, c.id)),
    load(() => getCampaignKeywords(c.id, range)),
    load(() => getSearchTerms(range, c.id)),
    load(() => getLocationData(range, c.id)),
    calls(),
  ])
  if (!overview.ok) return <ReportProblem problem={overview} />
  const ov = overview.data
  const totals = ov.totals
  const before = ov.previous.totals
  const series = (m: MetricDef) => ov.buckets.map((b: Bucket) => m.value(b))
  const kpi = (mid: string, note?: string) => {
    const m = metricById(mid)!
    return { label: m.label, value: formatUnit(m.unit, m.value(totals)), delta: delta(m, m.value(totals), m.value(before)), note, spark: series(m) }
  }
  const termRows = terms.ok ? terms.data : []
  const wasted = termRows.filter((t) => isWaste(t.metrics))
  const outside = (places.ok ? places.data.rows : []).filter((p) => p.status === "outside")
  const callList = callLoad.ok ? callLoad.data : null
  const missedCalls = callList ? callList.filter((x) => x.missed).length : 0

  // The account-wide to-dos, narrowed to this campaign, then the ones only a campaign has; each
  // opens the tab that deals with it.
  const todos: Todo[] = [
    ...doToday({
      q,
      grade,
      totalsCost: totals.cost,
      leads: totals.leads,
      attention: {
        wastedTermCost: wasted.reduce((s, t) => s + t.metrics.cost, 0),
        wastedTerms: wasted.length,
        suggested: new Set(termRows.filter((t) => t.suggestion && t.status === "NONE").map((t) => t.suggestion)).size,
        outsideCost: outside.reduce((s, p) => s + p.metrics.cost, 0),
        outsideTop: outside.slice(0, 3).map((p) => p.city),
        deadCampaigns: [],
      },
      alerts: [],
      missedCalls,
      waitingRequests: requests.filter(isOpen).length,
    }),
    ...campaignTodos(c, ads, keywords.ok ? keywords.data : [], totals.lostToBudget),
  ].map((t) => {
    const to = TODO_TAB[t.href.startsWith("#") ? t.href : t.href.split(/[?#]/)[0]]
    return to ? { ...t, href: tabHref(to) } : t
  })
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const
  todos.sort((a, b) => rank[a.severity] - rank[b.severity] || b.cost - a.cost)

  return (
    <>
      <AtAGlance
        grade={gradeOf(todos, grade)}
        totals={totals}
        before={before}
        range={range}
        leadCost={grade.leadCost}
        title="This campaign at a glance"
      />
      <DoToday todos={todos} />
      <TrendKpis
        cols="md:grid-cols-4 xl:grid-cols-8"
        caption={`Changes compare with the ${formatNumber(daysIn(range))} days before (${formatDay(ov.previous.range.from)} – ${formatDay(ov.previous.range.to)}).`}
        items={[
          kpi("cost"),
          kpi("leads"),
          kpi("cpl"),
          kpi("clicks"),
          kpi("ctr", `${formatNumber(totals.impressions)} impr.`),
          kpi("cpc"),
          kpi(
            "is",
            totals.lostToBudget !== null && totals.lostToRank !== null
              ? `lost ${formatPercent(totals.lostToBudget, 0)} budget, ${formatPercent(totals.lostToRank, 0)} rank`
              : undefined,
          ),
          {
            label: "Calls from ads",
            value: callList ? formatNumber(callList.length) : "—",
            note: callList ? (missedCalls ? `${formatNumber(missedCalls)} missed` : "None missed") : "Couldn't load",
            spark: [],
          },
        ]}
      />
      <Section
        title="Compare two metrics"
        description={`By ${ov.grain}: ${m1.label.toLowerCase()} on the left${m2 ? `, ${m2.label.toLowerCase()} (dashed) on the right` : ""}.`}
        actions={<MetricPicker options={OVERVIEW_METRICS.map((m) => ({ id: m.id, label: m.label }))} m1={m1.id} m2={m2?.id ?? "none"} />}
      >
        <CompareChart
          labels={ov.buckets.map((b) => bucketLabel(b.start, ov.grain))}
          series={[m1, ...(m2 ? [m2] : [])].map((m) => ({ label: m.label, unit: m.unit, values: series(m) }))}
        />
      </Section>
    </>
  )
}

async function SearchesTab({ id, range, q, admin }: { id: string; range: DateRange; q: string; admin: boolean }) {
  const [terms, keywords, editable, negatives] = await Promise.all([
    load(() => getSearchTerms(range, id)),
    load(() => getCampaignKeywords(id, range)),
    admin ? load(() => getEditableCampaigns()) : Promise.resolve(null),
    admin ? load(() => getCampaignNegatives({ campaignIds: [id] })) : Promise.resolve(null),
  ])
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <SearchesCard terms={terms} q={q} />
        <KeywordsCard keywords={keywords} />
      </div>
      {admin && editable?.ok && negatives?.ok ? (
        <BlockSearches terms={terms.ok ? terms.data : []} campaigns={editable.data.filter((e) => e.id === id)} existing={negatives.data} />
      ) : (
        !admin && (
          <p className="text-xs text-muted-foreground">
            Admins can block wasted searches for this campaign right here. <AdminLink />
          </p>
        )
      )}
    </>
  )
}

function WhereWhenTab({ places, schedule, q }: { places: Loaded<{ rows: LocationRow[] }>; schedule: Loaded<ScheduleGrid>; q: string }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
      <WhereCard places={places} q={q} />
      <WhenCard schedule={schedule} />
    </div>
  )
}

// ---- Campaign-only to-dos -------------------------------------------------------------------

function campaignTodos(c: CampaignInfo, ads: CampaignAd[], keywords: CampaignKeyword[], lostToBudget: number | null): Todo[] {
  const out: Todo[] = []
  const live = ads.filter((a) => a.status === "ENABLED")
  const disapproved = live.filter((a) => a.approval === "DISAPPROVED")
  if (disapproved.length)
    out.push({
      key: "disapproved",
      severity: "critical",
      title: `${disapproved.length} ad${disapproved.length === 1 ? " is" : "s are"} disapproved and not showing`,
      detail: disapproved.flatMap((a) => a.topics.map(enumLabel)).join(", ") || "See the policy details on the Ads page.",
      href: "/ads",
      cost: 0,
    })
  const limited = live.filter((a) => a.approval === "APPROVED_LIMITED")
  if (limited.length)
    out.push({
      key: "limited",
      severity: "medium",
      title: `${limited.length} ad${limited.length === 1 ? " is" : "s are"} approved but limited`,
      detail: limited.flatMap((a) => a.topics.map(enumLabel)).join(", "),
      href: "/ads",
      cost: 0,
    })
  const poor = live.filter((a) => a.strength === "POOR")
  if (poor.length)
    out.push({
      key: "poor-strength",
      severity: "medium",
      title: `${poor.length} ad${poor.length === 1 ? " has" : "s have"} poor ad strength`,
      detail: "Add more different headlines (up to 15) and descriptions (up to 4), and unpin what you can.",
      href: "#ads",
      cost: 0,
    })
  if (!live.length && c.status === "ENABLED")
    out.push({
      key: "no-ads",
      severity: "critical",
      title: "No running ads in this campaign",
      detail: "It can't show until an ad is on.",
      href: "#ads",
      cost: 0,
    })
  const lowQs = keywords.filter((k) => k.quality !== null && k.quality <= 4 && k.metrics.cost > 0)
  if (lowQs.length)
    out.push({
      key: "low-qs",
      severity: "medium",
      title: `${lowQs.length} keyword${lowQs.length === 1 ? "" : "s"} with a Quality Score of 4 or less`,
      detail: lowQs
        .slice(0, 3)
        .map((k) => `${k.text} (${k.quality})`)
        .join(", "),
      href: "#keywords",
      cost: lowQs.reduce((s, k) => s + k.metrics.cost, 0),
    })
  if (lostToBudget !== null && lostToBudget >= 0.2 && c.status === "ENABLED")
    out.push({
      key: "budget-lost",
      severity: "medium",
      title: `Missing ${formatPercent(lostToBudget, 0)} of possible impressions because the budget runs out`,
      detail: c.dailyBudget ? `Budget is ${formatUsd(c.dailyBudget)}/day.` : "",
      href: "#budget",
      cost: 0,
    })
  if (LEARNING.test(c.biddingStatus))
    out.push({
      key: "learning",
      severity: "low",
      title: "Google's bidding is still learning",
      detail: "Results swing for a week or two. Changes are held for approval on the Compliance page.",
      href: "/compliance",
      cost: 0,
    })
  return out
}

// ---- Settings strip -------------------------------------------------------------------------

function CampaignFacts({ c }: { c: CampaignInfo }) {
  const facts: [string, React.ReactNode][] = [
    ["Status", <StatusPill key="s" status={c.status} />],
    [
      "Google says",
      <span key="g" className="flex flex-wrap gap-1">
        <Pill tone={c.primaryStatus === "ELIGIBLE" ? "green" : c.primaryStatus === "LIMITED" || c.primaryStatus === "LEARNING" ? "amber" : "gray"}>
          {enumLabel(c.primaryStatus)}
        </Pill>
        {c.primaryReasons.slice(0, 2).map((r) => (
          <Pill key={r}>{enumLabel(r)}</Pill>
        ))}
      </span>,
    ],
    ["Type", enumLabel(c.channel)],
    ["Bidding", `${enumLabel(c.bidding)}${c.targetCpa ? ` (target ${formatUsd(c.targetCpa)}/lead)` : ""}`],
    [
      "Bidding status",
      <Pill key="b" tone={LEARNING.test(c.biddingStatus) ? "violet" : c.biddingStatus.startsWith("LIMITED") ? "amber" : "gray"}>
        {enumLabel(c.biddingStatus)}
      </Pill>,
    ],
    ["Budget", c.dailyBudget === null ? "—" : `${formatUsd(c.dailyBudget)}/day`],
  ]
  return (
    <section
      aria-label="Campaign settings"
      className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl border bg-card p-4 text-sm shadow-xs sm:grid-cols-3 lg:grid-cols-6"
    >
      {facts.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="font-medium">{value}</span>
        </div>
      ))}
    </section>
  )
}

// ---- Ads ------------------------------------------------------------------------------------

const labelTone = { BEST: "green", GOOD: "green", LOW: "red", LEARNING: "violet", PENDING: "gray", UNKNOWN: "gray" } as const
const strengthTone = { EXCELLENT: "green", GOOD: "green", AVERAGE: "amber", POOR: "red" } as const
function AdsTab({
  campaignId,
  personName,
  aiReady,
  ads,
  assets,
  selected,
  group,
  tabHref,
  q,
}: {
  ads: Loaded<CampaignAd[]>
  assets: Loaded<CampaignAssets>
  selected?: string
  group?: string
  tabHref: (t: TabId, extra?: string) => string
  q: string
  campaignId: string
  personName: string
  aiReady: boolean
}) {
  if (!ads.ok) return <ReportProblem problem={ads} />
  const a: CampaignAssets = assets.ok
    ? assets.data
    : { businessName: "", logo: null, images: [], sitelinks: [], callouts: [], snippets: [], phone: "" }
  const groups = [...new Set(ads.data.map((x) => x.adGroup))].sort()
  const shown = group && groups.includes(group) ? ads.data.filter((x) => x.adGroup === group) : ads.data
  const current = shown.find((x) => x.id === selected) ?? shown[0]
  const groupParam = group && groups.includes(group) ? `&group=${encodeURIComponent(group)}` : ""
  const firstLine = (ad: CampaignAd) => shownText((ad.headlines.find((h) => h.pinned === "HEADLINE_1") ?? ad.headlines[0])?.text ?? "(no headlines)")
  return (
    <>
      <Section
        id="ads"
        title={`${ads.data.length} ad${ads.data.length === 1 ? "" : "s"}`}
        description="Pick an ad to see how it looks on Google (one likely mix: pinned headlines in their spot, Google's best-rated first), with every headline and description. Google tags each Best, Good or Low once it has enough data."
        actions={
          <Link href={`/ads${q}`} className="text-sm font-medium text-primary hover:underline">
            Ads &amp; creatives
          </Link>
        }
      >
        {groups.length > 1 && (
          <nav aria-label="Ad groups" className="flex flex-wrap gap-1.5">
            {[
              { name: "", label: "All ad groups", n: ads.data.length },
              ...groups.map((g) => ({ name: g, label: g, n: ads.data.filter((x) => x.adGroup === g).length })),
            ].map((g) => {
              const on = (g.name || undefined) === (groupParam ? group : undefined)
              return (
                <Link
                  key={g.name || "all"}
                  href={tabHref("ads", g.name ? `&group=${encodeURIComponent(g.name)}` : "")}
                  scroll={false}
                  aria-current={on ? "true" : undefined}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    on && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
                  )}
                >
                  {g.label} ({g.n})
                </Link>
              )
            })}
          </nav>
        )}
        {!current ? (
          <p className="text-sm text-muted-foreground">No ads in this campaign.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1 lg:max-h-[46rem]" aria-label="Ads">
              {shown.map((ad, i) => (
                <li key={ad.id}>
                  <Link
                    href={tabHref("ads", `${groupParam}&ad=${ad.id}`)}
                    scroll={false}
                    aria-current={ad.id === current.id ? "true" : undefined}
                    className={cn(
                      "flex flex-col gap-1 rounded-lg border p-2.5 text-sm hover:border-primary/40",
                      ad.id === current.id ? "border-primary bg-primary/5" : "bg-card",
                      ad.status !== "ENABLED" && "opacity-70",
                    )}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="line-clamp-2 font-medium">
                        <span className="text-muted-foreground">{i + 1}. </span>
                        {firstLine(ad)}
                      </span>
                      {ad.status !== "ENABLED" && <StatusPill status={ad.status} />}
                    </span>
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="mr-1 text-[11px] text-muted-foreground">{ad.adGroup}</span>
                      <Pill tone={strengthTone[ad.strength as keyof typeof strengthTone] ?? "gray"}>{enumLabel(ad.strength)}</Pill>
                      {ad.approval !== "APPROVED" && <Pill tone={ad.approval === "DISAPPROVED" ? "red" : "amber"}>{enumLabel(ad.approval)}</Pill>}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {formatUsd(ad.metrics.cost)} · {formatNumber(ad.metrics.clicks)} click{ad.metrics.clicks === 1 ? "" : "s"}
                      {ad.metrics.impressions ? ` · ${formatPercent(rates(ad.metrics).ctr)} CTR` : ""}
                      {ad.metrics.conversions > 0 && ` · ${leadsText(ad.metrics.conversions)}`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <AdBlock ad={current} assets={a} />
          </div>
        )}
        {current && current.type === "RESPONSIVE_SEARCH_AD" && (
          <AdFixer key={current.id} campaignId={campaignId} ad={current} assets={a} personName={personName} aiReady={aiReady} />
        )}
      </Section>
      {assets.ok ? (
        <Section
          title="What shows with the ads"
          description="Images, sitelinks, callouts and the call button: the campaign's own, or the account's when it has none."
        >
          <AssetsStrip assets={a} />
        </Section>
      ) : (
        <ReportProblem problem={assets} />
      )}
    </>
  )
}

function AdBlock({ ad, assets }: { ad: CampaignAd; assets: CampaignAssets }) {
  const r = rates(ad.metrics)
  return (
    <div className="grid content-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{ad.adGroup}</span>
          <StatusPill status={ad.status} />
          <Pill tone={strengthTone[ad.strength as keyof typeof strengthTone] ?? "gray"}>Strength: {enumLabel(ad.strength)}</Pill>
          <Pill tone={ad.approval === "APPROVED" ? "green" : ad.approval === "DISAPPROVED" ? "red" : "amber"}>{enumLabel(ad.approval)}</Pill>
        </div>
        <AdPreview ad={ad} assets={assets} />
        <dl className="grid grid-cols-4 gap-2 text-center text-xs">
          {(
            [
              ["Spend", formatUsd(ad.metrics.cost)],
              ["Clicks", formatNumber(ad.metrics.clicks)],
              ["CTR", ad.metrics.impressions ? formatPercent(r.ctr) : "—"],
              ["Leads", formatConversions(ad.metrics.conversions)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-lg bg-muted/50 px-2 py-1.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {ad.finalUrl && (
          <a href={ad.finalUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-xs text-primary hover:underline">
            <ExternalLink className="size-3 shrink-0" aria-hidden /> {ad.finalUrl}
          </a>
        )}
      </div>
      <div className="grid content-start gap-4 sm:grid-cols-2 xl:grid-cols-1">
        <TextList title={`Headlines (${ad.headlines.length} of 15)`} items={ad.headlines} max={30} />
        <TextList title={`Descriptions (${ad.descriptions.length} of 4)`} items={ad.descriptions} max={90} />
      </div>
    </div>
  )
}

function TextList({ title, items, max }: { title: string; items: CampaignAd["headlines"]; max: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto pr-1 text-sm">
        {items.map((t, i) => (
          <li key={`${t.text}-${i}`} className="flex items-start justify-between gap-2 rounded-md border px-2 py-1">
            <span className="min-w-0">
              {shownText(t.text)}
              {t.text !== shownText(t.text) && <span className="block text-[11px] text-muted-foreground">{t.text}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {t.pinned && <Pill tone="violet">Pin {t.pinned.replace(/\D/g, "")}</Pill>}
              {["BEST", "GOOD", "LOW", "LEARNING"].includes(t.label) && (
                <Pill tone={labelTone[t.label as keyof typeof labelTone] ?? "gray"}>{enumLabel(t.label)}</Pill>
              )}
              <span className={cn("text-[11px] tabular-nums", shownText(t.text).length > max ? "text-destructive" : "text-muted-foreground")}>
                {shownText(t.text).length}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function AssetsStrip({ assets }: { assets: CampaignAssets }) {
  const none = !assets.images.length && !assets.sitelinks.length && !assets.callouts.length && !assets.snippets.length && !assets.phone
  return (
    <div className="flex flex-col gap-3">
      {none && <p className="text-sm text-muted-foreground">No images, sitelinks, callouts, or call button set for this campaign or the account.</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5 lg:col-span-2">
          <p className="text-xs font-medium text-muted-foreground">Images ({assets.images.length})</p>
          {assets.images.length ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {assets.images.map((img) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={img.url} src={img.url} alt="" title={img.level} className="h-24 w-auto shrink-0 rounded-lg border object-cover" />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">None. Image assets can lift clicks on mobile.</p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">Sitelinks ({assets.sitelinks.length})</p>
          <ul className="flex flex-col gap-0.5 text-sm">
            {assets.sitelinks.map((s) => (
              <li key={s.text} className="truncate" title={`${s.line1} ${s.line2} · ${s.url}`}>
                {s.text}
              </li>
            ))}
            {!assets.sitelinks.length && <li className="text-xs text-muted-foreground">None</li>}
          </ul>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">Callouts, snippets &amp; call</p>
          <ul className="flex flex-col gap-0.5 text-sm">
            {assets.phone && (
              <li className="flex items-center gap-1">
                <Phone className="size-3.5" aria-hidden /> {assets.phone}
              </li>
            )}
            {assets.callouts.map((t) => (
              <li key={t}>{t}</li>
            ))}
            {assets.snippets.map((s) => (
              <li key={s.header}>
                {s.header}: {s.values.join(", ")}
              </li>
            ))}
            {!assets.phone && !assets.callouts.length && !assets.snippets.length && <li className="text-xs text-muted-foreground">None</li>}
          </ul>
        </div>
      </div>
    </div>
  )
}

// ---- Landing page ---------------------------------------------------------------------------

function LandingSkeleton() {
  return (
    <Section title="Landing page" description="Loading a phone screenshot from Google PageSpeed (10–30 seconds the first time)…">
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
    </Section>
  )
}

async function LandingSection({ urls }: { urls: string[] }) {
  const shown = urls.slice(0, 2)
  const pages = await Promise.all(
    shown.map(async (url) => ({
      url,
      page: await load(() => checkPage(url)),
      speed: await load(() => Promise.resolve().then(() => getPageSpeed(url))),
    })),
  )
  return (
    <Section
      id="landing"
      title="Landing page"
      description="Where the ads send people: how the page looks on a phone, what it says, and how fast it loads."
      actions={
        <Link href="/landing-pages" className="text-sm font-medium text-primary hover:underline">
          All landing pages
        </Link>
      }
    >
      {!pages.length && <p className="text-sm text-muted-foreground">No running ads, so no landing page.</p>}
      <div className="flex flex-col gap-6">
        {pages.map(({ url, page, speed }) => {
          const p = page.ok ? page.data : null
          const s = speed.ok ? speed.data : null
          return (
            <div key={url} className="grid gap-4 border-t pt-4 first:border-t-0 first:pt-0 md:grid-cols-[14rem_minmax(0,1fr)]">
              <div className="mx-auto w-56 overflow-hidden rounded-[1.75rem] border-8 border-neutral-800 bg-neutral-800 shadow-sm md:mx-0">
                {s?.screenshot ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.screenshot} alt={`How ${url} looks on a phone`} className="block w-full rounded-[1.1rem] bg-white" />
                ) : (
                  <div className="flex aspect-[9/16] items-center justify-center rounded-[1.1rem] bg-white p-4 text-center text-xs text-muted-foreground">
                    {speed.ok
                      ? "No screenshot in this result yet."
                      : speed.kind === "missing"
                        ? "Add PAGESPEED_API_KEY to see a screenshot."
                        : "Couldn't take a screenshot."}
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-3 text-sm">
                <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate font-medium text-primary hover:underline">
                  <ExternalLink className="size-3.5 shrink-0" aria-hidden /> {url}
                </a>
                {p ? (
                  <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    <Fact label="Page title" value={p.title || "—"} />
                    <Fact label="Main heading (H1)" value={p.h1 || "None found"} />
                    <Fact label="Google snippet (meta description)" value={p.description || "None: Google picks text from the page"} wide />
                    <Fact
                      label="Loads"
                      value={
                        p.status === 200 ? (
                          <Pill tone="green">Works (200)</Pill>
                        ) : (
                          <Pill tone="red">{p.status ? `Error ${p.status}` : p.resolves ? "Unreachable" : "Domain doesn't exist"}</Pill>
                        )
                      }
                    />
                    <Fact
                      label="Speed on a phone"
                      value={
                        s?.performance != null ? (
                          <span className="flex items-center gap-1.5">
                            <Pill tone={s.performance >= 90 ? "green" : s.performance >= 50 ? "amber" : "red"}>{s.performance}/100</Pill>
                            {s.lcpS != null && <span className="text-xs text-muted-foreground">main content in {s.lcpS}s</span>}
                          </span>
                        ) : (
                          "—"
                        )
                      }
                    />
                    <Fact label="Form" value={p.formFields === null ? "No form" : `${p.formFields} field${p.formFields === 1 ? "" : "s"}`} />
                    <Fact
                      label="Tap to call / reviews"
                      value={`${p.tapToCall ? "Has tap-to-call" : "No tap-to-call"} · ${p.reviews ? "Shows reviews" : "No reviews found"}`}
                    />
                  </dl>
                ) : (
                  !page.ok && <ReportProblem problem={page} />
                )}
                {p?.images && p.images.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Pictures on the page</p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {[...(p.image ? [p.image] : []), ...p.images.filter((i) => i !== p.image)].slice(0, 6).map((src) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={src} src={src} alt="" loading="lazy" className="h-20 w-auto shrink-0 rounded-lg border bg-white object-contain" />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {urls.length > shown.length && (
        <p className="text-xs text-muted-foreground">And {urls.length - shown.length} more page(s) on the Landing pages report.</p>
      )}
    </Section>
  )
}

function Fact({ label, value, wide }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-0.5", wide && "sm:col-span-2")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

// ---- Searches and keywords ------------------------------------------------------------------

function SearchesCard({ terms, q }: { terms: Loaded<SearchTermRow[]>; q: string }) {
  return (
    <Section
      id="searches"
      title="Searches"
      description="What people typed before clicking: the ones that brought leads, and the ones that cost the most with none."
      actions={
        <Link href={`/search-terms${q}`} className="text-sm font-medium text-primary hover:underline">
          All search terms
        </Link>
      }
    >
      {!terms.ok ? (
        <ReportProblem problem={terms} />
      ) : (
        <div className="flex flex-col gap-4">
          <TermList title="Brought leads" rows={terms.data.filter((t) => t.metrics.conversions > 0).slice(0, 5)} empty="None in this period." />
          <TermList
            title="Cost the most, no leads"
            rows={terms.data.filter((t) => isWaste(t.metrics)).slice(0, 5)}
            empty="None. Nothing wasted."
            bad
          />
        </div>
      )}
    </Section>
  )
}

function TermList({ title, rows, empty, bad }: { title: string; rows: SearchTermRow[]; empty: string; bad?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <p className={cn("text-xs font-medium", bad ? "text-red-700" : "text-emerald-700")}>{title}</p>
      {rows.length ? (
        <ul className="divide-y text-sm">
          {rows.map((t) => (
            <li key={t.term} className="flex items-center justify-between gap-3 py-1.5">
              <span className="min-w-0 truncate">
                {t.term}
                {t.status.includes("EXCLUDED") && (
                  <span className="ml-1.5">
                    <Pill>Blocked</Pill>
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatUsd(t.metrics.cost)} · {formatNumber(t.metrics.clicks)} click{t.metrics.clicks === 1 ? "" : "s"}
                {t.metrics.conversions > 0 && ` · ${leadsText(t.metrics.conversions)}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  )
}

function KeywordsCard({ keywords }: { keywords: Loaded<CampaignKeyword[]> }) {
  return (
    <Section
      id="keywords"
      title="Keywords"
      description="What the campaign bids on, costliest first, with Google's Quality Score (1–10; higher means cheaper clicks)."
      actions={
        <Link href="/quality-score" className="text-sm font-medium text-primary hover:underline">
          Quality Score
        </Link>
      }
    >
      {!keywords.ok ? (
        <ReportProblem problem={keywords} />
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto text-sm">
          {keywords.data.slice(0, 30).map((k) => (
            <li key={k.id} className={cn("flex items-center justify-between gap-3 py-1.5", k.status !== "ENABLED" && "text-muted-foreground")}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">
                  {k.matchType === "EXACT" ? `[${k.text}]` : k.matchType === "PHRASE" ? `"${k.text}"` : k.text}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {k.adGroup}
                  {k.status !== "ENABLED" && ` · ${enumLabel(k.status)}`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                {formatUsd(k.metrics.cost)}
                {k.metrics.conversions > 0 && ` · ${leadsText(k.metrics.conversions)}`}
                {k.quality === null ? (
                  <Pill>QS —</Pill>
                ) : (
                  <Pill tone={k.quality >= 7 ? "green" : k.quality >= 5 ? "amber" : "red"}>QS {k.quality}</Pill>
                )}
              </span>
            </li>
          ))}
          {!keywords.data.length && <li className="py-2 text-muted-foreground">No keywords.</li>}
        </ul>
      )}
    </Section>
  )
}

// ---- Where and when -------------------------------------------------------------------------

function WhereCard({ places, q }: { places: Loaded<{ rows: LocationRow[] }>; q: string }) {
  if (!places.ok) return <ReportProblem problem={places} />
  const rows = places.data.rows
  const outside = rows.filter((p) => p.status === "outside")
  const outsideCost = outside.reduce((s, p) => s + p.metrics.cost, 0)
  const total = rows.reduce((s, p) => s + p.metrics.cost, 0)
  const top = rows.slice(0, 8)
  const max = Math.max(1, ...top.map((p) => p.metrics.cost))
  return (
    <Section
      id="where"
      title="Where"
      description={
        outsideCost > 0
          ? `${formatUsd(outsideCost)} (${formatPercent(total ? outsideCost / total : 0, 0)}) went to places outside your buy area.`
          : "Top cities by spend. Nothing went outside your buy area."
      }
      actions={
        <Link href={`/locations${q}`} className="text-sm font-medium text-primary hover:underline">
          Locations
        </Link>
      }
    >
      {top.length ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {top.map((p) => (
            <li key={p.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                {p.city}
                {p.status === "outside" && <Pill tone="red">Outside</Pill>}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatUsd(p.metrics.cost)}
                {p.metrics.conversions > 0 && ` · ${leadsText(p.metrics.conversions)}`}
              </span>
              <span className="col-span-2 h-1.5 rounded-full bg-muted">
                <span
                  className={cn("block h-full rounded-full", p.status === "outside" ? "bg-red-400" : "bg-primary/60")}
                  style={{ width: `${(p.metrics.cost / max) * 100}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No location data for this period.</p>
      )}
    </Section>
  )
}

const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`)

function WhenCard({ schedule }: { schedule: Loaded<ScheduleGrid> }) {
  if (!schedule.ok) return <ReportProblem problem={schedule} />
  const grid = schedule.data
  const max = Math.max(1, ...grid.flat().map((m) => m.clicks))
  const cells = grid.flatMap((row, d) => row.map((m, h) => ({ d, h, m })))
  const best = cells.filter((x) => x.m.conversions > 0).sort((a, b) => b.m.conversions - a.m.conversions)[0]
  const worst = cells.filter((x) => isWaste(x.m)).sort((a, b) => b.m.cost - a.m.cost)[0]
  const dayTotals = grid.map((row) => row.reduce((s, m) => s + m.clicks, 0))
  return (
    <Section
      title="When"
      description={
        [
          best && `Most leads: ${DAY_SHORT[best.d]} ${hourLabel(best.h)}.`,
          worst && `Costliest with no leads: ${DAY_SHORT[worst.d]} ${hourLabel(worst.h)} (${formatUsd(worst.m.cost)}).`,
        ]
          .filter(Boolean)
          .join(" ") || "Clicks by day and hour. Darker means more clicks."
      }
      actions={
        <Link href="/schedule" className="text-sm font-medium text-primary hover:underline">
          Day &amp; hour
        </Link>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-[10px]">
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="font-normal text-muted-foreground">
                  {h % 3 === 0 ? hourLabel(h) : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, d) => (
              <tr key={weekdays[d]}>
                <th className="pr-1 text-left font-normal whitespace-nowrap text-muted-foreground">
                  {DAY_SHORT[d]} <span className="tabular-nums">{dayTotals[d]}</span>
                </th>
                {row.map((m, h) => (
                  <td
                    key={h}
                    title={`${DAY_SHORT[d]} ${hourLabel(h)}: ${m.clicks} clicks, ${formatUsdCents(m.cost)}, ${formatConversions(m.conversions)} leads`}
                    className={cn("h-4 min-w-3 rounded-sm", m.conversions > 0 && "ring-1 ring-emerald-500")}
                    style={{
                      background: m.clicks
                        ? `color-mix(in oklab, var(--primary) ${Math.round(15 + (m.clicks / max) * 85)}%, transparent)`
                        : "var(--muted)",
                    }}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">Green outline: an hour that brought a lead. Number after the day: clicks.</p>
    </Section>
  )
}

// ---- Budget, leads and calls ----------------------------------------------------------------

function BudgetCard({ c }: { c: CampaignInfo }) {
  const { gone, total, left } = monthDays()
  const monthBudget = c.dailyBudget === null ? null : c.dailyBudget * total
  const pace = gone ? c.monthSpent / gone : 0
  const projected = c.monthSpent + pace * left
  const share = monthBudget ? Math.min(1, c.monthSpent / monthBudget) : 0
  const expected = gone / total
  return (
    <Section id="budget" title="Budget this month" description="Spend so far against the daily budget times the days in the month.">
      {monthBudget === null ? (
        <p className="text-sm text-muted-foreground">This campaign has no budget of its own.</p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-2xl font-semibold tabular-nums">
            {formatUsd(c.monthSpent)} <span className="text-sm font-normal text-muted-foreground">of about {formatUsd(monthBudget)}</span>
          </p>
          <div className="relative h-3 rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary/70" style={{ width: `${share * 100}%` }} />
            <div
              className="absolute top-[-3px] h-[18px] w-0.5 bg-foreground/60"
              style={{ left: `${expected * 100}%` }}
              title="Where spend would be on an even pace"
            />
          </div>
          <p className="text-muted-foreground">
            Day {gone} of {total}. At {formatUsd(pace)}/day so far, the month ends near{" "}
            <span className="font-medium text-foreground">{formatUsd(projected)}</span>
            {c.status !== "ENABLED" && " (the campaign isn't running, so it won't spend more)"}. Google can spend up to twice the daily budget on a
            busy day, but not more than the monthly amount.
          </p>
        </div>
      )}
    </Section>
  )
}

const gradeTone = { hot: "red", warm: "amber", cold: "gray", junk: "gray" } as const

function LeadsCard({
  leads,
  calls,
}: {
  leads: Loaded<Lead[]>
  calls: Loaded<{ start: string; seconds: number; missed: boolean; areaCode: string; from: string }[]>
}) {
  return (
    <Section
      id="leads"
      title="Leads and calls"
      description="Website form leads that came from this campaign's ads (matched by the campaign in the landing link), and calls from its ads."
      actions={
        <Link href="/leads" className="text-sm font-medium text-primary hover:underline">
          All leads
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        {!leads.ok ? (
          <ReportProblem problem={leads} />
        ) : leads.data.length ? (
          <ul className="divide-y text-sm">
            {leads.data.slice(0, 6).map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{l.name || "(no name)"}</span>
                  {l.propertyAddress && <span className="text-muted-foreground"> · {l.propertyAddress}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {l.score && <Pill tone={gradeTone[l.score.grade]}>{enumLabel(l.score.grade)}</Pill>}
                  {formatDate(l.createdAt.slice(0, 10))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No website leads matched to this campaign in this period.</p>
        )}
        {!calls.ok ? (
          <ReportProblem problem={calls} />
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">
              Calls ({calls.data.length}
              {calls.data.some((x) => x.missed) ? `, ${calls.data.filter((x) => x.missed).length} missed` : ""})
            </p>
            {calls.data.length ? (
              <ul className="divide-y text-sm">
                {calls.data.slice(0, 5).map((x) => (
                  <li key={x.start} className="flex items-center justify-between gap-3 py-1.5">
                    <span>
                      {x.start.slice(0, 16)} · area code {x.areaCode || "?"} · {x.from}
                    </span>
                    {x.missed ? (
                      <Pill tone="red">Missed</Pill>
                    ) : (
                      <span className="text-xs text-muted-foreground">{Math.round(x.seconds / 60)} min</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No calls from this campaign&apos;s ads in this period.</p>
            )}
          </div>
        )}
      </div>
    </Section>
  )
}

// ---- Block searches (admins) ----------------------------------------------------------------

function BlockSearches({
  terms,
  campaigns,
  existing,
}: {
  terms: SearchTermRow[]
  campaigns: Awaited<ReturnType<typeof getEditableCampaigns>>
  existing: Awaited<ReturnType<typeof getCampaignNegatives>>
}) {
  const byNegative = new Map<string, { negative: string; reason: string; terms: number; cost: number; conversions: number }>()
  for (const t of terms) {
    if (!t.rule || !t.suggestion || t.status.includes("EXCLUDED")) continue
    const s = byNegative.get(t.suggestion) ?? { negative: t.suggestion, reason: t.rule.reason, terms: 0, cost: 0, conversions: 0 }
    s.terms += 1
    s.cost += t.metrics.cost
    s.conversions += t.metrics.conversions
    byNegative.set(t.suggestion, s)
  }
  const suggestions = [...byNegative.values()].sort((a, b) => b.cost - a.cost)
  if (!campaigns.length) return null
  return (
    <details className="group rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold">
        <span>Block searches for this campaign</span>
        <span className="text-sm font-normal text-muted-foreground">
          {suggestions.length ? `${suggestions.length} suggested` : "Type your own"} · <span className="text-primary group-open:hidden">Open</span>
          <span className="hidden text-primary group-open:inline">Close</span>
        </span>
      </summary>
      <div className="mt-4">
        <NegativeKeywordPanel
          suggestions={suggestions}
          campaigns={campaigns}
          existing={existing.filter((n) => n.kind === "keyword").map((n) => `${n.campaignId}|${n.text}|${n.matchType}`)}
        />
      </div>
    </details>
  )
}

// ---- History --------------------------------------------------------------------------------

function HistoryCard({
  history,
  requests,
}: {
  history: Loaded<Awaited<ReturnType<typeof getChangeHistory>>>
  requests: Awaited<ReturnType<typeof readData>>["changeRequests"]
}) {
  return (
    <Section
      id="history"
      title="Recent changes"
      description="Changes to this campaign in Google Ads (last 30 days), and DealTrack's approval requests for it."
    >
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">In Google Ads</p>
          {!history.ok ? (
            <ReportProblem problem={history} />
          ) : history.data.length ? (
            <ul className="max-h-72 divide-y overflow-y-auto text-sm">
              {history.data.slice(0, 40).map((e) => (
                <li key={e.id} className="flex flex-col py-1.5">
                  <span>
                    {enumLabel(e.operation)} {enumLabel(e.resourceType).toLowerCase()}
                    {e.detail && <span className="text-muted-foreground"> · {e.detail}</span>}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {e.at.slice(0, 16)} · {e.user || enumLabel(e.client)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No changes in the last 30 days.</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Approval requests</p>
          {requests.length ? (
            <ul className="divide-y text-sm">
              {requests.slice(0, 10).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0">{requestTitle(r)}</span>
                  <Pill tone={isOpen(r) ? "violet" : requestStage(r) === "done" ? "green" : "gray"}>{enumLabel(requestStage(r))}</Pill>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              None. Turning it on or off goes through{" "}
              <Link href="/compliance" className="text-primary hover:underline">
                Compliance
              </Link>
              .
            </p>
          )}
        </div>
      </div>
    </Section>
  )
}
