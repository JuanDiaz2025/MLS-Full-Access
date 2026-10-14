// Competitors → Competitor ads: the weekly sampling. Each week it searches our core seller
// keywords from our cities through Bright Data, at random times (mostly 6 AM to 10 PM Pacific, a
// few at night, any day), so a competitor that runs out of budget by evening or skips weekends
// shows up as such. Combinations searched least lately go first, a quarter on a phone by default.
// Every search is a sample (ad-samples.ts), with or without ads.
//
// It only uses Bright Data's free searches (free-searches.ts), runs while the app is open, and on
// a team only on the main computer (the one that sends leads to Google Ads), so two computers
// can't both spend them. Settings and this week's plan are in .data/ad-sampler.json.
import { readSamples, sampleOf, saveSample } from "@/lib/competitors/ad-samples"
import { BrightDataError, FreeSearchesUsedUp, brightReady, searchGoogle, type Device } from "@/lib/competitors/brightdata"
import { FREE_LIMIT, WINDOW_DAYS } from "@/lib/competitors/free-searches"
import { jsonFileStore } from "@/lib/json-file-store"
import { sentElsewhere } from "@/lib/leads/wordpress"
import { targetedPlaces } from "@/lib/research/city-volumes"
import { PLACE_CHOICES, STATEWIDE, scanPlaces } from "@/lib/research/serp"
import { shared } from "@/lib/shared-state"

// The searches a seller makes when they want a cash buyer, without a city: each is searched from
// each city. Edited on the page.
export const CORE_SEARCHES = [
  "sell my house fast",
  "we buy houses",
  "cash home buyers",
  "sell my house for cash",
  "companies that buy houses",
  "cash for houses",
  "sell house as is",
  "sell inherited house",
  "buy my house",
  "sell my home fast",
  "we buy houses for cash",
  "cash offer for my house",
  "sell house fast for cash",
  "who buys houses for cash",
  "sell my house without a realtor",
  "sell house in probate",
  "sell house with tenants",
  "sell house before foreclosure",
  "sell fixer upper house",
  "house buyers near me",
]

// Searches a week: what the free searches allow (4,800 in 32 days is about 1,050 a week), less some
// for Google rankings scans.
export const MAX_PER_WEEK = Math.floor(((FREE_LIMIT / WINDOW_DAYS) * 7) / 50) * 50
const DEFAULT_PER_WEEK = 800
const PER_TICK = 5 // searches per check (every 2 minutes)
const LATE_MS = 3 * 3_600_000 // a search this late (the app was closed) moves to later in the week
const WEEK_MS = 7 * 86_400_000

export type SamplerSettings = {
  on: boolean
  keywords: string[]
  places: string[] | "targeted" // "targeted": the cities our running campaigns target
  perWeek: number
  mobile: number // share searched as a phone, 0 to 1
  by?: string
  at?: string
}
type Slot = { k: string; loc: string; dev: Device; due: string; done?: boolean; skip?: string; fails?: number }
type Week = { start: string; end: string; slots: Slot[] }
type SamplerFile = {
  settings: SamplerSettings
  week?: Week
  weeks?: { start: string; planned: number; done: number }[] // past weeks, newest first
  failsInARow?: number
  pausedUntil?: string
  notes?: { at: string; text: string }[] // newest first
}

const file = jsonFileStore<SamplerFile>("ad-sampler.json", () => ({
  settings: { on: false, keywords: CORE_SEARCHES, places: "targeted", perWeek: DEFAULT_PER_WEEK, mobile: 0.25 },
}))
const lock = shared("ad-sampler-lock", () => ({ busy: false }))

const pacificHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" })
// A random moment between `from` and `to`, ten times likelier between 6 AM and 10 PM Pacific.
function randomTime(from: number, to: number) {
  for (let i = 0; i < 100; i++) {
    const t = from + Math.random() * (to - from)
    const h = Number(pacificHour.format(t))
    if (Math.random() < (h >= 6 && h < 22 ? 1 : 0.1)) return t
  }
  return from + Math.random() * (to - from)
}

// The places to search from: the cities our running campaigns target (as kept by the Keyword
// explorer's city volumes, else asked of Google Ads), else every California place we know.
export async function samplerPlaces(settings: SamplerSettings) {
  if (settings.places !== "targeted") return settings.places
  const { targeted } = await scanPlaces()
  if (targeted.length) return targeted
  const live = (await targetedPlaces().catch(() => [])).slice(1).map((p) => p.name) // the first is California itself
  return live.length ? live : PLACE_CHOICES.filter((p) => p !== STATEWIDE)
}

const comboKey = (k: string, loc: string) => `${k}|${loc}`

async function planWeek(settings: SamplerSettings, now: number): Promise<Week> {
  const places = await samplerPlaces(settings)
  const combos = settings.keywords.flatMap((k) => places.map((loc) => ({ k, loc })))
  // Least sampled in the last 4 weeks first; a shuffle first so equals come in random order.
  const seen = new Map<string, number>()
  for (const s of await readSamples(28)) seen.set(comboKey(s.k, s.loc), (seen.get(comboKey(s.k, s.loc)) ?? 0) + 1)
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[combos[i], combos[j]] = [combos[j], combos[i]]
  }
  combos.sort((a, b) => (seen.get(comboKey(a.k, a.loc)) ?? 0) - (seen.get(comboKey(b.k, b.loc)) ?? 0))
  // At most 3 times each a week, when the list is short.
  const n = Math.min(settings.perWeek, combos.length * 3)
  const end = now + WEEK_MS
  const slots: Slot[] = Array.from({ length: n }, (_, i) => {
    const c = combos[i % combos.length]
    const dev: Device = Math.random() < settings.mobile ? "mobile" : "desktop"
    return { ...c, dev, due: new Date(randomTime(now, end)).toISOString() }
  }).sort((a, b) => a.due.localeCompare(b.due))
  return { start: new Date(now).toISOString(), end: new Date(end).toISOString(), slots }
}

