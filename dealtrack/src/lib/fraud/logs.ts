// Reading web server access logs (WP Engine's, or any server's in the usual "combined" format)
// for ad clicks: every request whose address carries a Google click ID. Logs hold what Google
// asks for in a refund claim (the IP address, the exact time, and the browser of each click)
// and that the Google Ads API never shows. Runs in the browser, so the log file never leaves
// the computer. Pure functions, safe on the server and in the browser.

export const BOT_AGENT = /headless|phantomjs|selenium|puppeteer|playwright|python|curl|wget|go-http|okhttp|bot\b|spider|crawler/i

// Google's own systems open ad landing pages to check them; those visits aren't billed clicks.
const GOOGLE_V4 = /^(66\.102|66\.249|64\.233|72\.14|74\.125|209\.85|216\.239|173\.194|108\.177)\./
const GOOGLE_V6 = /^(2001:4860|2404:6800|2607:f8b0|2800:3f0|2a00:1450|2c0f:fb50):/i
export const isGoogleIp = (ip: string) => GOOGLE_V4.test(ip) || GOOGLE_V6.test(ip)

// Phones and homes get a fixed IPv6 /64 and rotate the rest, so visits are grouped by it.
export function networkOf(ip: string) {
  if (!ip.includes(":")) return ip
  const groups = ip.split("::")[0].split(":")
  return `${groups.slice(0, 4).join(":")}::/64`
}

export type LogHit = {
  ip: string
  network: string
  time: string // ISO, UTC
  path: string
  gclid: string
  userAgent: string
  status: number
}

export type LogNetwork = {
  network: string
  ips: string[]
  hits: LogHit[]
  adClicks: number // distinct click IDs
  first: string
  last: string
  userAgents: string[]
  bot: boolean
  fastestGapS: number | null // the shortest time between two ad clicks
}

export type LogSummary = {
  lines: number
  read: number // lines that looked like log lines
  first: string | null
  last: string | null
  adHits: LogHit[]
  networks: LogNetwork[] // suspicious first
  googleChecks: number
}

const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
}
const CLF_TIME = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\]/
const ISO_TIME = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/
const REQUEST = /"(?:GET|POST|HEAD|PUT|OPTIONS|PATCH|DELETE) ([^ "]+)[^"]*" (\d{3})/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i
const CLICK_ID = /[?&](?:gclid|gbraid|wbraid)=([^&\s"#]+)/
const AD_LANDING = /[?&](?:gclid|gbraid|wbraid|gad_source|gad_campaignid)=/

function timeOf(line: string): string | null {
  const c = line.match(CLF_TIME)
  if (c) {
    const [, d, mon, y, h, mi, s, tz] = c
    const iso = `${y}-${MONTHS[mon] ?? "01"}-${d}T${h}:${mi}:${s}${tz.slice(0, 3)}:${tz.slice(3)}`
    const t = Date.parse(iso)
    return Number.isNaN(t) ? null : new Date(t).toISOString()
  }
  const i = line.match(ISO_TIME)
  if (!i) return null
  const t = Date.parse(i[1].replace(" ", "T"))
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

// One log line, or null when it isn't an ad click. The first IP address on the line is taken as
// the visitor's (WP Engine puts it first; some formats put the site's name before it).
export function parseLogLine(line: string): LogHit | "other" | null {
  const req = line.match(REQUEST)
  if (!req) return null
  const time = timeOf(line)
  const ip = line
    .slice(0, req.index)
    .split(/[\s,|]+/)
    .map((t) => t.replace(/^\[|\]$/g, ""))
    .find((t) => IPV4.test(t) || (IPV6.test(t) && t.includes(":")))
  if (!time || !ip) return null
  const path = req[1]
  if (!AD_LANDING.test(path)) return "other"
  const quoted = line.slice(req.index! + req[0].length).match(/"([^"]*)"/g) ?? []
  let gclid = path.match(CLICK_ID)?.[1] ?? ""
  try {
    gclid = decodeURIComponent(gclid)
  } catch {}
  return {
    ip,
    network: networkOf(ip),
    time,
    path: path.slice(0, 300),
    gclid,
    userAgent: (quoted.at(-1) ?? "").slice(1, -1).slice(0, 300),
    status: Number(req[2]),
  }
}

// Reads lines one at a time (logs can be large), then groups the ad clicks by network.
export function logReader() {
  let lines = 0
  let read = 0
  let first: string | null = null
  let last: string | null = null
  const hits: LogHit[] = []
  return {
    push(line: string) {
      lines++
      const hit = parseLogLine(line)
      if (!hit) return
      read++
      if (hit === "other") return
      // Pages load images and scripts with the same address in the referrer; only the page counts.
      if (/\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?)(\?|$)/i.test(hit.path)) return
      hits.push(hit)
      if (!first || hit.time < first) first = hit.time
      if (!last || hit.time > last) last = hit.time
    },
    result(): LogSummary {
      return summarizeHits(hits, { lines, read, first, last })
    },
  }
}

export function summarizeHits(all: LogHit[], counts: Pick<LogSummary, "lines" | "read" | "first" | "last">): LogSummary {
  const sorted = [...all].sort((a, b) => a.time.localeCompare(b.time))
  // A page reload sends the same click ID again; keep the first request for each.
  const seen = new Set<string>()
  const hits = sorted.filter((h) => {
    const key = h.gclid ? `${h.network}|${h.gclid}` : `${h.network}|${h.time}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const google = hits.filter((h) => isGoogleIp(h.ip))
  const by = new Map<string, LogHit[]>()
  for (const h of hits) if (!isGoogleIp(h.ip)) by.set(h.network, [...(by.get(h.network) ?? []), h])
  const networks = [...by].map(([network, list]): LogNetwork => {
    const gaps = list.slice(1).map((h, i) => (Date.parse(h.time) - Date.parse(list[i].time)) / 1000)
    return {
      network,
      ips: [...new Set(list.map((h) => h.ip))],
      hits: list,
      adClicks: new Set(list.map((h) => h.gclid || h.time)).size,
      first: list[0].time,
      last: list[list.length - 1].time,
      userAgents: [...new Set(list.map((h) => h.userAgent))].slice(0, 5),
      bot: list.some((h) => BOT_AGENT.test(h.userAgent)),
      fastestGapS: gaps.length ? Math.min(...gaps) : null,
    }
  })
  const weight = (n: LogNetwork) => n.adClicks * 10 + (n.bot ? 50 : 0) + (n.fastestGapS !== null && n.fastestGapS < 60 ? 20 : 0)
  return {
    ...counts,
    adHits: hits.filter((h) => !isGoogleIp(h.ip)),
    networks: networks.sort((a, b) => weight(b) - weight(a)),
    googleChecks: google.length,
  }
}
