// Read-only PostHog client (HogQL queries) and the site-behavior reports built on it.
// Needs a personal API key with read-only access to the one project.

import type { DateRange } from "@/lib/date-range"
import { MINUTE, ServiceError, cached, settings } from "@/lib/services"

const SERVICE = "PostHog"
const KEYS = ["POSTHOG_API_KEY", "POSTHOG_PROJECT_ID"] as const

type Value = string | number | boolean | null | Value[]

export async function hogql(query: string): Promise<Record<string, Value>[]> {
  const cfg = settings(SERVICE, KEYS)
  const host = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/$/, "")
  return cached(`hogql:${query}`, 10 * MINUTE, async () => {
    const res = await fetch(`${host}/api/projects/${cfg.POSTHOG_PROJECT_ID}/query/`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.POSTHOG_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      cache: "no-store",
    })
    const body = (await res.json().catch(() => ({}))) as { columns?: string[]; results?: Value[][]; detail?: string }
    if (!res.ok) {
      throw new ServiceError(
        SERVICE,
        res.status === 401 || res.status === 403
          ? "PostHog didn't accept POSTHOG_API_KEY, or the key can't read this project. Check it has read access to project " +
              cfg.POSTHOG_PROJECT_ID +
              "."
          : "PostHog returned an error for this report.",
        body.detail,
      )
    }
    const cols = body.columns ?? []
    return (body.results ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])))
  })
}

// Real prospects only: the live site, minus anyone with more than 150 pageviews (the team
// editing pages generated thousands of views in June 2026).
const PUBLIC = `properties.$host in ('www.twinhomebuyer.com', 'twinhomebuyer.com')
  and person_id not in (select person_id from events where event = '$pageview' group by person_id having count() > 150)`

const between = (r: DateRange) => `timestamp >= toDateTime('${r.from} 00:00:00', 'America/Los_Angeles')
  and timestamp < toDateTime('${r.to} 00:00:00', 'America/Los_Angeles') + interval 1 day`

export type Session = {
  id: string
  startedAt: string // ISO, UTC
  entryPage: string
  path: string[] // pages in order, first 12; filled by getPaths for the visits on screen
  campaignId: string // Google Ads campaign ID from the landing URL (gad_campaignid), if any
  keyword: string // utm_keyword / utm_term from the landing URL, if the campaign tags it
  city: string
  source: "Google Ads" | "Organic search" | "Social" | "Direct / other"
  device: string
  pageviews: number
  durationS: number
  maxScroll: number | null
  converted: boolean
  rageClicked: boolean
  secondsToSubmit: number | null
  weekday: number // 0 = Monday
  hour: number // Los Angeles time
}

function sourceOf(url: string, referrer: string): Session["source"] {
  if (/[?&](gclid|gbraid|wbraid)=|utm_medium=(cpc|ppc)/i.test(url)) return "Google Ads"
  if (/google|bing|duckduckgo|yahoo/i.test(referrer)) return "Organic search"
  if (/facebook|instagram|fb\./i.test(referrer)) return "Social"
  return "Direct / other"
}

export async function getSessions(range: DateRange): Promise<Session[]> {
  // Campaign and keyword are read from the landing URL in an outer query, so the heavy
  // per-session aggregation runs once. Page paths are fetched separately, only for the visits
  // shown (see getPaths): building them for every session hits PostHog's time limit.
  const rows = await hogql(`
    select *,
      extract(entry_url, 'gad_campaignid=([0-9]+)') as campaign_id,
      decodeURLComponent(extract(entry_url, 'utm_(?:keyword|term)=([^&#]+)')) as keyword
    from (
      select
        properties.$session_id as session_id,
        min(timestamp) as started_at,
        argMin(properties.$pathname, timestamp) as entry_page,
        argMin(properties.$current_url, timestamp) as entry_url,
        argMin(properties.$referring_domain, timestamp) as referrer,
        any(properties.$device_type) as device,
        any(properties.$geoip_city_name) as city,
        countIf(event = '$pageview') as pageviews,
        dateDiff('second', min(timestamp), max(timestamp)) as duration_s,
        max(toFloat(properties.$prev_pageview_max_scroll_percentage)) as max_scroll,
        countIf(event = '$autocapture' and properties.$event_type = 'submit') as submits,
        countIf(event = '$rageclick') as rage_clicks,
        dateDiff('second', min(timestamp),
          minIf(timestamp, event = '$autocapture' and properties.$event_type = 'submit')) as secs_to_submit,
        toDayOfWeek(toTimeZone(min(timestamp), 'America/Los_Angeles')) as weekday,
        toHour(toTimeZone(min(timestamp), 'America/Los_Angeles')) as hour
      from events
      where ${between(range)} and properties.$session_id is not null and ${PUBLIC}
      group by properties.$session_id
      having pageviews > 0
    )
    limit 50000`)
  return rows.map((r) => {
    const submits = Number(r.submits ?? 0)
    return {
      id: String(r.session_id ?? ""),
      startedAt: String(r.started_at ?? ""),
      entryPage: String(r.entry_page ?? "/"),
      path: [],
      campaignId: String(r.campaign_id ?? ""),
      keyword: String(r.keyword ?? "").replace(/\+/g, " ").trim(),
      city: String(r.city ?? ""),
      source: sourceOf(String(r.entry_url ?? ""), String(r.referrer ?? "")),
      device: String(r.device ?? "Unknown"),
      pageviews: Number(r.pageviews ?? 0),
      durationS: Number(r.duration_s ?? 0),
      maxScroll: r.max_scroll === null || r.max_scroll === undefined ? null : Number(r.max_scroll),
      converted: submits > 0,
      rageClicked: Number(r.rage_clicks ?? 0) > 0,
      secondsToSubmit: submits > 0 ? Number(r.secs_to_submit) : null,
      weekday: Number(r.weekday ?? 1) - 1,
      hour: Number(r.hour ?? 0),
    }
  })
}

