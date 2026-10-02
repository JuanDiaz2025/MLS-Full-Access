// Your Google Sheet, kept up to date by the app: a "Google Ads data" tab (spend, clicks,
// impressions and conversions per campaign per month since 2024) and a "2024–2026 Combined" tab
// (every deal from the year tabs in one list, with a summary by year and by campaign that works
// out ad spend per deal). The app only ever writes these two tabs; your other tabs are read,
// never changed.
//
// Year tabs are found by their header row: any tab with a year in its name (2026, 2025,
// "PENDING 2024"...) whose first row has an Address and a Marketing Fee column. Columns are
// matched by their header, so the tabs can differ in layout.
// From One Marketing Command Center; it uses the Google connection DealTrack sends conversions
// with ("Connect Google for conversions" on Lead automation, which also asks for spreadsheets).
import { accessToken, AdsApiError, runQuery, SHEETS_SCOPE, type AdsAccount, type AdsConnection } from "@/lib/conversions/google"
import { jsonFileStore } from "@/lib/json-file-store"
import { shared } from "@/lib/shared-state"

export const ADS_TAB = "Google Ads data"
export const COMBINED_TAB = "2024–2026 Combined"
const FROM = "2024-01-01"
const SYNC_EVERY_MS = 6 * 60 * 60_000

type SyncState = { spreadsheetId?: string; title?: string; lastSync?: string; lastError?: string; deals?: number; months?: number }
const file = jsonFileStore<SyncState>("sheet-sync.json", () => ({}))
export const getSheetSync = () => file.read()

// "https://docs.google.com/spreadsheets/d/<id>/edit..." or a bare id → the id.
export function spreadsheetIdFrom(input: string) {
  const text = input.trim()
  return text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? (/^[a-zA-Z0-9_-]{20,}$/.test(text) ? text : null)
}

export async function setSpreadsheet(id: string | null) {
  await file.update((s) => {
    for (const k of Object.keys(s)) delete s[k as keyof SyncState]
    if (id) s.spreadsheetId = id
  })
}

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`

async function sheets<T>(connection: AdsConnection, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${await accessToken(connection)}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string; details?: { reason?: string; metadata?: Record<string, string> }[] } }
  if (res.ok) return body as T
  const e = body.error ?? {}
  const reasons = (e.details ?? []).map((d) => d.reason ?? "").join(" ")
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(`${reasons} ${e.message}`)) {
    throw new AdsApiError("The app needs permission to edit your spreadsheets. Click “Connect Google for conversions” again on Leads → Lead automation and leave every box ticked.", "NEEDS_PERMISSION")
  }
  if (/SERVICE_DISABLED/.test(reasons) || /API has not been used|API .*is disabled/i.test(e.message ?? "")) {
    const meta = Object.assign({}, ...(e.details ?? []).map((d) => d.metadata ?? {})) as Record<string, string>
    const link = meta.activationUrl ?? "https://console.cloud.google.com/apis/library/sheets.googleapis.com"
    throw new AdsApiError(`Turn on the Google Sheets API for your app's Google Cloud project here: ${link} , wait 5 minutes, then click Sync now.`, "API_OFF")
  }
  if (res.status === 404) throw new AdsApiError("That spreadsheet wasn't found. Check the link, and that the Google account you connected can open it.")
  if (res.status === 403) throw new AdsApiError("The Google account you connected can't edit that spreadsheet. Share it with that account as an Editor, or connect with the account that owns it.")
  throw new AdsApiError(e.message ?? `Google Sheets answered ${res.status}.`)
}

type Meta = { properties?: { title?: string }; sheets?: { properties?: { sheetId?: number; title?: string } }[] }
type Values = { valueRanges?: { range?: string; values?: unknown[][] }[] }

// What each combined column is called in the year tabs (lowercase, spaces squeezed).
const COLUMNS: { key: string; title: string; match: RegExp }[] = [
  { key: "name", title: "Lead Name", match: /^lead name/ },
  { key: "received", title: "Lead Received", match: /lead received/ },
  { key: "contract", title: "Contract Signed", match: /contract signed/ },
  { key: "acquired", title: "Acquisition Date", match: /^acquisition date/ },
  { key: "address", title: "Address", match: /^address/ },
  { key: "campaign", title: "Campaign", match: /^campaign/ },
  { key: "keyword", title: "Keyword", match: /^keyword/ },
  { key: "adGroup", title: "Ad Group", match: /^ad group/ },
  { key: "source", title: "Lead Source", match: /^lead source/ },
  { key: "fee", title: "Marketing Fee", match: /^marketing fee/ },
  { key: "paidOn", title: "Paid on", match: /^paid on/ },
  { key: "status", title: "Status", match: /^status/ },
  { key: "landing", title: "Landing Page", match: /^landing page/ },
]
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ")

