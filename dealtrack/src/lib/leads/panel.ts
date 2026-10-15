// Everything the lead panel on the Leads page shows about one lead, ready to read: the team's
// notes and follow-up date, the lead's history, the ad it came from, and what Google Ads heard.
import { liveNotes, pacificDay } from "@/lib/leads/notes"
import { cleanTracking, googleClick } from "@/lib/leads/tracking"
import { leadStatuses, type ConversionKind, type ConversionUpload, type Lead, type LeadGrade } from "@/lib/leads/types"

export type Tone = "good" | "bad"
export type LeadDetail = {
  // A website lead: its notes and follow-up date go to the team's other computers too.
  shared: boolean
  notes: { id: string; when: string; by?: string; text: string }[] // newest first
  followUp?: { on: string; label: string; due: "overdue" | "today" | "soon" | "later"; note?: string; by?: string }
  history: { when: string; text: string; by?: string; tone?: Tone }[] // newest first
  ad?: { campaign?: string; adGroup?: string; keyword?: string; matchType?: string; device?: string; position?: string; fromLink?: boolean }
  adNote?: string // why the ad click's details aren't there (yet)
  tracking: [string, string][] // the raw tracking: label, value
  google: { title: string; lines: { text: string; tone?: Tone }[] }[]
  googleNote?: string
  call?: { when: string; result: string; missed: boolean; campaign?: string; areaCode?: string }
}

const ZONE = "America/Los_Angeles"
const DAY_MS = 86_400_000
const GOOGLE_KEEPS_MS = 90 * DAY_MS

// "Oct 9, 2026, 3:35 PM", Pacific.
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: ZONE, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
// "2026-10-17" → "Fri, Oct 17".
export const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
const statusName = (id?: string) => leadStatuses.find((s) => s.id === (id || "new"))?.label ?? id ?? "New"
const GRADE: Record<LeadGrade, string> = { hot: "Hot", warm: "Warm", cold: "Cold", junk: "Junk" }
const KIND: Record<ConversionKind, string> = { interested: "Interested (a qualified lead)", closed: "Closed deal", invalid: "Invalid lead (reporting only)" }
const KIND_SHORT: Record<ConversionKind, string> = { interested: "Interested", closed: "Closed deal", invalid: "an invalid lead" }

const DEVICE: Record<string, string> = { MOBILE: "Phone", DESKTOP: "Computer", TABLET: "Tablet", CONNECTED_TV: "TV", OTHER: "Other" }
const SLOT: Record<string, string> = {
  SEARCH_TOP: "Top of Google's results",
  SEARCH_OTHER: "Below Google's results",
  SEARCH_PARTNER_TOP: "Top of a search partner's results",
  SEARCH_PARTNER_OTHER: "On a search partner's results",
  CONTENT: "Display network",
}
const MATCH: Record<string, string> = { EXACT: "exact match", PHRASE: "phrase match", BROAD: "broad match" }

// When to get back to the lead, against today in Pacific time.
export function followUpDue(on: string, today = pacificDay()) {
  const tomorrow = pacificDay(Date.parse(`${today}T12:00:00Z`) + DAY_MS)
  if (on < today) return { due: "overdue" as const, label: `Overdue: was due ${dayLabel(on)}` }
  if (on === today) return { due: "today" as const, label: "Due today" }
  if (on === tomorrow) return { due: "soon" as const, label: `Tomorrow, ${dayLabel(on)}` }
  return { due: "later" as const, label: dayLabel(on) }
}

// The Google Ads call a phone-call lead was made from. Leads added before the call was kept with
// them have it in their id ("call:2026-10-14 18:12:33:510") and first note line.
function callOf(lead: Lead): LeadDetail["call"] {
  const parsed = lead.callId?.match(/^call:(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):(\d*)$/)
  if (!lead.call && !parsed) return undefined
  const first = lead.notes?.split("\n")[0] ?? ""
  const c = lead.call ?? {
    start: parsed![1],
    areaCode: parsed![2] || undefined,
    missed: /^Missed call/.test(first),
    seconds: Number(first.match(/(\d+) min/)?.[1] ?? 0) * 60,
    campaign: cleanTracking(lead.tracking)?.utmCampaign,
  }
  // "2026-10-14 18:12:33" is the Google Ads account's time.
  const [date, time = "00:00:00"] = c.start.split(" ")
  const at = new Date(`${date}T${time}Z`)
  const length = c.seconds >= 60 ? `${Math.floor(c.seconds / 60)} min${c.seconds % 60 ? ` ${c.seconds % 60} sec` : ""}` : c.seconds ? `${c.seconds} sec` : ""
  return {
    when: Number.isNaN(at.getTime()) ? c.start : at.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }),
    result: c.missed ? "Missed" : `Answered${length ? `, ${lead.call ? "" : "about "}${length}` : ""}`,
    missed: Boolean(c.missed),
    campaign: c.campaign,
    areaCode: c.areaCode,
  }
}

