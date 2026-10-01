// The evidence pack for an invalid-click refund claim: a summary to paste into Google's form,
// and a spreadsheet (CSV) with one row per click — the click ID (GCLID) Google can look up,
// plus the time, IP address, and browser from the site's analytics and the server logs.
// Pure functions, used in the browser.

import type { AdClick, FraudDay } from "@/lib/fraud/clicks"
import type { LogHit } from "@/lib/fraud/logs"
import type { AdVisit } from "@/lib/fraud/visitors"

export type ClaimInput = {
  account: { id: string; name: string }
  days: FraudDay[] // the days being claimed
  clicks: AdClick[] // Google's billed clicks on those days (last 90 days only)
  visits: AdVisit[] // ad visits PostHog saw on those days
  logHits: LogHit[] // ad clicks from the server logs on those days
  note: string // what the team knows, e.g. "A competitor, John Buys Houses, clicked our ads"
}

export type EvidenceRow = {
  date: string
  gclid: string
  campaign: string
  adGroup: string
  keyword: string
  googleLocation: string
  device: string
  billed: "yes" | "not in Google's list" | "unknown (older than 90 days)"
  siteTime: string
  siteIp: string
  sitePlace: string
  siteBrowser: string
  secondsOnSite: string
  formSent: string
  logTime: string
  logIp: string
  logUserAgent: string
}

const decode = (g: string) => {
  try {
    return decodeURIComponent(g)
  } catch {
    return g
  }
}

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
const day = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
const pacific = (iso: string) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "medium" }) + " PT" : ""
export const accountNumber = (id: string) => id.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")

// One row per click: Google's clicks first, then clicks the site saw that Google didn't list.
export function evidenceRows(input: ClaimInput, todayIso: string): EvidenceRow[] {
  const dates = new Set(input.days.map((d) => d.date))
  const visitBy = new Map(input.visits.filter((v) => v.gclid).map((v) => [decode(v.gclid), v]))
  const logBy = new Map(input.logHits.filter((h) => h.gclid).map((h) => [decode(h.gclid), h]))
  const recent = (date: string) => Date.parse(date) >= Date.parse(todayIso) - 89 * 86_400_000
  const rows: EvidenceRow[] = []
  const used = new Set<string>()

  const site = (v?: AdVisit) => ({
    siteTime: v ? pacific(v.startedAt) : "",
    siteIp: v?.ip ?? "",
    sitePlace: v ? [v.city, v.region, v.country].filter(Boolean).join(", ") : "",
    siteBrowser: v ? [v.browser, v.os, v.device].filter(Boolean).join(" · ") : "",
    secondsOnSite: v ? String(v.durationS) : "",
    formSent: v ? (v.submitted ? "yes" : "no") : "",
  })
  const log = (h?: LogHit) => ({ logTime: h ? pacific(h.time) : "", logIp: h?.ip ?? "", logUserAgent: h?.userAgent ?? "" })

  for (const c of input.clicks) {
    if (!dates.has(c.date)) continue
    used.add(c.gclid)
    rows.push({
      date: c.date,
      gclid: c.gclid,
      campaign: c.campaign,
      adGroup: c.adGroup,
      keyword: c.keyword,
      googleLocation: c.place,
      device: c.device.toLowerCase(),
      billed: "yes",
      ...site(visitBy.get(c.gclid)),
      ...log(logBy.get(c.gclid)),
    })
  }
  const extra = new Map<string, { date: string; visit?: AdVisit; hit?: LogHit }>()
  for (const v of input.visits) {
    const g = decode(v.gclid)
    if (!g || used.has(g)) continue
    extra.set(g, { ...extra.get(g), date: dayInPacific(v.startedAt), visit: v })
  }
  for (const h of input.logHits) {
    const g = decode(h.gclid)
    if (!g || used.has(g)) continue
    extra.set(g, { date: dayInPacific(h.time), ...extra.get(g), hit: h })
  }
  for (const [gclid, e] of extra) {
    if (!dates.has(e.date)) continue
    rows.push({
      date: e.date,
      gclid,
      campaign: e.visit?.campaignId ? `Campaign ${e.visit.campaignId}` : "",
      adGroup: "",
      keyword: "",
      googleLocation: "",
      device: "",
      billed: recent(e.date) ? "not in Google's list" : "unknown (older than 90 days)",
      ...site(e.visit),
      ...log(e.hit),
    })
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.siteTime || a.logTime).localeCompare(b.siteTime || b.logTime))
}

export const dayInPacific = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(iso))

const HEADERS: [keyof EvidenceRow, string][] = [
  ["date", "Date (Pacific)"],
  ["gclid", "Google click ID (GCLID)"],
  ["billed", "Billed by Google"],
  ["campaign", "Campaign"],
  ["adGroup", "Ad group"],
  ["keyword", "Keyword"],
  ["googleLocation", "Location (Google)"],
  ["device", "Device"],
  ["siteTime", "Arrived on site"],
  ["siteIp", "IP address (site analytics)"],
  ["sitePlace", "Location (site analytics)"],
  ["siteBrowser", "Browser"],
  ["secondsOnSite", "Seconds on site"],
  ["formSent", "Sent a form"],
  ["logTime", "Request time (server log)"],
  ["logIp", "IP address (server log)"],
  ["logUserAgent", "User agent (server log)"],
]

