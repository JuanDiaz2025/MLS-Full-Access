import type { Metadata } from "next"

import { PageHeader } from "@/components/report"
import KeywordExplorer, { type ExplorerRow } from "@/components/research/keyword-explorer"
import { TOPICS, placeOf, topicOf } from "@/lib/research/classify"
import { getCityVolumes } from "@/lib/research/city-volumes"
import { SOURCE_LABELS, STATEWIDE_VOLUMES, estimateVolume, estimatedShares, getResearch, volumeLocations } from "@/lib/research/keywords"

export const metadata: Metadata = { title: "Keyword explorer · DealTrack" }

// Our own keyword research, like Ahrefs' Keywords Explorer but for home-selling searches: every
// keyword we track, grouped by topic and place, with search volume and bids from Keyword Planner.
// ?vol=San Jose&vol=Oakland adds up the volumes Keyword Planner gave for those places instead of
// California's (estimated ones too, for places with only a city total).

type Vol = { volume?: number; cpcLow?: number; cpcHigh?: number; competition?: string; trend?: number[] }

// Several places' numbers for one keyword: searches and trends added up, the widest bid range,
// and the competition of the place with the most searches.
function combine(list: (Vol | undefined)[]): Vol | undefined {
  const have = list.filter((v): v is Vol => v?.volume !== undefined)
  if (!have.length) return undefined
  if (have.length === 1) return have[0]
  const len = Math.max(...have.map((v) => v.trend?.length ?? 0))
  const trend = len ? Array.from({ length: len }, (_, i) => have.reduce((s, v) => s + (v.trend?.[v.trend.length - len + i] ?? 0), 0)) : undefined
  const lows = have.map((v) => v.cpcLow).filter((n): n is number => n !== undefined)
  const highs = have.map((v) => v.cpcHigh).filter((n): n is number => n !== undefined)
  return {
    volume: have.reduce((s, v) => s + (v.volume ?? 0), 0),
    cpcLow: lows.length ? Math.min(...lows) : undefined,
    cpcHigh: highs.length ? Math.max(...highs) : undefined,
    competition: [...have].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0].competition,
    trend,
  }
}

// Google gives close variants ("for sell house", "house to sell") the same numbers, counted once:
// the same volume, trend and bids (to the cent) mark one group. Small keywords without bids often
// share numbers by chance, so they're never grouped.
function variantKey(v: Vol | undefined) {
  if (!v?.volume || !v.trend?.length || v.cpcHigh === undefined || new Set(v.trend).size < 2) return null
  return `${v.volume}|${v.trend.join(",")}|${v.cpcLow ?? ""}|${v.cpcHigh}`
}

export default async function KeywordExplorerPage({ searchParams }: { searchParams: Promise<{ vol?: string | string[] }> }) {
  const { vol } = await searchParams
  const [{ keywords, imports, volumesNote, placeTotals }, city] = await Promise.all([getResearch(), getCityVolumes()])
  const cityPlaces = Object.values(city.places)
  const places = volumeLocations(keywords)
  const shares = estimatedShares(placeTotals, keywords)
  const real = new Set(places.map((p) => p.place))
  const asked = [...new Set((Array.isArray(vol) ? vol : vol ? [vol] : []).map(String))]
  // California already holds every city, so picking it means California alone.
  const chosen = asked.includes(STATEWIDE_VOLUMES) ? [] : asked.filter((p) => real.has(p) || shares.has(p)).slice(0, 60)
  const estimatedChosen = chosen.filter((p) => !real.has(p))
  const counties = chosen.filter((p) => / County$/.test(p))

  const values = keywords.map((k) =>
    chosen.length ? combine(chosen.map((p) => (real.has(p) ? k.local?.[p] : estimateVolume(k, shares.get(p)!)))) : (k as Vol),
  )
  // The first keyword (shortest, then A–Z) of each variant group carries its searches.
  const leads = new Map<string, string>()
  keywords
    .map((k, i) => ({ text: k.text, key: variantKey(values[i]) }))
    .filter((x) => x.key)
    .sort((a, b) => a.text.length - b.text.length || a.text.localeCompare(b.text))
    .forEach((x) => leads.has(x.key!) || leads.set(x.key!, x.text))

  const rows: ExplorerRow[] = keywords.map((k, i) => {
    const v = values[i]
    const key = variantKey(v)
    const lead = key ? leads.get(key) : undefined
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
      group: key,
      variantOf: lead && lead !== k.text ? lead : undefined,
    }
  })
  const volumeAt =
    keywords
      .flatMap((k) => (chosen.length ? chosen.map((p) => k.local?.[p]?.at ?? "") : [k.volumeAt ?? ""]))
      .sort()
      .at(-1) ?? ""
  const notes = [
    estimatedChosen.length &&
      `Estimated for ${estimatedChosen.join(", ")}: each keyword's California volume × that place's share of California's searches (from Keyword Planner's city totals).`,
    counties.length &&
      chosen.length > counties.length &&
      `${counties.join(" and ")} already include${counties.length === 1 ? "s" : ""} ${counties.length === 1 ? "its" : "their"} cities: any of them picked too are counted twice.`,
  ].filter(Boolean) as string[]
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
          ...places.map((p) => ({ value: p.place, label: p.place })).sort((a, b) => a.label.localeCompare(b.label)),
          ...[...shares.keys()].sort().map((p) => ({ value: p, label: `${p} (est.)` })),
        ]}
        volumesFor={chosen.length ? chosen : [STATEWIDE_VOLUMES]}
        cities={{
          running: city.running,
          run: city.run,
          saved: cityPlaces.length,
          lastAt:
            cityPlaces
              .map((p) => p.at)
              .sort()
              .at(-1) ?? "",
        }}
        estimateNote={notes.join(" ")}
      />
    </>
  )
}
