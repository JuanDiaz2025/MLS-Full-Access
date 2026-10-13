// Competitors → Auction insights: the Auction insights downloads uploaded so far (auction-parse.ts
// reads them), so each competitor's share can be followed from one period to the next. Saved in
// .data/auction-insights.json; the newest 100 are kept.
import { jsonFileStore } from "@/lib/json-file-store"
import type { AuctionReport, AuctionRow } from "@/lib/competitors/auction-parse"

export type AuctionUpload = AuctionReport & { id: string; at: string; by: string; file: string }

const file = jsonFileStore<{ uploads: AuctionUpload[] }>("auction-insights.json", () => ({ uploads: [] }))
const KEEP = 100

export const getAuctionUploads = async () => (await file.read()).uploads ?? []

const share = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined)
const text = (s: unknown, max = 120) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined)

// Only the fields the page reads, in range, from rows the browser parsed.
function cleanRow(r: AuctionRow): AuctionRow | null {
  if (!r || typeof r !== "object") return null
  const domain = text(r.domain)
  if (!domain) return null
  const row: AuctionRow = { domain }
  if (r.you || domain === "You") row.you = true
  for (const k of ["campaign", "adGroup", "keyword", "device", "period"] as const) {
    const v = text(r[k])
    if (v) row[k] = v
  }
  for (const k of ["is", "overlap", "above", "top", "absTop", "out"] as const) {
    const v = share(r[k])
    if (v !== undefined) row[k] = v
  }
  const below = (Array.isArray(r.below) ? r.below : []).filter((k) => ["is", "overlap", "above", "top", "absTop", "out"].includes(k))
  if (below.length) row.below = below
  return row
}

export async function saveAuctionUpload(report: AuctionReport, fileName: string, by: string) {
  const rows = (Array.isArray(report?.rows) ? report.rows : []).slice(0, 5000).map(cleanRow).filter((r): r is AuctionRow => Boolean(r))
  if (!rows.length) return null
  const day = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined)
  const at = new Date().toISOString()
  const upload: AuctionUpload = {
    id: `${at.slice(0, 19).replace(/[^0-9]/g, "")}-${Math.random().toString(36).slice(2, 6)}`,
    at,
    by: by.slice(0, 60),
    file: fileName.slice(0, 120),
    rows,
    range: text(report.range, 80),
    from: day(report.from),
    to: day(report.to),
    splitBy: (Array.isArray(report.splitBy) ? report.splitBy : []).filter((s) => ["campaign", "adGroup", "keyword", "device", "period"].includes(s)),
  }
  await file.update((db) => {
    db.uploads = [upload, ...(db.uploads ?? [])].slice(0, KEEP)
  })
  return upload
}

export async function deleteAuctionUpload(id: string) {
  await file.update((db) => {
    db.uploads = (db.uploads ?? []).filter((u) => u.id !== id)
  })
}
