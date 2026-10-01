// DealTrack's own saved data, kept in one JSON file on the computer running it:
// .data/dealtrack.json inside the dealtrack folder (git ignores it). Holds the budget and alert
// settings, the log of alerts that have fired, and the weekly negative keyword batches.
//
// Writes go to a temporary file first and are then renamed over the real one, so a crash
// mid-save can't leave half a file. Saves are queued, so two at once can't overwrite each other.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import { ServiceError } from "@/lib/services"

export const DATA_DIR = process.env.DEALTRACK_DATA_DIR || path.join(process.cwd(), ".data")
const DIR = DATA_DIR
const FILE = path.join(DIR, "dealtrack.json")

export type Money = number | null

export type BudgetSettings = {
  monthly: Money // target Google Ads spend for the month
  alertLine: Money // month-to-date spend that raises an alert
  pauseLine: Money // month-to-date spend at which admins are asked to pause
  updatedBy?: string
  updatedAt?: string
}

export type AlertSettings = {
  maxCostPerLead: Money // alert when the last 14 days' cost per lead is above this
  noLeadDays: number // alert after this many days of spend with no leads…
  noLeadSpend: number // …once at least this much was spent in them
  monthNoLeadSpend: number // this much in a month with nothing back
  invalidClickRate: number // alert when a month's invalid-click share is above this (0–1)
  updatedBy?: string
  updatedAt?: string
}

export type AlertRecord = {
  key: string // stable id of the condition, e.g. "budget:pause-line:2026-10"
  severity: "critical" | "high" | "medium" | "info"
  title: string
  detail: string
  href?: string // DealTrack page with the details
  firstSeen: string // ISO
  lastSeen: string // ISO
  resolvedAt?: string // set when the condition was no longer there on a later check
  times: number // how many checks saw it
}

export type BatchItem = {
  negative: string
  matchType: "PHRASE" | "EXACT"
  why: string
  terms: string[] // search terms it blocks (the 5 costliest)
  termCount: number // how many of last week's searches it blocks
  clicks: number
  cost: number
  conversions: number
  proven: boolean | null // review: the evidence holds up (null = not reviewed yet)
  provenBy?: string
  approved: boolean | null // approval: approve or reject (null = not reviewed yet)
  approvedBy?: string
}

// A suggestion left out of the batch because it would also block searches that converted.
export type HeldBack = { negative: string; why: string; converting: string[] }

export type BatchStep = { by: string; at: string; note?: string }

export type BatchResult = {
  blockedSpendBefore: number // spend on searches the new negatives match, the week before the push…
  blockedSpendAfter: number // …and the week after (should drop to about zero)
  spendBefore: number
  spendAfter: number
  leadsBefore: number
  leadsAfter: number
}

export type NegativeBatch = {
  id: string // Monday of the search terms' week, YYYY-MM-DD
  from: string // search terms from…
  to: string // …to (YYYY-MM-DD)
  items: BatchItem[]
  heldBack: HeldBack[]
  alreadyNegative: string[] // suggestions skipped because running campaigns already block them
  drafted: BatchStep
  proven?: BatchStep
  approved?: BatchStep
  // dryRun: pushed while DEALTRACK_VALIDATE_ONLY=1, so Google changed nothing.
  pushed?: BatchStep & { campaignIds: string[]; campaignNames: string[]; added: number; skipped: number; failures: string[]; dryRun?: boolean }
  checked?: BatchStep & BatchResult
}

// Go-live checks that Google Ads can't show (e.g. after-hours coverage), ticked by a person.
export type ManualCheck = { done: boolean; by: string; at: string }

export type Data = {
  version: 1
  budget: BudgetSettings
  alerts: AlertSettings
  alertLog: AlertRecord[]
  batches: NegativeBatch[]
  audit: Record<string, ManualCheck>
}

export const DEFAULT_ALERTS: AlertSettings = {
  maxCostPerLead: null,
  noLeadDays: 3,
  noLeadSpend: 1000,
  monthNoLeadSpend: 20000,
  invalidClickRate: 0.25,
}

const empty = (): Data => ({
  version: 1,
  budget: { monthly: null, alertLine: null, pauseLine: null },
  alerts: { ...DEFAULT_ALERTS },
  alertLog: [],
  batches: [],
  audit: {},
})

export async function readData(): Promise<Data> {
  try {
    const saved = JSON.parse(await readFile(FILE, "utf8")) as Partial<Data>
    const base = empty()
    return {
      ...base,
      ...saved,
      budget: { ...base.budget, ...saved.budget },
      alerts: { ...base.alerts, ...saved.alerts },
      alertLog: Array.isArray(saved.alertLog) ? saved.alertLog : [],
      // Older files may lack fields added later; fill them in so pages can rely on them.
      batches: Array.isArray(saved.batches)
        ? saved.batches.map((b) => ({ ...b, items: b.items ?? [], heldBack: b.heldBack ?? [], alreadyNegative: b.alreadyNegative ?? [] }))
        : [],
      audit: saved.audit && typeof saved.audit === "object" ? saved.audit : {},
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty()
    throw new ServiceError("DealTrack", `Couldn't read DealTrack's saved data (${FILE}).`, err instanceof Error ? err.message : undefined)
  }
}

let queue: Promise<unknown> = Promise.resolve()

// Reads the latest data, lets `change` edit it, and saves the result. Returns what was saved.
// If `change` returns false, nothing is written (e.g. a check inside it failed).
export function updateData(change: (data: Data) => void | boolean): Promise<Data> {
  const run = queue.then(async () => {
    const data = await readData()
    if (change(data) === false) return data
    try {
      await mkdir(DIR, { recursive: true })
      const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8")
      await rename(tmp, FILE)
    } catch (err) {
      throw new ServiceError(
        "DealTrack",
        "Couldn't save. DealTrack stores its settings in a file on this computer, and it couldn't write there.",
        err instanceof Error ? err.message : undefined,
      )
    }
    return data
  })
  queue = run.catch(() => undefined)
  return run
}
