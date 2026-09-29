// Budget forecast: monthly Google Ads spend -> leads -> deals -> net revenue.
//
//   leads    ~ Poisson(exp(a + b·log(spend) + noise))    b < 1 means diminishing returns
//   deals    ~ Binomial(leads, p),  p ~ Beta(1 + deals, 1 + leads − deals)
//   profit   = the sum of deal profits drawn from the team's actual acquired deals
//
// Fit on months since FIT_START with complete lead data: cost per lead has risen about 4% a
// month since 2024, so older months overstate what a dollar buys today.

import { QUALIFIED, type Deal, type Lead } from "@/lib/leads"

export const FIT_START = "2025-01"
const MIN_MONTHLY_SPEND = 1000

export type MonthRow = {
  month: string // YYYY-MM
  cost: number
  leads: number
  qualified: number
  deals: number
  netRevenue: number
  hasLeadData: boolean
}

export function buildMonthly(spend: Map<string, number>, leads: Lead[], deals: Deal[]): MonthRow[] {
  const byMonth = new Map<string, MonthRow>()
  const row = (month: string) => {
    let r = byMonth.get(month)
    if (!r) {
      r = { month, cost: 0, leads: 0, qualified: 0, deals: 0, netRevenue: 0, hasLeadData: false }
      byMonth.set(month, r)
    }
    return r
  }
  for (const [month, cost] of spend) row(month).cost = cost
  for (const lead of leads) {
    const r = row(lead.date.slice(0, 7))
    r.leads++
    if (lead.stage && QUALIFIED.has(lead.stage)) r.qualified++
  }
  for (const deal of deals) {
    if (!deal.acquired) continue
    const r = row(deal.leadDate.slice(0, 7))
    r.deals++
    r.netRevenue += deal.netRevenue ?? 0
  }
  // A month has lead data only if the sheet covers all of it.
  const dates = leads.map((l) => l.date).sort()
  const first = dates[0]?.slice(0, 7)
  const last = dates.at(-1)
  for (const r of byMonth.values()) {
    const monthEnd = new Date(Date.UTC(Number(r.month.slice(0, 4)), Number(r.month.slice(5, 7)), 0)).toISOString().slice(0, 10)
    r.hasLeadData = !!first && !!last && r.month >= first && monthEnd <= last
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
}

export type Model = {
  intercept: number
  elasticity: number
  sigma: number
  r2: number
  months: number
  leads: number
  deals: number
  costPerLead: number
  qualifiedRate: number
  dealRate: number
  profits: number[]
}

// Least-squares fit of log(y) = intercept + elasticity·log(x). sigma is the spread of the
// residuals (in log units), used as month-to-month noise in the simulations.
type LogFit = { intercept: number; elasticity: number; sigma: number; r2: number }

// maxElasticity caps returns to scale: in Google's auction more spend never makes each lead
// cheaper, so a slope above 1 only means the high-spend months happened to be cheaper ones.
function fitLogLog(points: [number, number][], maxElasticity = Infinity): LogFit {
  const x = points.map(([v]) => Math.log(v))
  const y = points.map(([, v]) => Math.log(v))
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
  const mx = mean(x)
  const my = mean(y)
  const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0)
  const b = Math.min(sxx ? x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / sxx : 0, maxElasticity)
  const a = my - b * mx
  const sse = y.reduce((s, v, i) => s + (v - (a + b * x[i])) ** 2, 0)
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0)
  return { intercept: a, elasticity: b, sigma: Math.sqrt(sse / Math.max(points.length - 2, 1)), r2: sst ? 1 - sse / sst : 0 }
}

export function fit(monthly: MonthRow[], deals: Deal[]): Model | null {
  const rows = monthly.filter((r) => r.hasLeadData && r.month >= FIT_START && r.cost >= MIN_MONTHLY_SPEND && r.leads > 0)
  const profits = deals.filter((d) => d.acquired && d.netRevenue !== null).map((d) => d.netRevenue!)
  if (rows.length < 4 || !profits.length) return null

  const f = fitLogLog(rows.map((r) => [r.cost, r.leads]), 1)
  const leads = rows.reduce((s, r) => s + r.leads, 0)
  const dealCount = rows.reduce((s, r) => s + r.deals, 0)
  return {
    ...f,
    months: rows.length,
    leads,
    deals: dealCount,
    costPerLead: rows.reduce((s, r) => s + r.cost, 0) / leads,
    qualifiedRate: rows.reduce((s, r) => s + r.qualified, 0) / leads,
    dealRate: (1 + dealCount) / (2 + leads),
    profits,
  }
}

// ---- Simulation ---------------------------------------------------------------------------

// Small, seeded generator so the same inputs always give the same forecast.
function rng(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function normal(u: () => number) {
  return Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u())
}

function poisson(u: () => number, mu: number) {
  if (mu > 50) return Math.max(0, Math.round(mu + Math.sqrt(mu) * normal(u)))
  const limit = Math.exp(-mu)
  let k = 0
  let p = u()
  while (p > limit) {
    k++
    p *= u()
  }
  return k
}

