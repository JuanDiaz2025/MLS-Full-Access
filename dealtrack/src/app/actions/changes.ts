"use server"

// The only entry points that change Google Ads. Each one checks that the person is signed in as
// an admin, validates the input, and reports back what Google did.

import { isAdmin } from "@/lib/auth"
import {
  MATCH_TYPES,
  addNegativeKeywords,
  excludeLocations,
  removeNegatives,
  type ChangeSummary,
  type MatchType,
} from "@/lib/google-ads/changes"
import { GoogleAdsError, MissingKeysError } from "@/lib/google-ads/client"

export type ActionResult = { ok: boolean; message: string; failures?: string[] }

const MAX_ITEMS = 100
const MAX_CAMPAIGNS = 25
const CAMPAIGN_ID = /^\d{1,20}$/
const CRITERION = /^customers\/\d+\/campaignCriteria\/\d+~\d+$/

function report(summary: ChangeSummary, noun: string, verb: string): ActionResult {
  const parts: string[] = []
  if (summary.applied) parts.push(`${verb} ${summary.applied} ${noun}${summary.applied === 1 ? "" : "s"} in Google Ads.`)
  if (summary.skipped) parts.push(`${summary.skipped} ${summary.skipped === 1 ? "was" : "were"} already there.`)
  if (summary.failures.length) parts.push(`${summary.failures.length} failed.`)
  if (!parts.length) parts.push("Nothing to change.")
  return { ok: summary.failures.length === 0, message: parts.join(" "), failures: summary.failures }
}

async function guarded(run: () => Promise<ActionResult>): Promise<ActionResult> {
  if (!(await isAdmin())) {
    return { ok: false, message: "Only admins can change Google Ads. Sign in with the admin password first." }
  }
  try {
    return await run()
  } catch (err) {
    if (err instanceof MissingKeysError) return { ok: false, message: "Google Ads isn't connected, so nothing was changed." }
    if (err instanceof GoogleAdsError) {
      return { ok: false, message: `Nothing was changed. ${err.message}${err.detail ? ` Google said: ${err.detail}` : ""}` }
    }
    return { ok: false, message: err instanceof Error ? err.message : "Something went wrong, so nothing was changed." }
  }
}

function campaignIdsFrom(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CAMPAIGNS) return null
  return value.every((id) => typeof id === "string" && CAMPAIGN_ID.test(id)) ? (value as string[]) : null
}

export async function addNegativeKeywordsAction(input: {
  campaignIds: string[]
  keywords: string[]
  matchType: string
}): Promise<ActionResult> {
  return guarded(async () => {
    const campaignIds = campaignIdsFrom(input?.campaignIds)
    if (!campaignIds) return { ok: false, message: "Choose at least one campaign." }
    const keywords = Array.isArray(input.keywords) ? input.keywords.filter((k) => typeof k === "string") : []
    if (!keywords.length || keywords.length > MAX_ITEMS) return { ok: false, message: `Choose 1 to ${MAX_ITEMS} keywords.` }
    if (!MATCH_TYPES.includes(input.matchType as MatchType)) return { ok: false, message: "Choose a match type." }

    const summary = await addNegativeKeywords({ campaignIds, keywords, matchType: input.matchType as MatchType })
    return report(summary, "negative keyword", "Added")
  })
}

export async function excludeLocationsAction(input: { campaignIds: string[]; geoIds: string[] }): Promise<ActionResult> {
  return guarded(async () => {
    const campaignIds = campaignIdsFrom(input?.campaignIds)
    if (!campaignIds) return { ok: false, message: "Choose at least one campaign." }
    const geoIds = Array.isArray(input.geoIds) ? input.geoIds.filter((g) => typeof g === "string") : []
    if (!geoIds.length || geoIds.length > MAX_ITEMS) return { ok: false, message: `Choose 1 to ${MAX_ITEMS} locations.` }

    const summary = await excludeLocations({ campaignIds, geoIds })
    return report(summary, "location exclusion", "Added")
  })
}

export async function removeNegativesAction(resourceNames: string[]): Promise<ActionResult> {
  return guarded(async () => {
    const names = Array.isArray(resourceNames) ? resourceNames.filter((r) => typeof r === "string" && CRITERION.test(r)) : []
    if (!names.length || names.length > MAX_ITEMS) return { ok: false, message: "Nothing chosen to remove." }

    const summary = await removeNegatives(names)
    return report(summary, "item", "Removed")
  })
}
