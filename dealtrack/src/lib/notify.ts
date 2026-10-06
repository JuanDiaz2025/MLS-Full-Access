// Emails people when a new alert opens. Sent with Gmail from the Google account connected on
// Leads → Lead automation ("Connect Google for conversions", which also asks to send email), so
// there's no mail server or password to set up. Who gets them, and from which severity, is set on
// the Alerts page and saved in .data/alert-notify.json.
//
// Only alerts that weren't already open are sent, and the same alert at most once a day, so an
// alert that clears and comes back quickly doesn't send a stream of emails.
//
// The same alerts can also go to a webhook (e.g. a Zapier "Catch Hook" that posts them to a Google
// Chat space), with its own on/off switch and severity. See sendWebhook for what it receives.

import { accessToken, AdsApiError, GMAIL_SCOPE, getConnection } from "@/lib/conversions/google"
import { jsonFileStore } from "@/lib/json-file-store"
import type { AlertRecord } from "@/lib/store"

export type Severity = AlertRecord["severity"]
export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, info: 0 }
const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", info: "Info" }

const RESEND_AFTER_MS = 24 * 60 * 60_000
const MAX_RECIPIENTS = 20

export type NotifySettings = {
  enabled: boolean
  emails: string[]
  minSeverity: Severity // this severity and more serious are emailed
  updatedBy?: string
  updatedAt?: string
  lastSent?: { at: string; count: number; to: string[]; test?: boolean }
  lastError?: { at: string; message: string; test?: boolean }
  sent: Record<string, string> // alert key → when it was last emailed
  chat?: ChatSettings
}

// The webhook (Zapier → Google Chat). Kept apart from the emails: its own switch, severity and
// once-a-day memory, so one failing doesn't hold the other back.
export type ChatSettings = {
  enabled: boolean
  url: string
  minSeverity: Severity
  updatedBy?: string
  updatedAt?: string
  lastSent?: { at: string; count: number; test?: boolean }
  lastError?: { at: string; message: string; test?: boolean }
  sent: Record<string, string>
}

const file = jsonFileStore<NotifySettings>("alert-notify.json", () => ({ enabled: false, emails: [], minSeverity: "high", sent: {} }))

export async function getNotifySettings(): Promise<NotifySettings> {
  const s = await file.read()
  const chat = s.chat
  return {
    ...s,
    enabled: Boolean(s.enabled),
    emails: s.emails ?? [],
    minSeverity: s.minSeverity ?? "high",
    sent: s.sent ?? {},
    chat: { ...chat, enabled: Boolean(chat?.enabled), url: chat?.url ?? "", minSeverity: chat?.minSeverity ?? "high", sent: chat?.sent ?? {} },
  }
}

export async function saveChatSettings(input: Pick<ChatSettings, "enabled" | "url" | "minSeverity" | "updatedBy">) {
  await file.update((s) => {
    s.chat = { ...s.chat, sent: s.chat?.sent ?? {}, ...input, updatedAt: new Date().toISOString() }
  })
}

// A webhook address, or an error message. Only https, so alert details aren't sent in the clear.
export function parseWebhookUrl(text: string): string | { error: string } {
  const value = text.trim()
  if (!value) return ""
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { error: "That doesn't look like a web address. Paste the whole webhook URL from Zapier." }
  }
  if (url.protocol !== "https:") return { error: "The webhook address has to start with https://" }
  return url.toString()
}

// Shown on the Alerts page without the secret part of the address (Zapier's hook id).
export const maskUrl = (url: string) => {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname.length > 12 ? `${u.pathname.slice(0, 12)}…` : u.pathname}`
  } catch {
    return url
  }
}

export async function saveNotifySettings(input: Pick<NotifySettings, "enabled" | "emails" | "minSeverity" | "updatedBy">) {
  await file.update((s) => {
    Object.assign(s, input, { updatedAt: new Date().toISOString() })
  })
}

// "a@x.com, b@y.com\nc@z.com" → the addresses, or an error message.
export function parseEmails(text: string): string[] | string {
  const list = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  const bad = list.filter((e) => !/^[^\s@<>()"]+@[^\s@<>()"]+\.[a-z]{2,}$/i.test(e))
  if (bad.length) return `${bad.join(", ")} ${bad.length === 1 ? "doesn't" : "don't"} look like an email address.`
  if (list.length > MAX_RECIPIENTS) return `Up to ${MAX_RECIPIENTS} people.`
  return list
}

// Who the emails come from, and whether that account allowed DealTrack to send them.
export async function sender(): Promise<{ email: string; canSend: boolean; source: "connected" | "env" } | null> {
  const connection = await getConnection().catch(() => null)
  if (!connection) return null
  return { email: connection.email, canSend: connection.scopes.includes(GMAIL_SCOPE), source: connection.source }
}

const RECONNECT =
  "DealTrack needs permission to send email. Click “Connect Google again” below (or on Leads → Lead automation) and leave every box ticked."

// A header value with characters outside plain ASCII (dashes, accents) in the form email allows.
const header = (text: string) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`)