export function evidenceCsv(rows: EvidenceRow[]): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [HEADERS.map(([, h]) => h), ...rows.map((r) => HEADERS.map(([k]) => r[k]))].map((r) => r.map(cell).join(",")).join("\n")
}

type Repeat = { ip: string; clicks: number; first: string; last: string; source: "site analytics" | "server logs" }

// The same IP address (or home/phone network) behind several clicks on the claimed days.
function repeats(rows: EvidenceRow[]): Repeat[] {
  const out: Repeat[] = []
  for (const [field, timeField, source] of [
    ["siteIp", "siteTime", "site analytics"],
    ["logIp", "logTime", "server logs"],
  ] as const) {
    const by = new Map<string, EvidenceRow[]>()
    for (const r of rows) if (r[field]) by.set(r[field], [...(by.get(r[field]) ?? []), r])
    for (const [ip, list] of by) {
      if (list.length < 2) continue
      out.push({ ip, clicks: list.length, first: list[0][timeField], last: list[list.length - 1][timeField], source })
    }
  }
  return out.sort((a, b) => b.clicks - a.clicks)
}

// The text for Google's invalid-click form ("Describe the issue").
export function claimText(input: ClaimInput, rows: EvidenceRow[]): string {
  const days = [...input.days].sort((a, b) => a.date.localeCompare(b.date))
  if (!days.length) return ""
  const billed = rows.filter((r) => r.billed === "yes")
  const cost = days.reduce((s, d) => s + d.cost, 0)
  const clicks = days.reduce((s, d) => s + d.clicks, 0)
  const invalid = days.reduce((s, d) => s + d.invalid, 0)
  const conversions = days.reduce((s, d) => s + d.conversions, 0)
  const span = days.length === 1 ? day(days[0].date) : `${day(days[0].date)} to ${day(days[days.length - 1].date)}`
  const lines: string[] = []
  lines.push(`Google Ads account ${accountNumber(input.account.id)}${input.account.name ? ` (${input.account.name})` : ""}`)
  lines.push(`Request: review and credit invalid clicks, ${span}`)
  lines.push("")
  if (input.note.trim()) {
    lines.push(input.note.trim())
    lines.push("")
  }
  lines.push("What happened")
  for (const d of days) {
    const top = d.campaigns[0]
    lines.push(
      `- ${day(d.date)}: ${d.clicks} billed clicks (a normal day for this account was ${Math.round(d.normalClicks)}), ${usd(d.cost)} charged, ` +
        `${Math.round(d.conversions * 10) / 10} conversions. Google already filtered ${d.invalid} invalid clicks that day.` +
        (top ? ` Most were on the campaign "${top.name}".` : "") +
        (d.reasons.filter((r) => !r.startsWith("Google filtered")).length ? ` ${d.reasons.filter((r) => !r.startsWith("Google filtered")).join("; ")}.` : ""),
    )
  }
  lines.push(
    `Total: ${clicks} billed clicks, ${usd(cost)}, ${Math.round(conversions * 10) / 10} conversions; ${invalid} clicks already filtered as invalid.`,
  )
  lines.push("")

  const evidence: string[] = []
  for (const r of repeats(rows).slice(0, 8)) {
    evidence.push(`- IP address ${r.ip} made ${r.clicks} ad clicks (${r.source}), from ${r.first} to ${r.last}.`)
  }
  const bots = rows.filter((r) => /headless|phantomjs|selenium|puppeteer|playwright|python|curl|wget|bot\b|spider|crawler/i.test(r.logUserAgent))
  if (bots.length) evidence.push(`- ${bots.length} clicks came from automated browsers (user agents such as "${bots[0].logUserAgent.slice(0, 80)}").`)
  const bounced = rows.filter((r) => r.secondsOnSite !== "" && Number(r.secondsOnSite) < 5 && r.formSent === "no")
  if (bounced.length >= 3) evidence.push(`- ${bounced.length} of the clicks left the site within 5 seconds without doing anything.`)
  const outside = billed.filter((r) => r.googleLocation && !/California/.test(r.googleLocation))
  if (outside.length) evidence.push(`- ${outside.length} clicks came from outside the area the ads target (California).`)
  const missing = rows.filter((r) => r.billed !== "yes" && r.billed !== "unknown (older than 90 days)")
  if (missing.length) evidence.push(`- ${missing.length} ad visits on our site carry click IDs that aren't in the account's click report.`)
  if (evidence.length) {
    lines.push("Evidence")
    lines.push(...evidence)
    lines.push("")
  }
  lines.push(
    `Attached: a spreadsheet with ${rows.length} clicks: the Google click ID (GCLID) of each${rows.some((r) => r.siteIp || r.logIp) ? ", with the time, IP address, and browser from our website analytics and server logs" : ""}.`,
  )
  lines.push("We ask that these clicks be investigated and the account credited for the invalid ones.")
  return lines.join("\n")
}
