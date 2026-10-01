// The account's key numbers in one block of JSON, for when Claude Code can't use the chat's tools:
// DealTrack looks everything up itself and hands it over with the question, so the chat still
// answers from real data. The last 30 days against the 30 before, plus leads, calls and alerts.
import { dealtrackStatus, fraudCheck, recentLeads } from "@/lib/assistant/tools"
import { getPacing } from "@/lib/budget"
import { parseRange } from "@/lib/date-range"
import { getCalls } from "@/lib/google-ads/calls"
import { getOverview } from "@/lib/google-ads/overview"
import { getCampaigns, getSearchTerms } from "@/lib/google-ads/reports"
import { readData } from "@/lib/store"

const MAX_CHARS = 60_000
const r2 = (n: number) => Math.round(n * 100) / 100

export async function buildSnapshot() {
  const range = parseRange({ range: "30d" })
  const data = await readData()
  const settle = <T,>(p: Promise<T>) => p.catch((e: unknown) => ({ error: e instanceof Error ? e.message : "unavailable" }))
  const [overview, campaigns, terms, calls, pacing, leads, status, fraud] = await Promise.all([
    settle(getOverview(range)),
    settle(getCampaigns(range)),
    settle(getSearchTerms(range)),
    settle(getCalls(30)),
    settle(getPacing(data.budget)),
    recentLeads(90),
    dealtrackStatus(),
    settle(fraudCheck(30)),
  ])
  const snapshot = {
    period: { from: range.from, to: range.to },
    totals: "error" in overview ? overview : { last30Days: overview.totals, previous30Days: overview.previous.totals },
    campaigns: Array.isArray(campaigns) ? campaigns.slice(0, 30).map((c) => ({ name: c.name, status: c.status, type: c.channel, spend: r2(c.metrics.cost), clicks: c.metrics.clicks, conversions: r2(c.metrics.conversions) })) : campaigns,
    searchTerms: Array.isArray(terms)
      ? terms.slice(0, 50).map((t) => ({ term: t.term, cost: r2(t.metrics.cost), clicks: t.metrics.clicks, conversions: r2(t.metrics.conversions), suggestedNegative: t.suggestion ?? null }))
      : terms,
    pacing: "error" in pacing ? pacing : { month: pacing.monthLabel, spent: r2(pacing.spent), leads: pacing.leads, projected: r2(pacing.projectedByPace), budget: pacing.budget },
    calls: Array.isArray(calls) ? { total: calls.length, missed: calls.filter((c) => c.missed).length, recent: calls.slice(0, 30) } : calls,
    // Before the leads, so a long lead list can't push it past the size limit.
    fraud,
    leadsLast90Days: leads.slice(0, 100).map((l) => ({ ...l, notes: l.notes?.slice(0, 200) })),
    dealtrack: status,
  }
  const text = JSON.stringify(snapshot)
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}… (cut short)` : text
}
