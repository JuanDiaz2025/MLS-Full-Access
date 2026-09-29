// The metrics the Overview can show and compare, with how to format each and which direction is
// good. Shared by the page (server) and the chart and picker (browser).

import { formatConversions, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import type { Totals } from "@/lib/google-ads/overview"

export type Unit = "usd" | "usdCents" | "count" | "percent"

export type MetricId = "cost" | "leads" | "cpl" | "clicks" | "impressions" | "ctr" | "cpc" | "leadRate" | "is" | "conversions"

export type MetricDef = {
  id: MetricId
  label: string
  unit: Unit
  better: "up" | "down" | "neutral" // spend going up is neither good nor bad by itself
  value: (t: Totals) => number | null
}

export const OVERVIEW_METRICS: MetricDef[] = [
  { id: "cost", label: "Spend", unit: "usd", better: "neutral", value: (t) => t.cost },
  { id: "leads", label: "Leads", unit: "count", better: "up", value: (t) => t.leads },
  { id: "cpl", label: "Cost per lead", unit: "usd", better: "down", value: (t) => (t.leads ? t.cost / t.leads : null) },
  { id: "clicks", label: "Clicks", unit: "count", better: "up", value: (t) => t.clicks },
  { id: "impressions", label: "Impressions", unit: "count", better: "up", value: (t) => t.impressions },
  { id: "ctr", label: "Click-through rate", unit: "percent", better: "up", value: (t) => (t.impressions ? t.clicks / t.impressions : null) },
  { id: "cpc", label: "Avg. cost per click", unit: "usdCents", better: "down", value: (t) => (t.clicks ? t.cost / t.clicks : null) },
  { id: "leadRate", label: "Lead rate (leads ÷ clicks)", unit: "percent", better: "up", value: (t) => (t.clicks ? t.leads / t.clicks : null) },
  { id: "is", label: "Search impression share", unit: "percent", better: "up", value: (t) => t.impressionShare },
  { id: "conversions", label: "All conversions (incl. soft)", unit: "count", better: "up", value: (t) => t.conversions },
]

export const metricById = (id: string | undefined) => OVERVIEW_METRICS.find((m) => m.id === id)

export function formatUnit(unit: Unit, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—"
  if (unit === "usd") return formatUsd(v)
  if (unit === "usdCents") return formatUsdCents(v)
  if (unit === "percent") return formatPercent(v, 1)
  return formatConversions(Math.round(v * 10) / 10)
}

export type Delta = { text: string; tone: "good" | "bad" | "neutral" }

// "+12%" against the period before; rates move in percentage points ("+3.1 pts").
export function delta(m: MetricDef, now: number | null, before: number | null): Delta | undefined {
  if (now === null || before === null) return undefined
  const change = now - before
  let text: string
  if (m.unit === "percent") {
    const pts = change * 100
    if (Math.abs(pts) < 0.05) return { text: "No change", tone: "neutral" }
    text = `${pts > 0 ? "+" : "−"}${Math.abs(pts).toFixed(1)} pts`
  } else if (before === 0) {
    if (now === 0) return { text: "No change", tone: "neutral" }
    text = "New"
  } else {
    const pct = change / before
    if (Math.abs(pct) < 0.005) return { text: "No change", tone: "neutral" }
    text = `${pct > 0 ? "+" : "−"}${Math.abs(pct * 100).toFixed(Math.abs(pct) < 0.1 ? 1 : 0)}%`
  }
  const tone = m.better === "neutral" ? "neutral" : change > 0 === (m.better === "up") ? "good" : "bad"
  return { text, tone }
}
