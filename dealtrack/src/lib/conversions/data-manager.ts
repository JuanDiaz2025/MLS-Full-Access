// Google's Data Manager API, which Google now requires for sending offline conversions (the
// Google Ads API's uploadClickConversions is closed to new apps). It needs the "datamanager"
// permission (see google.ts), and the Data Manager API turned on in the Google Cloud project that
// DealTrack's Google client (GOOGLE_ADS_CLIENT_ID) belongs to. No developer token is needed.
import { accessToken, AdsApiError, type AdsAccount, type AdsConnection } from "@/lib/conversions/google"

export const DATA_MANAGER_LIBRARY = "https://console.cloud.google.com/apis/library/datamanager.googleapis.com"

export type DataManagerEvent = {
  eventTimestamp: string // ISO 8601
  transactionId?: string
  eventSource: "WEB" | "CALL"
  adIdentifiers?: { gclid?: string; gbraid?: string; wbraid?: string }
  userData?: { userIdentifiers: ({ emailAddress: string } | { phoneNumber: string })[] }
  conversionValue?: number
  currency?: string
}

type ErrorBody = {
  error?: {
    code?: number
    message?: string
    status?: string
    details?: {
      reason?: string
      metadata?: Record<string, string>
      links?: { description?: string; url?: string }[]
      fieldViolations?: { field?: string; description?: string; reason?: string }[]
    }[]
  }
}

// Sends events for one conversion action. Throws AdsApiError with a code saying what to do:
// NEEDS_PERMISSION (connect Google Ads again), API_OFF (turn on the API), TRANSIENT, or none.
type Destination = {
  operatingAccount: { accountType: "GOOGLE_ADS"; accountId: string }
  loginAccount?: { accountType: "GOOGLE_ADS"; accountId: string }
  productDestinationId: string
}

// The ways of naming the account to send to, best first. The conversion action may belong to a
// manager account (cross-account conversion tracking), and then the conversions have to go to that
// account; otherwise to the account itself, through the manager it's reached by, if any.
function destinations(account: AdsAccount, conversionActionId: string, owner?: string): Destination[] {
  const ga = (id: string) => ({ accountType: "GOOGLE_ADS" as const, accountId: id })
  const login = account.loginCustomerId
  const list: Destination[] = []
  const add = (operating: string, via?: string) => {
    const d: Destination = { operatingAccount: ga(operating), ...(via && via !== operating ? { loginAccount: ga(via) } : {}), productDestinationId: conversionActionId }
    if (!list.some((x) => JSON.stringify(x) === JSON.stringify(d))) list.push(d)
  }
  if (owner) add(owner, login)
  add(account.customerId, login)
  add(account.customerId)
  if (owner) add(owner)
  if (login) add(login)
  return list
}
// The last destination that worked, per account, so later sends go straight there.
const g = globalThis as typeof globalThis & { __omccDestination?: Map<string, string> }
const worked = (g.__omccDestination ??= new Map<string, string>())

// Google couldn't find the account or the conversion action from that way of naming them, or
// refused that way in (a wrong manager account): worth trying the other ways.
const NOT_FOUND = /not found|NOT_FOUND|INVALID_OPERATING_ACCOUNT|INVALID_LOGIN_ACCOUNT|PRODUCT_DESTINATION/i
const DENIED = /PERMISSION_DENIED|does not have permission|not authorized|caller does not have/i

// Sends events for one conversion action. Throws AdsApiError with a code saying what to do:
// NEEDS_PERMISSION (connect Google Ads again), API_OFF (turn on the API), TRANSIENT, or none.
// `owner` is the account that owns the conversion action, when it isn't this one.
// `validateOnly` asks Google to check the request without counting anything (for the Leads page's check).
export async function ingestEvents(
  connection: AdsConnection,
  account: AdsAccount,
  conversionActionId: string,
  events: DataManagerEvent[],
  validateOnly = false,
  owner?: string,
) {
  const key = `${account.customerId}:${conversionActionId}`
  let options = destinations(account, conversionActionId, owner)
  const known = worked.get(key)
  if (known) options = [...options.filter((d) => JSON.stringify(d) === known), ...options.filter((d) => JSON.stringify(d) !== known)]
  const errors: AdsApiError[] = []
  for (const destination of options) {
    try {
      const result = await sendOnce(connection, destination, events, validateOnly)
      worked.set(key, JSON.stringify(destination))
      return result
    } catch (e) {
      if (!(e instanceof AdsApiError) || !(e.notFound || e.denied)) throw e
      errors.push(e)
    }
  }
  // The first answer is about the best way in (the account itself), so it's the one to show.
  const first = errors[0]?.message ?? "Resource not found"
  if (errors.length && errors.every((e) => e.denied)) {
    // Not retried: nothing changes until someone with access connects, or another account is picked.
    throw new AdsApiError(
      `The Google account you connected can't use that Google Ads account (${account.name}, ${account.customerId}) for conversions. On the Google Ads page, pick your main account, or connect Google Ads again with a Google account that has access to it. (Google's words: “${first}”)`,
      "NO_ACCESS",
    )
  }
  throw new AdsApiError(
    `Google can't find the conversion action (id ${conversionActionId}) in your Google Ads account ${account.name} (${account.customerId})${owner && owner !== account.customerId ? ` or in ${owner}, which owns it` : ""}. If this isn't your main account, pick your main one on the Google Ads page. The app looks up your conversion actions again and retries on its own. (Google's words: “${first}”)`,
    "NOT_FOUND",
  )
}

