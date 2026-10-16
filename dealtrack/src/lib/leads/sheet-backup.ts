// A copy of every lead in a "DealTrack leads" tab of a Google Sheet (linked on the Leads page),
// kept up to date by the app within about a minute of any change: a new lead, a status, a score,
// what Google Ads heard. Deleted leads stay at the bottom with when they were deleted. Each row
// also keeps the lead exactly as DealTrack saved it (the last column), so Restore can put
// everything back in a new DealTrack. The app only ever writes this tab, and anything typed into
// it is replaced at the next update. It uses the Google connection that sends conversions
// ("Connect Google for conversions" on Lead automation), which also allows editing spreadsheets.
import { stat } from "node:fs/promises"
import path from "node:path"

import { AdsApiError, getConnection, SHEETS_SCOPE, type AdsConnection } from "@/lib/conversions/google"
import { jsonFileStore } from "@/lib/json-file-store"
import { leadSource } from "@/lib/leads/source"
import { listDeletedLeads, listLeads, listQrCodes, restoreLeads } from "@/lib/leads/store"
import { googleClick, leadChannel, realValue } from "@/lib/leads/tracking"
import { leadStatuses, type Lead } from "@/lib/leads/types"
import { shared } from "@/lib/shared-state"
import { quote, sheets } from "@/lib/sheets/sync"
import { DATA_DIR } from "@/lib/store"

export const BACKUP_TAB = "DealTrack leads"
const HEADER = [
  "Received (Pacific)",
  "Name",
  "Phone",
  "Email",
  "Property address",
  "Message",
  "Status",
  "Score",
  "Channel",
  "Came from",
  "Campaign",
  "Keyword",
  "Landing page",
  "Google click ID",
  "Google Ads heard",
  "Deleted on",
  "DealTrack ID", // column Q
  "Saved record (for Restore)", // column R
]
const MIN_GAP_MS = 20_000
const RETRY_AFTER_ERROR_MS = 10 * 60_000
const CELL_MAX = 49_000 // a Google Sheets cell holds up to 50,000 characters

export const NEEDS_SHEETS =
  "DealTrack needs permission to edit spreadsheets: an admin clicks “Connect Google for conversions” on Lead automation and leaves every box ticked."

type BackupState = {
  spreadsheetId?: string
  title?: string
  lastBackup?: string
  lastError?: string
  failedAt?: string
  // The tab holds leads this DealTrack doesn't have (a new computer before Restore, or another
  // computer's DealTrack writing to the same sheet), so the app doesn't write over them.
  others?: number
  // Leads in the tab that Restore left out because this DealTrack has its own copy of each.
  covered?: string[]
  version?: string
  leads?: number
  deleted?: number
}
const file = jsonFileStore<BackupState>("lead-backup.json", () => ({}))
export const getLeadBackup = () => file.read()

export async function setLeadBackupSheet(id: string | null) {
  await file.update((s) => {
    for (const k of Object.keys(s)) delete s[k as keyof BackupState]
    if (id) s.spreadsheetId = id
  })
}

// Changes whenever a lead or a deleted lead is saved.
async function savedVersion() {
  const times = await Promise.all(
    ["leads.json", "deleted-leads.json"].map((name) =>
      stat(path.join(DATA_DIR, name)).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  )
  return times.join("-")
}

// "2026-10-13 07:37": Pacific time, and it sorts as text.
const pacific = (iso?: string) =>
  iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).slice(0, 16) : ""
const statusLabel = (status?: string) => leadStatuses.find((s) => s.id === (status || "new"))?.label ?? status ?? ""

function googleHeard(lead: Lead) {
  return Object.entries(lead.conversions ?? {})
    .flatMap(([kind, c]) => (c ? [`${kind}: ${c.retraction ? (c.retraction.state === "none" ? "nothing to take back" : `taken back (${c.retraction.state})`) : c.test ? "test lead, not sent" : (c.google?.status ?? c.state)}`] : []))
    .join(", ")
}

function row(lead: Lead, placements: Map<string, string>, deletedAt?: string) {
  const t = lead.tracking
  const click = googleClick(t)
  const record = JSON.stringify(deletedAt ? { deletedAt, lead } : { lead })
  return [
    pacific(lead.createdAt),
    lead.name,
    lead.phone,
    lead.email,
    lead.propertyAddress,
    lead.notes,
    statusLabel(lead.status),
    lead.score && !lead.score.unscored ? `${lead.score.value} ${lead.score.grade}` : "",
    leadChannel(lead),
    leadSource(lead, placements),
    realValue(t?.utmCampaign),
    realValue(t?.utmTerm),
    t?.landingPage,
    click ? Object.values(click)[0] : "",
    googleHeard(lead),
    pacific(deletedAt),
    lead.id,
    // Too big for one cell (never seen): the row is still there to read, just not to restore.
    record.length > CELL_MAX ? "" : record,
  ].map((v) => String(v ?? "").slice(0, CELL_MAX))
}

