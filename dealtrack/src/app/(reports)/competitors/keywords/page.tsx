import type { Metadata } from "next"

import { PageHeader } from "@/components/report"
import KeywordExplorer, { type ExplorerRow } from "@/components/research/keyword-explorer"
import { TOPICS, placeOf, topicOf } from "@/lib/research/classify"
import { SOURCE_LABELS, STATEWIDE_VOLUMES, estimateVolume, estimatedShares, getResearch, volumeLocations } from "@/lib/research/keywords"

export const metadata: Metadata = { title: "Keyword explorer · DealTrack" }

// Our own keyword research, like Ahrefs' Keywords Explorer but for home-selling searches: every
// keyword we track, grouped by topic and place, with search volume and bids from Keyword Planner.
// ?vol=San Francisco shows the volumes Keyword Planner gave for that city instead of California's.
export default async function KeywordExplorerPage({ searchParams }: { searchParams: Promise<{ vol?: string }> }) {
  const { vol } = await searchParams
  const { keywords, imports, volumesNote, placeTotals } = await getResearch()
  const places = volumeLocations(keywords)
  const shares = estimatedShares(placeTotals, keywords)
  const place = places.find((p) => p.place === vol)?.place ?? ""
  const share = !place && vol ? shares.get(vol) : undefined
  const estimated = share !== undefined ? vol! : ""
  const rows: ExplorerRow[] = keywords.map((k) => {
    const v = place ? k.local?.[place] : share !== undefined ? estimateVolume(k, share) : k
    return {
      text: k.text,
      topic: topicOf(k.text),
      place: placeOf(k.text) ?? "",
      words: k.text.split(" ").length,
      volume: v?.volume ?? null,
      cpcLow: v?.cpcLow ?? null,
      cpcHigh: v?.cpcHigh ?? null,
      competition: v?.competition ?? "",
      trend: v?.trend ?? [],
      sources: k.sources,
    }
  })
  const volumeAt =
    keywords
      .map((k) => (place ? (k.local?.[place]?.at ?? "") : (k.volumeAt ?? "")))
      .sort()
      .at(-1) ?? ""
  return (
    <>
      <PageHeader
        title="Keyword explorer"
        description="Our own keyword research for home-selling searches, like Ahrefs or Semrush: every keyword we track, grouped by topic and city, with monthly searches and bid ranges from Google's Keyword Planner (California). Add keywords from a Google Ads report (only the keywords are kept), a Keyword Planner export, by hand, or from Google's search suggestions."
      />
      <KeywordExplorer
        rows={rows}
        topics={TOPICS.map((t) => ({ id: t.id, label: t.label }))}
        sourceLabels={SOURCE_LABELS}
        imports={imports}
        volumesNote={volumesNote ?? ""}
        volumeAt={volumeAt}
        volumePlaces={[
          { value: STATEWIDE_VOLUMES, label: "California (all)" },
          ...places.map((p) => ({ value: p.place, label: p.place })),
          ...[...shares.keys()].map((p) => ({ value: p, label: `${p} (est.)` })),
        ]}
        volumesFor={place || estimated || STATEWIDE_VOLUMES}
        estimateNote={
          share !== undefined
            ? `Estimated: each keyword's California volume × ${estimated}'s share of California's searches (${(share * 100).toFixed(1)}%, from Keyword Planner's city totals). Upload a Keyword Planner file run for ${estimated} alone for its real numbers.`
            : ""
        }
      />
    </>
  )
}
