// Read-only Google Ads API client for one fixed account.
//
// Every value comes from server environment variables (see .env.example). Nothing here runs in
// the browser, and nothing is ever written back to Google Ads.

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v22"
const ADS_ENDPOINT = "https://googleads.googleapis.com"
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

// Report results are kept for 10 minutes. Explorer access allows 2,880 API operations a day, so
// clicking around the dashboard shouldn't spend a new operation on every page view.
const CACHE_MS = 10 * 60 * 1000

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

const cache = new Map<string, { at: number; rows: unknown[] }>()

// Runs one GAQL query against the configured account and returns every row.
// Field names come back in camelCase, e.g. metrics.costMicros.
export async function gaql<Row>(query: string): Promise<Row[]> {
  const cfg = config()
  const key = `${cfg.customerId}\n${query}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows as Row[]

  const send = async () => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await getAccessToken(cfg)}`,
      "developer-token": cfg.developerToken,
      "content-type": "application/json",
    }
    if (cfg.loginCustomerId) headers["login-customer-id"] = cfg.loginCustomerId
    return fetch(`${ADS_ENDPOINT}/${API_VERSION}/customers/${cfg.customerId}/googleAds:searchStream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
      cache: "no-store",
    })
  }

  let res = await send()
  if (res.status === 401) {
    // The saved access token may have been revoked early. Get a fresh one and retry once.
    accessToken = null
    res = await send()
  }

  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }

  if (!res.ok) {
    const errorBody = (Array.isArray(body) ? body[0] : body) as ApiErrorBody | undefined
    throw explain(res.status, errorBody ?? { error: { message: text.slice(0, 300) } })
  }

  const batches = (Array.isArray(body) ? body : []) as { results?: Row[] }[]
  const rows = batches.flatMap((batch) => batch.results ?? [])
  cache.set(key, { at: Date.now(), rows })
  return rows
}
