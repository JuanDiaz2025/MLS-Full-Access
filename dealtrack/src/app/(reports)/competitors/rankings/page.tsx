import type { Metadata } from "next"

import { PageHeader } from "@/components/report"
import Rankings, { type Tab } from "@/components/research/rankings"
import { isAdmin } from "@/lib/auth"
import { TOPICS, placeOf, topicOf } from "@/lib/research/classify"
import { getResearch } from "@/lib/research/keywords"
import { analyze, analyzeMaps } from "@/lib/research/serp-analysis"
import {
  BRAND_QUERIES,
  ENGINE_LABELS,
  KIND_LABELS,
  OUR_SITES,
  PLACE_CHOICES,
  enginesReady,
  getReviews,
  getScanResults,
  getScans,
  scanRunning,
  serperBalance,
  type Scan,
  type ScanKind,
} from "@/lib/research/serp"

export const metadata: Metadata = { title: "Google rankings · DealTrack" }

const TABS: Tab[] = ["sites", "keywords", "maps", "brand", "scans"]
const REGION =
  /^(california|bay area|northern california|southern california|central valley|central coast|inland empire|peninsula|east bay|south bay|north bay|silicon valley|norcal|socal|marin|contra costa|solano|orange county)$/i

// Who shows up on Google for our keywords, city by city: like Ahrefs' or Semrush's competitor
// reports, from our own scans. The scan form, the competitors, each keyword's top 10, Google Maps
// and reviews, the brand check, and past scans.
export default async function RankingsPage({ searchParams }: { searchParams: Promise<{ scan?: string; tab?: string }> }) {
  const { scan: picked, tab } = await searchParams
  const [scans, research, balance, admin, reviews] = await Promise.all([getScans(), getResearch(), serperBalance(), isAdmin(), getReviews()])
  const kindOf = (s: Scan): ScanKind => s.kind ?? "web"

  // For each kind: the scan asked for, else the newest one with results; compared against the
  // scan before it of the same kind and service.
  const pick = (kind: ScanKind) => {
    const shown = scans.find((s) => s.id === picked && kindOf(s) === kind) ?? scans.find((s) => kindOf(s) === kind && s.done > 0)
    const older = shown ? scans.slice(scans.indexOf(shown) + 1).find((s) => kindOf(s) === kind && s.engine === shown.engine && s.done > 0) : undefined
    return { shown, older }
  }
  const load = async (kind: ScanKind) => {
    const { shown, older } = pick(kind)
    const [now, before] = await Promise.all([shown ? getScanResults(shown.id) : null, older ? getScanResults(older.id) : null])
    return { shownId: shown?.id ?? "", comparedAt: older?.at ?? "", now: now?.results ?? null, before: before?.results }
  }
  const [web, maps, brand] = await Promise.all([load("web"), load("maps"), load("brand")])
  const volumes = new Map(research.keywords.filter((k) => k.volume !== undefined).map((k) => [k.text, k.volume!]))

  return (
    <>
      <PageHeader
        title="Google rankings"
        description="Who shows up on Google for our keywords, city by city: the top 10 results, the businesses on Google Maps and their reviews, and what a seller sees when they look us up. Each scan is saved, so the next one shows who moved up or down. Keywords come from the Keyword explorer."
      />
      <Rankings
        admin={admin}
        engines={enginesReady()}
        engineLabels={ENGINE_LABELS}
        kindLabels={KIND_LABELS}
        balance={balance.value}
        balanceError={balance.error}
        running={scanRunning()}
        scans={scans}
        web={{ shownId: web.shownId, comparedAt: web.comparedAt, analysis: web.now ? analyze(web.now, volumes, web.before, OUR_SITES) : null }}
        maps={{ shownId: maps.shownId, comparedAt: maps.comparedAt, analysis: maps.now ? analyzeMaps(maps.now, maps.before, OUR_SITES) : null }}
        brand={{ shownId: brand.shownId, results: brand.now ?? [] }}
        brandQueries={BRAND_QUERIES}
        reviews={reviews}
        initialTab={TABS.includes(tab as Tab) ? (tab as Tab) : "sites"}
        topics={TOPICS.map((t) => ({ id: t.id, label: t.label }))}
        places={PLACE_CHOICES}
        keywords={research.keywords.map((k) => {
          const place = placeOf(k.text)
          return { t: topicOf(k.text), v: k.volume ?? null, named: !place ? "" : REGION.test(place) ? "region" : "city" }
        })}
      />
    </>
  )
}
