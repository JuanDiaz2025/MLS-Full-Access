import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import CampaignFilter from "@/components/campaign-filter"
import CityExclusionPanel from "@/components/changes/city-exclusion-panel"
import NegativesList from "@/components/changes/negatives-list"
import { formatConversions, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import CityMap from "@/components/locations/city-map"
import PageLoading from "@/components/page-loading"
import { AdminLink, DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { parseRange, rangeQuery, type DateRange } from "@/lib/date-range"
import { getCampaignNegatives, getEditableCampaigns, type CampaignNegative, type EditableCampaign } from "@/lib/google-ads/changes"
import { getLocationData, rates, sumMetrics, type LocationData, type LocationRow, type Metrics } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"
import {
  EXPENSIVE_CPA_TIMES,
  EXPENSIVE_MIN_SPEND,
  expensiveCities,
  getLocationOptions,
  getTargeting,
  mapCities,
  regions,
  type CampaignTargeting,
  type Region,
} from "@/lib/locations"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Locations · DealTrack" }

const VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "map", label: "Map" },
  { id: "cities", label: "Cities" },
  { id: "targeting", label: "Targeting" },
] as const
type View = (typeof VIEWS)[number]["id"]

// A year can reach thousands of cities with a click or two; the lists show the costliest.
const CITIES_SHOWN = 150
const OUTSIDE_SHOWN = 60
const CAMPAIGNS_SHOWN = 8

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const cpaOf = (m: Metrics) => rates(m).costPerConversion
const money = (n: number | null) => (n === null ? "—" : formatUsd(n))

// "34% cheaper" / "2.1× your average" / "about average", against the average cost per conversion.
function versus(cpa: number | null, avg: number | null): { text: string; tone: "green" | "red" | "gray" } {
  if (cpa === null || avg === null) return { text: "No conversions", tone: "gray" }
  const ratio = cpa / avg
  if (ratio <= 0.85) return { text: `${Math.round((1 - ratio) * 100)}% cheaper`, tone: "green" }
  if (ratio >= 1.15)
    return {
      text: ratio >= 2 ? `${ratio.toFixed(1)}× your average` : `${Math.round((ratio - 1) * 100)}% more expensive`,
      tone: "red",
    }
  return { text: "About average", tone: "gray" }
}

export default async function LocationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const range = parseRange(params)
  const asked = first(params.view)
  const view: View = VIEWS.some((v) => v.id === asked) ? (asked as View) : "overview"
  const campaignId = /^\d+$/.test(first(params.campaign) ?? "") ? first(params.campaign)! : ""
  const campaigns = await load(() => getEditableCampaigns())
  const list = campaigns.ok ? campaigns.data : []
  const chosen = list.find((c) => c.id === campaignId)

  return (
    <>
      <PageHeader
        title="Locations"
        description="Where the people who saw and clicked your ads were. The buy area is California: anything outside it is flagged."
        range={range}
      />
      <div className="flex flex-wrap items-end justify-between gap-2 border-b">
        <nav aria-label="Locations views" className="flex gap-1">
          {VIEWS.map((v) => {
            const q = new URLSearchParams(rangeQuery(range).replace(/^\?/, ""))
            if (v.id !== "overview") q.set("view", v.id)
            if (campaignId) q.set("campaign", campaignId)
            const href = `/locations${q.size ? `?${q}` : ""}`
            return (
              <Link
                key={v.id}
                href={href}
                aria-current={view === v.id ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
                  view === v.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {v.label}
              </Link>
            )
          })}
        </nav>
        <div className="pb-1.5">
          <CampaignFilter campaigns={list.map((c) => ({ id: c.id, name: c.name, status: c.status }))} value={chosen ? campaignId : ""} />
        </div>
      </div>
      {!campaigns.ok && <ReportProblem problem={campaigns} />}
      {chosen && (
        <p className="text-sm">
          Showing only <span className="font-medium">{chosen.name}</span> ({chosen.status === "ENABLED" ? "running" : "paused"}).
        </p>
      )}
      {/* Each tab loads only what it shows, while the header and tabs are already on screen. */}
      <Suspense key={`${view}|${range.from}|${range.to}|${campaignId}`} fallback={<PageLoading message={LOADING[view]} />}>
        <TabBody view={view} range={range} campaigns={list} campaignId={chosen ? campaignId : undefined} />
      </Suspense>
    </>
  )
}