type Tab = { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } }

async function addTab(connection: AdsConnection, id: string, rows: number) {
  const added = await sheets<{ replies?: { addSheet?: { properties?: { sheetId?: number } } }[] }>(connection, `${id}:batchUpdate`, {
    body: { requests: [{ addSheet: { properties: { title: BACKUP_TAB, gridProperties: { rowCount: Math.max(1000, rows + 500), columnCount: 20, frozenRowCount: 1 } } } }] },
  })
  const sheetId = added.replies?.[0]?.addSheet?.properties?.sheetId
  if (sheetId === undefined) return
  const width = (column: number, pixelSize: number) => ({
    updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: column, endIndex: column + 1 }, properties: { pixelSize }, fields: "pixelSize" },
  })
  await sheets(connection, `${id}:batchUpdate`, {
    body: {
      requests: [
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
        // Long messages and the saved record stay on one line.
        { repeatCell: { range: { sheetId, startColumnIndex: 0, endColumnIndex: HEADER.length }, cell: { userEnteredFormat: { wrapStrategy: "CLIP" } }, fields: "userEnteredFormat.wrapStrategy" } },
        width(0, 130),
        width(5, 260),
        width(HEADER.length - 1, 160),
        // A warning (not a lock) for anyone about to type in it.
        { addProtectedRange: { protectedRange: { range: { sheetId }, description: "Kept by DealTrack: anything changed here is replaced at the next update.", warningOnly: true } } },
      ],
    },
  })
}

// Writes the whole tab: every lead, newest first, then the deleted ones. It never writes over
// leads it doesn't have itself (see `others`): those are only in the sheet, so they'd be lost.
export async function backupLeads(connection: AdsConnection) {
  const { spreadsheetId: id, covered = [] } = await file.read()
  if (!id) throw new AdsApiError("Paste your spreadsheet's link first.")
  if (!connection.scopes.includes(SHEETS_SCOPE)) throw new AdsApiError(NEEDS_SHEETS, "NEEDS_PERMISSION")
  // Taken before reading, so a lead saved while this runs is caught by the next backup.
  const version = await savedVersion()
  try {
    const [leads, deleted, qrCodes, meta] = await Promise.all([
      listLeads(),
      listDeletedLeads(),
      listQrCodes(),
      sheets<{ properties?: { title?: string }; sheets?: { properties?: Tab }[] }>(connection, `${id}?fields=properties.title,sheets.properties(sheetId,title,gridProperties)`),
    ])
    const tab = meta.sheets?.map((s) => s.properties).find((p) => p?.title === BACKUP_TAB)
    if (tab) {
      const saved = await sheets<{ values?: string[][] }>(connection, `${id}/values/${encodeURIComponent(`${quote(BACKUP_TAB)}!Q2:Q`)}`)
      const mine = new Set([...leads.map((l) => l.id), ...deleted.map((d) => d.lead.id), ...covered])
      const others = (saved.values ?? []).filter(([leadId]) => leadId && !mine.has(leadId)).length
      if (others) {
        await file.update((s) => {
          if (s.spreadsheetId === id) s.others = others
        })
        throw new AdsApiError(
          `The “${BACKUP_TAB}” tab has ${others} lead${others === 1 ? "" : "s"} this DealTrack doesn't have, so nothing was written over ${others === 1 ? "it" : "them"}. On a new computer, click Restore to bring them in first. If another computer's DealTrack backs up to this sheet, use a different sheet here.`,
        )
      }
    }
    const placements = new Map(qrCodes.map((c) => [c.id, c.placement]))
    const rows = [...leads.map((l) => row(l, placements)), ...deleted.map((d) => row(d.lead, placements, d.deletedAt))]
    const needed = rows.length + 1
    if (!tab) await addTab(connection, id, needed)
    else {
      const grid = tab.gridProperties ?? {}
      const grow = [
        (grid.rowCount ?? 0) < needed && { appendDimension: { sheetId: tab.sheetId, dimension: "ROWS", length: needed - (grid.rowCount ?? 0) + 500 } },
        (grid.columnCount ?? 0) < HEADER.length + 1 && { appendDimension: { sheetId: tab.sheetId, dimension: "COLUMNS", length: HEADER.length + 1 - (grid.columnCount ?? 0) } },
      ].filter(Boolean)
      if (grow.length) await sheets(connection, `${id}:batchUpdate`, { body: { requests: grow } })
    }
    const stamp = `Updated by DealTrack ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })} (Pacific). Anything typed in this tab is replaced at the next update.`
    // RAW: whatever someone typed into a form is kept as text, never run as a formula.
    await sheets(connection, `${id}/values:batchUpdate`, {
      body: { valueInputOption: "RAW", data: [{ range: `${quote(BACKUP_TAB)}!A1`, values: [[...HEADER, stamp], ...rows] }] },
    })
    await sheets(connection, `${id}/values:batchClear`, { body: { ranges: [`${quote(BACKUP_TAB)}!A${needed + 1}:S`] } })
    await file.update((s) => {
      if (s.spreadsheetId !== id) return // another sheet was linked meanwhile
      s.title = meta.properties?.title
      s.lastBackup = new Date().toISOString()
      s.version = version
      s.leads = leads.length
      s.deleted = deleted.length
      delete s.lastError
      delete s.failedAt
      delete s.others
      delete s.covered // their rows were just written over
    })
    return { leads: leads.length, deleted: deleted.length, title: meta.properties?.title }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await file.update((s) => {
      if (s.spreadsheetId !== id) return
      s.lastError = message.slice(0, 500)
      s.failedAt = new Date().toISOString()
    })
    throw e
  }
}

