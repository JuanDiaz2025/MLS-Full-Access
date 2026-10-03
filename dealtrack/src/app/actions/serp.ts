"use server"

// Competitors → Google rankings: starting, stopping, continuing and deleting scans. Scans spend
// search credits, so only admins can start or continue one.

import { refresh } from "next/cache"

import { isAdmin, isSignedIn } from "@/lib/auth"
import { TOPICS } from "@/lib/research/classify"
import { PLACE_CHOICES, continueScan, deleteScan, pickKeywords, startScan, stopScan, type SerpEngine } from "@/lib/research/serp"

export type SerpState = { ok?: boolean; message?: string }

export type ScanRequest = { engine: SerpEngine; topics: string[]; minVolume: number; max: number; locations: string[] }

export async function startScanAction(req: ScanRequest): Promise<SerpState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can start a scan (it uses search credits)." }
  const engine: SerpEngine = req.engine === "brave" ? "brave" : "serper"
  const topics = (Array.isArray(req.topics) ? req.topics : []).map(String).filter((t) => TOPICS.some((x) => x.id === t))
  const keywords = await pickKeywords({ topics, minVolume: Number(req.minVolume) || 0, max: Number(req.max) || 0 })
  const locations = (Array.isArray(req.locations) ? req.locations : [])
    .map(String)
    .filter((l) => PLACE_CHOICES.includes(l))
    .slice(0, 50)
  const left = TOPICS.filter((t) => !topics.includes(t.id)).map((t) => t.label)
  const what = !left.length
    ? "all topics"
    : topics.length > TOPICS.length / 2
      ? `all topics but ${left.join(", ")}`
      : TOPICS.filter((t) => topics.includes(t.id))
          .map((t) => t.label)
          .join(", ")
  const res = await startScan({ engine, keywords, locations, what: `${keywords.length.toLocaleString("en-US")} keywords: ${what}` })
  refresh()
  return res
}

export async function continueScanAction(id: string): Promise<SerpState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can continue a scan (it uses search credits)." }
  const res = await continueScan(String(id))
  refresh()
  return res
}

export async function stopScanAction(): Promise<SerpState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  stopScan()
  refresh()
  return { ok: true, message: "Stopping after the searches already under way." }
}

export async function deleteScanAction(id: string): Promise<SerpState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can delete a scan." }
  const ok = await deleteScan(String(id))
  refresh()
  return ok ? { ok: true, message: "Scan deleted." } : { ok: false, message: "That scan is running; stop it first." }
}