const LOADING: Record<View, string> = {
  overview: "Adding up where your ads showed…",
  map: "Placing each city on the map…",
  cities: "Checking every city…",
  targeting: "Reading each campaign's location settings…",
}

async function TabBody({ view, range, campaigns, campaignId }: { view: View; range: DateRange; campaigns: EditableCampaign[]; campaignId?: string }) {
  const admin = await isAdmin()
  const result = await load(async () => {
    const data = await getLocationData(range, campaignId)
    const running = campaigns.filter((c) => c.status === "ENABLED")
    if (view === "overview") {
      const ids = [...new Set([...running.map((c) => c.id), ...data.byCampaign.map((c) => c.id)])]
      return { view, data, options: await getLocationOptions(ids), running } as const
    }
    if (view === "map") {
      const avg = cpaOf(sumMetrics(data.rows))
      return { view, avg, ...(await mapCities(data.rows, data.cityCampaigns)) } as const
    }
    const negatives = await getCampaignNegatives({ campaignIds: campaignId ? [campaignId] : running.map((c) => c.id) })
    if (view === "cities") return { view, data, negatives } as const
    // Targeting: the chosen campaign, or the running ones and the ones that spent in the period.
    const spent = new Set(data.byCampaign.filter((c) => c.presence.cost + c.interest.cost > 0).map((c) => c.id))
    const checked = campaigns.filter((c) => (campaignId ? c.id === campaignId : c.status === "ENABLED" || spent.has(c.id))).slice(0, 60)
    const converting = new Map(data.rows.map((r) => [r.key, r.metrics.conversions]))
    return { view, negatives, targeting: await getTargeting(checked, converting) } as const
  })
  if (!result.ok) return <ReportProblem problem={result} />
  const r = result.data
  switch (r.view) {
    case "overview":
      return <Overview data={r.data} options={r.options} running={r.running} range={range} />
    case "map":
      return (
        <Section
          title="Map"
          description="Every city where your ads showed in this period. Hover a bubble for its numbers and the campaigns that ran there; click to pin it. Scroll the page normally; use + and − (or pinch) to zoom."
        >
          <CityMap cities={r.cities} averageCpa={r.avg} missing={r.missing} />
        </Section>
      )
    case "cities":
      return <Cities data={r.data} negatives={r.negatives} campaigns={campaigns} admin={admin} />
    case "targeting":
      return <Targeting targeting={r.targeting} negatives={r.negatives} admin={admin} />
  }
}

// ---- Overview --------------------------------------------------------------------------------