// What Google Ads heard, one block per conversion.
function googleOf(lead: Lead): LeadDetail["google"] {
  const out: LeadDetail["google"] = []
  for (const kind of ["interested", "closed", "invalid"] as const) {
    const c: ConversionUpload | undefined = lead.conversions?.[kind]
    if (!c || c.parked) continue
    const lines: { text: string; tone?: Tone }[] = []
    if (c.state === "sent") lines.push({ text: `Sent ${when(c.lastTry ?? c.at)}${c.matchedBy ? `, matched by ${c.matchedBy}` : ""}.` })
    else if (c.state === "pending")
      lines.push({
        text: c.waitingFor
          ? "Waiting for a set-up step in Google (see the top of the Leads page)."
          : c.lastTry
            ? `Not taken yet: trying again (last try ${when(c.lastTry)}).${c.error ? ` ${c.error}` : ""}`
            : "Waiting to be sent (within a few minutes).",
      })
    else if (c.state === "failed") lines.push({ text: `Not sent: ${c.error ?? "Google Ads refused it."}`, tone: "bad" })
    else if (c.state === "skipped") lines.push({ text: `Not sent: ${c.error ?? "nothing Google can match it by (no click ID, email or phone)."}` })
    if (c.state === "sent" && c.google?.status === "accepted")
      lines.push({ text: `Accepted by Google ✓${c.google.reason ? ` (${c.google.reason})` : ""}. Checked ${when(c.google.checkedAt)}.`, tone: "good" })
    else if (c.state === "sent" && c.google?.status === "rejected") lines.push({ text: `Rejected by Google: ${c.google.reason ?? "no reason given"}.`, tone: "bad" })
    else if (c.state === "sent" && c.requestId) lines.push({ text: "Google is checking it (30 minutes to 24 hours)." })
    const back = c.retraction
    if (back?.state === "pending") lines.push({ text: "Being taken back from Google Ads." })
    else if (back?.state === "sent") lines.push({ text: `Taken back ${when(back.lastTry ?? back.at)}: Google no longer counts it.` })
    else if (back?.state === "failed") lines.push({ text: `Couldn't take it back: ${back.error ?? "Google Ads refused."}`, tone: "bad" })
    if (c.value !== undefined && c.value !== 1) lines.push({ text: `Value sent: $${c.value}.` })
    if (c.rule) lines.push({ text: `Queued by the Google Ads rule “${c.rule}”.` })
    out.push({ title: KIND[kind], lines })
  }
  return out
}

// The lead's story, newest first: when it came in, its score, every status and what Google heard.
function historyOf(lead: Lead, withGoogle: boolean): LeadDetail["history"] {
  const events: { at: string; text: string; by?: string; tone?: Tone }[] = [{ at: lead.createdAt, text: "Came in" }]
  // The score it came in with: a status changes the score, so for a lead worked before that was
  // kept (no firstScore) it isn't known any more.
  const unworked = !lead.status || lead.status === "new"
  const first = lead.firstScore ?? (unworked && lead.score && !lead.score.unscored ? lead.score : undefined)
  if (first) events.push({ at: lead.createdAt, text: `Scored ${first.value} (${GRADE[first.grade]}) when it came in` })
  const log =
    lead.statusLog ??
    (lead.status && lead.status !== "new" && lead.statusChangedAt
      ? [{ at: lead.statusChangedAt, status: lead.status, by: lead.statusByName, auto: lead.statusBy === "auto" || undefined }]
      : [])
  for (const e of log) events.push({ at: e.at, text: `Status: ${statusName(e.status)}${e.auto ? " (set by the app)" : ""}`, by: e.auto ? undefined : e.by })
  if (withGoogle) {
    for (const kind of ["interested", "closed", "invalid"] as const) {
      const c = lead.conversions?.[kind]
      if (!c || c.parked) continue
      if (c.state === "sent") events.push({ at: c.lastTry ?? c.at, text: `Sent to Google Ads as ${KIND_SHORT[kind]}` })
      if (c.state === "failed") events.push({ at: c.lastTry ?? c.at, text: `Couldn't send to Google Ads as ${KIND_SHORT[kind]}`, tone: "bad" })
      if (c.state === "sent" && c.google?.status === "accepted") events.push({ at: c.google.checkedAt, text: `Google accepted it (${KIND_SHORT[kind]})`, tone: "good" })
      if (c.state === "sent" && c.google?.status === "rejected") events.push({ at: c.google.checkedAt, text: `Google rejected it (${KIND_SHORT[kind]}): ${c.google.reason ?? "no reason given"}`, tone: "bad" })
      if (c.retraction?.state === "sent") events.push({ at: c.retraction.lastTry ?? c.retraction.at, text: `Taken back from Google Ads (${KIND_SHORT[kind]})` })
      if (c.retraction?.state === "failed") events.push({ at: c.retraction.lastTry ?? c.retraction.at, text: `Couldn't take back from Google Ads (${KIND_SHORT[kind]})`, tone: "bad" })
    }
  }
  return events
    .map((e, i) => ({ ...e, i, ms: Date.parse(e.at) || 0 }))
    .sort((a, b) => b.ms - a.ms || b.i - a.i)
    .map((e) => ({ when: when(e.at), text: e.text, by: e.by, tone: e.tone }))
}

