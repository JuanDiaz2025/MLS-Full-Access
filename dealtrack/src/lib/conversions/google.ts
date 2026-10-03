// The Google side of offline conversions (ported from One Marketing Command Center), wired to
// DealTrack's own Google Ads connection: the same account the reports read, so nobody connects
// Google per person. Sending conversions goes through Google's Data Manager API, which needs one
// permission DealTrack's reading key doesn't have ("datamanager"). An admin grants it once with
// "Connect Google for conversions" on the Leads page's automation settings; that key is saved
// encrypted in .data/conversions-google.json. A GOOGLE_ADS_REFRESH_TOKEN made with both
// permissions works too, with nothing to connect.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import { secretKey } from "@/lib/auth"
import { GoogleAdsError, MissingKeysError, adsAccountConfig, adsPost, gaql, gaqlFresh } from "@/lib/google-ads/client"
import { jsonFileStore } from "@/lib/json-file-store"

export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords"
export const DATA_MANAGER_SCOPE = "https://www.googleapis.com/auth/datamanager"
// For keeping the deals spreadsheet up to date (lib/sheets/sync.ts).
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
// For emailing alerts to the people set on the Alerts page (lib/notify.ts).
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send"

// `code` says what to do: NEEDS_PERMISSION (connect again), API_OFF (turn the API on), TRANSIENT.
export class AdsApiError extends Error {
  // Set when Google couldn't find the account or item asked for (worth trying another way).
  notFound = false
  // Set when Google refused that way in (no permission): also worth trying another way.
  denied = false
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}

export type AdsAccount = { customerId: string; name: string; currency: string; loginCustomerId?: string }
export type AdsConnection = { email: string; scopes: string[]; refreshToken: string; source: "connected" | "env" }

type Saved = { email: string; refreshToken: string; scopes: string[]; connectedAt: string; by: string }
const file = jsonFileStore<{ connection?: Saved }>("conversions-google.json", () => ({}))

function seal(text: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv)
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")
}
function unseal(sealed: string): string | null {
  try {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"))
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
  } catch {
    return null // saved with a different secret (SESSION_SECRET or the passwords changed): connect again
  }
}

export async function saveConnection(input: { email: string; refreshToken: string; scopes: string[]; by: string }) {
  await file.update((db) => {
    db.connection = { ...input, refreshToken: seal(input.refreshToken), connectedAt: new Date().toISOString() }
  })
}

export async function forgetConnection() {
  await file.update((db) => {
    delete db.connection
  })
}

export async function connectionInfo() {
  const saved = (await file.read()).connection
  return saved ? { email: saved.email, scopes: saved.scopes, connectedAt: saved.connectedAt, by: saved.by } : null
}

const tokens = new Map<string, { value: string; expiresAt: number }>()
const scopeCache = new Map<string, { scopes: string[]; at: number }>()

async function refresh(refreshToken: string) {
  const { clientId, clientSecret } = adsAccountConfig()
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    scope?: string
    error_description?: string
    error?: string
  }
  if (!res.ok || !body.access_token) {
    throw new AdsApiError(
      `Google didn't accept the saved key for sending conversions (${body.error_description || body.error || res.status}). Connect Google for conversions again.`,
      "NEEDS_PERMISSION",
    )
  }
  tokens.set(refreshToken, { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 })
  if (body.scope) scopeCache.set(refreshToken, { scopes: body.scope.split(" "), at: Date.now() })
  return body.access_token
}

export async function accessToken(connection: AdsConnection) {
  const t = tokens.get(connection.refreshToken)
  return t && t.expiresAt > Date.now() + 60_000 ? t.value : refresh(connection.refreshToken)
}

// The connection that sends: the one an admin connected, or DealTrack's own key.
export async function getConnection(): Promise<AdsConnection | null> {
  const saved = (await file.read()).connection
  const token = saved ? unseal(saved.refreshToken) : null
  if (saved && token) return { email: saved.email, scopes: saved.scopes, refreshToken: token, source: "connected" }
  let cfg
  try {
    cfg = adsAccountConfig()
  } catch (e) {
    if (e instanceof MissingKeysError) return null
    throw e
  }
  // Which permissions DealTrack's own key has (it says when it's refreshed); checked hourly.
  const known = scopeCache.get(cfg.refreshToken)
  if (!known || Date.now() - known.at > 3_600_000) await refresh(cfg.refreshToken).catch(() => undefined)
  return {
    email: "DealTrack's Google Ads key",
    scopes: scopeCache.get(cfg.refreshToken)?.scopes ?? [ADS_SCOPE],
    refreshToken: cfg.refreshToken,
    source: "env",
  }
}

let accountCache: AdsAccount | null = null

// DealTrack's account and the connection that sends for it, or null when Google Ads isn't set up.
export async function activeAccount(): Promise<{ connection: AdsConnection; account: AdsAccount } | null> {
  const connection = await getConnection()
  if (!connection) return null
  if (!accountCache) {
    const cfg = adsAccountConfig()
    const rows = await gaql<{ customer: { descriptiveName?: string; currencyCode?: string } }>(
      "SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1",
    )
    accountCache = {
      customerId: cfg.customerId,
      loginCustomerId: cfg.loginCustomerId,
      name: rows[0]?.customer.descriptiveName ?? cfg.customerId,
      currency: rows[0]?.customer.currencyCode ?? "USD",
    }
  }
  return { connection, account: accountCache }
}

const asAdsError = (e: unknown) =>
  e instanceof GoogleAdsError
    ? new AdsApiError(
        `${e.message}${e.detail ? ` Google said: ${e.detail}` : ""}`,
        /limit|exhausted|internal/i.test(`${e.message} ${e.detail}`) ? "TRANSIENT" : undefined,
      )
    : e

// A fresh GAQL query (conversion actions change as DealTrack makes them).
export async function runQuery(_connection: AdsConnection, _account: AdsAccount, query: string): Promise<unknown[]> {
  try {
    return await gaqlFresh(query)
  } catch (e) {
    throw asAdsError(e)
  }
}

// A request to the account through DealTrack's Google Ads connection.
export async function postToAds<T>(_connection: AdsConnection, _account: AdsAccount, path: string, payload: unknown): Promise<T> {
  try {
    return await adsPost<T>(path.startsWith("/") ? path.slice(1) : path, payload)
  } catch (e) {
    throw asAdsError(e)
  }
}