export async function sendEmail(to: string[], subject: string, html: string) {
  const connection = await getConnection()
  if (!connection) throw new AdsApiError("Google isn't connected. Check the Google Ads keys in .env.local.")
  if (!connection.scopes.includes(GMAIL_SCOPE)) throw new AdsApiError(RECONNECT, "NEEDS_PERMISSION")
  const message = [
    `To: ${to.join(", ")}`,
    `Subject: ${header(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n")
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(connection)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(message, "utf8").toString("base64url") }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  if (res.ok) return
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; details?: { reason?: string; metadata?: Record<string, string> }[] }
  }
  const e = body.error ?? {}
  const reasons = (e.details ?? []).map((d) => d.reason ?? "").join(" ")
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(`${reasons} ${e.message}`))
    throw new AdsApiError(RECONNECT, "NEEDS_PERMISSION")
  if (/SERVICE_DISABLED/.test(reasons) || /API has not been used|API .*is disabled/i.test(e.message ?? "")) {
    const meta = Object.assign({}, ...(e.details ?? []).map((d) => d.metadata ?? {})) as Record<string, string>
    const link = meta.activationUrl ?? "https://console.cloud.google.com/apis/library/gmail.googleapis.com"
    throw new AdsApiError(`Turn on the Gmail API for your app's Google Cloud project here: ${link} , wait 5 minutes, then try again.`, "API_OFF")
  }
  throw new AdsApiError(e.message ?? `Gmail answered ${res.status}.`)
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const siteUrl = () => (process.env.DEALTRACK_URL || "http://localhost:3000").replace(/\/$/, "")
const COLORS: Record<Severity, string> = { critical: "#b91c1c", high: "#dc2626", medium: "#b45309", info: "#6b7280" }

type Item = Pick<AlertRecord, "severity" | "title" | "detail" | "href">

function alertsHtml(items: Item[], intro: string) {
  const rows = items
    .map(
      (a) => `<tr><td style="padding:10px 0;border-top:1px solid #eee;vertical-align:top">
<span style="display:inline-block;padding:2px 8px;border-radius:9px;background:${COLORS[a.severity]};color:#fff;font-size:12px;font-weight:bold">${SEVERITY_LABEL[a.severity]}</span>
<div style="margin-top:6px;font-weight:bold"><a href="${siteUrl()}${escape(a.href ?? "/alerts")}" style="color:#111;text-decoration:none">${escape(a.title)}</a></div>
<div style="color:#555;font-size:14px">${escape(a.detail)}</div></td></tr>`,
    )
    .join("")
  return `<div style="font-family:Arial,sans-serif;max-width:600px;color:#111">
<p style="font-size:15px">${intro}</p>
<table style="width:100%;border-collapse:collapse">${rows}</table>
<p style="margin-top:16px"><a href="${siteUrl()}/alerts" style="color:#2563eb">Open Alerts in DealTrack</a></p>
<p style="color:#888;font-size:12px">Sent by DealTrack (Marketing Command Center). Change who gets these on the Alerts page.</p></div>`
}

const isDue = (a: Item & { key: string }, minSeverity: Severity, sent: Record<string, string>, now: number) =>
  SEVERITY_RANK[a.severity] >= SEVERITY_RANK[minSeverity] && !(sent[a.key] && now - Date.parse(sent[a.key]) < RESEND_AFTER_MS)
const keepWeek = (sent: Record<string, string>, now: number) =>
  Object.fromEntries(Object.entries(sent).filter(([, t]) => now - Date.parse(t) < 7 * RESEND_AFTER_MS))

// Sends the alerts that just opened, by email and to the webhook, to whichever is on and wants them.
export async function notifyNewAlerts(opened: (Item & { key: string })[]) {
  await Promise.all([emailNewAlerts(opened), chatNewAlerts(opened)])
}

async function emailNewAlerts(opened: (Item & { key: string })[]) {
  const s = await getNotifySettings()
  if (!s.enabled || !s.emails.length) return
  const now = Date.now()
  const due = opened.filter((a) => isDue(a, s.minSeverity, s.sent, now))
  if (!due.length) return
  const top = due.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a))
  const subject = due.length === 1 ? `DealTrack alert: ${top.title}` : `DealTrack: ${due.length} new alerts (${top.title})`
  const at = new Date().toISOString()
  try {
    await sendEmail(
      s.emails,
      subject.slice(0, 180),
      alertsHtml(due, due.length === 1 ? "A new alert just opened:" : `${due.length} new alerts just opened:`),
    )
    await file.update((d) => {
      d.sent = keepWeek(d.sent ?? {}, now)
      for (const a of due) d.sent[a.key] = at
      d.lastSent = { at, count: due.length, to: s.emails }
      delete d.lastError
    })
  } catch (e) {
    await file.update((d) => {
      d.lastError = { at, message: e instanceof Error ? e.message : String(e) }
    })
  }
}

