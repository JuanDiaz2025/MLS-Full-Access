// Competitors → SEO → Our Google numbers (server side): our own site in Google's free results, from
// Search Console. What to set up first if it isn't connected, then the numbers: clicks, views,
// click rate and position against the period before, the searches almost on page 1, new ones,
// ones losing ground, the cities people name, seller situations, our top searches and pages, and
// our click rate at each position (what the Keywords tab's visits use).

import Link from "next/link"
import { ExternalLink } from "lucide-react"

import TrendChart from "@/components/dashboard/trend-chart"
import { DataTable, KpiGrid, Pill, Section, type Column } from "@/components/report"
import { RefreshButton, SitePicker } from "@/components/seo/search-console-controls"
import { buttonVariants } from "@/components/ui/button"
import { topicOf } from "@/lib/research/classify"
import { almostPageOne, byCity, byTopic, changeOf, droppingSearches, newSearches, type Group } from "@/lib/seo/search-analysis"
import { SEARCH_CONSOLE_LIBRARY, listSites, searchConsoleState, type ScPage, type ScQuery, type SearchConsoleState } from "@/lib/seo/search-console"
import { cn } from "@/lib/utils"

export const SC_PERIODS = [7, 28, 90]
const fmt = (n: number) => n.toLocaleString("en-US")
const pct = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
const CONNECT = "/api/conversions/connect?back=/competitors/seo"

function Setup({ state, admin }: { state: Extract<SearchConsoleState, { ok: false }>; admin: boolean }) {
  const connect = admin ? (
    <a href={CONNECT} className={cn(buttonVariants({ size: "sm" }), "self-start")}>
      Connect Google
    </a>
  ) : (
    <p className="text-sm text-muted-foreground">An admin connects it, once.</p>
  )
  const api = (
    <a href={SEARCH_CONSOLE_LIBRARY} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
      turn on the Search Console API <ExternalLink className="size-3" />
    </a>
  )
  return (
    <Section title="Connect Search Console" description="Search Console is Google's own free report on our site in its free results: every search that showed twinhomebuyer.com, with views, clicks and position.">
      <p className={cn("text-sm font-medium", state.code === "TRANSIENT" ? "text-amber-700 dark:text-amber-400" : "")}>{state.message}</p>
      {state.code === "NOT_CONNECTED" && (
        <>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
            <li>In DealTrack&apos;s Google Cloud project (the one with the Google Ads API), {api}.</li>
            <li>
              Click Connect Google and sign in with a Google account that can open twinhomebuyer.com in Search Console. It&apos;s the same Connect Google as on the Leads
              automation page; it now also asks to read Search Console. Read only: DealTrack changes nothing there.
            </li>
            <li>Pick the property here.</li>
          </ol>
          {connect}
        </>
      )}
      {state.code === "NEEDS_PERMISSION" && (
        <>
          <p className="text-sm">
            Google was connected before DealTrack read Search Console. Connect again and allow “View Search Console data” (read only). If Google says the API is off, {api}{" "}
            first.
          </p>
          {connect}
        </>
      )}
      {state.code === "API_OFF" && (
        <p className="text-sm">
          In DealTrack&apos;s Google Cloud project, {api}, wait a minute, then refresh this page.
        </p>
      )}
      {(state.code === "NO_SITE" || state.code === "NO_ACCESS") && <SitePicker sites={state.sites ?? []} current={state.site ?? null} admin={admin} />}
      {state.code === "TRANSIENT" && <RefreshButton days={28} />}
      {state.email && <p className="text-xs text-muted-foreground">Connected Google account: {state.email}</p>}
    </Section>
  )
}

