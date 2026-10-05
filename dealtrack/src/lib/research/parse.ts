// Reading a keyword file in the browser (Competitors → Keyword explorer), so only the keywords
// themselves reach the app. Three kinds are recognized:
//   - a Google Ads keyword or search terms report (CSV): only the keyword text is kept, never the
//     report's impressions, clicks, cost or conversions, which cover whatever dates it was run for;
//   - a Keyword Planner export ("Get search volume and forecasts", CSV in UTF-16 with tabs):
//     the keyword plus its monthly searches, top-of-page bid range and competition, and the
//     location it was run for (its "Segmentation" rows: "California", "San Francisco"...);
//   - any list with a "Keyword" column, or one keyword per line.

export type ParsedKeyword = { text: string; volume?: number; cpcLow?: number; cpcHigh?: number; competition?: string; trend?: number[] }
// placeTotals: each location's searches a month over all the file's keywords (Keyword Planner's
// totals rows), the one per-city number Google gives when several cities are in one export.
export type ParsedFile = { kind: "planner" | "ads-report" | "list"; rows: ParsedKeyword[]; location?: string; placeTotals?: Record<string, number> }

// "[Sell My House]", "\"we buy houses\"", "+cash +offer" → "sell my house", "we buy houses", "cash offer".
export function normalizeKeyword(raw: string): string | null {
  const text = raw
    .replace(/^[\s"'[\]]+|[\s"'[\]]+$/g, "")
    .replace(/(^|\s)\+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  if (!text || text === "--" || text.length > 80 || /^total:/.test(text) || !/[a-z0-9]/.test(text)) return null
  return text
}

// Bytes → text: Keyword Planner saves UTF-16 with a byte order mark; reports are UTF-8.
export function decodeFile(buffer: ArrayBuffer): string {
  const b = new Uint8Array(buffer)
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b)
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b)
  return new TextDecoder("utf-8").decode(b).replace(/^﻿/, "")
}

// One line of CSV or TSV, quotes respected.
function splitLine(line: string, sep: string): string[] {
  const out: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      out.push(cell)
      cell = ""
    } else cell += ch
  }
  out.push(cell)
  return out.map((c) => c.trim())
}

const number = (s: string | undefined) => {
  if (!s) return undefined
  const n = Number(s.replace(/[$,\s]/g, ""))
  return Number.isFinite(n) ? n : undefined
}

export function parseKeywordFile(text: string): ParsedFile {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  // The header is the first line with a "Keyword" (or "Search term") column; reports put a title
  // and a date range above it.
  const headerAt = lines.findIndex((l) => /(^|[\t,"])\s*(keyword|search term)\s*("|\t|,|$)/i.test(l))
  if (headerAt < 0) {
    const rows = [...new Set(lines.map((l) => normalizeKeyword(l.split(/[\t,]/)[0])).filter((k): k is string => !!k))].map((t) => ({ text: t }))
    return { kind: "list", rows }
  }
  const sep = lines[headerAt].includes("\t") ? "\t" : ","
  const header = splitLine(lines[headerAt], sep).map((h) => h.toLowerCase())
  const col = (re: RegExp) => header.findIndex((h) => re.test(h))
  const kw = col(/^(keyword|search term)$/)
  const volume = col(/avg\.? monthly searches/)
  const low = col(/top of page bid \(low/)
  const high = col(/top of page bid \(high/)
  const competition = col(/^competition$/)
  const months = header.map((h, i) => (/^searches:/.test(h) ? i : -1)).filter((i) => i >= 0)
  const segmentation = col(/^segmentation$/)
  const planner = volume >= 0
  const places = new Map<string, number>()
  const seen = new Map<string, ParsedKeyword>()
  for (const line of lines.slice(headerAt + 1)) {
    const cells = splitLine(line, sep)
    const text = normalizeKeyword(cells[kw] ?? "")
    // Keyword Planner's totals rows: no keyword, and "All" or a location in Segmentation.
    if (!cells[kw]?.trim() && planner && segmentation >= 0 && cells[segmentation] && !/^all$/i.test(cells[segmentation])) {
      places.set(cells[segmentation].split(",")[0].trim(), number(cells[volume]) ?? 0)
    }
    if (!text) continue
    const row: ParsedKeyword = seen.get(text) ?? { text }
    if (planner) {
      row.volume = number(cells[volume]) ?? row.volume
      row.cpcLow = number(cells[low]) ?? row.cpcLow
      row.cpcHigh = number(cells[high]) ?? row.cpcHigh
      if (competition >= 0 && cells[competition]) row.competition = cells[competition]
      if (months.length) row.trend = months.map((i) => number(cells[i]) ?? 0)
      // An export over several years averages them all; the last 12 months say how it is now.
      if (row.trend && row.trend.length > 12) {
        row.trend = row.trend.slice(-12)
        const sum = row.trend.reduce((a, b) => a + b, 0)
        if (sum > 0) row.volume = Math.round(sum / 12)
      }
    }
    seen.set(text, row)
  }
  const kind = planner ? "planner" : header.some((h) => /match type|campaign|ad group/.test(h)) ? "ads-report" : "list"
  // Several locations in one export are added together by Google, so they count as one place.
  const names = [...places.keys()]
  const location = names.length > 3 ? `${names.length} cities` : names.join(" + ")
  return { kind, rows: [...seen.values()], ...(names.length ? { location, placeTotals: Object.fromEntries(places) } : {}) }
}
