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
  adIdentifiers?: { gclid: string }
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
// `validateOnly` asks Google to check the request without counting anything (for the Leads page's check).
export async function ingestEvents(
  connection: AdsConnection,
  account: AdsAccount,
  conversionActionId: string,
  events: DataManagerEvent[],
  validateOnly = false,
) {
  const destination = {
    operatingAccount: { accountType: "GOOGLE_ADS", accountId: account.customerId },
    ...(account.loginCustomerId && account.loginCustomerId !== account.customerId
      ? { loginAccount: { accountType: "GOOGLE_ADS", accountId: account.loginCustomerId } }
      : {}),
    productDestinationId: conversionActionId,
  }
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
  const violation = e.details?.flatMap((d) => d.fieldViolations ?? [])[0]
  throw new AdsApiError(violation?.description ? `${message} ${violation.description}` : message, e.status)
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