async function sendOnce(connection: AdsConnection, destination: Destination, events: DataManagerEvent[], validateOnly: boolean) {
  const res = await fetch("https://datamanager.googleapis.com/v1/events:ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(connection)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ destinations: [destination], encoding: "HEX", events, ...(validateOnly ? { validateOnly: true } : {}) }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  if (res.ok) return (await res.json().catch(() => ({}))) as { requestId?: string }

  const body = ((await res.json().catch(() => null)) ?? {}) as ErrorBody
  const e = body.error ?? {}
  const reasons = (e.details ?? []).map((d) => d.reason ?? "").join(" ")
  const message = e.message ?? `Google answered ${res.status}.`
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(`${reasons} ${message}`)) {
    throw new AdsApiError(
      "Google needs one more permission to receive conversions. On the Leads page, open Automation and click Connect Google for conversions, and allow everything it asks.",
      "NEEDS_PERMISSION",
    )
  }
  // The API is off for the Google Cloud project that owns the app's sign-in client. Google names
  // that project and links straight to its switch: show both, since the usual cause is the API
  // being turned on in a different project.
  if (/SERVICE_DISABLED|accessNotConfigured/i.test(reasons) || /API has not been used|API .*is disabled|accessNotConfigured/i.test(message)) {
    const meta = Object.assign({}, ...(e.details ?? []).map((d) => d.metadata ?? {})) as Record<string, string>
    const link =
      meta.activationUrl ??
      (e.details ?? []).flatMap((d) => d.links ?? []).find((l) => l.url?.includes("console"))?.url ??
      DATA_MANAGER_LIBRARY
    const project = meta.consumer?.replace(/^projects\//, "") ?? message.match(/project (\d+)/)?.[1]
    throw new AdsApiError(
      `Google says the Data Manager API is off${project ? ` in Google Cloud project ${project}` : ""}, the project DealTrack's Google client (GOOGLE_ADS_CLIENT_ID) belongs to. Turn it on here: ${link} . If you already turned it on, it was probably in a different project; it has to be this one. Then wait 5 minutes and click Try again now. (Google's words: “${message}”)`,
      "API_OFF",
    )
  }
  if (res.status === 429 || res.status >= 500) throw new AdsApiError(message, "TRANSIENT")
  const violations = e.details?.flatMap((d) => d.fieldViolations ?? []) ?? []
  const text = [message, ...violations.map((v) => [v.description, v.field && `(${v.field})`].filter(Boolean).join(" "))].join(" ")
  const err = new AdsApiError(text, e.status)
  const all = `${text} ${reasons} ${e.status ?? ""} ${violations.map((v) => v.reason).join(" ")}`
  err.denied = res.status === 403 || DENIED.test(all)
  err.notFound = !err.denied && (res.status === 404 || NOT_FOUND.test(all))
  throw err
}

export type RequestStatus = {
  requestStatusPerDestination?: {
    requestStatus?: "REQUEST_STATUS_UNKNOWN" | "SUCCESS" | "PROCESSING" | "FAILED" | "PARTIAL_SUCCESS"
    errorInfo?: { errorCounts?: { recordCount?: string; reason?: string }[] }
    warningInfo?: { warningCounts?: { recordCount?: string; reason?: string }[] }
  }[]
}

// What Google decided about an earlier upload: it checks them after taking them in (30 minutes to
// 24 hours), and can still turn one down, e.g. for a click ID it doesn't recognize.
export async function requestStatus(connection: AdsConnection, requestId: string) {
  const res = await fetch(`https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`, {
    headers: { Authorization: `Bearer ${await accessToken(connection)}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json().catch(() => ({}))) as RequestStatus & ErrorBody
  if (!res.ok) throw new AdsApiError(body.error?.message ?? `Google answered ${res.status}.`, body.error?.status)
  return body
}
