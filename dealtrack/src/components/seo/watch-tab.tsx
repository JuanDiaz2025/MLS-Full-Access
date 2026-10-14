// Competitors → SEO → Competitor watch (server side): the competitors whose websites are checked,
// what changed on them, the patterns across them, and the cities they have pages for.

import Link from "next/link"
import { ExternalLink } from "lucide-react"

import { DataTable, Pill, Section, type Column } from "@/components/report"
import { AddCompetitor, ChangeList, SiteActions, Suggestions, WatchProgress, WatchSettingsCard } from "@/components/seo/watch-controls"
import { isSignedIn } from "@/lib/auth"
import { OFFER_TAGS } from "@/lib/competitors/ad-analysis"
import { TOPICS } from "@/lib/research/classify"
import { suggestedCompetitors } from "@/lib/seo/competitors"
import { SITUATIONS, urlFacts } from "@/lib/seo/page-read"
import { searchConsoleReport } from "@/lib/seo/search-console"
import { EVERY_CHOICES, PAGE_CHOICES, cityCoverage, patternsOf, sitePages, watchView, type Pattern, type WatchRow } from "@/lib/seo/site-watch"

const fmt = (n: number) => n.toLocaleString("en-US")
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })
const FROM: Record<WatchRow["from"], string> = { auction: "Auction insights", ads: "Competitor ads", manual: "Added by hand" }
const OFFER_LABELS = Object.fromEntries(OFFER_TAGS.map((t) => [t.id, t.label])) as Record<string, string>
const SITUATION_LABELS = Object.fromEntries(TOPICS.filter((t) => SITUATIONS.some((s) => s.id === t.id)).map((t) => [t.id, t.label])) as Record<string, string>
const PATTERN_KIND: Record<Pattern["kind"], string> = { place: "City", situation: "Seller situation", offer: "Offer" }

function LastCheck({ r }: { r: WatchRow }) {
  const run = r.run
  if (!run) return <span className="text-muted-foreground">Not checked yet</span>
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      <span className="text-sm">{day(run.at)}</span>
      {run.blocked ? (
        <span className="text-destructive">Stopped: {run.blocked}. Never got around.</span>
      ) : run.problem ? (
        <span className="text-amber-700 dark:text-amber-400">{run.problem}</span>
      ) : run.baseline ? (
        <span className="text-muted-foreground">The starting point: changes show from the next check.</span>
      ) : (
        <span>
          {run.changes ? <b>{fmt(run.changes)} change{run.changes === 1 ? "" : "s"}</b> : "No changes"}, {fmt(run.read)} page{run.read === 1 ? "" : "s"} read in{" "}
          {run.took < 90 ? `${run.took}s` : `${Math.round(run.took / 60)} min`}
        </span>
      )}
      {run.note && <span className="text-muted-foreground">{run.note}</span>}
    </span>
  )
}

