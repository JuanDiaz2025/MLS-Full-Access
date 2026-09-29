// Turns the "PPC LEAD" Google Sheet (kept by the team because REI Blackbook has no API) into
// leads and deals. Pure functions: rows in, typed records out.

// Funnel stages, from worst to best. The CRM score text maps onto these, so both the old scale
// ("5 Appointment booked") and the new one ("3 Appointment Booked") land in the same stage.
export const STAGES = ["invalid", "unresponsive", "engaged", "appointment", "offer", "contract", "cancelled", "acquired"] as const
export type Stage = (typeof STAGES)[number]

// Checked in order; the first match wins ("not interested" must be tested before "interested").
const STAGE_RULES: [Stage, RegExp][] = [
  ["acquired", /^10\b|acquired/],
  ["cancelled", /cancel/],
  ["contract", /under contract|clear to close|reinstated/],
  ["offer", /offer sent|contract sent|initial offer/],
  ["appointment", /appointment/],
  ["unresponsive", /not interested|unresponsive|new lead/],
  ["engaged", /follow up|interested|offer rejected|price too low/],
  ["invalid", /invalid|lost|dead/],
]

export function stageOf(score: string): Stage | null {
  const text = score.toLowerCase()
  return STAGE_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? null
}

// A booked appointment (the person answered and agreed to meet) or anything past it.
export const QUALIFIED: ReadonlySet<Stage> = new Set(["appointment", "offer", "contract", "cancelled", "acquired"])

export type Lead = {
  date: string // YYYY-MM-DD
  channel: "call" | "form"
  stage: Stage | null
  city: string
  gclid?: string
}

export type Deal = {
  leadDate: string // YYYY-MM-DD, the month the lead came in
  acquired: boolean
  city: string
  netRevenue: number | null
}

type Cell = string | number | boolean | null | undefined

// Google Sheets returns dates as serial day numbers (UNFORMATTED_VALUE) or text.
export function toIsoDate(value: Cell): string | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "number") {
    const ms = Math.round((value - 25569) * 86_400_000) // days since 1899-12-30
    return new Date(ms).toISOString().slice(0, 10)
  }
  const parsed = Date.parse(String(value))
  return Number.isNaN(parsed) ? null : new Date(parsed - new Date(parsed).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function toNumber(value: Cell): number | null {
  if (value === null || value === undefined || value === "") return null
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""))
  return Number.isFinite(n) ? n : null
}

// Maps the header row to column indexes. Duplicate headers keep the first one.
function columns(header: Cell[]) {
  const index = new Map<string, number>()
  header.forEach((h, i) => {
    const name = String(h ?? "").trim().toLowerCase()
    if (name && !index.has(name)) index.set(name, i)
  })
  return (name: string) => index.get(name.toLowerCase())
}

// "PPC LEAD Extract" tab. Organic and SEO leads are left out: this dashboard is about paid ads.
export function parseLeads(rows: Cell[][]): Lead[] {
  const [header, ...body] = rows
  if (!header) return []
  const col = columns(header)
  const tagging = col("Tagging")
  const score = col("Score Card")
  const stamp = col("Time Stamp")
  const city = col("Cities")
  const webId = col("WEB ID NO.")
  // The lead date sits in column B, whose header is blank in the sheet.
  const dateCol = col("Date Added") ?? 1
  if (tagging === undefined || score === undefined) return []

  const leads: Lead[] = []
  for (const row of body) {
    const tag = String(row[tagging] ?? "").trim()
    if (!tag || /organic|seo/i.test(tag)) continue
    const date = toIsoDate(row[dateCol]) ?? (stamp !== undefined ? toIsoDate(row[stamp]) : null)
    if (!date) continue
    const gclid = webId !== undefined ? String(row[webId] ?? "").match(/[A-Za-z0-9_-]{30,}/)?.[0] : undefined
    leads.push({
      date,
      channel: /call/i.test(tag) ? "call" : "form",
      stage: stageOf(String(row[score] ?? "")),
      city: city !== undefined ? String(row[city] ?? "").trim() : "",
      gclid,
    })
  }
  return leads
}

// "Acquired Leads" tab: contracts and acquisitions with purchase, sale, and net revenue.
export function parseDeals(rows: Cell[][]): Deal[] {
  const [header, ...body] = rows
  if (!header) return []
  const col = columns(header)
  const added = col("Date Added")
  const score = col("Score Card")
  const city = col("City")
  const net = col("Net Revenue")
  if (added === undefined || score === undefined) return []

  const deals: Deal[] = []
  for (const row of body) {
    const text = String(row[score] ?? "").trim()
    const leadDate = toIsoDate(row[added])
    if (!text || !leadDate) continue
    deals.push({
      leadDate,
      acquired: stageOf(text) === "acquired",
      city: city !== undefined ? String(row[city] ?? "").trim() : "",
      netRevenue: net !== undefined ? toNumber(row[net]) : null,
    })
  }
  return deals
}
