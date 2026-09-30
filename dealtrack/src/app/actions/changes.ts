"use server"

// The only entry points that change Google Ads. Each one checks that the person is signed in as
// an admin, validates the input, and reports back what Google did.

import { refresh } from "next/cache"

import { isAdmin } from "@/lib/auth"
import { dayOf, formatDay } from "@/lib/date-range"
import {
  MATCH_TYPES,
  addNegativeKeywords,
  excludeLocations,
  getEditableCampaigns,
  pauseCampaigns,
  removeNegatives,
  type ChangeSummary,
  type MatchType,
} from "@/lib/google-ads/changes"
import { GoogleAdsError, MissingKeysError, dryRun } from "@/lib/google-ads/client"
import { brake, pushedLines, stageOf } from "@/lib/negative-batches"
import { rememberName } from "@/lib/people"
import { readData, updateData } from "@/lib/store"

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
  if (dryRun()) {
    const would = summary.applied ? ` It would have ${verb.toLowerCase()} ${summary.applied} ${noun}${summary.applied === 1 ? "" : "s"}.` : ""
    return {
      ok: summary.failures.length === 0,
      message: `Dry run (DEALTRACK_VALIDATE_ONLY=1): Google checked the change and applied nothing.${would}${summary.failures.length ? ` ${summary.failures.length} would fail.` : ""}`,
      failures: summary.failures,
    }
  }
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

// Budget pause line: pauses the chosen running campaigns. Turning them back on is done in Google
// Ads, on purpose: switching ads on and off resets Google's learning.
export async function pauseCampaignsAction(campaignIds: string[]): Promise<ActionResult> {
  return guarded(async () => {
    const ids = campaignIdsFrom(campaignIds)
    if (!ids) return { ok: false, message: "Choose at least one running campaign." }
    const summary = await pauseCampaigns(ids)
    const r = report(summary, "campaign", "Paused")
    return summary.skipped && !summary.applied ? { ...r, message: "Those campaigns aren't running any more, so nothing was paused." } : r
  })
}

// Weekly negatives, step 4: sends a batch's approved lines to Google Ads in one change. At most
// one batch a week (the brake), and only after a review and an approval.
export async function pushNegativeBatchAction(batchId: string, campaignIds: string[], rawName: string): Promise<ActionResult> {
  return guarded(async () => {
    const name = await rememberName(rawName)
    if (!name) return { ok: false, message: "Type your name first, so the batch shows who pushed it." }
    const ids = campaignIdsFrom(campaignIds)
    if (!ids) return { ok: false, message: "Choose at least one campaign." }
    const data = await readData()
    const batch = data.batches.find((b) => b.id === batchId)
    if (!batch) return { ok: false, message: "That batch doesn't exist any more. Reload the page." }
    if (stageOf(batch) !== "ready") return { ok: false, message: batch.pushed ? "This batch was already pushed." : "This batch isn't proven and approved yet." }
    const held = brake(data.batches, batch.id)
    if (held) {
      return {
        ok: false,
        message: `A batch already went out on ${formatDay(dayOf(held.last))}. One batch a week keeps Google's learning steady; the next can go on ${formatDay(held.nextDay)}.`,
      }
    }

    const lines = pushedLines(batch)
    const summary: ChangeSummary = { applied: 0, skipped: 0, failures: [] }
    for (const matchType of ["PHRASE", "EXACT"] as const) {
      const keywords = lines.filter((l) => l.matchType === matchType).map((l) => l.negative)
      if (!keywords.length) continue
      const s = await addNegativeKeywords({ campaignIds: ids, keywords, matchType })
      summary.applied += s.applied
      summary.skipped += s.skipped
      summary.failures.push(...s.failures)
    }
    const names = new Map((await getEditableCampaigns()).map((c) => [c.id, c.name]))
    await updateData((d) => {
      const b = d.batches.find((x) => x.id === batchId)
      if (!b || b.pushed) return false
      b.pushed = {
        by: name,
        at: new Date().toISOString(),
        campaignIds: ids,
        campaignNames: ids.map((id) => names.get(id) ?? id),
        added: summary.applied,
        skipped: summary.skipped,
        failures: summary.failures,
        dryRun: dryRun() || undefined,
      }
    })
    refresh()
    return report(summary, "negative keyword", "Added")
  })
}