function Overview({ data, options, running, range }: { data: LocationData; options: Map<string, string>; running: EditableCampaign[]; range: DateRange }) {
  const rows = data.rows.filter((r) => r.metrics.cost > 0 || r.metrics.clicks > 0 || r.metrics.conversions > 0)
  const total = sumMetrics(rows)
  const inside = sumMetrics(rows.filter((r) => r.status === "inside"))
  const outside = sumMetrics(rows.filter((r) => r.status === "outside"))
  const avg = cpaOf(total)
  const share = (cost: number) => formatPercent(total.cost ? cost / total.cost : 0, 0)
  const { presence, interest } = data.byKind
  const option = options
  const presenceOnlyRunning = running.filter((c) => options.get(c.id) === "PRESENCE")
  const interestCheaper = cpaOf(interest) !== null && cpaOf(presence) !== null && cpaOf(interest)! < cpaOf(presence)!

  return (
    <>
      <KpiGrid
        items={[
          {
            label: "Spend in California",
            value: formatUsd(inside.cost),
            note: `${share(inside.cost)} of spend`,
          },
          {
            label: "Conversions in California",
            value: formatConversions(inside.conversions),
          },
          {
            label: "Spend outside California",
            value: formatUsd(outside.cost),
            note: `${share(outside.cost)} of spend`,
            tone: outside.cost > 0 ? "bad" : "default",
          },
          {
            label: "Conversions outside",
            value: formatConversions(outside.conversions),
          },
          { label: "Average cost / conversion", value: money(avg) },
          {
            label: "Cities with spend or clicks",
            value: formatNumber(rows.length),
          },
        ]}
      />

      <Section
        title="In the area, or searching about it"
        description="Google can show ads to people physically in your target places (presence), and to people elsewhere searching about those places (interest), like an heir in Texas selling a house in San Jose."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <KindCard title="People in the area" note="Presence" m={presence} avg={avg} />
          <KindCard title="People elsewhere, searching about the area" note="Interest" m={interest} avg={avg} highlight={interestCheaper} />
        </div>
        {interestCheaper && presenceOnlyRunning.length > 0 && (
          <p className="rounded-xl border border-amber-300 bg-amber-50/60 px-3 py-2 text-sm text-amber-950">
            Searchers from elsewhere cost {money(cpaOf(interest))} a conversion, against {money(cpaOf(presence))} for people in the area. Running{" "}
            {presenceOnlyRunning.map((t) => t.name).join(", ")} {presenceOnlyRunning.length === 1 ? "is" : "are"} set to people in the area only, so{" "}
            {presenceOnlyRunning.length === 1 ? "it misses" : "they miss"} them. To change it: the campaign&apos;s Settings › Locations › Location
            options › Presence or interest.
          </p>
        )}
        {(() => {
          const spent = data.byCampaign.filter((c) => c.presence.cost + c.interest.cost > 0)
          const table = (list: typeof spent) => <CampaignSplitTable rows={list} option={option} />
          return (
            <>
              {table(spent.slice(0, CAMPAIGNS_SHOWN))}
              {spent.length > CAMPAIGNS_SHOWN && (
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-primary">Show all {spent.length} campaigns</summary>
                  <div className="mt-2">{table(spent.slice(CAMPAIGNS_SHOWN))}</div>
                </details>
              )}
            </>
          )
        })()}
      </Section>

      <Section
        title="Regions"
        description={`California cities grouped into regions, against your average cost per conversion (${money(avg)}). Open a region to see its cities.`}
      >
        <RegionTable regions={regions(rows)} avg={avg} />
        <p className="text-xs text-muted-foreground">
          Showing {range.label}. Regions are set in lib/locations.ts; a city that isn&apos;t listed there counts as &ldquo;Other California&rdquo;.
        </p>
      </Section>
    </>
  )
}

function CampaignSplitTable({ rows, option }: { rows: LocationData["byCampaign"]; option: Map<string, string> }) {
  return (
    <DataTable<LocationData["byCampaign"][number]>
      rows={rows}
      rowKey={(c) => c.id}
      columns={[
        {
          key: "name",
          label: "Campaign",
          render: (c) => (
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{c.name}</span>
              <span className="text-xs text-muted-foreground">
                {c.status === "ENABLED" ? "Running" : "Paused"}
                {option.get(c.id) ? ` · ${option.get(c.id) === "PRESENCE" ? "People in the area only" : "In the area or searching about it"}` : ""}
              </span>
            </span>
          ),
        },
        {
          key: "pc",
          label: "In the area",
          align: "right",
          render: (c) => `${formatUsd(c.presence.cost)} · ${formatConversions(c.presence.conversions)} conv`,
        },
        {
          key: "pcpa",
          label: "Cost / conv.",
          align: "right",
          render: (c) => money(cpaOf(c.presence)),
        },
        {
          key: "ic",
          label: "Searching about it",
          align: "right",
          render: (c) => `${formatUsd(c.interest.cost)} · ${formatConversions(c.interest.conversions)} conv`,
        },
        {
          key: "icpa",
          label: "Cost / conv.",
          align: "right",
          render: (c) => money(cpaOf(c.interest)),
        },
      ]}
    />
  )
}

function KindCard({ title, note, m, avg, highlight }: { title: string; note: string; m: Metrics; avg: number | null; highlight?: boolean }) {
  const v = versus(cpaOf(m), avg)
  return (
    <div className={cn("flex flex-col gap-1 rounded-xl border p-4", highlight && "border-emerald-300 bg-emerald-50/50")}>
      <span className="text-xs text-muted-foreground">
        {title} <span className="text-[11px]">({note})</span>
      </span>
      <span className="text-2xl font-semibold tabular-nums">{money(cpaOf(m))}</span>
      <span className="text-xs text-muted-foreground">
        per conversion · {formatUsd(m.cost)} spent · {formatConversions(m.conversions)} conversions
      </span>
      <span>
        <Pill tone={v.tone}>{v.text}</Pill>
      </span>
    </div>
  )
}

