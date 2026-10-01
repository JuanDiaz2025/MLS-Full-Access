// Who actually arrived from the ads, from PostHog: each ad click that reached the site, with the
// visitor's IP address, place, and browser. The same network clicking the ads again and again is
// the clearest sign of a competitor or a click farm, and it's the evidence Google asks for.

import type { DateRange } from "@/lib/date-range"
import { hogql } from "@/lib/posthog"
import { BOT_AGENT, isGoogleIp, networkOf } from "@/lib/fraud/logs"

export type AdVisit = {
  sessionId: string
  startedAt: string // ISO, UTC
  gclid: string
  campaignId: string
  ip: string
  network: string // the IPv4 address, or the IPv6 /64 a home or phone keeps
  city: string
  region: string
  country: string
  browser: string
  os: string
  device: string
  userAgent: string
  pageviews: number
  durationS: number
  submitted: boolean
}

export type NetworkFlag = "repeat" | "abroad" | "outside-ca" | "bounce" | "bot-agent"

export const NETWORK_FLAG_LABELS: Record<NetworkFlag, string> = {
  repeat: "Clicked the ads again and again",
  abroad: "Outside the US",
  "outside-ca": "Outside California",
  bounce: "Left within seconds every time",
  "bot-agent": "Automated browser",
}

export type Network = {
  network: string
  ips: string[]
  visits: AdVisit[]
  adClicks: number // distinct gclids, or visits when the gclid was missing
  first: string
  last: string
  place: string
  submitted: number
  flags: NetworkFlag[]
  known?: string // the team's label when someone marked this network as their own
}

// Three or more ad clicks from one network in the period.
export const REPEAT_CLICKS = 3

const between = (r: DateRange) => `timestamp >= toDateTime('${r.from} 00:00:00', 'America/Los_Angeles')
  and timestamp < toDateTime('${r.to} 00:00:00', 'America/Los_Angeles') + interval 1 day`

export async function getAdVisits(range: DateRange): Promise<AdVisit[]> {
  // Everyone on the live site, the team included: someone clicking the ads a hundred times is
  // exactly what this looks for, so heavy visitors aren't left out the way other reports do.
  const rows = await hogql(`
    select * from (
      select
        properties.$session_id as session_id,
        min(timestamp) as started_at,
        argMin(properties.$current_url, timestamp) as entry_url,
        any(properties.$ip) as ip,
        any(properties.$geoip_city_name) as city,
        any(properties.$geoip_subdivision_1_name) as region,
        any(properties.$geoip_country_code) as country,
        any(properties.$browser) as browser,
        any(properties.$os) as os,
        any(properties.$device_type) as device,
        any(properties.$raw_user_agent) as user_agent,
        countIf(event = '$pageview') as pageviews,
        dateDiff('second', min(timestamp), max(timestamp)) as duration_s,
        countIf(event = '$autocapture' and properties.$event_type = 'submit') as submits
      from events
      where ${between(range)} and properties.$session_id is not null
        and properties.$host in ('www.twinhomebuyer.com', 'twinhomebuyer.com')
      group by properties.$session_id
    )
    where match(entry_url, '[?&](gclid|gbraid|wbraid|gad_source|gad_campaignid)=')
    order by started_at
    limit 20000`)
  return rows.map((r) => {
    const url = String(r.entry_url ?? "")
    const ip = String(r.ip ?? "")
    return {
      sessionId: String(r.session_id ?? ""),
      startedAt: String(r.started_at ?? ""),
      gclid: url.match(/[?&](?:gclid|gbraid|wbraid)=([^&#]+)/)?.[1] ?? "",
      campaignId: url.match(/[?&]gad_campaignid=(\d+)/)?.[1] ?? "",
      ip,
      network: ip ? networkOf(ip) : "",
      city: String(r.city ?? ""),
      region: String(r.region ?? ""),
      country: String(r.country ?? ""),
      browser: String(r.browser ?? ""),
      os: String(r.os ?? ""),
      device: String(r.device ?? ""),
      userAgent: String(r.user_agent ?? ""),
      pageviews: Number(r.pageviews ?? 0),
      durationS: Number(r.duration_s ?? 0),
      submitted: Number(r.submits ?? 0) > 0,
    }
  })
}

// Ad visits grouped by network, the suspicious ones first. Google's own systems open landing
// pages to check them (and those visits aren't billed), so they're left out; networks the team
// marked as its own go last.
export function groupNetworks(visits: AdVisit[], known: { network: string; label: string }[] = []): Network[] {
  const labels = new Map(known.map((k) => [k.network, k.label]))
  const by = new Map<string, AdVisit[]>()
  for (const v of visits) {
    if (!v.network || isGoogleIp(v.ip)) continue
    by.set(v.network, [...(by.get(v.network) ?? []), v])
  }
  const networks = [...by].map(([network, list]): Network => {
    const gclids = new Set(list.map((v) => v.gclid).filter(Boolean))
    const adClicks = gclids.size + list.filter((x) => !x.gclid).length
    const v = list[0]
    const flags: NetworkFlag[] = []
    if (adClicks >= REPEAT_CLICKS) flags.push("repeat")
    if (v.country && v.country !== "US") flags.push("abroad")
    else if (v.region && v.region !== "California") flags.push("outside-ca")
    if (list.length >= 2 && list.every((x) => x.pageviews <= 1 && x.durationS < 5 && !x.submitted)) flags.push("bounce")
    if (list.some((x) => BOT_AGENT.test(x.userAgent))) flags.push("bot-agent")
    return {
      network,
      ips: [...new Set(list.map((x) => x.ip))],
      visits: list,
      adClicks,
      first: list[0].startedAt,
      last: list[list.length - 1].startedAt,
      place: [v.city, v.region, v.country].filter(Boolean).join(", ") || "Unknown",
      submitted: list.filter((x) => x.submitted).length,
      flags,
      known: labels.get(network),
    }
  })
  const weight = (n: Network) =>
    (n.known ? -1000 : 0) + (n.flags.includes("repeat") ? 100 : 0) + (n.flags.includes("bot-agent") ? 50 : 0) + n.flags.length * 10 + n.adClicks
  return networks.sort((a, b) => weight(b) - weight(a))
}

export type Cluster = { start: string; visits: AdVisit[]; places: string[] }

// Ad clicks from several different connections within the same couple of minutes, from places
// far apart: a click farm or a bot network working through a list. Real sellers don't arrive
// in lockstep.
export const CLUSTER_SECONDS = 120
export const CLUSTER_MIN = 4

export function findClusters(visits: AdVisit[], known: { network: string }[] = []): Cluster[] {
  const own = new Set(known.map((k) => k.network))
  const list = visits.filter((v) => v.network && !own.has(v.network) && !isGoogleIp(v.ip)).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const out: Cluster[] = []
  for (let i = 0; i < list.length; ) {
    const start = Date.parse(list[i].startedAt)
    let j = i
    while (j + 1 < list.length && Date.parse(list[j + 1].startedAt) - start <= CLUSTER_SECONDS * 1000) j++
    const group = list.slice(i, j + 1)
    if (new Set(group.map((v) => v.network)).size >= CLUSTER_MIN) {
      out.push({
        start: group[0].startedAt,
        visits: group,
        places: [...new Set(group.map((v) => [v.city, v.region, v.country].filter(Boolean).join(", ") || "Unknown"))],
      })
      i = j + 1
    } else i++
  }
  return out.sort((a, b) => b.visits.length - a.visits.length)
}
