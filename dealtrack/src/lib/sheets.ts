// Reads the "PPC LEAD" Google Sheet through the Sheets API (read-only scope).
//
// It signs in with the same Google OAuth client as Google Ads. GOOGLE_SHEETS_REFRESH_TOKEN is a
// refresh token created with the https://www.googleapis.com/auth/spreadsheets.readonly scope; if
// it's empty, GOOGLE_ADS_REFRESH_TOKEN is tried (works when that token was created with both scopes).

import { parseDeals, parseLeads, type Deal, type Lead } from "@/lib/leads"
import { MINUTE, MissingSettingsError, ServiceError, cached } from "@/lib/services"

const SERVICE = "Google Sheets"
const LEADS_TAB = "PPC LEAD Extract"
const DEALS_TAB = "Acquired Leads"

function sheetsConfig() {
  const sheetId = process.env.LEADS_SHEET_ID?.trim()
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET?.trim()
  const refreshToken = (process.env.GOOGLE_SHEETS_REFRESH_TOKEN || process.env.GOOGLE_ADS_REFRESH_TOKEN)?.trim()
  const missing = [
    !sheetId && "LEADS_SHEET_ID",
    !clientId && "GOOGLE_ADS_CLIENT_ID",
    !clientSecret && "GOOGLE_ADS_CLIENT_SECRET",
    !refreshToken && "GOOGLE_SHEETS_REFRESH_TOKEN",
  ].filter(Boolean) as string[]
  if (missing.length) throw new MissingSettingsError(SERVICE, missing)
  return { sheetId: sheetId!, clientId: clientId!, clientSecret: clientSecret!, refreshToken: refreshToken! }
}

async function accessToken(cfg: ReturnType<typeof sheetsConfig>) {
  return cached(`sheets-token:${cfg.refreshToken.slice(-8)}`, 50 * MINUTE, async () => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
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
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string }
    if (!res.ok || !body.access_token) {
      throw new ServiceError(SERVICE, "Google didn't accept the Sheets refresh token. Create a new one with the spreadsheets.readonly scope.", body.error_description || body.error)
    }
    return body.access_token
  })
}

type Cell = string | number | boolean | null
type BatchGet = { valueRanges?: { values?: Cell[][] }[]; error?: { message?: string; status?: string } }

// Both tabs in one request, cached for 10 minutes.
export function getLeadData(): Promise<{ leads: Lead[]; deals: Deal[]; fetchedAt: number }> {
  const cfg = sheetsConfig()
  return cached(`sheets:${cfg.sheetId}`, 10 * MINUTE, async () => {
    const params = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" })
    params.append("ranges", `'${LEADS_TAB}'!A:AJ`)
    params.append("ranges", `'${DEALS_TAB}'!A:W`)
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheetId}/values:batchGet?${params}`, {
      headers: { authorization: `Bearer ${await accessToken(cfg)}` },
      cache: "no-store",
    })
    const body = (await res.json().catch(() => ({}))) as BatchGet
    if (!res.ok) {
      const hint = /insufficient authentication scopes/i.test(body.error?.message ?? "")
        ? process.env.GOOGLE_SHEETS_REFRESH_TOKEN?.trim()
          ? "GOOGLE_SHEETS_REFRESH_TOKEN wasn't created with the Sheets scope. Create it again in OAuth Playground with https://www.googleapis.com/auth/spreadsheets.readonly."
          : "GOOGLE_SHEETS_REFRESH_TOKEN is empty, and the Google Ads refresh token can't read Sheets. Create one in OAuth Playground with the https://www.googleapis.com/auth/spreadsheets.readonly scope (see README)."
        : res.status === 403
          ? "The Google login behind the refresh token can't open the lead sheet, or the Sheets API isn't enabled in the Google Cloud project."
          : res.status === 404
            ? "No sheet matches LEADS_SHEET_ID. Copy the ID from the sheet's URL (between /d/ and /edit)."
            : "Google Sheets returned an error."
      throw new ServiceError(SERVICE, hint, body.error?.message)
    }
    const [leadRows, dealRows] = (body.valueRanges ?? []).map((r) => r.values ?? [])
    const leads = parseLeads(leadRows ?? [])
    if (!leads.length) {
      throw new ServiceError(SERVICE, `The "${LEADS_TAB}" tab has no PPC leads, or its column headers changed (it needs "Tagging" and "Score Card").`)
    }
    return { leads, deals: parseDeals(dealRows ?? []), fetchedAt: Date.now() }
  })
}