// The deals from every year tab, as rows of the combined tab: [Year, ...COLUMNS, From tab].
// Written back with USER_ENTERED, Sheets would read text like "+we +buy +houses" or "=..." as a
// formula (#ERROR!): a leading ' keeps it text (the ' isn't shown).
const asText = (v: unknown) => (typeof v === "string" && /^[=+\-@]/.test(v) && Number.isNaN(Number(v)) ? `'${v}` : v)

async function readDeals(connection: AdsConnection, id: string, tabs: string[]) {
  const yearTabs = tabs.filter((t) => /\b20\d\d\b/.test(t) && t !== COMBINED_TAB && t !== ADS_TAB)
  if (!yearTabs.length) return { rows: [] as unknown[][], used: [] as string[] }
  const ranges = yearTabs.map((t) => `ranges=${encodeURIComponent(`${quote(t)}!A1:AZ2000`)}`).join("&")
  const data = await sheets<Values>(connection, `${id}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`)
  const rows: unknown[][] = []
  const used: string[] = []
  ;(data.valueRanges ?? []).forEach((vr, i) => {
    const tab = yearTabs[i]
    const [header = [], ...body] = vr.values ?? []
    const heads = header.map(norm)
    const at = Object.fromEntries(COLUMNS.map((c) => [c.key, heads.findIndex((h) => c.match.test(h))]))
    // A deals tab has an address and a marketing fee column; ad reports and logs don't.
    if (at.address < 0 || at.fee < 0) return
    used.push(tab)
    const year = Number(tab.match(/\b(20\d\d)\b/)![1])
    for (const r of body) {
      const cell = (k: string) => (at[k] >= 0 ? (r[at[k]] ?? "") : "")
      if (!String(cell("address")).trim() && !String(cell("name")).trim()) continue
      rows.push([year, ...COLUMNS.map((c) => asText(cell(c.key))), tab])
    }
  })
  return { rows, used }
}

type AdsRow = { campaign?: { name?: string }; segments?: { month?: string }; metrics?: { costMicros?: string; clicks?: string; impressions?: string; conversions?: number } }

// Spend and results per campaign per month, since January 2024.
async function readAds(connection: AdsConnection, account: AdsAccount) {
  const today = new Date().toISOString().slice(0, 10)
  const rows = (await runQuery(
    connection,
    account,
    `SELECT campaign.name, segments.month, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${FROM}' AND '${today}' AND metrics.impressions > 0`,
  )) as AdsRow[]
  return rows
    .map((r) => {
      const month = r.segments?.month ?? ""
      return [
        month.slice(0, 7),
        Number(month.slice(0, 4)),
        r.campaign?.name ?? "",
        Math.round(Number(r.metrics?.costMicros ?? 0) / 10_000) / 100,
        Number(r.metrics?.clicks ?? 0),
        Number(r.metrics?.impressions ?? 0),
        Math.round(Number(r.metrics?.conversions ?? 0) * 100) / 100,
      ]
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2])))
}

// The summary block beside the combined deals: one row per year and one per Google Ads
// campaign, all formulas over the deals list and the Google Ads data tab.
function summary(years: number[], campaigns: string[], dealRows: number) {
  const d = (col: string) => `$${col}$2:$${col}$${dealRows + 1}`
  const ads = (col: string) => `${quote(ADS_TAB)}!$${col}$2:$${col}$50000`
  // Combined columns: A Year, B Lead Name, C Lead Received, D Contract, E Acquired, F Address,
  // G Campaign, H Keyword, I Ad Group, J Lead Source, K Fee, L Paid on, M Status, N Landing, O From tab.
  const out: unknown[][] = [["By year", "Deals", "Marketing fees", "Google Ads spend", "Google Ads deals (PPC)", "Ad spend per PPC deal", "Fees from PPC deals", "Return on ad spend"]]
  years.forEach((y, i) => {
    const r = i + 2
    out.push([
      y,
      `=COUNTIFS(${d("A")},$R${r})`,
      `=SUMIFS(${d("K")},${d("A")},$R${r})`,
      `=SUMIFS(${ads("D")},${ads("B")},$R${r})`,
      `=COUNTIFS(${d("A")},$R${r},${d("J")},"PPC*")`,
      `=IF(V${r}=0,"",U${r}/V${r})`,
      `=SUMIFS(${d("K")},${d("A")},$R${r},${d("J")},"PPC*")`,
      `=IF(U${r}=0,"",X${r}/U${r})`,
    ])
  })
  const last = years.length + 1
  out.push([
    "All years",
    `=SUM(S2:S${last})`,
    `=SUM(T2:T${last})`,
    `=SUM(U2:U${last})`,
    `=SUM(V2:V${last})`,
    `=IF(V${last + 1}=0,"",U${last + 1}/V${last + 1})`,
    `=SUM(X2:X${last})`,
    `=IF(U${last + 1}=0,"",X${last + 1}/U${last + 1})`,
  ])
  out.push([])
  const start = out.length + 1
  out.push(["By Google Ads campaign", "Deals", "Marketing fees", "Google Ads spend", "", "Ad spend per deal", "", "Return on ad spend"])
  campaigns.forEach((c, i) => {
    const r = start + 1 + i
    out.push([
      asText(c),
      `=COUNTIFS(${d("G")},$R${r})`,
      `=SUMIFS(${d("K")},${d("G")},$R${r})`,
      `=SUMIFS(${ads("D")},${ads("C")},$R${r})`,
      "",
      `=IF(S${r}=0,"",U${r}/S${r})`,
      "",
      `=IF(U${r}=0,"",T${r}/U${r})`,
    ])
  })
  return out
}

