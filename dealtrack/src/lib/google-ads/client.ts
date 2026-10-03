// Read-only Google Ads API client for one fixed account.
//
// Every value comes from server environment variables (see .env.example). Nothing here runs in
// the browser, and nothing is ever written back to Google Ads.

import { countRequest, markLimitHit, operationsIn } from "@/lib/google-ads/usage"

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v22"
const ADS_ENDPOINT = "https://googleads.googleapis.com"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

// Report results are fresh for 10 minutes. Explorer access allows 2,880 API operations a day, so
// clicking around the dashboard shouldn't spend a new operation on every page view. After that,
// for up to 6 hours, the last result is shown straight away while a fresh one is fetched in the
// background for the next view, so pages don't wait on Google.
const CACHE_MS = 10 * 60 * 1000
const STALE_MS = 6 * 60 * 60 * 1000

export const REQUIRED_KEYS = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_CUSTOMER_ID",
] as const

type AdsConfig = {
  developerToken: string
  clientId: string
  clientSecret: string
  refreshToken: string
  customerId: string
  loginCustomerId?: string
}

// Customer IDs are shown as 123-456-7890 in Google Ads; the API wants 1234567890.
const digits = (value: string | undefined) => value?.replace(/\D/g, "") || undefined

export function missingKeys(): string[] {
  return REQUIRED_KEYS.filter((key) => !process.env[key]?.trim())
}

function config(): AdsConfig {
  const missing = missingKeys()
  if (missing.length) throw new MissingKeysError(missing)
  return {
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!.trim(),
    clientId: process.env.GOOGLE_ADS_CLIENT_ID!.trim(),
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!.trim(),
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN!.trim(),
    customerId: digits(process.env.GOOGLE_ADS_CUSTOMER_ID)!,
    loginCustomerId: digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
  }
}

export class MissingKeysError extends Error {
  constructor(public keys: string[]) {
    super(`Google Ads keys are missing: ${keys.join(", ")}`)
  }
}

// `message` is written for the person using the dashboard; `detail` is Google's own wording.
export class GoogleAdsError extends Error {
  constructor(
    message: string,
    public detail?: string,
  ) {
    super(message)
  }
}

let accessToken: { value: string; expiresAt: number } | null = null

async function getAccessToken(cfg: AdsConfig): Promise<string> {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.access_token) {
    throw new GoogleAdsError(
      "Google didn't accept the sign-in keys. Check GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_REFRESH_TOKEN, or create a new refresh token.",
      body.error_description || body.error,
    )
  }
  accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  return accessToken.value
}

type ApiErrorBody = {
  error?: {
    message?: string
    status?: string
    details?: { errors?: { message?: string; errorCode?: Record<string, string> }[] }[]
  }
}

function explain(status: number, body: ApiErrorBody | undefined): GoogleAdsError {
  const googleError = body?.error?.details?.[0]?.errors?.[0]
  const detail = googleError?.message || body?.error?.message
  const code = googleError?.errorCode ? Object.values(googleError.errorCode)[0] : undefined

  if (code === "CUSTOMER_NOT_FOUND" || code === "USER_PERMISSION_DENIED") {
    return new GoogleAdsError(
      "This Google login can't open the account in GOOGLE_ADS_CUSTOMER_ID. Check the 10-digit ID at the top right of Google Ads.",
      detail,
    )
  }
  if (code === "DEVELOPER_TOKEN_NOT_APPROVED" || code === "DEVELOPER_TOKEN_PROHIBITED") {
    return new GoogleAdsError("Google hasn't approved the developer token for this account.", detail)
  }
  if (status === 429 || code === "RESOURCE_EXHAUSTED" || code === "RESOURCE_TEMPORARILY_EXHAUSTED") {
    return new GoogleAdsError(
      "The daily Google Ads API limit was reached (2,880 operations with Explorer access). Try again tomorrow.",
      detail,
    )
  }
  if (status === 401 || status === 403) {
    return new GoogleAdsError("Google refused the request. The keys may have been reset or revoked.", detail)
  }
  return new GoogleAdsError("Google Ads returned an error for this report.", detail)
}

// Kept on globalThis so the startup warm-up (instrumentation.ts) and the pages share one cache.
const shared = globalThis as typeof globalThis & {
  __dealtrackAds?: { cache: Map<string, { at: number; rows: unknown[] }>; inflight: Map<string, Promise<unknown[]>> }
}
const { cache, inflight } = (shared.__dealtrackAds ??= { cache: new Map(), inflight: new Map() })