// One for the whole app (pages, API routes and the timer alike), see shared-state.ts.
const run = shared("lead-backup-run", () => ({ running: null as Promise<void> | null, lastAttempt: 0 }))

// Called often (the Leads page's background work, and once a minute while the app runs). Backs up
// only when a lead was saved since the last backup, at most every 20 seconds; after a failure it
// waits 10 minutes before trying again.
export function backupLeadsIfChanged(): Promise<void> {
  if (run.running) return run.running
  if (Date.now() - run.lastAttempt < MIN_GAP_MS) return Promise.resolve()
  run.running = (async () => {
    try {
      const state = await file.read()
      if (!state.spreadsheetId) return
      if (state.failedAt && Date.now() - Date.parse(state.failedAt) < RETRY_AFTER_ERROR_MS) return
      if ((await savedVersion()) === state.version) return
      const connection = await getConnection()
      if (!connection) return
      run.lastAttempt = Date.now()
      await backupLeads(connection)
    } catch {
      // Saved in lead-backup.json and shown on the Leads page.
    }
  })().finally(() => {
    run.running = null
  })
  return run.running
}

// "Back up now": after any backup already under way, whether or not anything changed.
export async function backupNow(connection: AdsConnection) {
  if (run.running) await run.running
  run.lastAttempt = Date.now()
  return backupLeads(connection)
}

function parseRecord(text?: string): { lead: Lead; deletedAt?: string } | null {
  try {
    const saved = JSON.parse(text ?? "") as { lead?: Lead; deletedAt?: unknown }
    const lead = saved.lead
    if (!lead || typeof lead.id !== "string" || typeof lead.createdAt !== "string" || typeof lead.name !== "string") return null
    return { lead, deletedAt: typeof saved.deletedAt === "string" ? saved.deletedAt : undefined }
  } catch {
    return null
  }
}

// Puts leads back from the tab. What it changes, and what it never does: restoreLeads in store.ts.
export async function restoreFromBackup(connection: AdsConnection) {
  const id = (await file.read()).spreadsheetId
  if (!id) throw new AdsApiError("Paste your spreadsheet's link first.")
  if (!connection.scopes.includes(SHEETS_SCOPE)) throw new AdsApiError(NEEDS_SHEETS, "NEEDS_PERMISSION")
  let data: { values?: string[][] }
  try {
    data = await sheets(connection, `${id}/values/${encodeURIComponent(`${quote(BACKUP_TAB)}!R2:R`)}`)
  } catch (e) {
    if (e instanceof Error && /unable to parse range/i.test(e.message)) throw new AdsApiError(`That spreadsheet has no “${BACKUP_TAB}” tab to restore from.`)
    throw e
  }
  const rows = (data.values ?? []).filter(([text]) => text)
  const entries = rows.map(([text]) => parseRecord(text)).filter((e) => e !== null)
  if (!entries.length) throw new AdsApiError(`The “${BACKUP_TAB}” tab has no saved leads to restore.`)
  const { covered, ...counts } = await restoreLeads(entries)
  // The tab and this DealTrack now hold the same leads, so backups can go ahead again.
  await file.update((s) => {
    if (s.spreadsheetId !== id) return
    s.covered = [...new Set([...(s.covered ?? []), ...covered])]
    delete s.failedAt
    delete s.others
  })
  return { ...counts, unreadable: rows.length - entries.length }
}
