"use server"

// Linking the deals spreadsheet and syncing it now (Reports → Deal History). From One Marketing
// Command Center.

import { revalidatePath } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { activeAccount } from "@/lib/conversions/google"
import { setSpreadsheet, spreadsheetIdFrom, syncSheet } from "@/lib/sheets/sync"

export type SheetFormState = { error?: string; ok?: string } | undefined

// Saves the spreadsheet link (or removes it) and syncs right away.
export async function sheetAction(_: SheetFormState, formData: FormData): Promise<SheetFormState> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  if (formData.get("disconnect")) {
    await setSpreadsheet(null)
    revalidatePath("/deals")
    return { ok: "Disconnected. The tabs stay in your sheet; they just won't be updated." }
  }
  const link = String(formData.get("sheet") ?? "")
  if (link) {
    const id = spreadsheetIdFrom(link)
    if (!id) return { error: "That doesn't look like a Google Sheets link. Copy it from your browser's address bar while the sheet is open." }
    await setSpreadsheet(id)
  }
  try {
    const active = await activeAccount()
    if (!active) return { error: "Google Ads isn't connected. Check the Google Ads keys in .env.local." }
    const r = await syncSheet(active.connection, active.account)
    revalidatePath("/deals")
    return { ok: `Done: ${r.deals} deals from ${r.tabs.join(", ") || "no year tabs"}, and ${r.months} months of Google Ads campaign results.` }
  } catch (e) {
    revalidatePath("/deals")
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
