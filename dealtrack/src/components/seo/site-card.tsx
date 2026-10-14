// Competitors → Competitor sites: the site looked up, on Google (from the searches DealTrack made)
// and in the SEO tab's Competitor watch.

import Link from "next/link"

import { Section } from "@/components/report"
import { WatchButton } from "@/components/seo/watch-controls"
import { estimatedShares, getResearch } from "@/lib/research/keywords"
import { OUR_SITES } from "@/lib/research/serp"
import { siteOf } from "@/lib/research/site"
import { adsSearches } from "@/lib/seo/ads-searches"
import { siteTraffic } from "@/lib/seo/keywords"
import { latestRankings } from "@/lib/seo/rankings"
import { searchConsoleReport } from "@/lib/seo/search-console"
import { watchView } from "@/lib/seo/site-watch"
import { getTrends } from "@/lib/seo/trends"

const fmt = (n: number) => n.toLocaleString("en-US")

export default async function SiteSeoCard({ site, admin }: { site: string; admin: boolean }) {
  const domain = siteOf(site)
  if (!domain) return null
  const [rankings, research, ads, sc, trends, view] = await Promise.all([
    latestRankings(42),
    getResearch(),
    adsSearches().catch(() => new Map()),
    searchConsoleReport(28).catch(() => null),
    getTrends(),
    watchView(),
  ])
  const t = siteTraffic({ keywords: research.keywords, shares: estimatedShares(research.placeTotals, research.keywords), ads, sc, rankings, trends, ourSites: OUR_SITES }, rankings).get(domain)
  const watched = view.sites.find((s) => s.site === domain)
  const cities = Object.entries(watched?.run?.places ?? {}).sort((a, b) => b[1] - a[1])
  const open = view.changes.filter((c) => c.site === domain && c.status === "new").length

  return (
    <Section
      title={`${domain} in Google's free results`}
      description={
        <>
          From the keyword × city searches DealTrack made in the last 6 weeks, and the weekly look at its website. More in{" "}
          <Link href="/competitors/seo?tab=rankings" className="text-primary hover:underline">
            SEO
          </Link>
          .
        </>
      }
    >
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">In Google&apos;s top 10</dt>
          <dd>
            {rankings.length ? (
              <>
                <b>{fmt(t?.results ?? 0)}</b> of {fmt(rankings.length)} searches checked{t?.top3 ? `, ${fmt(t.top3)} in the top 3` : ""}
              </>
            ) : (
              "No searches checked yet"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Visits a month from them (est.)</dt>
          <dd>{t?.visits ? <b>~{fmt(t.visits)}</b> : "–"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Website watch</dt>
          <dd className="flex flex-col items-start gap-1">
            {watched?.run?.source ? (
              <Link href={`/competitors/seo?tab=watch&site=${encodeURIComponent(domain)}#pages`} className="text-primary hover:underline">
                {fmt(watched.run.listed)} pages, {cities.length} cit{cities.length === 1 ? "y" : "ies"}
                {open ? `, ${fmt(open)} change${open === 1 ? "" : "s"} to review` : ""}
              </Link>
            ) : watched ? (
              <span>Watched, not checked yet</span>
            ) : (
              <span className="text-muted-foreground">Not watched</span>
            )}
            {admin && !OUR_SITES.includes(domain) && <WatchButton site={domain} watching={!!watched} />}
          </dd>
        </div>
      </dl>
    </Section>
  )
}
