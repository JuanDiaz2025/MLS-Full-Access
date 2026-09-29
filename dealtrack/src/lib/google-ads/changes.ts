// Changes DealTrack can make in Google Ads: campaign-level negative keywords and excluded
// locations, plus removing them again. Each function re-checks its inputs against the live
// account before sending anything, so a bad request can't touch other settings.

import { customerResource, gaql, mutate } from "@/lib/google-ads/client"
import { GEO_RESOURCE, geoNames } from "@/lib/google-ads/reports"
import { serviceAreaStatus } from "@/lib/service-area"

export const MATCH_TYPES = ["PHRASE", "EXACT", "BROAD"] as const
export type MatchType = (typeof MATCH_TYPES)[number]

export type EditableCampaign = { id: string; name: string; status: string; channel: string }

// Local Services and Smart campaigns don't take campaign-level negative keywords or exclusions.
const UNSUPPORTED_CHANNELS = new Set(["LOCAL_SERVICES", "SMART"])

export type CampaignNegative = {
  resourceName: string
  campaignId: string
  campaignName: string
  kind: "keyword" | "location"
  text?: string // keyword text, lowercase
  matchType?: string
  geo?: string // geoTargetConstants/…
  place?: string // "Fresno, California"
}

export type ChangeSummary = {
  applied: number
  skipped: number // already in place
  failures: string[]
  // What Google saved, read back after a real change (negative keywords only).
  saved?: string[]
}

