"use server"

// Competitors → Google rankings: starting, stopping, continuing and deleting scans. Scans spend
// search credits, so only admins can start or continue one.

import { refresh } from "next/cache"

import { isAdmin, isSignedIn } from "@/lib/auth"
import { TOPICS } from "@/lib/research/classify"
import {
  scanPlaces,
  continueScan,
  deleteScan,
  fetchReviews,
  pickKeywords,
  startScan,
  stopScan,
  type ScanKind,
  type SerpEngine,
} from "@/lib/research/serp"

export type SerpState = { ok?: boolean; message?: string }

export type ScanRequest = {
  kind: ScanKind
  engine: SerpEngine
  topics: string[]
  minVolume: number
  max: number
  locations: string[]
  stars?: boolean
  typed?: string[] // keywords typed in the form: used instead of the topics when there are any
}

const MAX_TYPED = 100

// Typed keywords as Google gets them: lower case, single spaces, no duplicates.
function cleanTyped(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  for (const item of list) {
    const k = String(item ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80)
    if (k) seen.add(k)
    if (seen.size >= MAX_TYPED) break
  }
  return [...seen]
}

export async function startScanAction(req: ScanRequest): Promise<SerpState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can start a scan (it uses search credits)." }
  const kind: ScanKind = req.kind === "maps" || req.kind === "brand" ? req.kind : "web"
  const engine: SerpEngine = req.engine === "brave" && kind === "web" ? "brave" : "serper"
  if (kind === "brand") {
    const res = await startScan({ kind, engine, keywords: [], locations: [], what: "Brand check: how people look us up" })
    refresh()
    return res
  }
  const typed = cleanTyped(req.typed)
  const topics = (Array.isArray(req.topics) ? req.topics : []).map(String).filter((t) => TOPICS.some((x) => x.id === t))
  const keywords = typed.length ? typed : await pickKeywords({ topics, minVolume: Number(req.minVolume) || 0, max: Number(req.max) || 0 })
  const allowed = new Set((await scanPlaces()).all)
  const locations = (Array.isArray(req.locations) ? req.locations : [])
    .map(String)
    .filter((l) => allowed.has(l))
    .slice(0, 80)
  const left = TOPICS.filter((t) => !topics.includes(t.id)).map((t) => t.label)
  const what = !left.length
    ? "all topics"
    : topics.length > TOPICS.length / 2
      ? `all topics but ${left.join(", ")}`
      : TOPICS.filter((t) => topics.includes(t.id))
          .map((t) => t.label)
          .join(", ")
  const res = await startScan({
    kind,
    engine,
    keywords,
    locations,
    stars: kind === "maps" && Boolean(req.stars),
    what: `${keywords.length.toLocaleString("en-US")} keywords: ${typed.length ? `typed (${typed.slice(0, 3).join(", ")}${typed.length > 3 ? "…" : ""})` : what}${kind === "maps" && req.stars ? " (with stars)" : ""}`,
  })
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

export async function fetchReviewsAction(places: { cid: string; name: string; site: string }[], pages: number): Promise<SerpState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can get reviews (it uses search credits)." }
  const list = (Array.isArray(places) ? places : [])
    .slice(0, 30)
    .map((p) => ({ cid: String(p?.cid ?? ""), name: String(p?.name ?? ""), site: String(p?.site ?? "") }))
  const res = await fetchReviews(list, Number(pages) || 1)
  refresh()
  return res
}