// Bold, frozen headers and money shown as dollars, on the two tabs the app owns.
async function format(connection: AdsConnection, id: string, summaryRows: number) {
  const meta = await sheets<Meta>(connection, `${id}?fields=sheets.properties(sheetId,title)`)
  const sheetId = (t: string) => meta.sheets?.find((s) => s.properties?.title === t)?.properties?.sheetId
  const ads = sheetId(ADS_TAB)
  const combined = sheetId(COMBINED_TAB)
  if (ads === undefined || combined === undefined) return
  const money = { numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" } }
  const cells = (sheet: number, r0: number, r1: number, c0: number, c1: number, userEnteredFormat: object, fields: string) => ({
    repeatCell: { range: { sheetId: sheet, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 }, cell: { userEnteredFormat }, fields },
  })
  const bold = { textFormat: { bold: true } }
  await sheets(connection, `${id}:batchUpdate`, {
    body: {
      requests: [
        { updateSheetProperties: { properties: { sheetId: ads, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        { updateSheetProperties: { properties: { sheetId: combined, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
        cells(ads, 0, 1, 0, 7, bold, "userEnteredFormat.textFormat.bold"),
        cells(ads, 1, 50000, 3, 4, money, "userEnteredFormat.numberFormat"),
        cells(combined, 0, 1, 0, 15, bold, "userEnteredFormat.textFormat.bold"),
        cells(combined, 1, 5000, 10, 11, money, "userEnteredFormat.numberFormat"),
        // Summary: R (17) to Y (24). Money in T, U, W, X; return on ad spend as "4.2x" in Y.
        cells(combined, 0, summaryRows, 17, 18, bold, "userEnteredFormat.textFormat.bold"),
        cells(combined, 0, 1, 17, 25, bold, "userEnteredFormat.textFormat.bold"),
        cells(combined, 1, summaryRows, 19, 21, money, "userEnteredFormat.numberFormat"),
        cells(combined, 1, summaryRows, 22, 24, money, "userEnteredFormat.numberFormat"),
        cells(combined, 1, summaryRows, 24, 25, { numberFormat: { type: "NUMBER", pattern: '0.0"x"' } }, "userEnteredFormat.numberFormat"),
        { autoResizeDimensions: { dimensions: { sheetId: ads, dimension: "COLUMNS", startIndex: 0, endIndex: 9 } } },
        { autoResizeDimensions: { dimensions: { sheetId: combined, dimension: "COLUMNS", startIndex: 0, endIndex: 25 } } },
      ],
    },
  })
}

// Writes both tabs. Returns how many deals and Google Ads month rows were written.
export async function syncSheet(connection: AdsConnection, account: AdsAccount) {
  const state = await file.read()
  const id = state.spreadsheetId
  if (!id) throw new AdsApiError("Paste your spreadsheet's link first.")
  if (connection.scopes && !connection.scopes.includes(SHEETS_SCOPE)) {
    throw new AdsApiError("The app needs permission to edit your spreadsheets. Click “Connect Google for conversions” again on Leads → Lead automation and leave every box ticked.", "NEEDS_PERMISSION")
  }
  try {
    const meta = await sheets<Meta>(connection, `${id}?fields=properties.title,sheets.properties(sheetId,title)`)
    const tabs = (meta.sheets ?? []).map((s) => s.properties?.title ?? "")
    // Make the two tabs if they're not there yet.
    const missing = [ADS_TAB, COMBINED_TAB].filter((t) => !tabs.includes(t))
    if (missing.length) await sheets(connection, `${id}:batchUpdate`, { body: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } })

    const [{ rows: deals, used }, adsRows] = await Promise.all([readDeals(connection, id, tabs), readAds(connection, account)])
    const stamp = `Updated by DealTrack on ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`

    const adsValues = [["Month", "Year", "Campaign", "Spend", "Clicks", "Impressions", "Conversions", "", stamp], ...adsRows.map((r) => r.map(asText))]
    const years = [...new Set([...deals.map((r) => Number(r[0])), ...adsRows.map((r) => Number(r[1]))])].filter(Boolean).sort((a, b) => b - a)
    const campaigns = [...new Set(adsRows.map((r) => String(r[2])))].filter(Boolean).sort()
    const dealValues = [["Year", ...COLUMNS.map((c) => c.title), "From tab"], ...deals]
    const sum = summary(years, campaigns, Math.max(deals.length, 1))

    await sheets(connection, `${id}/values:batchClear`, { body: { ranges: [`${quote(ADS_TAB)}!A:Z`, `${quote(COMBINED_TAB)}!A:Z`] } })
    await sheets(connection, `${id}/values:batchUpdate`, {
      body: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: `${quote(ADS_TAB)}!A1`, values: adsValues },
          { range: `${quote(COMBINED_TAB)}!A1`, values: dealValues },
          { range: `${quote(COMBINED_TAB)}!R1`, values: sum },
          { range: `${quote(COMBINED_TAB)}!R${sum.length + 2}`, values: [[stamp], [`Deals from: ${used.join(", ") || "no year tabs found"}`]] },
        ],
      },
    })
    await format(connection, id, sum.length)
    await file.update((s) => {
      if (s.spreadsheetId !== id) return // another sheet was linked meanwhile
      s.title = meta.properties?.title
      s.lastSync = new Date().toISOString()
      s.deals = deals.length
      s.months = adsRows.length
      delete s.lastError
    })
    return { deals: deals.length, months: adsRows.length, tabs: used }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await file.update((s) => {
      if (s.spreadsheetId !== id) return
      s.lastError = message.slice(0, 400)
      s.lastSync = new Date().toISOString()
    })
    throw e
  }
}

// What the "2024–2026 Combined" tab holds now, as shown in the sheet (dollars formatted), for the
// Google Sheet page: the deals (A–O) and the summary tables beside them (from R1).
export type CombinedView = { deals: string[][]; header: string[]; tables: { header: string[]; rows: string[][] }[]; notes: string[] }
export async function readCombined(connection: AdsConnection): Promise<CombinedView | null> {
  const id = (await file.read()).spreadsheetId
  if (!id) return null
  const ranges = [`${quote(COMBINED_TAB)}!A1:O5000`, `${quote(COMBINED_TAB)}!R1:Y300`].map((r) => `ranges=${encodeURIComponent(r)}`).join("&")
  const data = await sheets<Values>(connection, `${id}/values:batchGet?${ranges}&valueRenderOption=FORMATTED_VALUE`)
  const text = (rows?: unknown[][]) => (rows ?? []).map((r) => r.map((c) => String(c ?? "")))
  const [header = [], ...deals] = text(data.valueRanges?.[0]?.values)
  // The summary is blocks of rows split by an empty row; a block of one-cell rows is the notes.
  const tables: CombinedView["tables"] = []
  const notes: string[] = []
  let block: string[][] = []
  const flush = () => {
    if (block.length && block.every((r) => r.filter(Boolean).length <= 1) && block.length <= 3) notes.push(...block.map((r) => r[0]).filter(Boolean))
    else if (block.length) tables.push({ header: block[0], rows: block.slice(1) })
    block = []
  }
  for (const r of text(data.valueRanges?.[1]?.values)) {
    if (!r.some(Boolean)) flush()
    else block.push(r)
  }
  flush()
  return { header, deals: deals.filter((r) => r.some(Boolean)), tables, notes }
}

// Keeps the sheet fresh: at most every 6 hours, when the app is used.
// One for the whole app (pages and API routes alike), see shared-state.ts.
const sheetRun = shared("sheet-sync-run", () => ({ running: null as Promise<unknown> | null }))
export function syncSheetIfDue(connection: AdsConnection, account: AdsAccount) {
  if (sheetRun.running) return sheetRun.running
  sheetRun.running = (async () => {
    const s = await file.read()
    if (!s.spreadsheetId || (s.lastSync && Date.now() - Date.parse(s.lastSync) < SYNC_EVERY_MS)) return
    await syncSheet(connection, account).catch(() => {})
  })().finally(() => {
    sheetRun.running = null
  })
  return sheetRun.running
}
