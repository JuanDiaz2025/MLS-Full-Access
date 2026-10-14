// Roughly where each lead was when they got in touch, never the property's address. Two sources:
// - Google Ads keeps where every ad click came from for 90 days: the city and ZIP code of the
//   phone or computer, and the place the search was about when it named another one. The lead's
//   Google click ID finds it.
// - PostHog, on the website, reads a city from each visitor's internet connection. The lead's visit
//   is found by its ad click ID, or else by the form sent on the site at that same moment.
//   Call-button taps come with theirs (call-taps.ts). Only a visit from before the lead arrived
//   counts: anyone can open the same link later (the team, from the lead's email).
// Both are rough: a phone often shows its carrier's nearby city, and a VPN somewhere else entirely.
// So a PostHog city abroad for an ad click Google placed in the US is left out: that's someone
// else who opened the link, or a VPN.
import { gaqlFresh, missingKeys } from "@/lib/google-ads/client"
import { getAccount, geoNames } from "@/lib/google-ads/reports"
import { hogqlFresh } from "@/lib/posthog"
import { shared } from "@/lib/shared-state"
import { listLeads, updateLead } from "@/lib/leads/store"
import { googleClick } from "@/lib/leads/tracking"
import type { Lead, LeadPlace } from "@/lib/leads/types"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// Clicks reach Google Ads' click report a few hours after they happen, and stay there 90 days.
// How long to wait before the 1st, 2nd and 3rd look.
const GOOGLE_WAITS = [HOUR, 6 * HOUR, 24 * HOUR]
const GOOGLE_KEEPS = 89 * DAY
// PostHog has a visit within a minute or two.
const POSTHOG_WAITS = [2 * MINUTE, 30 * MINUTE, 6 * HOUR]
// Not found for a lead this old: it won't turn up later either.
const SETTLED = 2 * DAY
// A form sent this long before or after the lead arrived is that lead's.
const SENT_BEFORE = 5 * MINUTE
const SENT_AFTER = 2 * MINUTE
// Newest first, this many leads per source each time, so a first run over old leads is spread out.
const PER_RUN = 15
const EVERY_MS = 2 * MINUTE
const run = shared("lead-places", () => ({ lastAttempt: 0, running: null as Promise<void> | null }))

// Click IDs are letters, digits, - and _: anything else stays out of a query.
const CLICK_ID = /^[A-Za-z0-9_-]{10,200}$/
// PageSpeed's ad-click tests (google-ads/click-url.ts) and typed-in tests aren't real clicks.
const TEST_CLICK = /^test/i

const STATES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
  Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
}

// "San Carlos,San Mateo County,California,United States" → "San Carlos, CA"; outside the US
// "Toronto,Ontario,Canada" → "Toronto, Canada".
export function placeName(name: string, canonical: string) {
  const parts = canonical.split(",").map((p) => p.trim())
  const country = parts.at(-1) ?? ""
  if (country !== "United States") return name === country ? name : [name, country].filter(Boolean).join(", ")
  const state = parts.map((p) => STATES[p]).find(Boolean)
  if (!state || STATES[name] || name.endsWith(`, ${state}`)) return name
  return `${name}, ${state}`
}

// "San Jose" + "CA" + "US" → "San Jose, CA"; outside the US, with the country's name: "Toronto,
// Canada" (its code, "CA", would read like a state).
export function visitorPlace(city: unknown, region: unknown, country: unknown, countryName?: unknown) {
  const c = String(city ?? "").trim()
  if (!c) return undefined
  const r = String(region ?? "").trim()
  const k = String(country ?? "").trim()
  if (k === "US" || !k) return /^[A-Z]{2}$/.test(r) ? `${c}, ${r}` : c
  return `${c}, ${String(countryName ?? "").trim() || k}`
}