// What the webhook receives, as JSON. "text" is ready to post as a Google Chat message (Chat reads
// *bold* and <url|label> links), so in Zapier it's the only field to map; the rest is there for
// anyone who wants to build their own message.
function webhookBody(items: Item[], test = false) {
  const top = items.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a))
  const title = test ? "DealTrack test: Google Chat alerts work" : items.length === 1 ? `DealTrack alert: ${top.title}` : `DealTrack: ${items.length} new alerts`
  const lines = items.map((a) => `• *${SEVERITY_LABEL[a.severity]}:* <${siteUrl()}${a.href ?? "/alerts"}|${a.title}>\n   ${a.detail}`)
  return {
    source: "DealTrack",
    event: test ? "test" : "alerts.opened",
    sentAt: new Date().toISOString(),
    title,
    text: [`*${title}*`, ...lines, `<${siteUrl()}/alerts|Open Alerts in DealTrack>`].join("\n"),
    count: items.length,
    topSeverity: top.severity,
    alerts: items.map((a) => ({
      severity: a.severity,
      severityLabel: SEVERITY_LABEL[a.severity],
      title: a.title,
      detail: a.detail,
      url: `${siteUrl()}${a.href ?? "/alerts"}`,
    })),
    alertsPageUrl: `${siteUrl()}/alerts`,
  }
}

export async function sendWebhook(url: string, body: unknown) {
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw new Error(`Couldn't reach the webhook (${e instanceof Error ? e.message : String(e)}). Check the address.`)
  }
  if (res.ok) return
  if (res.status === 404 || res.status === 410)
    throw new Error(`The webhook answered ${res.status}: the address is wrong or the Zap was deleted. Copy the URL from Zapier again.`)
  const text = (await res.text().catch(() => "")).slice(0, 200)
  throw new Error(`The webhook answered ${res.status}${text ? `: ${text}` : ""}.`)
}

async function chatNewAlerts(opened: (Item & { key: string })[]) {
  const { chat } = await getNotifySettings()
  if (!chat?.enabled || !chat.url) return
  const now = Date.now()
  const due = opened.filter((a) => isDue(a, chat.minSeverity, chat.sent, now))
  if (!due.length) return
  const at = new Date().toISOString()
  try {
    await sendWebhook(chat.url, webhookBody(due))
    await file.update((d) => {
      const c = d.chat!
      c.sent = keepWeek(c.sent ?? {}, now)
      for (const a of due) c.sent[a.key] = at
      c.lastSent = { at, count: due.length }
      delete c.lastError
    })
  } catch (e) {
    await file.update((d) => {
      if (d.chat) d.chat.lastError = { at, message: e instanceof Error ? e.message : String(e) }
    })
  }
}

// A sample message, to check the webhook and the Zap behind it work.
export async function sendTestWebhook(url: string, by: string) {
  const at = new Date().toISOString()
  const sample: Item = {
    severity: "info",
    title: "This is a test alert",
    detail: `${by} sent this from the Alerts page to check that alerts reach Google Chat. Nothing needs attention.`,
    href: "/alerts",
  }
  try {
    await sendWebhook(url, webhookBody([sample], true))
    await file.update((d) => {
      if (d.chat) {
        d.chat.lastSent = { at, count: 1, test: true }
        delete d.chat.lastError
      }
    })
  } catch (e) {
    await file.update((d) => {
      if (d.chat) d.chat.lastError = { at, message: e instanceof Error ? e.message : String(e), test: true }
    })
    throw e
  }
}

// A sample email, to check the people and the Google connection work.
export async function sendTestEmail(to: string[], by: string) {
  const at = new Date().toISOString()
  try {
    await sendEmail(
      to,
      "DealTrack test: alert emails work",
      alertsHtml(
        [
          {
            severity: "info",
            title: "This is a test alert",
            detail: `${by} sent this from the Alerts page to check that alert emails arrive. Nothing needs attention.`,
            href: "/alerts",
          },
        ],
        "This is how DealTrack alert emails will look:",
      ),
    )
    await file.update((d) => {
      d.lastSent = { at, count: 1, to, test: true }
      delete d.lastError
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await file.update((d) => {
      d.lastError = { at, message, test: true }
    })
    throw e
  }
}
