// Competitors → SEO → Rankings by city (server side): who's in Google's top 10 for our keywords in
// each city, from the searches DealTrack already makes (the weekly Competitor ads searches keep the
// top 10; Google rankings scans too). No extra searches. Who ranks most, with their estimated
// visits; each city; and each keyword in each city, with who moved since the check before.

import Link from "next/link"

import { DataTable, KpiGrid, Pill, Section, type Column } from "@/components/report"
import { NavSelect } from "@/components/seo/nav-select"
import { WatchButton } from "@/components/seo/watch-controls"
import { getResearch, estimatedShares } from "@/lib/research/keywords"
import { isDirectory } from "@/lib/research/serp-analysis"
import { OUR_SITES } from "@/lib/research/serp"
import { adsSearches } from "@/lib/seo/ads-searches"
import { getWatchList } from "@/lib/seo/competitors"
import { siteTraffic } from "@/lib/seo/keywords"
import { latestRankings, topSites, type Mover, type Ranking } from "@/lib/seo/rankings"
import { searchConsoleReport } from "@/lib/seo/search-console"
import { getTrends } from "@/lib/seo/trends"
import { cn } from "@/lib/utils"

const fmt = (n: number) => n.toLocaleString("en-US")
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })
const DAYS = 42

function Move({ r }: { r: Ranking }) {
  const now = r.now.ours
  const before = r.before ? r.before.ours : undefined
  if (now === null)
    return (
      <span className="flex flex-col items-end">
        <span className="text-muted-foreground">Not in top 10</span>
        {before ? <span className="text-[11px] text-destructive">was #{before}</span> : null}
      </span>
    )
  return (
    <span className="flex flex-col items-end">
      <b>#{now}</b>
      {before === null && <span className="text-[11px] text-emerald-700 dark:text-emerald-400">new in top 10</span>}
      {typeof before === "number" && before !== now && (
        <span className={cn("text-[11px]", now < before ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>was #{before}</span>
      )}
    </span>
  )
}

export default async function RankingsTab({ admin, place, dirs }: { admin: boolean; place?: string; dirs: boolean }) {
  const [all, research, ads, sc, trends, watched] = await Promise.all([
    latestRankings(DAYS),
    getResearch(),
    adsSearches().catch(() => new Map()),
    searchConsoleReport(28).catch(() => null),
    getTrends(),
    getWatchList(),
  ])
  const places = [...new Set(all.map((r) => r.loc))].sort()
  const where = place && places.includes(place) ? place : ""
  const rows = where ? all.filter((r) => r.loc === where) : all
  const traffic = siteTraffic({ keywords: research.keywords, shares: estimatedShares(research.placeTotals, research.keywords), ads, sc, rankings: rows, trends, ourSites: OUR_SITES }, rows)
  const watching = new Set(watched.map((w) => w.site))
  const movers = topSites(rows).filter((m) => dirs || !m.directory || m.ours)
  const ours = rows.filter((r) => r.now.ours !== null)
  const top3 = rows.filter((r) => r.now.ours !== null && r.now.ours <= 3)
  const leader = topSites(rows).find((m) => !m.ours && !m.directory)

  const moverColumns: Column<Mover>[] = [
    {
      key: "site",
      label: "Site",
      render: (m) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={cn("font-medium", m.ours && "text-emerald-700 dark:text-emerald-400")}>{m.ours ? `${m.site} (us)` : m.site}</span>
          {m.directory && <Pill>Listing site</Pill>}
        </span>
      ),
    },
    { key: "results", label: "In top 10", align: "right", render: (m) => fmt(m.results) },
    { key: "top3", label: "Top 3", align: "right", render: (m) => fmt(m.top3) },
    { key: "firsts", label: "#1", align: "right", render: (m) => fmt(m.firsts) },
    {
      key: "visits",
      label: "Visits a month (est.)",
      align: "right",
      render: (m) => {
        const t = traffic.get(m.site)
        return t?.visits ? `~${fmt(t.visits)}` : <span className="text-muted-foreground">–</span>
      },
    },
    {
      key: "watch",
      label: "",
      align: "right",
      render: (m) => (m.ours || m.directory || !admin ? null : <WatchButton site={m.site} watching={watching.has(m.site)} />),
    },
  ]

  // Each city: how many searches were checked, how we did, and which business is first most often
  // (listing sites too when they're shown).
  const cities = places
    .filter((p) => !where || p === where)
    .map((p) => {
      const list = all.filter((r) => r.loc === p)
      const mine = list.filter((r) => r.now.ours !== null)
      const firsts = new Map<string, number>()
      for (const r of list) {
        const first = r.now.top.find((s) => !OUR_SITES.includes(s) && (dirs || !isDirectory(s)))
        if (first) firsts.set(first, (firsts.get(first) ?? 0) + 1)
      }
      const best = [...firsts.entries()].sort((a, b) => b[1] - a[1])[0]
      return {
        place: p,
        checked: list.length,
        ours: mine.length,
        best: mine.length ? Math.min(...mine.map((r) => r.now.ours!)) : null,
        leader: best ? `${best[0]} (${best[1]})` : "",
        at: list.map((r) => r.now.at).sort().at(-1) ?? "",
      }
    })

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Place</span>
        <NavSelect
          value={where}
          options={[{ value: "", label: `Every place (${places.length})` }, ...places.map((p) => ({ value: p, label: p }))]}
          param="place"
          base={{ tab: "rankings", ...(dirs ? { dirs: "1" } : {}) }}
          label="Place"
        />
        <Link href={`?tab=rankings${where ? `&place=${encodeURIComponent(where)}` : ""}${dirs ? "" : "&dirs=1"}`} scroll={false} className="text-xs text-primary hover:underline">
          {dirs ? "Hide listing sites" : "Show listing sites (Zillow, Redfin...)"}
        </Link>
      </div>

      {!rows.length ? (
        <p className="rounded-2xl border bg-card p-6 text-center text-sm text-muted-foreground">
          No searches with Google&apos;s top 10 in the last {DAYS} days. They come from the weekly{" "}
          <Link href="/competitors/ads" className="text-primary hover:underline">
            Competitor ads
          </Link>{" "}
          searches and from{" "}
          <Link href="/competitors/rankings" className="text-primary hover:underline">
            Google rankings
          </Link>{" "}
          scans.
        </p>
      ) : (
        <>
          <KpiGrid
            items={[
              { label: "Searches checked", value: fmt(rows.length), note: `Keyword × city, last ${DAYS} days` },
              { label: "Places", value: fmt(where ? 1 : places.length) },
              { label: "We're in the top 10", value: `${Math.round((ours.length / rows.length) * 100)}%`, note: `${fmt(ours.length)} of ${fmt(rows.length)}` },
              { label: "We're in the top 3", value: fmt(top3.length) },
              { label: "Most in the top 10", value: leader ? fmt(leader.results) : "–", note: leader?.site ?? "" },
            ]}
          />

          <Section
            title="Who ranks most"
            description="Sites in Google's top 10 most often, across the keyword × city searches checked. Visits a month: each search's estimated searches there × the share of clicks its position gets, like Semrush's traffic, only over these searches."
          >
            <DataTable rows={movers.slice(0, 40)} columns={moverColumns} rowKey={(m) => m.site} />
          </Section>

          {!where && (
            <Section title="By city">
              <DataTable
                rows={cities}
                rowKey={(c) => c.place}
                columns={[
                  {
                    key: "place",
                    label: "City",
                    render: (c) => (
                      <Link href={`?tab=rankings&place=${encodeURIComponent(c.place)}`} scroll={false} className="font-medium text-primary hover:underline">
                        {c.place}
                      </Link>
                    ),
                  },
                  { key: "checked", label: "Searches", align: "right", render: (c) => fmt(c.checked) },
                  { key: "ours", label: "We're in the top 10", align: "right", render: (c) => `${fmt(c.ours)} (${Math.round((c.ours / Math.max(1, c.checked)) * 100)}%)` },
                  { key: "best", label: "Our best", align: "right", render: (c) => (c.best ? `#${c.best}` : "–") },
                  { key: "leader", label: dirs ? "First most often" : "Top business most often", render: (c) => <span className="text-xs">{c.leader || "–"}</span> },
                  { key: "at", label: "Last checked", align: "right", render: (c) => (c.at ? day(c.at) : "–") },
                ]}
              />
            </Section>
          )}

          <Section title={where ? `Keywords in ${where}` : "Each keyword in each city"} description="The newest check of each, from a computer when there was one, with where we were in the check before. Open a row for the whole top 10.">
            <DataTable
              rows={rows.slice(0, 400)}
              rowKey={(r) => `${r.loc}|${r.k}`}
              columns={[
                {
                  key: "k",
                  label: "Keyword",
                  className: "min-w-56",
                  render: (r) => (
                    <details>
                      <summary className="cursor-pointer font-medium">{r.k}</summary>
                      <ol className="mt-1 list-decimal pl-5 text-xs">
                        {r.now.top.map((s, i) => (
                          <li key={`${s}-${i}`} className={cn(OUR_SITES.includes(s) && "font-semibold text-emerald-700 dark:text-emerald-400")}>
                            {r.now.pages[s] ? (
                              <a href={r.now.pages[s]} target="_blank" rel="noreferrer" className="break-all hover:underline">
                                {s}
                              </a>
                            ) : (
                              s
                            )}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ),
                },
                ...(where ? [] : [{ key: "loc", label: "City", render: (r: Ranking) => r.loc }]),
                { key: "us", label: "Us", align: "right" as const, render: (r: Ranking) => <Move r={r} /> },
                ...[0, 1, 2].map((i) => ({
                  key: `p${i}`,
                  label: `#${i + 1}`,
                  render: (r: Ranking) => <span className={cn("text-xs", OUR_SITES.includes(r.now.top[i] ?? "") && "font-semibold text-emerald-700 dark:text-emerald-400")}>{r.now.top[i] ?? "–"}</span>,
                })),
                { key: "at", label: "Checked", align: "right" as const, render: (r: Ranking) => <span className="text-xs whitespace-nowrap">{day(r.now.at)}{r.now.dev === "mobile" ? " (phone)" : ""}</span> },
              ]}
            />
            {rows.length > 400 && <p className="text-xs text-muted-foreground">The first 400 of {fmt(rows.length)}: pick a place above.</p>}
          </Section>
        </>
      )}
    </>
  )
}
