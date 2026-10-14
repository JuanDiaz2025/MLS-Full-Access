// Competitors → SEO → Keywords (server side): our own Semrush for one place. Gathers the keyword
// list and Keyword Planner's numbers, our ads' real search counts, Search Console, the rankings from
// searches already made and the Google Trends answers, then the estimates and the new ideas.

import Link from "next/link"

import { KpiGrid, Section } from "@/components/report"
import Ideas from "@/components/seo/ideas"
import KeywordTable, { type KeywordRow } from "@/components/seo/keyword-table"
import { NavSelect } from "@/components/seo/nav-select"
import { isSignedIn } from "@/lib/auth"
import { brightReady } from "@/lib/competitors/brightdata"
import { freeSearches } from "@/lib/competitors/free-searches"
import { TOPICS, placeOf } from "@/lib/research/classify"
import { estimatedShares, getResearch, volumeLocations } from "@/lib/research/keywords"
import { normalizeKeyword } from "@/lib/research/parse"
import { isDirectory } from "@/lib/research/serp-analysis"
import { OUR_SITES } from "@/lib/research/serp"
import { adsSearches } from "@/lib/seo/ads-searches"
import { CA, estimates, keywordIdeas } from "@/lib/seo/keywords"
import { latestRankings, rankKey, searchIdeas } from "@/lib/seo/rankings"
import { SELLER_TOPICS } from "@/lib/seo/search-analysis"
import { searchConsoleReport } from "@/lib/seo/search-console"
import { getTrends, getTrendsRun, trendsFresh, trendsLimit, trendsProgress } from "@/lib/seo/trends"

const fmt = (n: number) => n.toLocaleString("en-US")

