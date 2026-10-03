import type { Metadata } from "next"

import { PageHeader } from "@/components/report"
import KeywordExplorer, { type ExplorerRow } from "@/components/research/keyword-explorer"
import { TOPICS, placeOf, topicOf } from "@/lib/research/classify"
import { SOURCE_LABELS, getResearch } from "@/lib/research/keywords"

export const metadata: Metadata = { title: "Keyword explorer · DealTrack" }

// Our own keyword research, like Ahrefs' Keywords Explorer but for home-selling searches: every
// keyword we track, grouped by topic and place, with search volume and bids from Keyword Planner.
export default async function KeywordExplorerPage() {
  const { keywords, imports, volumesNote } = await getResearch()
  const rows: ExplorerRow[] = keywords.map((k) => ({
    text: k.text,
    topic: topicOf(k.text),
    place: placeOf(k.text) ?? "",
    words: k.text.split(" ").length,
    volume: k.volume ?? null,
    cpcLow: k.cpcLow ?? null,
    cpcHigh: k.cpcHigh ?? null,
    competition: k.competition ?? "",
    trend: k.trend ?? [],
    sources: k.sources,
  }))
  const volumeAt =
    keywords
      .map((k) => k.volumeAt ?? "")
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
      />
    </>
  )
}