// Marsaglia–Tsang gamma sampler, used for Beta draws.
function gamma(u: () => number, shape: number): number {
  if (shape < 1) return gamma(u, shape + 1) * u() ** (1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = normal(u)
      v = 1 + c * x
    } while (v <= 0)
    v = v ** 3
    const w = u()
    if (w < 1 - 0.0331 * x ** 4 || Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function beta(u: () => number, a: number, b: number) {
  const x = gamma(u, a)
  return x / (x + gamma(u, b))
}

function binomial(u: () => number, n: number, p: number) {
  let k = 0
  for (let i = 0; i < n; i++) if (u() < p) k++
  return k
}

const percentile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]

export type Scenario = {
  budget: number
  totalCost: number // Google Ads spend over the period
  leads: [number, number, number] // P10, P50, P90
  deals: [number, number, number]
  netRevenue: [number, number, number]
  chanceNoDeals: number
  chanceProfit: number
}

export function simulate(model: Model, budgets: number[], { months = 3, runs = 5000, seed = 7 } = {}): Scenario[] {
  return budgets.map((budget) => {
    const u = rng(seed + budget)
    const leads: number[] = []
    const deals: number[] = []
    const revenue: number[] = []
    const cost = budget * months
    for (let run = 0; run < runs; run++) {
      const p = beta(u, 1 + model.deals, 1 + model.leads - model.deals)
      let l = 0
      let d = 0
      let rev = 0
      for (let m = 0; m < months; m++) {
        const mu = Math.exp(model.intercept + model.elasticity * Math.log(budget) + model.sigma * normal(u))
        const monthLeads = poisson(u, mu)
        const monthDeals = binomial(u, monthLeads, p)
        l += monthLeads
        d += monthDeals
        for (let k = 0; k < monthDeals; k++) rev += model.profits[Math.floor(u() * model.profits.length)]
      }
      leads.push(l)
      deals.push(d)
      revenue.push(rev)
    }
    const sortNum = (a: number[]) => [...a].sort((x, y) => x - y)
    const [sl, sd, sr] = [sortNum(leads), sortNum(deals), sortNum(revenue)]
    const q = (s: number[]): [number, number, number] => [percentile(s, 0.1), percentile(s, 0.5), percentile(s, 0.9)]
    return {
      budget,
      totalCost: cost,
      leads: q(sl),
      deals: q(sd),
      netRevenue: q(sr),
      chanceNoDeals: deals.filter((v) => v === 0).length / runs,
      chanceProfit: revenue.filter((v) => v > cost).length / runs,
    }
  })
}

export function median(values: number[]) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ---- Google Ads only ----------------------------------------------------------------------
// Works without the lead sheet: spend -> Google-counted leads (lead forms and calls; page views,
// directions, and other soft actions are left out before this point). Clicks aren't forecast:
// cost per click moved from ~$10 to $130+ when the bidding changed in 2026, so spend doesn't
// predict them.

export type AdsMonth = { month: string; cost: number; clicks: number; leads: number }

export type AdsModel = {
  leads: LogFit
  months: number
  costPerLead: number
}

// `from`/`to` (YYYY-MM, inclusive) pick the months the model learns from.
export function fitAds(monthly: AdsMonth[], from = FIT_START, to = "9999-12"): AdsModel | null {
  const rows = monthly.filter((r) => r.month >= from && r.month <= to && r.cost >= MIN_MONTHLY_SPEND && r.leads > 0)
  if (rows.length < 4) return null
  return {
    leads: fitLogLog(rows.map((r) => [r.cost, r.leads]), 1),
    months: rows.length,
    costPerLead: rows.reduce((s, r) => s + r.cost, 0) / rows.reduce((s, r) => s + r.leads, 0),
  }
}

export type AdsScenario = {
  budget: number
  totalCost: number
  leads: [number, number, number] // P10, P50, P90
  costPerLead: [number, number, number] // P10 is the cheapest outcome
}

export function simulateAds(model: AdsModel, budgets: number[], { months = 3, runs = 5000, seed = 11 } = {}): AdsScenario[] {
  const draw = (u: () => number, f: LogFit, budget: number) =>
    Math.exp(f.intercept + f.elasticity * Math.log(budget) + f.sigma * normal(u))
  return budgets.map((budget) => {
    const u = rng(seed + budget)
    const leads: number[] = []
    const cpl: number[] = []
    const cost = budget * months
    for (let run = 0; run < runs; run++) {
      let l = 0
      for (let m = 0; m < months; m++) l += poisson(u, draw(u, model.leads, budget))
      leads.push(l)
      cpl.push(l ? cost / l : cost)
    }
    const q = (a: number[]): [number, number, number] => {
      const s = [...a].sort((x, y) => x - y)
      return [percentile(s, 0.1), percentile(s, 0.5), percentile(s, 0.9)]
    }
    return { budget, totalCost: cost, leads: q(leads), costPerLead: q(cpl) }
  })
}