function RegionTable({ regions, avg }: { regions: Region[]; avg: number | null }) {
  const total = regions.reduce((s, r) => s + r.metrics.cost, 0)
  return (
    <div className="flex flex-col divide-y rounded-xl border">
      <div className="hidden grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))] gap-2 px-3 py-2 text-xs text-muted-foreground sm:grid">
        <span>Region</span>
        <span className="text-right">Spend</span>
        <span className="text-right">Conversions</span>
        <span className="text-right">Cost / conv.</span>
        <span className="text-right">vs. average</span>
      </div>
      {regions.map((r) => {
        const v = versus(cpaOf(r.metrics), avg)
        return (
          <details key={r.name} className="group">
            <summary className="grid cursor-pointer list-none grid-cols-2 gap-2 px-3 py-2.5 text-sm hover:bg-muted/40 sm:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
              <span className="col-span-2 font-medium sm:col-span-1">
                <span className="mr-1 inline-block text-muted-foreground transition-transform group-open:rotate-90">›</span>
                {r.name}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  {r.cities.length} {r.cities.length === 1 ? "city" : "cities"} · {formatPercent(total ? r.metrics.cost / total : 0, 0)} of spend
                </span>
              </span>
              <span className="tabular-nums sm:text-right">{formatUsd(r.metrics.cost)}</span>
              <span className="tabular-nums sm:text-right">{formatConversions(r.metrics.conversions)} conv</span>
              <span className="tabular-nums sm:text-right">{money(cpaOf(r.metrics))}</span>
              <span className="sm:text-right">
                <Pill tone={v.tone}>{v.text}</Pill>
              </span>
            </summary>
            <ul className="flex flex-col gap-1 bg-muted/20 px-3 py-2 pl-8 text-xs">
              {r.cities.slice(0, 30).map((c) => (
                <li key={c.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
                  <span className="col-span-2 sm:col-span-1">{c.city}</span>
                  <span className="tabular-nums sm:text-right">{formatUsd(c.metrics.cost)}</span>
                  <span className="tabular-nums sm:text-right">{formatConversions(c.metrics.conversions)} conv</span>
                  <span className="tabular-nums sm:text-right">{money(cpaOf(c.metrics))}</span>
                  <span className="text-muted-foreground sm:text-right">{versus(cpaOf(c.metrics), avg).text}</span>
                </li>
              ))}
              {r.cities.length > 30 && <li className="text-muted-foreground">and {r.cities.length - 30} more (see the Cities tab)</li>}
            </ul>
          </details>
        )
      })}
      {!regions.length && <p className="px-3 py-4 text-sm text-muted-foreground">No spend in California in this period.</p>}
    </div>
  )
}

// ---- Cities ----------------------------------------------------------------------------------

function Cities({
  data,
  negatives,
  campaigns,
  admin,
}: {
  data: LocationData
  negatives: CampaignNegative[]
  campaigns: EditableCampaign[]
  admin: boolean
}) {
  const rows = data.rows.filter((r) => r.metrics.cost > 0 || r.metrics.clicks > 0 || r.metrics.conversions > 0)
  const hidden = data.rows.length - rows.length
  const avg = cpaOf(sumMetrics(rows))
  const expensive = expensiveCities(rows, avg)
  const existing = negatives.filter((n) => n.kind === "location").map((n) => `${n.campaignId}|${n.geo}`)
  const toOption = (r: LocationRow) => ({
    geo: r.key,
    city: r.city,
    region: r.region,
    cost: r.metrics.cost,
    conversions: r.metrics.conversions,
  })
  const outsideAll = rows.filter((r) => r.status === "outside" && r.key.startsWith("geoTargetConstants/"))
  const outside = outsideAll.slice(0, OUTSIDE_SHOWN)
  const outsideRest = sumMetrics(outsideAll.slice(OUTSIDE_SHOWN))
  const shown = rows.slice(0, CITIES_SHOWN)
  const rest = sumMetrics(rows.slice(CITIES_SHOWN))

  return (
    <>
      <Section
        title={`Expensive cities in California (${expensive.length})`}
        description={`California cities with at least ${formatUsd(EXPENSIVE_MIN_SPEND)} spent and no conversions, or a cost per conversion ${EXPENSIVE_CPA_TIMES}× your average (${money(avg)}) or more. They're in the buy area, so nothing is chosen for you: exclude one, lower its bid in Google Ads, or leave it.`}
        actions={!admin && <AdminLink />}
      >
        {admin ? (
          <CityExclusionPanel inside cities={expensive.map((c) => ({ ...toOption(c), region: c.reason }))} campaigns={campaigns} existing={existing} />
        ) : (
          !expensive.length && <p className="text-sm text-muted-foreground">No California city spent a lot without results in this period.</p>
        )}
      </Section>

      <Section
        title={`Cities outside California (${formatNumber(outsideAll.length)})`}
        description={`Ads shouldn't reach people here. Cities that spent without converting are pre-selected; ones that converted are highlighted and left for you to decide.${outsideAll.length > OUTSIDE_SHOWN ? ` Showing the ${OUTSIDE_SHOWN} costliest; the other ${formatNumber(outsideAll.length - OUTSIDE_SHOWN)} spent ${formatUsd(outsideRest.cost)} in all. For those, targeting only California (Targeting tab) works better than excluding cities one by one.` : ""}`}
        actions={!admin && <AdminLink />}
      >
        {admin ? (
          <CityExclusionPanel cities={outside.map(toOption)} campaigns={campaigns} existing={existing} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {formatNumber(outsideAll.length)} cities outside California had clicks or spend in this period. They&apos;re red below.
          </p>
        )}
      </Section>

      <Section
        title="By city"
        description={`The ${rows.length > CITIES_SHOWN ? `${CITIES_SHOWN} costliest of ${formatNumber(rows.length)} cities` : `${rows.length} cities`} with spend, clicks, or conversions${rows.length > CITIES_SHOWN ? `; the rest spent ${formatUsd(rest.cost)} for ${formatConversions(rest.conversions)} conversions` : ""}${hidden ? `. ${formatNumber(hidden)} with only impressions are left out` : ""}.`}
      >
        <div className="max-h-[65vh] overflow-y-auto rounded-xl border">
          <DataTable<LocationRow>
            rows={shown}
            rowKey={(r) => r.key}
            rowClassName={(r) => (r.status === "outside" ? "bg-red-50/60" : undefined)}
            columns={[
              {
                key: "city",
                label: "City",
                render: (r) => (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{r.city}</span>
                    <span className="text-xs text-muted-foreground">{r.county ? `${r.county} County` : r.region}</span>
                  </div>
                ),
              },
              {
                key: "area",
                label: "Buy area",
                render: (r) =>
                  r.status === "inside" ? (
                    <Pill tone="green">California</Pill>
                  ) : r.status === "outside" ? (
                    <Pill tone="red">Outside</Pill>
                  ) : (
                    <Pill>Unknown</Pill>
                  ),
              },
              {
                key: "cost",
                label: "Spend",
                align: "right",
                render: (r) => formatUsd(r.metrics.cost),
              },
              {
                key: "clicks",
                label: "Clicks",
                align: "right",
                render: (r) => formatNumber(r.metrics.clicks),
              },
              {
                key: "conv",
                label: "Conversions",
                align: "right",
                render: (r) => formatConversions(r.metrics.conversions),
              },
              {
                key: "cpa",
                label: "Cost / conv.",
                align: "right",
                render: (r) => (cpaOf(r.metrics) === null ? <span className="text-muted-foreground">—</span> : formatUsd(cpaOf(r.metrics)!)),
              },
            ]}
          />
        </div>
      </Section>
    </>
  )
}

// ---- Targeting -------------------------------------------------------------------------------

function Targeting({ targeting, negatives, admin }: { targeting: CampaignTargeting[]; negatives: CampaignNegative[]; admin: boolean }) {
  const running = targeting.filter((t) => t.status === "ENABLED")
  const paused = targeting.filter((t) => t.status !== "ENABLED")
  const exclusions = negatives.filter((n) => n.kind === "location")
  return (
    <>
      <Section
        title="Running campaigns"
        description="Where each campaign shows ads, where it doesn't, and its location setting, with anything that looks wrong."
      >
        {running.length ? (
          running.map((t) => <TargetingCard key={t.id} t={t} />)
        ) : (
          <p className="text-sm text-muted-foreground">No campaign is running right now.</p>
        )}
      </Section>
      {paused.length > 0 && (
        <details className="rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
          <summary className="cursor-pointer font-semibold">
            Paused campaigns that spent in this period ({paused.length})
            <span className="ml-2 text-sm font-normal text-muted-foreground">Worth a check before turning one back on.</span>
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {paused.map((t) => (
              <TargetingCard key={t.id} t={t} />
            ))}
          </div>
        </details>
      )}
      <details className="rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
        <summary className="cursor-pointer font-semibold">
          Excluded locations on running campaigns ({exclusions.length})
          <span className="ml-2 text-sm font-normal text-muted-foreground">Open to see or remove them.</span>
        </summary>
        <div className="mt-3">
          <NegativesList
            canEdit={admin}
            noun="location exclusion"
            empty="No excluded locations yet."
            items={exclusions
              .sort((a, b) => (a.place ?? "").localeCompare(b.place ?? ""))
              .map((n) => ({
                resourceName: n.resourceName,
                label: n.place ?? n.geo ?? "",
                campaignName: n.campaignName,
              }))}
          />
        </div>
      </details>
    </>
  )
}

const PLACES_SHOWN = 12

function TargetingCard({ t }: { t: CampaignTargeting }) {
  const optionLabel =
    t.option === "PRESENCE" ? "People in the area only" : t.option === "PRESENCE_OR_INTEREST" ? "In the area, or searching about it" : t.option || "—"
  // Targets outside California are the problem; excluding them is right, so those stay plain.
  const list = (places: { name: string; outside?: boolean }[], flagOutside: boolean) => (
    <span>
      {places.slice(0, PLACES_SHOWN).map((p, i) => (
        <span key={`${p.name}-${i}`} className={cn(flagOutside && p.outside && "font-medium text-destructive")}>
          {i > 0 && "; "}
          {p.name.replace(/, California$/, "")}
        </span>
      ))}
      {places.length > PLACES_SHOWN && <span className="text-muted-foreground"> and {places.length - PLACES_SHOWN} more</span>}
    </span>
  )
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t.name}</span>
        <span className="flex items-center gap-1.5 text-xs">
          <Pill tone={t.status === "ENABLED" ? "green" : "gray"}>{t.status === "ENABLED" ? "Running" : "Paused"}</Pill>
          <Pill>{optionLabel}</Pill>
        </span>
      </div>
      <dl className="grid gap-1 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted-foreground">Targets ({t.targets.length + t.radius.length})</dt>
        <dd>
          {t.targets.length || t.radius.length ? (
            <>
              {list(t.targets, true)}
              {t.radius.length > 0 && (
                <span>
                  {t.targets.length ? "; " : ""}
                  {t.radius.join("; ")}
                </span>
              )}
            </>
          ) : (
            <span className="text-destructive">Nowhere set</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Excludes ({t.excluded.length})</dt>
        <dd>
          {t.excluded.length ? (
            <>
              {list(t.excluded, false)}
              {t.excluded.some((e) => !e.outside) && (
                <span className="mt-0.5 block text-xs text-amber-800">
                  {t.excluded.filter((e) => !e.outside).length} of these are in California (the buy area), e.g.{" "}
                  {t.excluded
                    .filter((e) => !e.outside)
                    .slice(0, 3)
                    .map((e) => e.name.replace(/, California$/, ""))
                    .join("; ")}
                  . Fine if this campaign is meant for part of the state only.
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">Nothing</span>
          )}
        </dd>
      </dl>
      {t.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {t.warnings.map((w) => (
            <li
              key={w.text}
              className={cn("rounded-lg px-2.5 py-1.5 text-xs", w.tone === "red" ? "bg-red-50 text-red-900" : "bg-amber-50 text-amber-950")}
            >
              {w.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-emerald-700">Looks right.</p>
      )}
    </div>
  )
}
