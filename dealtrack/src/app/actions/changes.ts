"use server"

// The only entry points that change Google Ads. Each one checks that the person is signed in as
// an admin, validates the input, and reports back what Google did.

import { refresh } from "next/cache"

import { isAdmin } from "@/lib/auth"
import { changeKey, isOpen, learningGate, newRequestId } from "@/lib/compliance"
import { dayOf, formatDay } from "@/lib/date-range"
import {
  MATCH_TYPES,
  STANDARD_LIST,
  addKeywords,
  addToStandardList,
  addNegativeKeywords,
  excludeLocations,
  getEditableCampaigns,
  removeNegatives,
  type ChangeSummary,
  type MatchType,
} from "@/lib/google-ads/changes"
import { GoogleAdsError, MissingKeysError, dryRun } from "@/lib/google-ads/client"
import { ideaStage, pushedIdeas } from "@/lib/keyword-ideas"
import { brake, pushedLines, stageOf } from "@/lib/negative-batches"
import { currentName, rememberName } from "@/lib/people"
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
    return { ok: false, message: "Only admins can change Google Ads. Sign in as an admin first." }
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

// Compliance: a change to a campaign whose bidding is still learning is held. The first time, an
// override request is filed on the Compliance page; once it's checked and approved, the same
// change goes through (once). Returns a result to stop with, or what to do after a good push.
async function learningHold(
  key: string,
  label: string,
  campaignIds: string[],
  by: string,
): Promise<{ stop: ActionResult } | { done: (failures: string[]) => Promise<void> }> {
  const data = await readData()
  const gate = await learningGate(data, key, campaignIds)
  if (gate.ok) {
    const override = gate.override
    return {
      done: async (failures) => {
        if (!override) return
        await updateData((d) => {
          const r = d.changeRequests.find((x) => x.id === override.id)
          if (r && !r.applied) r.applied = { by, at: new Date().toISOString(), failures, dryRun: dryRun() || undefined }
        })
      },
    }
  }
  const names = gate.learning.map((l) => `${l.name} (${l.reason.toLowerCase()})`).join(", ")
  const open = data.changeRequests.find((r) => r.kind === "learning" && r.change?.key === key && isOpen(r))
  if (!open) {
    await updateData((d) => {
      d.changeRequests.unshift({
        id: newRequestId(),
        kind: "learning",
        campaigns: gate.learning.map((l) => ({ id: l.id, name: l.name })),
        change: { key, label },
        learning: gate.learning.map((l) => ({ campaign: l.name, reason: l.reason })),
        reason: `${label}, while Google's bidding is still learning.`,
        requested: { by, at: new Date().toISOString() },
      })
    })
    refresh()
  }
  return {
    stop: {
      ok: false,
      message: `Held by the Compliance check: ${names} ${gate.learning.length === 1 ? "is" : "are"} still in Google's learning period, and changes now can reset it. ${
        open ? "An override request is already waiting" : "An override request was added"
      } on the Compliance page (Monitor → Compliance). Once it's checked and approved, push again. Or wait until learning ends.`,
    },
  }
}

const adminName = async () => (await currentName()) || "An admin"

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

    const hold = await learningHold(
      changeKey("negatives", [...campaignIds, ...keywords.map((k) => k.toLowerCase())]),
      `Add ${keywords.length} negative keyword${keywords.length === 1 ? "" : "s"} (${keywords.slice(0, 3).join(", ")}${keywords.length > 3 ? "…" : ""})`,
      campaignIds,
      await adminName(),
    )
    if ("stop" in hold) return hold.stop
    const summary = await addNegativeKeywords({ campaignIds, keywords, matchType: input.matchType as MatchType })
    await hold.done(summary.failures)
    return report(summary, "negative keyword", "Added")
  })
}

