// Date ranges for reports, read from ?range= or ?from=&to= in the URL so every page can share
// and bookmark the same period. Dates are in the account's time zone (Los Angeles).

export const ACCOUNT_TIME_ZONE = "America/Los_Angeles"

export const presets = [
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "ytd", label: "This year" },
  { id: "12m", label: "Last 12 months" },
  { id: "bateman", label: "Bateman (Jun 5 – Jul 23)" },
] as const

export type PresetId = (typeof presets)[number]["id"]

export type DateRange = {
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD
  preset?: PresetId
  label: string
}

const DEFAULT_PRESET: PresetId = "30d"
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function today(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: ACCOUNT_TIME_ZONE }).format(new Date())
}

// The account-time-zone date (YYYY-MM-DD) of a moment, e.g. when something was saved.
export function dayOf(time: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ACCOUNT_TIME_ZONE }).format(new Date(time))
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function isValidDate(value: string | undefined): value is string {
  return !!value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

function presetRange(id: PresetId): DateRange {
  const end = today()
  const label = presets.find((p) => p.id === id)!.label
  switch (id) {
    case "7d":
      return { from: addDays(end, -6), to: end, preset: id, label }
    case "90d":
      return { from: addDays(end, -89), to: end, preset: id, label }
    case "ytd":
      return { from: `${end.slice(0, 4)}-01-01`, to: end, preset: id, label }
    case "12m":
      return { from: addDays(end, -364), to: end, preset: id, label }
    case "bateman":
      return { from: "2026-06-05", to: "2026-07-23", preset: id, label }
    default:
      return { from: addDays(end, -29), to: end, preset: "30d", label: "Last 30 days" }
  }
}

type SearchParams = Record<string, string | string[] | undefined>

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function parseRange(params: SearchParams): DateRange {
  const from = first(params.from)
  const to = first(params.to)
  if (isValidDate(from) && isValidDate(to)) {
    const [start, end] = from <= to ? [from, to] : [to, from]
    return { from: start, to: end, label: `${formatDay(start)} – ${formatDay(end)}` }
  }
  const preset = first(params.range)
  const known = presets.some((p) => p.id === preset)
  return presetRange(known ? (preset as PresetId) : DEFAULT_PRESET)
}

// Query string that keeps the current range when moving between pages.
export function rangeQuery(range: DateRange): string {
  if (range.preset) return range.preset === DEFAULT_PRESET ? "" : `?range=${range.preset}`
  return `?from=${range.from}&to=${range.to}`
}

export function formatDay(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}

// Every date from `from` to `to`, inclusive. Used to fill days with no spend in charts.
export function eachDay(range: DateRange): string[] {
  const days: string[] = []
  for (let d = range.from; d <= range.to && days.length < 800; d = addDays(d, 1)) days.push(d)
  return days
}