export default async function WatchTab({ admin, site }: { admin: boolean; site?: string }) {
  const [view, suggestions, signedIn, sc] = await Promise.all([watchView(), suggestedCompetitors(), isSignedIn(), searchConsoleReport(28).catch(() => null)])
  const names = Object.fromEntries(view.sites.map((s) => [s.site, s.name]))
  const patterns = patternsOf(view.changes)
  const coverage = cityCoverage(view.sites)
  const ourPlaces = sc ? new Set(sc.pages.flatMap((p) => urlFacts(p.page).places)) : null
  const picked = site ? view.sites.find((s) => s.site === site) : undefined
  const pages = picked ? await sitePages(picked.site) : null

  const columns: Column<WatchRow>[] = [
    {
      key: "site",
      label: "Competitor",
      render: (r) => (
        <span className="flex flex-col gap-1">
          <span className="font-medium">{r.name}</span>
          <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline">
            {r.site} <ExternalLink className="size-3" />
          </a>
          <span className="flex flex-wrap gap-1">
            {r.tier && <Pill tone="violet">Tier {r.tier}</Pill>}
            <Pill>{FROM[r.from]}</Pill>
            {!r.on && <Pill tone="amber">Paused</Pill>}
          </span>
        </span>
      ),
    },
    {
      key: "pages",
      label: "Pages",
      align: "right",
      render: (r) =>
        r.run?.source ? (
          <span className="flex flex-col items-end text-xs">
            <Link href={`?tab=watch&site=${encodeURIComponent(r.site)}#pages`} className="text-sm text-primary tabular-nums hover:underline">
              {fmt(r.run.listed)}
            </Link>
            <span className="text-muted-foreground">{r.run.source === "sitemap" ? "from its sitemap" : "linked from its home page"}</span>
            {r.run.notAllowed > 0 && <span className="text-muted-foreground">{fmt(r.run.notAllowed)} left out (robots.txt)</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">–</span>
        ),
    },
    { key: "last", label: "Last check", className: "min-w-52", render: (r) => <LastCheck r={r} /> },
    {
      key: "next",
      label: "Next check",
      render: (r) =>
        r.asked ? (
          <span className="text-xs">Soon (asked for)</span>
        ) : r.stopped ? (
          <span className="text-xs text-destructive">Blocked 3 checks in a row: only when asked</span>
        ) : r.next ? (
          <span className="text-xs">{day(r.next)}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{r.on ? "Automatic checks off" : "Paused"}</span>
        ),
    },
    {
      key: "cities",
      label: "Has pages about",
      className: "min-w-44",
      render: (r) => {
        const top = Object.entries(r.run?.places ?? {}).sort((a, b) => b[1] - a[1])
        return top.length ? (
          <span className="text-xs">
            {top
              .slice(0, 5)
              .map(([p, n]) => (n > 1 ? `${p} (${n})` : p))
              .join(", ")}
            {top.length > 5 ? ` and ${top.length - 5} more cities` : ""}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No city pages seen</span>
        )
      },
    },
    { key: "actions", label: "", align: "right", render: (r) => <SiteActions admin={admin} site={r.site} on={r.on} tier={r.tier} stopped={r.stopped} /> },
  ]

  return (
    <>
      <Section
        title="Competitors we watch"
        description="Once a week DealTrack reads each competitor's public pages and compares them with the week before: new city and seller-situation pages, pages taken down, and new titles, headlines, offers, cities and phone numbers. It follows each site's robots.txt (the rules a site sets for automated visitors), waits two seconds or more between pages, says who it is (DealTrackBot, with our website), and reads at most 150 pages a check. A site that blocks it is left alone until the next check, never got around. Free: no Bright Data searches."
      >
        <WatchProgress progress={view.progress} />
        <WatchSettingsCard admin={admin} settings={view.settings} everyChoices={EVERY_CHOICES} pageChoices={PAGE_CHOICES} sites={view.sites.length} />
        <DataTable rows={view.sites} columns={columns} rowKey={(r) => r.site} empty="No competitors on the list yet. Add them from Google Ads below, or by their website." />
        <AddCompetitor admin={admin} />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">From Google Ads</h3>
          <p className="text-xs text-muted-foreground">
            Advertisers in our Auction insights downloads and in the Competitor ads searches, not on the list yet. Listing sites (Zillow, Redfin...) are left out.
          </p>
          <Suggestions admin={admin} items={suggestions} />
        </div>
      </Section>

      <Section
        title="Changes to review"
        description="Each change waits for someone to decide: Act (we do something about it), Watch (keep an eye on it) or Ignore. Your name is kept with it. Ignored changes leave the patterns below."
      >
        <ChangeList changes={view.changes} labels={{ offers: OFFER_LABELS, situations: SITUATION_LABELS, names }} signedIn={signedIn} />
      </Section>

      <Section
        title="Patterns"
        description="The same city, seller situation or offer in new or changed pages at two or more competitors in the last 4 weeks: where they're all moving."
      >
        {patterns.length ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {patterns.map((p) => (
              <li key={`${p.kind}|${p.value}`} className="flex flex-wrap items-baseline gap-x-2">
                <Pill tone="violet">{PATTERN_KIND[p.kind]}</Pill>
                <b>{p.kind === "offer" ? (OFFER_LABELS[p.value] ?? p.value) : p.kind === "situation" ? (SITUATION_LABELS[p.value] ?? p.value) : p.value}</b>
                <span>
                  at {p.sites.length} competitors ({p.sites.map((s) => names[s] ?? s).join(", ")}), {fmt(p.changes)} page{p.changes === 1 ? "" : "s"}, latest {day(p.latest)}
                </span>
                {p.kind === "place" && ourPlaces && !ourPlaces.has(p.value) && <span className="text-xs text-amber-700 dark:text-amber-400">We have no page about it in Search Console</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No patterns in the last 4 weeks.</p>
        )}
      </Section>

      <Section
        title="Cities they have pages for"
        description={`From each competitor's pages so far: a page is about a city when its title, headline or address names it.${ourPlaces ? " Ours: a page of ours that Google showed in the last 28 days (Search Console) names it." : " Connect Search Console (Our Google numbers) to see which we have too."}`}
      >
        <DataTable
          rows={coverage.slice(0, 120)}
          rowKey={(r) => r.place}
          empty="No city pages seen yet."
          columns={[
            { key: "place", label: "City", render: (r) => <span className="font-medium">{r.place}</span> },
            { key: "n", label: "Competitors", align: "right", render: (r) => fmt(r.sites.length) },
            {
              key: "who",
              label: "Who",
              render: (r) => (
                <span className="text-xs">
                  {r.sites.map((s) => `${names[s.site] ?? s.site}${s.pages > 1 ? ` (${s.pages} pages)` : ""}`).join(", ")}
                </span>
              ),
            },
            {
              key: "us",
              label: "Us",
              render: (r) =>
                ourPlaces === null ? <span className="text-muted-foreground">–</span> : ourPlaces.has(r.place) ? <Pill tone="green">Yes</Pill> : <Pill tone="amber">No page seen</Pill>,
            },
          ]}
        />
      </Section>

      {picked && pages && (
        <Section id="pages" title={`${picked.name}'s pages`} description={`${fmt(pages.length)} pages from ${picked.site}, as last read. Cities and situations come from each page's title, headline and address.`}>
          <DataTable
            rows={pages.slice(0, 500)}
            rowKey={(p) => p.url}
            columns={[
              {
                key: "url",
                label: "Page",
                className: "max-w-80",
                render: (p) => (
                  <a href={p.url} target="_blank" rel="noreferrer" className={p.gone ? "break-all text-muted-foreground line-through" : "break-all text-primary hover:underline"}>
                    {(() => {
                      try {
                        return new URL(p.url).pathname
                      } catch {
                        return p.url
                      }
                    })()}
                  </a>
                ),
              },
              { key: "title", label: "Title", className: "min-w-56", render: (p) => <span className="text-xs">{p.title || <span className="text-muted-foreground">Not read yet</span>}</span> },
              {
                key: "about",
                label: "About",
                render: (p) => <span className="text-xs">{[...p.places, ...p.situations.map((s) => SITUATION_LABELS[s] ?? s)].join(", ") || "–"}</span>,
              },
              { key: "offers", label: "Offers", render: (p) => <span className="text-xs">{p.offers.map((o) => OFFER_LABELS[o] ?? o).join(", ") || "–"}</span> },
              { key: "words", label: "Words", align: "right", render: (p) => (p.words === null ? "–" : fmt(p.words)) },
              { key: "first", label: "First seen", align: "right", render: (p) => day(p.first) },
              { key: "gone", label: "Gone", align: "right", render: (p) => (p.gone ? day(p.gone) : "") },
            ]}
          />
        </Section>
      )}
    </>
  )
}