// Pages each session visited, in order (first 12), for a handful of sessions.
export async function getPaths(range: DateRange, sessionIds: string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(sessionIds.filter((id) => /^[0-9a-f-]{8,64}$/i.test(id)))]
  if (!ids.length) return new Map()
  const rows = await hogql(`
    select properties.$session_id as session_id,
      arraySlice(arrayMap(x -> x.2, arraySort(x -> x.1, groupArray(tuple(timestamp, properties.$pathname)))), 1, 12) as path
    from events
    where ${between(range)} and event = '$pageview' and properties.$session_id in (${ids.map((id) => `'${id}'`).join(", ")})
    group by session_id`)
  return new Map(rows.map((r) => [String(r.session_id), Array.isArray(r.path) ? (r.path as unknown[]).map(String) : []]))
}

// Visitors and form submits per landing page path, for the landing page audit.
export async function getPageStats(range: DateRange): Promise<Map<string, { sessions: number; conversions: number }>> {
  const sessions = await getSessions(range)
  const stats = new Map<string, { sessions: number; conversions: number }>()
  for (const s of sessions) {
    const st = stats.get(s.entryPage) ?? { sessions: 0, conversions: 0 }
    st.sessions++
    if (s.converted) st.conversions++
    stats.set(s.entryPage, st)
  }
  return stats
}

export type SiteWeek = {
  week: string // Monday, YYYY-MM-DD
  publicPageviews: number
  internalPageviews: number
  adLandings: number
  formSubmits: number
}

// Weekly site totals for alerts. Only complete weeks.
export async function getSiteWeeks(weeks = 26): Promise<SiteWeek[]> {
  const rows = await hogql(`
    select toStartOfWeek(timestamp, 1) as week,
      countIf(event = '$pageview' and ${PUBLIC}) as public_pv,
      countIf(event = '$pageview' and not (${PUBLIC})) as internal_pv,
      countIf(event = '$pageview' and properties.$current_url ilike '%gclid=%') as ad_landings,
      countIf(event = '$autocapture' and properties.$event_type = 'submit' and ${PUBLIC}) as submits
    from events
    where timestamp >= toStartOfWeek(now(), 1) - interval ${weeks} week and timestamp < toStartOfWeek(now(), 1)
    group by week order by week`)
  return rows.map((r) => ({
    week: String(r.week).slice(0, 10),
    publicPageviews: Number(r.public_pv ?? 0),
    internalPageviews: Number(r.internal_pv ?? 0),
    adLandings: Number(r.ad_landings ?? 0),
    formSubmits: Number(r.submits ?? 0),
  }))
}

// ---- Session replays ---------------------------------------------------------------------

export function replayUrl(sessionId: string) {
  const host = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/$/, "")
  return `${host}/project/${process.env.POSTHOG_PROJECT_ID}/replay/${sessionId}`
}

// Which of these sessions PostHog recorded, with the recording length in seconds. Visits
// without a recording (blocked, too short, or before recording was on) are simply absent.
export async function getRecordings(sessionIds: string[]): Promise<Map<string, number>> {
  const cfg = settings(SERVICE, KEYS)
  const host = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/$/, "")
  const ids = [...new Set(sessionIds.filter(Boolean))].sort()
  if (!ids.length) return new Map()
  return cached(`recordings:${ids.join(",")}`, 10 * MINUTE, async () => {
    const params = new URLSearchParams({ session_ids: JSON.stringify(ids), date_from: "-365d", limit: String(ids.length) })
    const res = await fetch(`${host}/api/projects/${cfg.POSTHOG_PROJECT_ID}/session_recordings?${params}`, {
      headers: { authorization: `Bearer ${cfg.POSTHOG_API_KEY}` },
      cache: "no-store",
    })
    if (!res.ok) throw new ServiceError(SERVICE, "PostHog couldn't list session recordings.", (await res.text()).slice(0, 200))
    const body = (await res.json()) as { results?: { id: string; recording_duration?: number }[] }
    return new Map((body.results ?? []).map((r) => [r.id, r.recording_duration ?? 0]))
  })
}
