// The chat's tools. All of them only read: Google Ads through GAQL SELECT queries on DealTrack's
// connection (the search endpoint can't change an account), the website leads, and DealTrack's
// own saved records (alerts, budget lines, weekly negatives).
import { GoogleAdsError, gaql } from "@/lib/google-ads/client"
import { leadSource } from "@/lib/leads/source"
import { listLeads, listQrCodes } from "@/lib/leads/store"
import { leadChannel } from "@/lib/leads/tracking"
import { readData } from "@/lib/store"

// Written once and handed to whichever AI provider is set up (see claude.ts and openai.ts).
export type ToolSpec = {
  name: string
  description: string
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
}

export const toolSpecs: ToolSpec[] = [
  {
    name: "google_ads_query",
    description:
      "Run a read-only Google Ads Query Language (GAQL) SELECT query against Twin Home Buyer's Google Ads account and get the rows back as JSON. " +
      "Use it for any question about spend, clicks, impressions, conversions, campaigns, ad groups, keywords, search terms, locations or devices. " +
      "Useful resources: campaign, ad_group, ad_group_criterion (keywords), keyword_view, search_term_view, geographic_view, customer. " +
      "For locations: user_location_view with segments.geo_target_city and user_location_view.targeting_location (false = outside the target area), " +
      "campaign_criterion WHERE campaign_criterion.type = 'LOCATION' for targeting, campaign.geo_target_type_setting.positive_geo_target_type for Presence vs Presence or interest, " +
      "and geo_target_constant (resource_name IN (...)) to turn geoTargetConstants/123 into place names. " +
      "For phone calls: call_view (start_call_date_time, call_duration_seconds, call_status MISSED or RECEIVED, caller_area_code, campaign.name); filter with call_view.start_call_date_time >= 'YYYY-MM-DD 00:00:00' instead of segments.date. " +
      "Money fields end in _micros: divide by 1,000,000 to get dollars. " +
      "Always filter by date with segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' (or DURING LAST_7_DAYS / LAST_30_DAYS / THIS_MONTH / LAST_MONTH), " +
      "and add ORDER BY and a LIMIT (at most 200). JSON field names come back in camelCase, e.g. metrics.costMicros.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A complete GAQL SELECT statement." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_leads",
    description:
      "List the leads collected in the last N days, newest first, from the WordPress website's forms. " +
      "Each lead has a date, name, phone, email, property address, notes, the form, its channel (Google Ads, Facebook, organic search...) and tracking (UTM tags, Google click ID, landing page). " +
      "These are separate from Google Ads conversions.",
    parameters: {
      type: "object",
      properties: { days: { type: "integer", description: "How many days back to look, from 1 to 365." } },
      required: ["days"],
      additionalProperties: false,
    },
  },
  {
    name: "dealtrack_status",
    description:
      "DealTrack's own records: the open alerts (and the last 20 that cleared), the monthly budget with its alert and pause lines, the alert limits, " +
      "and the weekly negative keyword batches with each line's review and approval. Use it for questions about alerts, the budget, or negatives.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
]

const MAX_ROWS = 200
const MAX_CHARS = 60_000

// Keeps tool results a sensible size for the model, and says when rows were left out.
function asResult(rows: unknown[]) {
  const kept = rows.slice(0, MAX_ROWS)
  let text = JSON.stringify({ rowCount: rows.length, rows: kept })
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}… (truncated, narrow the query)`
  else if (rows.length > kept.length) text += `\n(Only the first ${MAX_ROWS} of ${rows.length} rows are shown.)`
  return text
}

export async function recentLeads(days: number) {
  const since = Date.now() - days * 86_400_000
  const [leads, qrCodes] = await Promise.all([listLeads(), listQrCodes()])
  const placements = new Map(qrCodes.map((c) => [c.id, c.placement]))
  return leads
    .filter((l) => Date.parse(l.createdAt) >= since)
    .map((l) => ({
      date: l.createdAt,
      name: l.name,
      phone: l.phone,
      email: l.email,
      propertyAddress: l.propertyAddress,
      notes: l.notes,
      source: leadSource(l, placements),
      channel: leadChannel(l),
      tracking: l.tracking,
    }))
}

export async function dealtrackStatus() {
  const data = await readData()
  return {
    budget: data.budget,
    alertLimits: data.alerts,
    openAlerts: data.alertLog.filter((r) => !r.resolvedAt).map(({ severity, title, detail, firstSeen }) => ({ severity, title, detail, firstSeen })),
    recentlyCleared: data.alertLog.filter((r) => r.resolvedAt).slice(0, 20).map(({ title, firstSeen, resolvedAt }) => ({ title, firstSeen, resolvedAt })),
    weeklyNegatives: data.batches.slice(0, 8).map((b) => ({
      week: `${b.from} to ${b.to}`,
      lines: b.items.map((i) => ({ negative: i.negative, why: i.why, cost: Math.round(i.cost), reviewed: i.proven, approved: i.approved })),
      pushed: b.pushed ? { by: b.pushed.by, at: b.pushed.at, dryRun: !!b.pushed.dryRun } : null,
    })),
  }
}

export async function runTool(name: string, input: unknown): Promise<{ content: string; isError?: boolean }> {
  try {
    if (name === "google_ads_query") {
      const { query } = input as { query?: unknown }
      if (typeof query !== "string" || !/^\s*select\b/i.test(query)) return { content: "Send one GAQL SELECT statement.", isError: true }
      return { content: asResult(await gaql(query)) }
    }
    if (name === "list_leads") {
      const days = Math.min(Math.max(Math.round(Number((input as { days?: unknown }).days) || 30), 1), 365)
      return { content: asResult(await recentLeads(days)) }
    }
    if (name === "dealtrack_status") return { content: JSON.stringify(await dealtrackStatus()).slice(0, MAX_CHARS) }
    return { content: `Unknown tool ${name}.`, isError: true }
  } catch (error) {
    // Google's error text (e.g. a GAQL typo) helps the model fix its own query.
    if (error instanceof GoogleAdsError) return { content: `${error.message}${error.detail ? ` ${error.detail}` : ""}`, isError: true }
    return { content: error instanceof Error ? error.message : "The request failed.", isError: true }
  }
}