export async function excludeLocationsAction(input: { campaignIds: string[]; geoIds: string[]; allowInside?: boolean }): Promise<ActionResult> {
  return guarded(async () => {
    const campaignIds = campaignIdsFrom(input?.campaignIds)
    if (!campaignIds) return { ok: false, message: "Choose at least one campaign." }
    const geoIds = Array.isArray(input.geoIds) ? input.geoIds.filter((g) => typeof g === "string") : []
    if (!geoIds.length || geoIds.length > MAX_ITEMS) return { ok: false, message: `Choose 1 to ${MAX_ITEMS} locations.` }

    const hold = await learningHold(
      changeKey("locations", [...campaignIds, ...geoIds]),
      `Exclude ${geoIds.length} location${geoIds.length === 1 ? "" : "s"}`,
      campaignIds,
      await adminName(),
    )
    if ("stop" in hold) return hold.stop
    const summary = await excludeLocations({ campaignIds, geoIds, allowInside: input.allowInside === true })
    await hold.done(summary.failures)
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

// Weekly negatives, step 4: sends a batch's approved lines to Google Ads in one change. At most
// one batch a week (the brake), and only after a review and an approval.
// With `toList`, the lines go into the shared list "DealTrack standard negatives" (created the first
// time) and the list is attached to the campaigns, instead of adding them to each campaign.
export async function pushNegativeBatchAction(batchId: string, campaignIds: string[], rawName: string, toList = false): Promise<ActionResult> {
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
    const hold = await learningHold(changeKey("negatives-batch", batch.id), `Push the negatives batch for ${batch.from} to ${batch.to}`, ids, name)
    if ("stop" in hold) return hold.stop
    const summary: ChangeSummary & { attached?: number } = { applied: 0, skipped: 0, failures: [] }
    if (toList) {
      const s = await addToStandardList({ campaignIds: ids, keywords: lines.map((l) => ({ text: l.negative, matchType: l.matchType })) })
      Object.assign(summary, s)
    }
    for (const matchType of toList ? [] : (["PHRASE", "EXACT"] as const)) {
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
        list: toList ? STANDARD_LIST : undefined,
        attached: toList ? summary.attached : undefined,
      }
    })
    await hold.done(summary.failures)
    refresh()
    if (toList) {
      const n = summary.applied
      const m = summary.attached ?? 0
      const words = `${n} negative keyword${n === 1 ? "" : "s"} to "${STANDARD_LIST}"${m ? ` and attach it to ${m} more campaign${m === 1 ? "" : "s"}` : ""}`
      const already = summary.skipped ? ` ${summary.skipped} ${summary.skipped === 1 ? "was" : "were"} already in the list.` : ""
      return {
        ok: true,
        message: dryRun()
          ? `Dry run (DEALTRACK_VALIDATE_ONLY=1): Google checked the change and applied nothing. It would add ${words}.${already}`
          : `Added ${words}.${already}`.replace("Added 0 negative keywords to", "Nothing new to add to"),
      }
    }
    return report(summary, "negative keyword", "Added")
  })
}

// Keyword ideas, last step: adds the approved keywords to their ad groups in one change, paused
// when asked so they can be switched on in Google Ads later.
export async function pushKeywordBatchAction(batchId: string, paused: boolean, rawName: string): Promise<ActionResult> {
  return guarded(async () => {
    const name = await rememberName(rawName)
    if (!name) return { ok: false, message: "Type your name first, so the batch shows who pushed it." }
    const batch = (await readData()).keywordBatches.find((b) => b.id === batchId)
    if (!batch) return { ok: false, message: "That batch doesn't exist any more. Reload the page." }
    if (ideaStage(batch) !== "ready") return { ok: false, message: batch.pushed ? "This batch was already pushed." : "This batch isn't reviewed and approved yet." }
    const lines = pushedIdeas(batch)
    if (lines.some((l) => !l.targets.length)) return { ok: false, message: "Every approved keyword needs an ad group." }
    const keywords = lines.flatMap((l) => l.targets.map((t) => ({ adGroupId: t.adGroupId, text: l.text, matchType: l.matchType })))
    const campaignIds = [...new Set(lines.flatMap((l) => l.targets.map((t) => t.campaignId)).filter(Boolean))]
    const hold = await learningHold(changeKey("keywords-batch", batch.id), `Add the keyword ideas batch for ${batch.from} to ${batch.to}`, campaignIds, name)
    if ("stop" in hold) return hold.stop
    const summary = await addKeywords({ keywords, paused: !!paused })
    await hold.done(summary.failures)
    await updateData((d) => {
      const b = d.keywordBatches.find((x) => x.id === batchId)
      if (!b || b.pushed) return false
      b.pushed = {
        by: name,
        at: new Date().toISOString(),
        added: summary.applied,
        skipped: summary.skipped,
        failures: summary.failures,
        paused: !!paused,
        dryRun: dryRun() || undefined,
      }
    })
    refresh()
    return report(summary, paused ? "paused keyword" : "keyword", "Added")
  })
}