export default async function KeywordsTab({ admin, place: asked }: { admin: boolean; place?: string }) {
  const ready = brightReady()
  const [research, sc, ads, rankings, trends, free, signedIn, trendsRun] = await Promise.all([
    getResearch(),
    searchConsoleReport(28).catch(() => null),
    adsSearches().catch(() => new Map()),
    latestRankings(42),
    getTrends(),
    ready ? freeSearches() : null,
    isSignedIn(),
    getTrendsRun(),
  ])
  const shares = estimatedShares(research.placeTotals, research.keywords)
  const planner = new Set(volumeLocations(research.keywords).map((p) => p.place))
  const searched = new Set(rankings.map((r) => r.loc))
  const places = [...new Set([...planner, ...shares.keys(), ...searched])].filter((p) => p.toLowerCase() !== CA.toLowerCase()).sort()
  const place = asked && places.includes(asked) ? asked : CA
  const ca = place === CA

  // A city's view: keywords without a place, and the ones naming that city.
  const keywords = ca
    ? research.keywords
    : research.keywords.filter((k) => {
        const named = placeOf(k.text)
        return !named || named.toLowerCase() === place.toLowerCase()
      })
  const input = { keywords, shares, ads, sc, rankings, trends, ourSites: OUR_SITES }
  const byRank = new Map(rankings.map((r) => [rankKey(r.loc, r.k), r]))
  const rows: KeywordRow[] = estimates(input, place).map((e) => {
    const t = trends[normalizeKeyword(e.k) ?? e.k]
    return {
      ...e,
      top: (byRank.get(rankKey(place, e.k))?.now.top ?? []).map((site) => ({ site, dir: isDirectory(site), ours: OUR_SITES.includes(site) })),
      trendsFresh: trendsFresh(t),
      trendsNote: t && "error" in t ? t.error : null,
    }
  })

  const known = new Set(research.keywords.map((k) => normalizeKeyword(k.text) ?? k.text))
  const ideas = keywordIdeas(sc, await searchIdeas(42, known), trends, known)

  // Totals over seller searches, each set of close variants (same numbers) counted once.
  const seller = rows.filter((r) => SELLER_TOPICS.has(r.topic))
  const once = new Set<string>()
  let searches = 0
  let visits = 0
  for (const r of seller) {
    if (r.searches === null) continue
    const key = r.trend.length > 1 ? `${r.searches}|${r.trend.join(",")}` : r.k
    if (once.has(key)) continue
    once.add(key)
    searches += r.searches
    visits += r.visits ?? 0
  }
  const checked = seller.filter((r) => r.ourPositionFrom === "Google")
  const page1 = checked.filter((r) => r.ourPosition !== null)
  const withTrends = Object.values(trends).filter((t) => "points" in t).length

  const options = [
    { value: CA, label: "California (all)" },
    ...places.map((p) => ({ value: p, label: `${p}${planner.has(p) ? "" : shares.has(p) ? " (estimated)" : " (rankings only)"}` })),
  ]
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Place</span>
        <NavSelect value={place} options={options} param="place" base={{ tab: "keywords" }} label="Place" />
        <span className="text-xs text-muted-foreground">Cities with Keyword Planner numbers, estimated ones, and the ones searched for rankings.</span>
      </div>

      <KpiGrid
        items={[
          { label: "Seller searches a month", value: searches ? `~${fmt(searches)}` : "–", note: `${place}, estimated, close variants once` },
          { label: "Visits to us a month", value: visits ? `~${fmt(visits)}` : "–", note: "From Google's free results, estimated" },
          {
            label: "On page 1",
            value: checked.length ? `${fmt(page1.length)} of ${fmt(checked.length)}` : "–",
            note: checked.length ? `Seller keywords searched from ${place}` : `Not searched from ${place} yet`,
          },
          sc
            ? { label: "Search Console", value: fmt(sc.totals.impressions), note: `Views in 28 days, ${fmt(sc.totals.clicks)} clicks`, href: "?tab=google", linkLabel: "Our Google numbers" }
            : { label: "Search Console", value: "Not connected", note: "Real views and clicks", href: "?tab=google", linkLabel: "Connect" },
          { label: "Google Trends", value: fmt(withTrends), note: "Keywords with this year's line" },
          ...(free ? [{ label: "Free searches left", value: fmt(free.left), note: `Of ${fmt(free.cap)}, Bright Data` }] : []),
        ]}
      />

      <Section
        title={`Keywords in ${place}`}
        description={
          <>
            Searches a month like Semrush shows them, worked out from what Google tells us: Keyword Planner{ca ? "" : " (this city's own numbers, or California's × the city's share)"}, moved to
            this month with Google Trends or Keyword Planner&apos;s latest month, and never below what our ads and Search Console saw for real. Click a keyword to see how. We
            rank and the top business come from the searches DealTrack already makes (
            <Link href="/competitors/ads" className="text-primary hover:underline">
              Competitor ads
            </Link>{" "}
            and{" "}
            <Link href="/competitors/rankings" className="text-primary hover:underline">
              Google rankings
            </Link>
            ); visits are searches × the share of clicks that place gets{sc?.ctrCurve.some((c) => c.ours) ? " (ours, from Search Console)" : ""}. Keywords come from the{" "}
            <Link href="/competitors/keywords" className="text-primary hover:underline">
              Keyword explorer
            </Link>
            .
          </>
        }
      >
        <KeywordTable
          rows={rows}
          ca={ca}
          place={place}
          topics={TOPICS.map((t) => ({ id: t.id, label: t.label }))}
          sellerTopics={[...SELLER_TOPICS]}
          admin={admin}
          trendsReady={ready}
          freeLeft={free?.left ?? null}
          trendsPerRun={trendsLimit(trendsRun)}
          trendsRun={trendsRun}
          trendsProgress={trendsProgress()}
        />
      </Section>

      <Section
        title="New keyword ideas"
        description="Searches not in the Keyword explorer yet: the ones that showed us in Google (Search Console), what Google lists under “People also ask” and “Related searches” for our keywords, and rising searches from Google Trends. Add them, then get their numbers there."
      >
        <Ideas ideas={ideas} signedIn={signedIn} />
      </Section>
    </>
  )
}
