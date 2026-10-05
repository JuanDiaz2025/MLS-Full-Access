import type { Metadata } from "next"

import { PageHeader } from "@/components/report"
import CompetitorSites, { type SiteRow } from "@/components/research/competitor-sites"
import { keywordsInUse } from "@/lib/negative-batches"
import { TOPICS, topicOf } from "@/lib/research/classify"
import { getCityVolumes } from "@/lib/research/city-volumes"
import { getSiteReports, suggestedSites } from "@/lib/research/competitor-sites"
import { STATEWIDE_VOLUMES, getResearch } from "@/lib/research/keywords"

export const metadata: Metadata = { title: "Competitor sites · DealTrack" }

// Not seller searches: people buying a home, competitors' names, and everything unsorted.
const NOT_SELLER = new Set(["home-buyers", "competitor", "other"])

export default async function CompetitorSitesPage({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams
  const [reports, research, city, suggested, bids] = await Promise.all([
    getSiteReports(),
    getResearch(),
    getCityVolumes(),
    suggestedSites().catch(() => []),
    keywordsInUse().catch(() => null),
  ])
  const report = reports.find((x) => x.id === r) ?? reports[0]
  const ours = new Set(research.keywords.map((k) => k.text))
  const bidOn = bids ? new Set([...bids.byCampaign.values()].flat()) : null
  const topicLabel = Object.fromEntries(TOPICS.map((t) => [t.id, t.label]))
  // How many of the competitors looked up for the same place also have each keyword.
  const sameplace = reports.filter((x) => report && x.place === report.place)
  const rows: SiteRow[] = (report?.ideas ?? []).map((i) => {
    const topic = topicOf(i.text)
    return {
      ...i,
      topic: topicLabel[topic] ?? topic,
      seller: !NOT_SELLER.has(topic),
      inList: ours.has(i.text),
      weBid: bidOn ? bidOn.has(i.text) : null,
      sites: sameplace.filter((x) => x.ideas.some((y) => y.text === i.text)).length,
    }
  })

  return (
    <>
      <PageHeader
        title="Competitor sites"
        description="The keywords Google ties to a competitor's website, from Keyword Planner, with their searches for California or one of our cities. Keywords they go after that aren't in our list are the gap: add the good ones to the Keyword explorer. One Google Ads API operation per lookup."
      />
      <CompetitorSites
        reports={reports.map((x) => ({ id: x.id, site: x.site, place: x.place, at: x.at, by: x.by, count: x.ideas.length }))}
        current={report?.id ?? ""}
        rows={rows}
        places={[
          STATEWIDE_VOLUMES,
          ...Object.keys(city.places)
            .filter((p) => p !== STATEWIDE_VOLUMES)
            .sort(),
        ]}
        suggested={suggested}
        bidsKnown={!!bidOn}
      />
    </>
  )
}