// Campaigns that can take negative keywords and exclusions: not removed, and not Local Services
// or Smart campaigns. Running (enabled) campaigns come first.
export async function getEditableCampaigns(): Promise<EditableCampaign[]> {
  const rows = await gaql<{
    campaign: { id?: string | number; name?: string; status?: string; advertisingChannelType?: string }
  }>(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign
     WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`,
  )
  return rows
    .map((r) => ({
      id: String(r.campaign.id ?? ""),
      name: r.campaign.name ?? "(no name)",
      status: r.campaign.status ?? "",
      channel: r.campaign.advertisingChannelType ?? "",
    }))
    .filter((c) => c.id && !UNSUPPORTED_CHANNELS.has(c.channel))
    .sort((a, b) => Number(b.status === "ENABLED") - Number(a.status === "ENABLED") || a.name.localeCompare(b.name))
}

const ID_LIST = (ids: string[]) => ids.filter((id) => /^\d+$/.test(id)).join(", ")

// Negative keywords and excluded locations on the given campaigns (the account has thousands
// across old paused campaigns, so callers always narrow it down), or the given criteria.
export async function getCampaignNegatives(
  filter: { campaignIds: string[] } | { resourceNames: string[] },
): Promise<CampaignNegative[]> {
  let where: string
  if ("campaignIds" in filter) {
    const ids = ID_LIST(filter.campaignIds)
    if (!ids) return []
    where = `campaign.id IN (${ids})`
  } else {
    const names = filter.resourceNames.filter((r) => /^customers\/\d+\/campaignCriteria\/\d+~\d+$/.test(r))
    if (!names.length) return []
    where = `campaign_criterion.resource_name IN (${names.map((r) => `'${r}'`).join(", ")})`
  }

  const rows = await gaql<{
    campaign: { id?: string | number; name?: string }
    campaignCriterion: {
      resourceName: string
      type?: string
      keyword?: { text?: string; matchType?: string }
      location?: { geoTargetConstant?: string }
    }
  }>(
    `SELECT campaign.id, campaign.name, campaign_criterion.resource_name, campaign_criterion.type,
       campaign_criterion.keyword.text, campaign_criterion.keyword.match_type,
       campaign_criterion.location.geo_target_constant
     FROM campaign_criterion
     WHERE ${where}
       AND campaign_criterion.negative = TRUE
       AND campaign_criterion.type IN ('KEYWORD', 'LOCATION')
       AND campaign.status != 'REMOVED'`,
  )

  const geoIds = rows.map((r) => r.campaignCriterion.location?.geoTargetConstant ?? "").filter(Boolean)
  const names = await geoNames(geoIds)

  return rows.map((r) => {
    const base = {
      resourceName: r.campaignCriterion.resourceName,
      campaignId: String(r.campaign.id ?? ""),
      campaignName: r.campaign.name ?? "",
    }
    if (r.campaignCriterion.type === "LOCATION") {
      const geo = r.campaignCriterion.location?.geoTargetConstant ?? ""
      const name = names.get(geo)
      const place = name ? name.canonical.split(",").filter((p) => p !== "United States").join(", ") : geo
      return { ...base, kind: "location" as const, geo, place }
    }
    return {
      ...base,
      kind: "keyword" as const,
      text: (r.campaignCriterion.keyword?.text ?? "").toLowerCase(),
      matchType: r.campaignCriterion.keyword?.matchType ?? "",
    }
  })
}

// ---- Change history (read-only) -------------------------------------------------------------

export type ChangeEvent = {
  at: string // "2026-09-29 08:14:03.123456" in the account's time zone
  user: string
  client: string // GOOGLE_ADS_API, GOOGLE_ADS_WEB_CLIENT, …
  resourceType: string // CAMPAIGN_CRITERION, AD_GROUP_AD, CAMPAIGN_BUDGET, …
  operation: string // CREATE, UPDATE, REMOVE
  campaign: string
  detail: string
}

type CriterionShape = {
  negative?: boolean
  keyword?: { text?: string; matchType?: string }
  location?: { geoTargetConstant?: string }
}

// Google keeps change history for the last 30 days, so the range is capped there.
export async function getChangeHistory(from: string, to: string): Promise<ChangeEvent[]> {
  const [rows, campaigns] = await Promise.all([
    gaql<{
      changeEvent: {
        changeDateTime?: string
        userEmail?: string
        clientType?: string
        changeResourceType?: string
        resourceChangeOperation?: string
        changedFields?: string
        campaign?: string
        newResource?: { campaignCriterion?: CriterionShape; adGroupCriterion?: CriterionShape }
        oldResource?: { campaignCriterion?: CriterionShape; adGroupCriterion?: CriterionShape }
      }
    }>(
      `SELECT change_event.change_date_time, change_event.user_email, change_event.client_type,
         change_event.change_resource_type, change_event.resource_change_operation,
         change_event.changed_fields, change_event.campaign, change_event.new_resource, change_event.old_resource
       FROM change_event
       WHERE change_event.change_date_time >= '${from}' AND change_event.change_date_time <= '${to} 23:59:59'
       ORDER BY change_event.change_date_time DESC
       LIMIT 500`,
    ),
    gaql<{ campaign: { resourceName: string; name?: string } }>("SELECT campaign.resource_name, campaign.name FROM campaign"),
  ])

  const campaignNames = new Map(campaigns.map((c) => [c.campaign.resourceName, c.campaign.name ?? ""]))
  const criteria = rows.map((r) => {
    const e = r.changeEvent
    return e.newResource?.campaignCriterion ?? e.oldResource?.campaignCriterion ?? e.newResource?.adGroupCriterion ?? e.oldResource?.adGroupCriterion
  })
  const places = await geoNames(criteria.map((c) => c?.location?.geoTargetConstant ?? "").filter(Boolean))

  return rows.map((r, i) => {
    const e = r.changeEvent
    const c = criteria[i]
    let detail = ""
    if (c?.keyword?.text) {
      detail = `${c.negative ? "Negative keyword" : "Keyword"} "${c.keyword.text}" (${(c.keyword.matchType ?? "").toLowerCase()})`
    } else if (c?.location?.geoTargetConstant) {
      const place = places.get(c.location.geoTargetConstant)?.name ?? c.location.geoTargetConstant
      detail = `${c.negative ? "Excluded location" : "Location"}: ${place}`
    } else if (e.changedFields) {
      detail = `Changed: ${e.changedFields.split(",").slice(0, 6).join(", ")}`
    }
    return {
      at: e.changeDateTime ?? "",
      user: e.userEmail ?? "",
      client: e.clientType ?? "",
      resourceType: e.changeResourceType ?? "",
      operation: e.resourceChangeOperation ?? "",
      campaign: (e.campaign && campaignNames.get(e.campaign)) || "",
      detail,
    }
  })
}

// Google allows up to 80 characters and 10 words, without most symbols. Returns null if the text
// can't be a keyword. Surrounding quotes or brackets (phrase/exact notation) are removed.
export function cleanKeyword(input: string): string | null {
  const text = input
    .trim()
    .replace(/^["[]+|["\]]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  if (!text || text.length > 80 || text.split(" ").length > 10) return null
  if (!/^[\p{L}\p{N}'&.\- ]+$/u.test(text)) return null
  return text
}

async function checkCampaigns(campaignIds: string[]) {
  const editable = await getEditableCampaigns()
  const known = new Set(editable.map((c) => c.id))
  const unknown = campaignIds.filter((id) => !known.has(id))
  if (unknown.length) throw new Error("One of the chosen campaigns no longer exists or was removed. Reload the page.")
  return new Map(editable.map((c) => [c.id, c.name]))
}

function summarize(
  total: number,
  skipped: number,
  failures: Map<number, string>,
  describe: (index: number) => string,
): ChangeSummary {
  return {
    applied: total - failures.size,
    skipped,
    failures: [...failures.entries()].map(([i, message]) => `${describe(i)}: ${message}`),
  }
}

export async function addNegativeKeywords(
  input: { campaignIds: string[]; keywords: string[]; matchType: MatchType },
  { validateOnly = false } = {},
): Promise<ChangeSummary> {
  const campaigns = await checkCampaigns(input.campaignIds)
  const keywords = [...new Set(input.keywords.map(cleanKeyword).filter((k): k is string => !!k))]
  if (!keywords.length) throw new Error("None of those can be a keyword. Use letters, numbers, and spaces.")

  const existing = new Set(
    (await getCampaignNegatives({ campaignIds: input.campaignIds }))
      .filter((n) => n.kind === "keyword")
      .map((n) => `${n.campaignId}|${n.text}|${n.matchType}`),
  )

  const planned: { campaignId: string; text: string }[] = []
  let skipped = 0
  for (const campaignId of input.campaignIds) {
    for (const text of keywords) {
      if (existing.has(`${campaignId}|${text}|${input.matchType}`)) skipped++
      else planned.push({ campaignId, text })
    }
  }
  if (!planned.length) return { applied: 0, skipped, failures: [] }

  const customer = customerResource()
  const result = await mutate(
    "campaignCriteria",
    planned.map((p) => ({
      create: {
        campaign: `${customer}/campaigns/${p.campaignId}`,
        negative: true,
        keyword: { text: p.text, matchType: input.matchType },
      },
    })),
    { validateOnly },
  )
  const summary = summarize(planned.length, skipped, result.failures, (i) => `"${planned[i]?.text}" in ${campaigns.get(planned[i]?.campaignId)}`)
  // Read back what Google stored, so the message shows the saved text rather than what was sent.
  const created = result.resourceNames.filter(Boolean).slice(0, 200)
  if (!validateOnly && created.length) {
    const saved = await getCampaignNegatives({ resourceNames: created })
    summary.saved = [...new Set(saved.map((n) => notation(n.text ?? "", n.matchType ?? "")))]
  }
  return summary
}

const notation = (text: string, matchType: string) =>
  matchType === "PHRASE" ? `"${text}"` : matchType === "EXACT" ? `[${text}]` : text

export async function excludeLocations(
  input: { campaignIds: string[]; geoIds: string[] },
  { validateOnly = false } = {},
): Promise<ChangeSummary> {
  const campaigns = await checkCampaigns(input.campaignIds)
  const geoIds = [...new Set(input.geoIds)].filter((g) => GEO_RESOURCE.test(g))
  if (!geoIds.length) throw new Error("No valid locations were chosen.")

  // Never exclude a place inside the service area, whatever the page sent.
  const names = await geoNames(geoIds)
  for (const geo of geoIds) {
    const name = names.get(geo)
    if (!name) throw new Error("Google doesn't recognize one of the chosen locations.")
    if (serviceAreaStatus(name.canonical).status === "inside") {
      throw new Error(`${name.name} is inside the Bay Area service area, so it can't be excluded here.`)
    }
  }

  const existing = new Set(
    (await getCampaignNegatives({ campaignIds: input.campaignIds }))
      .filter((n) => n.kind === "location")
      .map((n) => `${n.campaignId}|${n.geo}`),
  )
  const planned: { campaignId: string; geo: string }[] = []
  let skipped = 0
  for (const campaignId of input.campaignIds) {
    for (const geo of geoIds) {
      if (existing.has(`${campaignId}|${geo}`)) skipped++
      else planned.push({ campaignId, geo })
    }
  }
  if (!planned.length) return { applied: 0, skipped, failures: [] }

  const customer = customerResource()
  const result = await mutate(
    "campaignCriteria",
    planned.map((p) => ({
      create: {
        campaign: `${customer}/campaigns/${p.campaignId}`,
        negative: true,
        location: { geoTargetConstant: p.geo },
      },
    })),
    { validateOnly },
  )
  return summarize(
    planned.length,
    skipped,
    result.failures,
    (i) => `${names.get(planned[i]?.geo)?.name} in ${campaigns.get(planned[i]?.campaignId)}`,
  )
}

// Removes negative keywords or location exclusions. Only resources that are currently one of the
// campaign negatives above can be removed, so this can't delete keywords, ads, or campaigns.
export async function removeNegatives(resourceNames: string[], { validateOnly = false } = {}): Promise<ChangeSummary> {
  const current = new Map((await getCampaignNegatives({ resourceNames })).map((n) => [n.resourceName, n]))
  const targets = [...new Set(resourceNames)].filter((r) => current.has(r))
  if (!targets.length) return { applied: 0, skipped: resourceNames.length, failures: [] }

  const result = await mutate(
    "campaignCriteria",
    targets.map((resourceName) => ({ remove: resourceName })),
    { validateOnly },
  )
  return summarize(targets.length, resourceNames.length - targets.length, result.failures, (i) => {
    const n = current.get(targets[i])
    return n?.kind === "location" ? `${n.place}` : `"${n?.text}"`
  })
}
