import type { Metadata } from "next"

import { PageHeader } from "@/components/report"
import Rankings from "@/components/research/rankings"
import { isAdmin } from "@/lib/auth"
import { TOPICS, placeOf, topicOf } from "@/lib/research/classify"
import { getResearch } from "@/lib/research/keywords"
import { analyze } from "@/lib/research/serp-analysis"
import { ENGINE_LABELS, OUR_SITES, PLACE_CHOICES, enginesReady, getScanResults, getScans, scanRunning, serperBalance } from "@/lib/research/serp"

export const metadata: Metadata = { title: "Google rankings · DealTrack" }

// Who shows up on Google for our keywords, city by city: like Ahrefs' or Semrush's competitor
// reports, from our own scans. The scan form, the competitors, each keyword's top 10, and past scans.
export default async function RankingsPage({ searchParams }: { searchParams: Promise<{ scan?: string }> }) {
  const { scan: picked } = await searchParams
  const [scans, research, balance, admin] = await Promise.all([getScans(), getResearch(), serperBalance(), isAdmin()])

  const shown = scans.find((s) => s.id === picked) ?? scans.find((s) => s.done > 0) ?? scans[0]
  // Compared against the scan before it from the same service.
  const older = shown ? scans.slice(scans.indexOf(shown) + 1).find((s) => s.engine === shown.engine && s.done > 0) : undefined
  const [results, before] = await Promise.all([shown ? getScanResults(shown.id) : null, older ? getScanResults(older.id) : null])
  const volumes = new Map(research.keywords.filter((k) => k.volume !== undefined).map((k) => [k.text, k.volume!]))
  const analysis = results ? analyze(results.results, volumes, before?.results, OUR_SITES) : null

  return (
    <>
      <PageHeader
        title="Google rankings"
        description="Who shows up on Google for our keywords, city by city: the top 10 results for each search. A scan searches each keyword once (in each place you pick), then this page shows each competitor's share of the searches, where they rank and with which page, and how it changed since the scan before. Keywords come from the Keyword explorer."
      />
      <Rankings
        admin={admin}
        engines={enginesReady()}
        engineLabels={ENGINE_LABELS}
        balance={balance.value}
        balanceError={balance.error}
        running={scanRunning()}
        scans={scans}
        shownId={shown?.id ?? ""}
        comparedAt={older?.at ?? ""}
        analysis={analysis}
        topics={TOPICS.map((t) => ({ id: t.id, label: t.label }))}
        places={PLACE_CHOICES}
        keywords={research.keywords.map((k) => ({ t: topicOf(k.text), v: k.volume ?? null, named: Boolean(placeOf(k.text)) }))}
      />
    </>
  )
}
