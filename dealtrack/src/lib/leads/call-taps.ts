// Taps on the website's phone number, brought in as leads the same way form submissions are.
// PostHog (already on twinhomebuyer.com) records every tap on a "tel:" link with the page, device,
// city and the visit's campaign tags (utm, gclid). The app checks for new taps at most once a
// minute while it's open; PostHog shows a tap a minute or two after it happens.
//
// A tap means someone started a call, not that it connected: the call itself (who, how long) is in
// REI BlackBook. So these leads are never scored or sent to Google Ads on their own; once the team
// sets a status (Interested…), they go to Google Ads like any other lead, matched by the ad click.
import { jsonFileStore } from "@/lib/json-file-store"
import { addLead, listLeads } from "@/lib/leads/store"
import { CALL_TAP_SOURCE, type LeadTracking } from "@/lib/leads/types"
import { hogqlFresh } from "@/lib/posthog"
import { shared } from "@/lib/shared-state"

type State = { lastAt?: string; lastSync?: string; lastError?: string; added?: number }
const file = jsonFileStore<State>("call-taps.json", () => ({}))
export const getCallTaps = () => file.read()

const SYNC_EVERY_MS = 60_000
// The first check looks back a week; after that, from the last tap brought in.
const FIRST_LOOK_BACK_MS = 7 * 86_400_000
// Several taps by the same visitor within this long are one call attempt.
const SAME_CALL_MS = 30 * 60_000
const sync = shared("call-tap-sync", () => ({ lastAttempt: 0, running: null as Promise<void> | null }))

const configured = () => Boolean(process.env.POSTHOG_API_KEY && process.env.POSTHOG_PROJECT_ID)

// The campaign tags from the address the visit started on (or the page tapped on).
function trackingFrom(entry: string, current: string, referrer: string): LeadTracking | undefined {
  const pick = (url: string) => {
    try {
      return new URL(url).searchParams
    } catch {
      return null
    }
  }
  const a = pick(entry)
  const b = pick(current)
  const get = (k: string) => a?.get(k) || b?.get(k) || undefined
  const t: LeadTracking = {
    utmSource: get("utm_source"),
    utmMedium: get("utm_medium"),
    utmCampaign: get("utm_campaign"),
    utmTerm: get("utm_term") || get("utm_keyword"),
    utmContent: get("utm_content"),
    gclid: get("gclid"),
    gbraid: get("gbraid"),
    wbraid: get("wbraid"),
    fbclid: get("fbclid"),
    msclkid: get("msclkid"),
    landingPage: (entry || current).split("?")[0] || undefined,
    referrer: referrer && referrer !== "$direct" ? referrer : undefined,
  }
  const kept = Object.fromEntries(Object.entries(t).filter(([, v]) => v)) as LeadTracking
  return Object.keys(kept).length ? kept : undefined
}

const shownNumber = (tel: string) => {
  const d = tel.replace(/\D/g, "").slice(-10)
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : tel.replace(/^tel:/, "")
}
const pathOf = (url: string) => {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

export function syncCallTaps(): Promise<void> {
  if (!configured()) return Promise.resolve()
  if (sync.running) return sync.running
  if (Date.now() - sync.lastAttempt < SYNC_EVERY_MS) return Promise.resolve()
  sync.lastAttempt = Date.now()
  sync.running = (async () => {
    const state = await file.read()
    const since = state.lastAt ? Date.parse(state.lastAt) : Date.now() - FIRST_LOOK_BACK_MS
    const seconds = Math.max(60, Math.ceil((Date.now() - since) / 1000) + 5)
    try {
      const rows = await hogqlFresh(`
        select uuid, timestamp, distinct_id, properties.$current_url, properties.$device_type, properties.$geoip_city_name,
          properties.$geoip_subdivision_1_code, properties.$referrer, session.$entry_current_url,
          extract(elements_chain, 'href="(tel:[^"]+)"')
        from events
        where event = '$autocapture' and elements_chain like '%href="tel:%'
          and properties.$host in ('www.twinhomebuyer.com', 'twinhomebuyer.com')
          and timestamp > now() - interval ${seconds} second
        order by timestamp asc limit 500`)
      const existing = (await listLeads()).filter((l) => l.source === CALL_TAP_SOURCE)
      const lastByVisitor = new Map<string, number>()
      for (const l of existing) {
        const visitor = l.inboxId?.split(":")[1]
        if (visitor) lastByVisitor.set(visitor, Math.max(lastByVisitor.get(visitor) ?? 0, Date.parse(l.createdAt)))
      }
      let lastAt = state.lastAt
      let added = 0
      for (const r of rows) {
        const values = Object.values(r).map((v) => (v == null ? "" : String(v)))
        const [uuid, at, visitor, current, device, city, region, referrer, entry, tel] = values
        const when = Date.parse(at)
        if (Number.isNaN(when) || (state.lastAt && when <= Date.parse(state.lastAt))) continue
        lastAt = new Date(when).toISOString()
        // Tapping twice (or again a few minutes later) is the same call attempt.
        const previous = lastByVisitor.get(visitor)
        lastByVisitor.set(visitor, when)
        if (previous && when - previous < SAME_CALL_MS) continue
        const place = [city, /^[A-Z]{2}$/.test(region) ? region : ""].filter(Boolean).join(", ")
        await addLead(
          {
            name: "Website caller (tapped the phone number)",
            source: CALL_TAP_SOURCE,
            notes: `Tapped ${shownNumber(tel)} on ${pathOf(current)}${device ? ` · ${device}` : ""}${place ? ` · ${place}` : ""}. The call is in REI BlackBook: find it there, add the caller's details, and set the status.`,
            tracking: trackingFrom(entry, current, referrer),
            inboxId: `tap:${visitor}:${uuid}`,
          },
          lastAt,
        )
        added++
      }
      await file.update((s) => {
        s.lastAt = lastAt ?? s.lastAt ?? new Date(since).toISOString()
        s.lastSync = new Date().toISOString()
        s.added = (s.added ?? 0) + added
        delete s.lastError
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await file.update((s) => {
        s.lastError = message.slice(0, 300)
        s.lastSync = new Date().toISOString()
      })
    }
  })().finally(() => {
    sync.running = null
  })
  return sync.running
}