// Forgets every cached report, so the next view asks Google again.
export function clearReportCache() {
  cache.clear()
}

// When the data on screen was fetched from Google (a cached result keeps its original time).
let lastDataAt: number | null = null
export function lastFetchedAt() {
  return lastDataAt
}

// How long one try may take, reading the whole answer included. Google is sometimes slow for a
// while; a try that runs out is made once more before the page gives up.
const REQUEST_TIMEOUT_MS = 45_000

// Thrown when Google didn't answer in time, twice.
export class GoogleAdsTimeoutError extends Error {
  constructor() {
    super("Google Ads took too long to answer.")
    this.name = "GoogleAdsTimeoutError"
  }
}

const timedOut = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")

// Sends one request to the Google Ads API for the configured account, retrying once with a fresh
// access token if Google says the token expired. Returns the parsed JSON body.
async function call(cfg: AdsConfig, path: string, payload: unknown): Promise<unknown> {
  const send = async () => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await getAccessToken(cfg)}`,
      "developer-token": cfg.developerToken,
      "content-type": "application/json",
    }
    if (cfg.loginCustomerId) headers["login-customer-id"] = cfg.loginCustomerId
    // A path is a service under the account ("googleAds:searchStream") or a method on the
    // account itself (":generateKeywordIdeas").
    const url = `${ADS_ENDPOINT}/${API_VERSION}/customers/${cfg.customerId}${path.startsWith(":") ? "" : "/"}${path}`
    // For the "API used today" meter in the header.
    countRequest(operationsIn(path, payload)).catch(() => undefined)
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    // Read the answer inside the same time limit: a slow answer counts as a slow try.
    return { status: res.status, ok: res.ok, text: await res.text() }
  }
  // A request Google leaves hanging is cancelled and tried once more, so one slow answer can't
  // hold a page for minutes.
  const sendWithRetry = async () => {
    try {
      return await send()
    } catch (err) {
      if (!timedOut(err)) throw err
      try {
        return await send()
      } catch (again) {
        throw timedOut(again) ? new GoogleAdsTimeoutError() : again
      }
    }
  }

  let res = await sendWithRetry()
  if (res.status === 401) {
    // The saved access token may have been revoked early. Get a fresh one and retry once.
    accessToken = null
    res = await sendWithRetry()
  }
  // Google sometimes answers "Internal error" for a report that works a moment later.
  for (const wait of [500, 1500]) {
    if (res.status < 500) break
    await new Promise((r) => setTimeout(r, wait))
    res = await sendWithRetry()
  }

  const text = res.text
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }

  if (!res.ok) {
    const errorBody = (Array.isArray(body) ? body[0] : body) as ApiErrorBody | undefined
    if (res.status === 429 || /RESOURCE_EXHAUSTED/.test(text)) markLimitHit().catch(() => undefined)
    throw explain(res.status, errorBody ?? { error: { message: text.slice(0, 300) } })
  }
  return body
}

// Runs one GAQL query against the configured account and returns every row.
// Field names come back in camelCase, e.g. metrics.costMicros.
export async function gaql<Row>(query: string): Promise<Row[]> {
  const cfg = config()
  const key = `${cfg.customerId}\n${query}`
  const hit = cache.get(key)
  const age = hit ? Date.now() - hit.at : Infinity
  if (hit && age < STALE_MS) {
    // Stale: show it now, refresh quietly for next time.
    if (age >= CACHE_MS) fetchRows(cfg, key, query).catch(() => undefined)
    lastDataAt = hit.at
    return hit.rows as Row[]
  }
  try {
    return (await fetchRows(cfg, key, query)) as Row[]
  } catch (err) {
    // Google didn't answer in time: an older copy beats an error page.
    if (hit && err instanceof GoogleAdsTimeoutError) {
      lastDataAt = hit.at
      return hit.rows as Row[]
    }
    throw err
  }
}

// One request per query at a time: pages that ask for the same report at once share it.
function fetchRows(cfg: AdsConfig, key: string, query: string): Promise<unknown[]> {
  const running = inflight.get(key)
  if (running) return running
  const request = call(cfg, "googleAds:searchStream", { query })
    .then((body) => {
      const batches = (Array.isArray(body) ? body : []) as { results?: unknown[] }[]
      const rows = batches.flatMap((batch) => batch.results ?? [])
      const at = Date.now()
      cache.set(key, { at, rows })
      lastDataAt = at
      return rows
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

// The same query, always asked of Google (and saved for the cached reports). For things that
// just changed, like a conversion action DealTrack created a moment ago.
export function gaqlFresh<Row>(query: string): Promise<Row[]> {
  const cfg = config()
  return fetchRows(cfg, `${cfg.customerId}\n${query}`, query) as Promise<Row[]>
}

// The configured account and its sign-in keys, for the offline conversions (lib/conversions).
export function adsAccountConfig() {
  const cfg = config()
  return { customerId: cfg.customerId, loginCustomerId: cfg.loginCustomerId, clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken }
}

// ---- Changes --------------------------------------------------------------------------------
// Everything below writes to the Google Ads account. Only the server actions in
// src/app/actions/changes.ts call it, after checking that an admin confirmed the change.

export function customerResource() {
  return `customers/${config().customerId}`
}

export type MutateResult = {
  // Resource names of what was created or removed, in operation order ("" where it failed).
  resourceNames: string[]
  // Google's message for each failed operation, keyed by operation index.
  failures: Map<number, string>
}

type PartialFailureDetail = {
  errors?: {
    message?: string
    location?: { fieldPathElements?: { fieldName?: string; index?: number }[] }
  }[]
}

// Dry-run mode for trying DealTrack's change buttons safely: with DEALTRACK_VALIDATE_ONLY=1,
// every change is sent with validateOnly, so Google checks it and applies nothing.
export function dryRun() {
  return process.env.DEALTRACK_VALIDATE_ONLY === "1"
}

// Runs a batch of create/remove operations on one Google Ads service, e.g. "campaignCriteria".
// With partialFailure, the operations that work are applied even if others fail (for example a
// negative keyword that already exists). With validateOnly, Google checks the request and
// changes nothing.
export async function mutate(
  service: string,
  operations: unknown[],
  { validateOnly: asked = false }: { validateOnly?: boolean } = {},
): Promise<MutateResult> {
  const validateOnly = asked || dryRun()
  const cfg = config()
  const body = (await call(cfg, `${service}:mutate`, {
    operations,
    partialFailure: true,
    validateOnly,
  })) as {
    results?: { resourceName?: string }[]
    partialFailureError?: { message?: string; details?: PartialFailureDetail[] }
  }

  const failures = new Map<number, string>()
  for (const detail of body?.partialFailureError?.details ?? []) {
    for (const err of detail.errors ?? []) {
      const index = err.location?.fieldPathElements?.find((e) => e.fieldName === "operations")?.index ?? 0
      failures.set(index, err.message ?? "Google rejected this change.")
    }
  }
  if (body?.partialFailureError && !failures.size) {
    failures.set(0, body.partialFailureError.message ?? "Google rejected this change.")
  }

  // Reports read before the change are now out of date.
  if (!validateOnly) cache.clear()

  return {
    resourceNames: (body?.results ?? []).map((r) => r.resourceName ?? ""),
    failures,
  }
}

// Runs operations on several services in one all-or-nothing request (GoogleAdsService.Mutate),
// e.g. create a shared list, fill it, and attach it to campaigns. A new item can be named with a
// temporary negative id (sharedSets/-1) so later operations in the same request can point at it.
// Throws a GoogleAdsError if any operation fails; then nothing is applied.
export async function mutateAll(operations: unknown[], { validateOnly: asked = false }: { validateOnly?: boolean } = {}) {
  if (!operations.length) return
  const validateOnly = asked || dryRun()
  await call(config(), "googleAds:mutate", { mutateOperations: operations, validateOnly })
  if (!validateOnly) cache.clear()
}

// Keyword Planner ideas (KeywordPlanIdeaService.GenerateKeywordIdeas): related searches with their
// monthly volume and top-of-page bids. Read-only. Cached like reports, since ideas barely change.
const ideaCache = ((globalThis as { __dtIdeaCache?: Map<string, { at: number; body: unknown }> }).__dtIdeaCache ??= new Map())

// A POST to the account for a method without its own helper, e.g. ":uploadConversionAdjustments"
// (taking back an offline conversion). Not cached.
export async function adsPost<T>(path: string, payload: unknown): Promise<T> {
  return (await call(config(), path, payload)) as T
}

export async function keywordIdeas(payload: Record<string, unknown>): Promise<unknown> {
  const cfg = config()
  const key = `${cfg.customerId}\n${JSON.stringify(payload)}`
  const hit = ideaCache.get(key)
  if (hit && Date.now() - hit.at < STALE_MS) return hit.body
  const body = await call(cfg, ":generateKeywordIdeas", payload)
  ideaCache.set(key, { at: Date.now(), body })
  return body
}