const STATE_CODES = new Set(Object.values(STATES))
// Google's place is in the US: "San Jose, CA 95136", "San Jose, CA" or a state ("California").
const googleInUS = (place: string) => STATE_CODES.has(place.match(/, ([A-Z]{2})(?: \d{5})?$/)?.[1] ?? "") || place in STATES
// PostHog's place is abroad: by the country it came with, or (saved before that) a two-letter
// ending that isn't a state, "Manila, PH".
function posthogAbroad(p: LeadPlace) {
  if (p.posthogCountry) return p.posthogCountry !== "US"
  const code = p.posthog?.match(/, ([A-Z]{2})$/)?.[1]
  return Boolean(code && !STATE_CODES.has(code))
}

// Whether a source is due another look: the first a while after the lead came in, then spaced out.
function due(tries: number | undefined, at: string | undefined, waits: number[], createdAt: string) {
  const n = tries ?? 0
  if (n >= waits.length) return false
  const from = n === 0 ? Date.parse(createdAt) : Date.parse(at ?? "")
  return Number.isNaN(from) || Date.now() - from >= waits[n]
}

const newestFirst = (a: Lead, b: Lead) => b.createdAt.localeCompare(a.createdAt)

async function save(id: string, change: (place: LeadPlace) => void) {
  await updateLead(id, (l) => {
    l.place ??= {}
    change(l.place)
  })
}

// ---- Google Ads -----------------------------------------------------------------------------

type GeoIds = { city?: string; metro?: string; region?: string; country?: string; mostSpecific?: string }
type ClickRow = { clickView?: { gclid?: string; locationOfPresence?: GeoIds; areaOfInterest?: GeoIds } }

const gclidOf = (l: Lead) => {
  const id = googleClick(l.tracking)?.gclid
  return id && CLICK_ID.test(id) && !TEST_CLICK.test(id) ? id : undefined
}

// The day in the account's time zone, "2026-10-13": the click report is asked one day at a time.
const dayIn = (zone: string, ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms)

async function locateByGoogle(leads: Lead[]) {
  if (missingKeys().length) return
  const todo = leads
    .filter((l) => gclidOf(l) && !l.place?.google && Date.now() - Date.parse(l.createdAt) < GOOGLE_KEEPS && due(l.place?.googleTries, l.place?.googleAt, GOOGLE_WAITS, l.createdAt))
    .sort(newestFirst)
    .slice(0, PER_RUN)
  if (!todo.length) return
  const zone = (await getAccount()).timeZone
  // The click was the day the lead came in or the day before.
  const byDay = new Map<string, Set<string>>()
  for (const l of todo) {
    const at = Date.parse(l.createdAt)
    for (const day of [dayIn(zone, at), dayIn(zone, at - DAY)]) {
      if (!byDay.has(day)) byDay.set(day, new Set())
      byDay.get(day)!.add(gclidOf(l)!)
    }
  }
  const found = new Map<string, ClickRow["clickView"]>()
  for (const [day, ids] of byDay) {
    const rows = await gaqlFresh<ClickRow>(
      `SELECT click_view.gclid, click_view.location_of_presence.city, click_view.location_of_presence.metro,
         click_view.location_of_presence.region, click_view.location_of_presence.country, click_view.location_of_presence.most_specific,
         click_view.area_of_interest.city, click_view.area_of_interest.metro, click_view.area_of_interest.region,
         click_view.area_of_interest.country, click_view.area_of_interest.most_specific
       FROM click_view WHERE segments.date = '${day}' AND click_view.gclid IN (${[...ids].map((g) => `'${g}'`).join(", ")})`,
    )
    for (const r of rows) if (r.clickView?.gclid) found.set(r.clickView.gclid, r.clickView)
  }
  const all = [...found.values()].flatMap((c) => [c?.locationOfPresence, c?.areaOfInterest])
  const names = await geoNames(all.flatMap((g) => (g ? [g.city, g.metro, g.region, g.country, g.mostSpecific] : [])).filter((id): id is string => Boolean(id)))
  // The city (with its ZIP code when Google has one), else the area or state it was in.
  const label = (g?: GeoIds) => {
    if (!g) return undefined
    const city = g.city ? names.get(g.city) : undefined
    const place = city ?? [g.metro, g.region, g.country].map((id) => (id ? names.get(id) : undefined)).find(Boolean)
    if (!place) return undefined
    const zip = g.mostSpecific ? names.get(g.mostSpecific)?.name : undefined
    const text = placeName(place.name, place.canonical)
    return city && zip && /^\d{5}$/.test(zip) ? `${text} ${zip}` : text
  }
  const now = new Date().toISOString()
  for (const l of todo) {
    const click = found.get(gclidOf(l)!)
    const where = label(click?.locationOfPresence)
    const about = label(click?.areaOfInterest)
    await save(l.id, (p) => {
      p.googleTries = where || Date.now() - Date.parse(l.createdAt) < SETTLED ? (p.googleTries ?? 0) + 1 : GOOGLE_WAITS.length
      p.googleAt = now
      if (where) p.google = where
      // Only when the search named somewhere other than where they were.
      const town = (s?: string) => s?.replace(/ \d{5}$/, "")
      if (about && town(about) !== town(where)) p.googleInterest = about
    })
  }
}