// `elsewhere`: the team's computer that sends website leads to Google Ads, when it isn't this one.
export function leadDetail(lead: Lead, shared: boolean, elsewhere: { name?: string } | null): LeadDetail {
  const t = cleanTracking(lead.tracking) ?? {}
  const click = googleClick(lead.tracking)
  const a = lead.adClick
  const found = Boolean(a && Object.keys(a).length)
  const position = a?.slot ? SLOT[a.slot] : undefined
  const ad: LeadDetail["ad"] = found
    ? {
        campaign: a!.campaign,
        adGroup: a!.adGroup,
        keyword: a!.keyword,
        matchType: a!.matchType ? (MATCH[a!.matchType] ?? a!.matchType.toLowerCase()) : undefined,
        device: a!.device ? (DEVICE[a!.device] ?? a!.device) : undefined,
        position: position && a!.page && a!.page > 1 ? `${position}, page ${a!.page}` : position,
      }
    : t.utmCampaign || t.utmTerm || lead.call?.campaign
      ? { campaign: lead.call?.campaign ?? t.utmCampaign, keyword: t.utmTerm, fromLink: true }
      : undefined
  const age = Date.now() - Date.parse(lead.createdAt)
  const adNote = found
    ? undefined
    : click?.gclid
      ? a
        ? "Google Ads didn't have this click in its click report."
        : age < GOOGLE_KEEPS_MS
          ? "The ad's campaign, keyword and device come from Google Ads' click report, a few hours after the click. DealTrack looks it up by itself."
          : "Google Ads keeps click details for 90 days, and this click is older."
      : click
        ? "Google doesn't give click details for this kind of ad click (an iPhone click ID, gbraid or wbraid)."
        : undefined
  const tracking: [string, string][] = (
    [
      ["UTM source", t.utmSource],
      ["UTM medium", t.utmMedium],
      ["UTM campaign", t.utmCampaign],
      ["UTM term (keyword)", t.utmTerm],
      ["UTM content", t.utmContent],
      ["Google click ID (gclid)", t.gclid],
      ["iPhone click ID (gbraid)", t.gbraid],
      ["iPhone click ID (wbraid)", t.wbraid],
      ["Facebook click ID", t.fbclid],
      ["Microsoft click ID", t.msclkid],
      ["Landing page (full)", t.landingPage],
      ["Referrer", t.referrer],
    ] as [string, string | undefined][]
  ).filter((x): x is [string, string] => Boolean(x[1]))
  const fromTeam = Boolean(elsewhere && shared)
  const f = lead.followUp?.on ? lead.followUp : undefined
  return {
    shared,
    notes: liveNotes(lead)
      .slice()
      .reverse()
      .map((n) => ({ id: n.id, when: when(n.at), by: n.by, text: n.text })),
    followUp: f?.on ? { on: f.on, ...followUpDue(f.on), note: f.note, by: f.by } : undefined,
    history: historyOf(lead, !fromTeam),
    ad,
    adNote,
    tracking,
    google: fromTeam ? [] : googleOf(lead),
    googleNote: fromTeam
      ? `Google Ads hears about this lead from ${elsewhere!.name || "your team's main computer"}, so its results show there.`
      : lead.googleBlockedBy
        ? `The Google Ads rule “${lead.googleBlockedBy}” keeps this lead from Google Ads.`
        : undefined,
    call: callOf(lead),
  }
}