const note = (f: SamplerFile, text: string) => {
  if (f.notes?.[0]?.text === text) return
  f.notes = [{ at: new Date().toISOString(), text: text.slice(0, 300) }, ...(f.notes ?? [])].slice(0, 20)
}

function closeWeek(f: SamplerFile) {
  if (!f.week) return
  f.weeks = [{ start: f.week.start, planned: f.week.slots.length, done: f.week.slots.filter((s) => s.done).length }, ...(f.weeks ?? [])].slice(0, 26)
  delete f.week
}

// Runs the searches that are due. Called every 2 minutes while the app is open.
export async function runDueSamples() {
  if (lock.busy || !brightReady()) return
  lock.busy = true
  try {
    const now = Date.now()
    const first = await file.read()
    if (!first.settings.on || !first.settings.keywords.length || (first.pausedUntil && Date.parse(first.pausedUntil) > now)) return
    if (await sentElsewhere()) return
    if (!first.week || now >= Date.parse(first.week.end)) {
      const week = await planWeek(first.settings, now)
      await file.update((f) => {
        closeWeek(f)
        f.week = week
      })
    }

    // What's due now; very late ones (the app was closed) move to a random time later this week.
    const due = await file.update((f) => {
      const week = f.week!
      const end = Date.parse(week.end)
      for (const s of week.slots) {
        if (s.done || s.skip || Date.parse(s.due) > now - LATE_MS) continue
        if (end - now > 3_600_000) s.due = new Date(randomTime(now + 10 * 60_000, end)).toISOString()
        else s.skip = "The app was closed"
      }
      week.slots.sort((a, b) => a.due.localeCompare(b.due))
      return week.slots.filter((s) => !s.done && !s.skip && Date.parse(s.due) <= now).slice(0, PER_TICK)
    })

    for (const slot of due) {
      const same = (s: Slot) => s.k === slot.k && s.loc === slot.loc && s.dev === slot.dev && s.due === slot.due
      try {
        const found = await searchGoogle(slot.k, slot.loc, slot.dev)
        await saveSample(sampleOf(found, slot.k, slot.loc, slot.dev, "sampler"))
        await file.update((f) => {
          const s = f.week?.slots.find(same)
          if (s) s.done = true
          f.failsInARow = 0
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        await file.update((f) => {
          if (e instanceof FreeSearchesUsedUp) {
            // Nothing was searched; it carries on by itself when searches free up.
            note(f, message)
            return
          }
          if (e instanceof BrightDataError && e.fatal) {
            // A bad key or zone would fail every time: turn the sampling off rather than keep trying.
            f.settings.on = false
            note(f, `Turned off: ${message}`)
            return
          }
          // Bright Data having trouble: wait 15 minutes, then 30, 60... up to 6 hours, so failures
          // can't use up the free searches.
          const s = f.week?.slots.find(same)
          if (s && (s.fails = (s.fails ?? 0) + 1) >= 2) s.skip = message.slice(0, 120)
          f.failsInARow = (f.failsInARow ?? 0) + 1
          f.pausedUntil = new Date(Date.now() + Math.min(6 * 3_600_000, 15 * 60_000 * 2 ** (f.failsInARow - 1))).toISOString()
          note(f, `A search failed (${message}); trying again ${f.failsInARow > 1 ? "later" : "in 15 minutes"}.`)
        })
        return
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  } catch {
    // Tried again at the next check.
  } finally {
    lock.busy = false
  }
}

export type SamplerView = {
  settings: SamplerSettings
  places: string[] // what it searches from now
  targeted: string[] // "our targeted cities"
  week: { start: string; end: string; planned: number; done: number; skipped: number; next?: string } | null
  weeks: { start: string; planned: number; done: number }[]
  notes: { at: string; text: string }[]
  pausedUntil?: string
  mainComputer: string | null // another computer on the team does the sampling
}

export async function getSampler(): Promise<SamplerView> {
  const f = await file.read()
  const week = f.week
  const main = await sentElsewhere().catch(() => null)
  const targeted = await samplerPlaces({ ...f.settings, places: "targeted" })
  return {
    settings: f.settings,
    places: f.settings.places === "targeted" ? targeted : f.settings.places,
    targeted,
    week: week
      ? {
          start: week.start,
          end: week.end,
          planned: week.slots.length,
          done: week.slots.filter((s) => s.done).length,
          skipped: week.slots.filter((s) => s.skip).length,
          next: week.slots.find((s) => !s.done && !s.skip)?.due,
        }
      : null,
    weeks: f.weeks ?? [],
    notes: f.notes ?? [],
    pausedUntil: f.pausedUntil && Date.parse(f.pausedUntil) > Date.now() ? f.pausedUntil : undefined,
    mainComputer: main ? main.name || "another computer" : null,
  }
}

// Saves the settings. A change of keywords, places or pace plans the week again from now.
export async function saveSampler(next: SamplerSettings) {
  await file.update((f) => {
    const before = JSON.stringify([f.settings.keywords, f.settings.places, f.settings.perWeek, f.settings.mobile])
    f.settings = next
    if (JSON.stringify([next.keywords, next.places, next.perWeek, next.mobile]) !== before) closeWeek(f)
    if (next.on) {
      delete f.pausedUntil
      f.failsInARow = 0
    }
  })
}
