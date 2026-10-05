import type { Metadata } from "next"

import { PageHeader } from "@/components/report"
import Rankings, { type Tab } from "@/components/research/rankings"
import { isAdmin } from "@/lib/auth"
import { TOPICS, placeOf, topicOf } from "@/lib/research/classify"
import { estimatedShares, getResearch } from "@/lib/research/keywords"
import { analyze, analyzeMaps, localKey } from "@/lib/research/serp-analysis"
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
  type SerpResult,
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

  // For each kind: the scan asked for, else the newest one with results. It's compared with the
  // newest earlier scan of the same kind and service that searched mostly the same things (at
  // least half of this scan's searches), and only on the searches both made: a scan of other
  // keywords would make every site look like it moved.
  const searchKey = (r: SerpResult) => `${r.t ?? ""}|${r.k}|${r.loc}`
  const load = async (kind: ScanKind) => {
    const shown = scans.find((s) => s.id === picked && kindOf(s) === kind) ?? scans.find((s) => kindOf(s) === kind && s.done > 0)
    const now = shown ? ((await getScanResults(shown.id))?.results ?? null) : null
    let comparedAt = ""
    let before: SerpResult[] | undefined
    if (shown && now?.length && kind !== "brand") {
      const mine = new Set(now.filter((r) => !r.err).map(searchKey))
      const earlier = scans.slice(scans.indexOf(shown) + 1).filter((s) => kindOf(s) === kind && s.engine === shown.engine && s.done > 0)
      for (const s of earlier.slice(0, 5)) {
        const same = ((await getScanResults(s.id))?.results ?? []).filter((r) => !r.err && mine.has(searchKey(r)))
        if (same.length >= mine.size / 2) {
          comparedAt = s.at
          before = same
          break
        }
      }
    }
    return { shownId: shown?.id ?? "", comparedAt, now, before }
  }
  const [web, maps, brand] = await Promise.all([load("web"), load("maps"), load("brand")])
  const volumes = new Map(research.keywords.filter((k) => k.volume !== undefined).map((k) => [k.text, k.volume!]))
  for (const k of research.keywords)
    for (const [place, v] of Object.entries(k.local ?? {})) if (v.volume !== undefined) volumes.set(localKey(place, k.text), v.volume)
  // Cities with only Keyword Planner's city total: estimated from California's volume.
  for (const [place, share] of estimatedShares(research.placeTotals, research.keywords))
    for (const k of research.keywords)
      if (k.volume !== undefined && !volumes.has(localKey(place, k.text))) volumes.set(localKey(place, k.text), Math.round(k.volume * share))

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
