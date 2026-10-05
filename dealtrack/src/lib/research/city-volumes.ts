// Every targeted city's own search volumes, straight from Keyword Planner (needs Basic access):
// the places our running campaigns target in California, one Keyword Planner request each, one
// after another in the background. Each city's numbers land in the Keyword explorer under
// "Volumes for", the same as a Keyword Planner file run for that city alone, and replace the
// estimates. About one API operation per city; refreshed once a month (instrumentation.ts).

import { gaql } from "@/lib/google-ads/client"
import { geoNames } from "@/lib/google-ads/reports"
import { jsonFileStore } from "@/lib/json-file-store"
import { CALIFORNIA, STATEWIDE_VOLUMES, getResearch, isExplorerRefusal, plannerKeywords, plannerMetrics, saveVolumes } from "@/lib/research/keywords"
import { serviceAreaStatus } from "@/lib/service-area"
import { shared } from "@/lib/shared-state"

export type Place = { name: string; geo: string }
export type CityRun = {
  by: string
  startedAt: string
  finishedAt?: string
  total: number
  done: number
  current?: string
  failures: string[]
  stopped?: boolean
}
type File = { places: Record<string, { geo: string; at: string; keywords: number }>; run?: CityRun }

const file = jsonFileStore<File>("city-volumes.json", () => ({ places: {} }))
const job = shared("city-volumes-job", () => ({ running: false, stop: false }))
export const REFRESH_DAYS = 30
const PAUSE_MS = 1_500 // between cities: Keyword Planner also limits requests per minute
const RETRIES = 3

export async function getCityVolumes() {
  const f = await file.read()
  return { places: f.places ?? {}, run: f.run, running: job.running }
}

// California first, then the places running campaigns target there (cities and counties), by
// Google's own names: "Oakland", "Alameda County".
export async function targetedPlaces(): Promise<Place[]> {
  const rows = await gaql<{ campaignCriterion: { location?: { geoTargetConstant?: string } } }>(
    `SELECT campaign_criterion.location.geo_target_constant FROM campaign_criterion
     WHERE campaign.status = 'ENABLED' AND campaign_criterion.type = 'LOCATION' AND campaign_criterion.negative = FALSE
       AND campaign_criterion.status != 'REMOVED'`,
  )
  const geos = [...new Set(rows.map((r) => r.campaignCriterion.location?.geoTargetConstant).filter((g): g is string => !!g))]
  const names = await geoNames(geos)
  const places = new Map<string, Place>()
  for (const [geo, n] of names) {
    if (geo === CALIFORNIA || serviceAreaStatus(n.canonical).status !== "inside" || !n.name) continue
    places.set(n.name, { name: n.name, geo })
  }
  return [{ name: STATEWIDE_VOLUMES, geo: CALIFORNIA }, ...[...places.values()].sort((a, b) => a.name.localeCompare(b.name))]
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tooFast = (e: unknown) => e instanceof Error && /^Too many requests/.test(e.message)

// Starts the background run (one at a time for the whole app). `onlyOlderThanDays` skips places
// fetched more recently than that, for the monthly refresh.
export async function startCityVolumes(by: string, onlyOlderThanDays = 0): Promise<{ ok: boolean; message: string }> {
  if (job.running) return { ok: false, message: "Already getting city volumes. Watch the progress below." }
  const { keywords } = await getResearch()
  const texts = plannerKeywords(keywords)
  if (!texts.length) return { ok: false, message: "Add keywords first." }
  const all = await targetedPlaces()
  const { places: saved } = await getCityVolumes()
  const cutoff = Date.now() - onlyOlderThanDays * 86_400_000
  const places = onlyOlderThanDays ? all.filter((p) => !saved[p.name] || Date.parse(saved[p.name].at) < cutoff) : all
  if (!places.length) return { ok: true, message: "Every targeted place is up to date." }

  job.running = true
  job.stop = false
  const run: CityRun = { by, startedAt: new Date().toISOString(), total: places.length, done: 0, failures: [] }
  await file.update((f) => {
    f.run = run
  })
  const save = (change: (r: CityRun, f: File) => void) =>
    file.update((f) => {
      f.places ??= {}
      change((f.run ??= run), f)
    })

  void (async () => {
    try {
      for (const [i, p] of places.entries()) {
        if (job.stop) {
          await save((r) => (r.stopped = true))
          break
        }
        await save((r) => (r.current = p.name))
        for (let attempt = 0; ; attempt++) {
          try {
            const found = await plannerMetrics(texts, p.geo)
            await saveVolumes(p.name, found)
            await save((r, f) => {
              r.done++
              f.places[p.name] = { geo: p.geo, at: new Date().toISOString(), keywords: found.size }
            })
            break
          } catch (e) {
            if (tooFast(e) && attempt < RETRIES) {
              await pause(60_000)
              continue
            }
            const why = isExplorerRefusal(e) ? "Google says the app doesn't have Basic access yet" : e instanceof Error ? e.message : String(e)
            await save((r) => {
              r.done++
              r.failures.push(`${p.name}: ${why}`)
            })
            // Explorer access or the daily limit fails every city the same way: stop there.
            if (isExplorerRefusal(e) || (e instanceof Error && /daily Google Ads API limit/.test(e.message))) {
              await save((r) => (r.stopped = true))
              return
            }
            break
          }
        }
        if (i < places.length - 1) await pause(PAUSE_MS)
      }
    } finally {
      await save((r) => {
        r.current = undefined
        r.finishedAt = new Date().toISOString()
      }).catch(() => undefined)
      job.running = false
    }
  })()

  return {
    ok: true,
    message: `Getting volumes for ${places.length} place${places.length === 1 ? "" : "s"} from Keyword Planner, one at a time. You can leave this page.`,
  }
}

export function stopCityVolumes() {
  if (job.running) job.stop = true
}

// Once a month: places whose numbers are older than REFRESH_DAYS.
export async function refreshCityVolumesIfDue() {
  const { places, running } = await getCityVolumes()
  if (running || !Object.keys(places).length) return // only after someone ran it once
  await startCityVolumes("DealTrack (monthly refresh)", REFRESH_DAYS)
}
