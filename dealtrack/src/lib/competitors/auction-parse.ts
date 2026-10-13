// Reading Google Ads' Auction insights download (in the browser, so only the numbers reach the
// app). Google's own, free view of who competes in our auctions: for each other advertiser, how
// often they showed (impression share), how often they showed when we did (overlap), how often
// they ranked above us, and how often they were at the top. It isn't in the Google Ads API, so it's
// downloaded by hand: "CSV" (UTF-8, commas) or "CSV for Excel" (UTF-16, tabs), with a title and the
// date range above the header, and optional columns that split it by campaign, week, device...

import { splitLine } from "@/lib/research/parse"

export const METRICS = [
  { id: "is", label: "Impression share", match: /^(search )?impr(ession)?\.? share$/ },
  { id: "overlap", label: "Overlap rate", match: /^overlap rate$/ },
  { id: "above", label: "Position above rate", match: /^position above rate$/ },
  { id: "top", label: "Top of page rate", match: /^top of page rate$/ },
  { id: "absTop", label: "Abs. top of page rate", match: /^abs(olute|\.)? top of page rate$/ },
  { id: "out", label: "Outranking share", match: /^outranking share$/ },
] as const
export type MetricId = (typeof METRICS)[number]["id"]

// Columns that split the report (a campaign, a week...): kept so each row says what it covers.
const SEGMENTS = [
  { id: "campaign", match: /^campaign$/ },
  { id: "adGroup", match: /^ad group$/ },
  { id: "keyword", match: /^(search )?keyword$/ },
  { id: "device", match: /^device$/ },
  { id: "period", match: /^(day|week|month|quarter|year)$/ },
] as const
type SegmentId = (typeof SEGMENTS)[number]["id"]

// One advertiser's numbers, each a share from 0 to 1. "< 10%" is kept as 0.1 and listed in `below`.
export type AuctionRow = { domain: string; you?: boolean } & Partial<Record<SegmentId, string>> & Partial<Record<MetricId, number>> & { below?: MetricId[] }
export type AuctionReport = { rows: AuctionRow[]; range?: string; from?: string; to?: string; splitBy: string[] }

const clean = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")

// "45.50%" → 0.455; "< 10%" → 0.1 (below); "--" or blank → nothing. A share is never over 100%, so a
// comma is a decimal comma ("45,50%" from a European-format download).
function share(text: string): { v?: number; below?: boolean } {
  const t = text.trim()
  if (!t || t === "--" || t === "-") return {}
  const below = /^</.test(t)
  const n = Number(t.replace(/[<>%\s]/g, "").replace(",", "."))
  if (!Number.isFinite(n)) return {}
  return { v: Math.round(n * 100) / 10000, below }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
// "Sep 1, 2026", "September 1, 2026" or "2026-09-01" → "2026-09-01".
function isoDay(text: string) {
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const m = text.match(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/)
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1
  return m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}` : undefined
}

export function parseAuctionInsights(text: string): AuctionReport | { error: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const headerAt = lines.findIndex((l) => /display url domain/i.test(l))
  if (headerAt < 0) {
    return { error: "That isn't an Auction insights download: it has no \"Display URL domain\" column. In Google Ads, open Auction insights and use Download → .csv." }
  }
  const sep = lines[headerAt].includes("\t") ? "\t" : lines[headerAt].split(";").length > lines[headerAt].split(",").length ? ";" : ","
  const header = splitLine(lines[headerAt], sep).map(clean)
  const domainCol = header.findIndex((h) => h === "display url domain")
  const metricCols = METRICS.map((m) => ({ id: m.id, col: header.findIndex((h) => m.match.test(h)) })).filter((m) => m.col >= 0)
  if (!metricCols.length) return { error: "That download has no Impression share or other Auction insights columns." }
  const segmentCols = SEGMENTS.map((s) => ({ id: s.id, col: header.findIndex((h) => s.match.test(h)) })).filter((s) => s.col >= 0)

  // The date range is on a line above the header: "September 1, 2026 - September 30, 2026".
  const rangeLine = lines.slice(0, headerAt).map((l) => l.replace(/["\t]/g, " ").trim()).find((l) => /\d{4}/.test(l) && /[-–]/.test(l))
  const [fromText, toText] = rangeLine ? rangeLine.split(/\s[-–]\s/) : []
  const from = fromText ? isoDay(fromText) : undefined
  const to = toText ? isoDay(toText) : undefined

  const rows: AuctionRow[] = []
  for (const line of lines.slice(headerAt + 1)) {
    const cells = splitLine(line, sep)
    const domain = (cells[domainCol] ?? "").trim()
    if (!domain || /^total/i.test(domain)) continue
    const row: AuctionRow = { domain: domain.toLowerCase() === "you" ? "You" : domain.toLowerCase().replace(/^www\./, "").slice(0, 120) }
    if (row.domain === "You") row.you = true
    for (const s of segmentCols) {
      const v = (cells[s.col] ?? "").trim()
      if (v && v !== "--") row[s.id] = v.slice(0, 120)
    }
    const below: MetricId[] = []
    for (const m of metricCols) {
      const { v, below: lt } = share(cells[m.col] ?? "")
      if (v === undefined) continue
      row[m.id] = v
      if (lt) below.push(m.id)
    }
    if (below.length) row.below = below
    rows.push(row)
  }
  if (!rows.length) return { error: "That download has no advertisers in it. Pick a longer date range in Google Ads and download it again." }
  return { rows: rows.slice(0, 5000), range: rangeLine, from, to, splitBy: segmentCols.map((s) => s.id) }
}
