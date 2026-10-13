"use server"

// The lead backup sheet on the Leads page (sheet-backup.ts): linking it, backing up now, and
// Restore. Like the Deal History sheet link, anyone signed in can use it.

import { revalidatePath } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { getConnection } from "@/lib/conversions/google"
import { BACKUP_TAB, backupNow, getLeadBackup, restoreFromBackup, setLeadBackupSheet } from "@/lib/leads/sheet-backup"
import { spreadsheetIdFrom } from "@/lib/sheets/sync"

export type BackupFormState = { error?: string; ok?: string } | undefined

const NO_GOOGLE = "Google Ads isn't set up: fill in the GOOGLE_ADS_ keys in .env.local first."
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

// Saves the sheet's link (or turns the backup off) and backs up right away.
export async function leadBackupAction(_: BackupFormState, formData: FormData): Promise<BackupFormState> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  try {
    if (formData.get("disconnect")) {
      await setLeadBackupSheet(null)
      return { ok: "Backup turned off. The tab stays in your sheet; DealTrack just stops updating it." }
    }
    const link = String(formData.get("sheet") ?? "").trim()
    if (link) {
      const id = spreadsheetIdFrom(link)
      if (!id) return { error: "That doesn't look like a Google Sheets link. Copy it from your browser's address bar while the sheet is open." }
      if (id !== (await getLeadBackup()).spreadsheetId) await setLeadBackupSheet(id)
    }
    if (!(await getLeadBackup()).spreadsheetId) return { error: "Paste your spreadsheet's link first." }
    const connection = await getConnection()
    if (!connection) return { error: NO_GOOGLE }
    const r = await backupNow(connection)
    return {
      ok: `Backed up ${plural(r.leads, "lead")}${r.deleted ? ` and ${r.deleted} deleted` : ""} to the “${BACKUP_TAB}” tab${r.title ? ` of “${r.title}”` : ""}.`,
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    revalidatePath("/leads", "layout")
  }
}

// Brings leads back from the sheet, then backs up so the tab matches this DealTrack again.
export async function restoreLeadBackupAction(): Promise<{ error?: string; ok?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  try {
    const connection = await getConnection()
    if (!connection) return { error: NO_GOOGLE }
    const r = await restoreFromBackup(connection)
    const done = [
      r.added && `${plural(r.added, "lead")} added`,
      r.replaced && `${r.replaced} that came in again from the website got back their status and history`,
      r.deleted && `${r.deleted} back in the Deleted list`,
      r.kept && `${r.kept} already here`,
      r.unreadable && `${plural(r.unreadable, "row")} couldn't be read`,
    ].filter(Boolean)
    let after = ""
    try {
      await backupNow(connection)
    } catch (e) {
      after = ` The backup right after it didn't go through: ${e instanceof Error ? e.message : String(e)}`
    }
    return { ok: `Restored from the sheet: ${done.join(", ") || "nothing to change"}.${after}` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    revalidatePath("/leads", "layout")
  }
}