const searchColumns = (days: number, page = true): Column<ScQuery>[] => [
  {
    key: "q",
    label: "Search",
    render: (q) => (
      <span className="flex flex-wrap items-center gap-1">
        <span className="font-medium">{q.q}</span>
        {topicOf(q.q) === "brand" && <Pill>Our name</Pill>}
      </span>
    ),
  },
  { key: "views", label: "Views", align: "right", render: (q) => fmt(q.impressions) },
  { key: "clicks", label: "Clicks", align: "right", render: (q) => fmt(q.clicks) },
  { key: "ctr", label: "Click rate", align: "right", render: (q) => pct(q.ctr) },
  {
    key: "pos",
    label: "Position",
    align: "right",
    render: (q) => (
      <span className="flex flex-col items-end">
        <b>{q.position.toFixed(1)}</b>
        {q.prev && Math.abs(q.prev.position - q.position) >= 0.5 && (
          <span className={cn("text-[11px]", q.position < q.prev.position ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
            was {q.prev.position.toFixed(1)}
          </span>
        )}
        {!q.prev && <span className="text-[11px] text-muted-foreground">new in {days} days</span>}
      </span>
    ),
  },
  ...(page
    ? [
        {
          key: "page",
          label: "Our page",
          className: "max-w-64",
          render: (q: ScQuery) =>
            q.page ? (
              <a href={q.page} target="_blank" rel="noreferrer" className="text-xs break-all text-primary hover:underline">
                {pathOf(q.page)}
              </a>
            ) : (
              <span className="text-muted-foreground">–</span>
            ),
        },
      ]
    : []),
]

const groupColumns = (label: string): Column<Group>[] => [
  { key: "name", label, render: (g) => <span className="font-medium">{g.name}</span> },
  { key: "searches", label: "Searches", align: "right", render: (g) => fmt(g.searches) },
  { key: "views", label: "Views", align: "right", render: (g) => fmt(g.impressions) },
  { key: "clicks", label: "Clicks", align: "right", render: (g) => fmt(g.clicks) },
  { key: "pos", label: "Avg. position", align: "right", render: (g) => g.position.toFixed(1) },
  { key: "top", label: "Most seen", className: "min-w-56", render: (g) => <span className="text-xs">{g.top.map((q) => q.q).join(" · ")}</span> },
]

export default async function GoogleTab({ admin, days, pick }: { admin: boolean; days: number; pick: boolean }) {
  const state = await searchConsoleState(days)
  if (!state.ok) return <Setup state={state} admin={admin} />
  const r = state.report
  const sites = pick && admin ? await listSites().catch(() => []) : null
  const change = (now: number, before: number) => {
    const c = changeOf(now, before)
    return c === null ? "Nothing the period before" : `${c >= 0 ? "+" : ""}${Math.round(c * 100)}% vs the ${days} days before`
  }
  const posChange = r.prevTotals.position ? r.prevTotals.position - r.totals.position : 0
  const almost = almostPageOne(r)
  const fresh = newSearches(r)
  const dropping = droppingSearches(r)
  const cities = byCity(r)
  const topics = byTopic(r)
  const top = [...r.queries].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
  const pages = [...r.pages].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
  const brand = r.queries.filter((q) => topicOf(q.q) === "brand").reduce((s, q) => s + q.clicks, 0)

  const pageColumns: Column<ScPage>[] = [
    {
      key: "page",
      label: "Page",
      className: "max-w-80",
      render: (p) => (
        <a href={p.page} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">
          {pathOf(p.page)}
        </a>
      ),
    },
    { key: "clicks", label: "Clicks", align: "right", render: (p) => fmt(p.clicks) },
    {
      key: "was",
      label: "Before",
      align: "right",
      render: (p) => <span className="text-muted-foreground">{p.prev ? fmt(p.prev.clicks) : "–"}</span>,
    },
    { key: "views", label: "Views", align: "right", render: (p) => fmt(p.impressions) },
    { key: "ctr", label: "Click rate", align: "right", render: (p) => pct(p.ctr) },
    { key: "pos", label: "Position", align: "right", render: (p) => p.position.toFixed(1) },
  ]

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-muted p-1 font-medium" role="group" aria-label="Period">
            {SC_PERIODS.map((d) => (
              <Link
                key={d}
                href={`?tab=google${d === 28 ? "" : `&days=${d}`}`}
                scroll={false}
                aria-current={d === days ? "true" : undefined}
                className={cn("rounded-md px-3 py-1.5", d === days ? "bg-background shadow-xs" : "text-muted-foreground")}
              >
                Last {d} days
              </Link>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {day(r.current.from)} – {day(r.current.to)} (Google publishes about 2 days late) · {r.site.replace(/^sc-domain:/, "")}
            {admin && (
              <>
                {" "}
                ·{" "}
                <Link href="?tab=google&pick=1" className="text-primary hover:underline">
                  change
                </Link>
              </>
            )}
          </span>
        </div>
        <RefreshButton days={days} />
      </div>
      {sites && (
        <Section title="Search Console property">
          <SitePicker sites={sites} current={r.site} admin={admin} />
        </Section>
      )}

      <KpiGrid
        items={[
          { label: "Clicks", value: fmt(r.totals.clicks), note: change(r.totals.clicks, r.prevTotals.clicks), tone: r.totals.clicks >= r.prevTotals.clicks ? "good" : "bad" },
          { label: "Views", value: fmt(r.totals.impressions), note: change(r.totals.impressions, r.prevTotals.impressions) },
          { label: "Click rate", value: pct(r.totals.ctr), note: r.prevTotals.impressions ? `Was ${pct(r.prevTotals.ctr)}` : "" },
          {
            label: "Average position",
            value: r.totals.position.toFixed(1),
            note: r.prevTotals.position ? (Math.abs(posChange) < 0.1 ? "About the same" : `${Math.abs(posChange).toFixed(1)} places ${posChange > 0 ? "better" : "worse"}`) : "",
            tone: posChange > 0.1 ? "good" : posChange < -0.1 ? "bad" : "default",
          },
          { label: "Searches", value: fmt(r.queries.length), note: `${fmt(fresh.length)} new this period` },
          { label: "Searches for our name", value: r.totals.clicks ? pct(brand / r.totals.clicks) : "–", note: "Of the clicks" },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Clicks a day">
          <TrendChart data={r.daily.map((d) => ({ date: d.date, value: d.clicks }))} color="var(--primary)" label="Clicks" />
        </Section>
        <Section title="Views a day">
          <TrendChart data={r.daily.map((d) => ({ date: d.date, value: d.impressions }))} color="var(--chart-2, var(--primary))" label="Views" />
        </Section>
      </div>

      <Section
        title="Almost on page 1"
        description="Searches where we're at positions 8 to 20: the bottom of page 1 or the top of page 2. A better page, or a few links to it, moves these the most; each place up gets far more clicks."
      >
        <DataTable rows={almost.slice(0, 50)} columns={searchColumns(days)} rowKey={(q) => q.q} empty="None with 10 or more views." />
      </Section>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <Section title="New this period" description={`Searches that showed us in the last ${days} days and not the ${days} before.`}>
          <DataTable rows={fresh.slice(0, 40)} columns={searchColumns(days, false)} rowKey={(q) => q.q} empty="None with 5 or more views." />
        </Section>
        <Section title="Losing ground" description="Clicks halved (from at least 3), or 3 or more places down with real views.">
          <DataTable rows={dropping.slice(0, 40)} columns={searchColumns(days, false)} rowKey={(q) => q.q} empty="Nothing losing ground." />
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <Section title="Cities people name" description="Search Console has no city breakdown: these are searches that name a city.">
          <DataTable rows={cities.slice(0, 40)} columns={groupColumns("City")} rowKey={(g) => g.name} empty="No searches name a city." />
        </Section>
        <Section title="By seller situation" description="Searches grouped the way the Keyword explorer groups keywords.">
          <DataTable rows={topics} columns={groupColumns("Topic")} rowKey={(g) => g.name} />
        </Section>
      </div>

      <Section title="Top searches" description={`What brought people to us from Google's free results in the last ${days} days. Google leaves out rare searches.`}>
        <DataTable rows={top.slice(0, 100)} columns={searchColumns(days)} rowKey={(q) => q.q} />
      </Section>

      <Section title="Top pages">
        <DataTable rows={pages.slice(0, 50)} columns={pageColumns} rowKey={(p) => p.page} />
      </Section>

      <Section
        title="Our click rate by position"
        description="Of 100 people who see us at each position, how many click, from searches that aren't for our name. Ours where we had 50 or more views at that position; Google's usual numbers otherwise. The Keywords tab's visits use these."
      >
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
          {r.ctrCurve.map((c) => (
            <div key={c.position} className="flex flex-col items-center rounded-lg border p-2 text-center">
              <span className="text-xs text-muted-foreground">#{c.position}</span>
              <b className="tabular-nums">{pct(c.ctr)}</b>
              <span className="text-[10px] text-muted-foreground">{c.ours ? "ours" : "usual"}</span>
            </div>
          ))}
        </div>
      </Section>
    </>
  )
}
