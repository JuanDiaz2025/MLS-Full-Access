// The Leads page's background work: new leads from the WordPress site (checked at most every 30
// seconds), scores for new leads, conversions for Google Ads and the spreadsheet (at most every
// 6 hours). Run after a page is sent, so nothing waits on it. From One Marketing Command Center.
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { activeAccount } from "@/lib/conversions/google"
import { sendPendingConversions } from "@/lib/conversions/offline-conversions"
import { syncSheetIfDue } from "@/lib/sheets/sync"
import { scoreUnscored } from "@/lib/leads/store"
import { syncWordPress } from "@/lib/leads/wordpress"
import { DATA_DIR } from "@/lib/store"

async function sendConversions() {
  try {
    const active = await activeAccount()
    if (active) {
      void syncSheetIfDue(active.connection, active.account)
      await sendPendingConversions(active.connection, active.account)
    }
  } catch (error) {
    console.error("Couldn't send conversions to Google Ads:", error)
  }
}

export function catchUp() {
  return Promise.all([
    scoreUnscored()
      .then(() => syncWordPress())
      .catch((error) => console.error("Couldn't check the website for new leads:", error)),
    sendConversions(),
  ])
}

// Changes whenever anything the Leads page shows is saved (leads, their statuses and Google Ads
// states, the website connection), so the page only reloads when there's something new. The
// website check's own "last checked" time doesn't count: it's saved every 30 seconds.
export async function leadsVersion() {
  const [leads, sheet, site] = await Promise.all([
    stat(path.join(DATA_DIR, "leads.json")).then(
      (s) => s.mtimeMs,
      () => 0,
    ),
    stat(path.join(DATA_DIR, "sheet-sync.json")).then(
      (s) => s.mtimeMs,
      () => 0,
    ),
    readFile(path.join(DATA_DIR, "wordpress.json"), "utf8").then(
      (text) => {
        try {
          const state = JSON.parse(text) as Record<string, unknown>
          delete state.lastSync
          return createHash("sha1").update(JSON.stringify(state)).digest("hex").slice(0, 12)
        } catch {
          return text.length
        }
      },
      () => 0,
    ),
  ])
  return `${leads}-${sheet}-${site}`
}