// ---- PostHog --------------------------------------------------------------------------------

const posthogReady = () => Boolean(process.env.POSTHOG_API_KEY && process.env.POSTHOG_PROJECT_ID)
const LIVE_SITE = `properties.$host in ('www.twinhomebuyer.com', 'twinhomebuyer.com')`
// ClickHouse's time, to the second, in UTC.
const utc = (ms: number) => `toDateTime('${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}', 'UTC')`

const clickOf = (l: Lead) => {
  const c = googleClick(l.tracking)
  const id = c?.gclid ?? c?.gbraid ?? c?.wbraid
  return id && CLICK_ID.test(id) && !TEST_CLICK.test(id) ? id : undefined
}

// A call-button tap's PostHog event ("tap:<visitor>:<event id>", call-taps.ts).
const tapEvent = (l: Lead) => {
  const id = l.inboxId?.startsWith("tap:") ? l.inboxId.split(":").at(-1) : undefined
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined
}

async function locateByPostHog(leads: Lead[]) {
  if (!posthogReady()) return
  const todo = leads
    .filter(
      (l) =>
        !l.place?.posthog && !l.qrCodeId && !l.callId &&
        // Website leads only: a call-button tap, an ad click, or a form on the site.
        (tapEvent(l) || clickOf(l) || l.inboxId?.startsWith("wp:") || l.source?.startsWith("Website")) &&
        due(l.place?.posthogTries, l.place?.posthogAt, POSTHOG_WAITS, l.createdAt),
    )
    .sort(newestFirst)
    .slice(0, PER_RUN)
  if (!todo.length) return
  const found = new Map<string, { place: string; country: string }>() // lead id → place
  const placeOf = (r: Record<string, unknown>) => {
    const place = visitorPlace(r.city, r.region, r.country, r.country_name)
    return place ? { place, country: String(r.country ?? "") } : undefined
  }

  // Call-button taps from before taps brought their place: the tap itself.
  const byTap = todo.filter((l) => tapEvent(l))
  if (byTap.length) {
    const since = Math.min(...byTap.map((l) => Date.parse(l.createdAt))) - DAY
    const rows = await hogqlFresh(`
      select toString(uuid) as id, properties.$geoip_city_name as city, properties.$geoip_subdivision_1_code as region,
        properties.$geoip_country_code as country, properties.$geoip_country_name as country_name
      from events
      where timestamp >= ${utc(since)} and toString(uuid) in (${byTap.map((l) => `'${tapEvent(l)!.toLowerCase()}'`).join(", ")})`)
    const places = new Map(rows.map((r) => [String(r.id).toLowerCase(), placeOf(r)]))
    for (const l of byTap) {
      const place = places.get(tapEvent(l)!.toLowerCase())
      if (place) found.set(l.id, place)
    }
  }

  // Ad leads: the first visit that landed with the same click ID, from before the lead came in.
  const byClick = todo.filter((l) => !tapEvent(l) && clickOf(l))
  if (byClick.length) {
    const since = Math.min(...byClick.map((l) => Date.parse(l.createdAt))) - 95 * DAY
    const click = `extract(properties.$current_url, '[?&](?:gclid|gbraid|wbraid)=([A-Za-z0-9_-]+)')`
    const rows = await hogqlFresh(`
      select ${click} as click, timestamp, properties.$geoip_city_name as city, properties.$geoip_subdivision_1_code as region,
        properties.$geoip_country_code as country, properties.$geoip_country_name as country_name
      from events
      where event = '$pageview' and timestamp >= ${utc(since)} and ${LIVE_SITE}
        and (properties.$current_url ilike '%gclid=%' or properties.$current_url ilike '%braid=%')
        and ${click} in (${[...new Set(byClick.map((l) => clickOf(l)!))].map((id) => `'${id}'`).join(", ")})
      order by timestamp limit 5000`)
    for (const l of byClick) {
      const by = Date.parse(l.createdAt) + SENT_AFTER
      const visit = rows.find((r) => String(r.click) === clickOf(l) && Date.parse(String(r.timestamp)) <= by && placeOf(r))
      if (visit) found.set(l.id, placeOf(visit)!)
    }
  }

  // Other website leads: the form sent on the site at that moment, if only one visitor sent one.
  const byTime = todo.filter((l) => !tapEvent(l) && !found.has(l.id) && !Number.isNaN(Date.parse(l.createdAt)))
  if (byTime.length) {
    const windows = byTime.map((l) => `(timestamp >= ${utc(Date.parse(l.createdAt) - SENT_BEFORE)} and timestamp <= ${utc(Date.parse(l.createdAt) + SENT_AFTER)})`)
    const rows = await hogqlFresh(`
      select timestamp, person_id, properties.$geoip_city_name as city, properties.$geoip_subdivision_1_code as region,
        properties.$geoip_country_code as country, properties.$geoip_country_name as country_name
      from events
      where event = '$autocapture' and properties.$event_type = 'submit' and ${LIVE_SITE} and (${windows.join(" or ")})
      limit 5000`)
    const sends = rows.map((r) => ({ at: Date.parse(String(r.timestamp)), person: String(r.person_id ?? ""), place: placeOf(r) }))
    for (const l of byTime) {
      const at = Date.parse(l.createdAt)
      const near = sends.filter((s) => s.at >= at - SENT_BEFORE && s.at <= at + SENT_AFTER)
      // Two different visitors sending at the same moment: there's no telling which is this lead.
      if (near.length && new Set(near.map((s) => s.person)).size === 1 && near[0].place) found.set(l.id, near[0].place)
    }
  }

  const now = new Date().toISOString()
  for (const l of todo) {
    const place = found.get(l.id)
    await save(l.id, (p) => {
      p.posthogTries = place || Date.now() - Date.parse(l.createdAt) < SETTLED ? (p.posthogTries ?? 0) + 1 : POSTHOG_WAITS.length
      p.posthogAt = now
      if (place) {
        p.posthog = place.place
        if (place.country) p.posthogCountry = place.country
      }
    })
  }
}

// A PostHog city abroad for an ad click Google placed in the US isn't where the lead was: someone
// else opened the link (the team, from the lead's email), or a VPN. It's left out.
async function dropForeignVisits() {
  for (const l of await listLeads()) {
    const p = l.place
    if (!p?.google || !p.posthog || !googleInUS(p.google) || !posthogAbroad(p)) continue
    await save(l.id, (x) => {
      delete x.posthog
      delete x.posthogCountry
      x.posthogTries = POSTHOG_WAITS.length
    })
  }
}

// Looks up the rough location of leads that don't have one yet: at most every 2 minutes, one run at
// a time, and each lead only a few times (see the waits above).
export function locateLeads(): Promise<void> {
  if (run.running) return run.running
  if (Date.now() - run.lastAttempt < EVERY_MS) return Promise.resolve()
  run.lastAttempt = Date.now()
  run.running = (async () => {
    const leads = await listLeads()
    await locateByGoogle(leads).catch((error) => console.error("Couldn't look up where Google Ads clicks came from:", error))
    await locateByPostHog(leads).catch((error) => console.error("Couldn't look up where website visitors were:", error))
    await dropForeignVisits().catch(() => undefined)
  })().finally(() => {
    run.running = null
  })
  return run.running
}
