"use server"

// Keyword ideas steps that only touch DealTrack's saved data: drafting, reviewing, approving,
// changing a line's match type or ad group, and discarding. Pushing to Google Ads is in
// actions/changes.ts with the other changes, and needs an admin.

import { refresh } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { addDays, formatDay, today } from "@/lib/date-range"
import { getEditableCampaigns } from "@/lib/google-ads/changes"
import { adGroupsWithKeywords, draftIdeas, ideaStage } from "@/lib/keyword-ideas"
import { rememberName } from "@/lib/people"
import { readData, updateData, type IdeaSource, type KeywordBatch } from "@/lib/store"

export type IdeaResult = { ok: boolean; message: string; batchId?: string }

const SOURCES: IdeaSource[] = ["proven", "phrase", "situation", "planner"]
const MAX_DAYS = 731
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

async function person(rawName: unknown): Promise<{ name: string } | IdeaResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const name = await rememberName(rawName)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who did each step." }
  return { name }
}

const failed = (e: unknown): IdeaResult => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong, so nothing was saved." })

async function changeBatch(batchId: string, edit: (b: KeywordBatch) => string | undefined): Promise<IdeaResult | null> {
  let error: string | undefined
  await updateData((d) => {
    const b = d.keywordBatches.find((x) => x.id === batchId)
    error = b ? edit(b) : "That batch doesn't exist any more. Reload the page."
    return !error
  })
  return error ? { ok: false, message: error } : null
}

export async function draftKeywordIdeas(
  input: { from: string; to: string; campaignId: string; sources: string[]; competitors: boolean },
  rawName: string,
): Promise<IdeaResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const { from, to } = input
  if (!isDay(from) || !isDay(to)) return { ok: false, message: "Choose a start and an end date." }
  if (from > to) return { ok: false, message: "The start date has to come before the end date." }
  if (to > today()) return { ok: false, message: "The end date can't be in the future." }
  if (to > addDays(from, MAX_DAYS - 1)) return { ok: false, message: "Choose two years or less." }
  const sources = SOURCES.filter((s) => Array.isArray(input.sources) && input.sources.includes(s))
  if (!sources.length) return { ok: false, message: "Choose at least one kind of idea." }
  const campaignId = input.campaignId || undefined
  if (campaignId && !/^\d+$/.test(campaignId)) return { ok: false, message: "Unknown campaign. Reload the page." }
  try {
    const campaign = campaignId ? (await getEditableCampaigns()).find((c) => c.id === campaignId) : undefined
    if (campaignId && !campaign) return { ok: false, message: "That campaign no longer exists or was removed. Reload the page." }
    const draft = await draftIdeas({ from, to, campaignId, sources, competitors: !!input.competitors })
    const id = `ideas_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`
    await updateData((d) => {
      d.keywordBatches.unshift({
        id,
        from,
        to,
        campaignId,
        campaignName: campaign?.name,
        sources,
        ...draft,
        drafted: { by: who.name, at: new Date().toISOString() },
      })
    })
    refresh()
    const n = draft.items.length
    return {
      ok: true,
      batchId: id,
      message: n
        ? `Drafted ${n} keyword idea${n === 1 ? "" : "s"} from ${formatDay(from)} – ${formatDay(to)}${campaign ? ` in ${campaign.name}` : ""}. Next: someone reviews each line.`
        : "No new keyword ideas: everything that converted is already a keyword, or a safety check left it out.",
    }
  } catch (e) {
    return failed(e)
  }
}

export async function markKeywordIdea(batchId: string, index: number, field: "proven" | "approved", value: boolean | null, rawName: string): Promise<IdeaResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  if ((field !== "proven" && field !== "approved") || (value !== true && value !== false && value !== null)) return { ok: false, message: "Unknown choice." }
  try {
    const problem = await changeBatch(batchId, (b) => {
      const item = b.items[index]
      if (!Number.isInteger(index) || !item) return "That line doesn't exist any more. Reload the page."
      const stage = ideaStage(b)
      if (field === "proven") {
        if (stage !== "proving") return "The review step is closed. Reopen it to change a line."
        item.proven = value
        item.provenBy = value === null ? undefined : who.name
      } else {
        if (stage !== "approving") return b.proven ? "The approval step is closed. Reopen it to change a line." : "The lines need a review first."
        if (!item.proven) return "Only lines that held up in review can be approved."
        if (value && !item.adGroupId) return "Choose an ad group for this keyword first."
        item.approved = value
        item.approvedBy = value === null ? undefined : who.name
      }
    })
    if (problem) return problem
    refresh()
    return { ok: true, message: "Saved." }
  } catch (e) {
    return failed(e)
  }
}

export async function markAllKeywordIdeas(batchId: string, field: "proven" | "approved", value: boolean, rawName: string): Promise<IdeaResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  if ((field !== "proven" && field !== "approved") || typeof value !== "boolean") return { ok: false, message: "Unknown choice." }
  try {
    let n = 0
    let noGroup = 0
    const problem = await changeBatch(batchId, (b) => {
      const stage = ideaStage(b)
      if (field === "proven" && stage !== "proving") return "The review step is closed. Reopen it to change a line."
      if (field === "approved" && stage !== "approving") return b.proven ? "The approval step is closed. Reopen it to change a line." : "The lines need a review first."
      for (const item of b.items) {
        if (field === "proven" && item.proven === null) {
          item.proven = value
          item.provenBy = who.name
          n++
        } else if (field === "approved" && item.proven && item.approved === null) {
          if (value && !item.adGroupId) {
            noGroup++
            continue
          }
          item.approved = value
          item.approvedBy = who.name
          n++
        }
      }
    })
    if (problem) return problem
    refresh()
    return { ok: true, message: `Marked ${n} line${n === 1 ? "" : "s"}.${noGroup ? ` ${noGroup} still need an ad group first.` : ""}` }
  } catch (e) {
    return failed(e)
  }
}

// Change a line's match type or ad group while it's in review or approval.
export async function editKeywordIdea(
  batchId: string,
  index: number,
  change: { matchType?: string; adGroupId?: string },
  rawName: string,
): Promise<IdeaResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  try {
    const group = change.adGroupId ? (await adGroupsWithKeywords()).find((g) => g.id === change.adGroupId) : undefined
    if (change.adGroupId && !group) return { ok: false, message: "That ad group no longer exists. Reload the page." }
    if (change.matchType && change.matchType !== "EXACT" && change.matchType !== "PHRASE") return { ok: false, message: "Unknown match type." }
    const problem = await changeBatch(batchId, (b) => {
      const item = b.items[index]
      if (!Number.isInteger(index) || !item) return "That line doesn't exist any more. Reload the page."
      const stage = ideaStage(b)
      if (stage !== "proving" && stage !== "approving") return "Lines can only change during review or approval."
      if (change.matchType && b.items.some((o, i) => i !== index && o.text === item.text && o.matchType === change.matchType)) {
        return `There's already a ${change.matchType === "EXACT" ? "exact" : "phrase"} line for "${item.text}".`
      }
      if (change.matchType) item.matchType = change.matchType as "EXACT" | "PHRASE"
      if (group) {
        item.adGroupId = group.id
        item.adGroupName = group.name
        item.campaignId = group.campaignId
        item.campaignName = group.campaignName
      }
    })
    if (problem) return problem
    refresh()
    return { ok: true, message: "Saved." }
  } catch (e) {
    return failed(e)
  }
}

export async function finishKeywordStep(batchId: string, step: "proven" | "approved", rawName: string): Promise<IdeaResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  try {
    const problem = await changeBatch(batchId, (b) => {
      const stage = ideaStage(b)
      if (step === "proven") {
        if (stage !== "proving") return "The review step is already done."
        const open = b.items.filter((i) => i.proven === null).length
        if (open) return `${open} line${open === 1 ? " still needs" : "s still need"} a decision.`
        b.proven = { by: who.name, at: new Date().toISOString() }
      } else if (step === "approved") {
        if (stage !== "approving") return b.approved ? "The approval step is already done." : "The lines need a review first."
        const open = b.items.filter((i) => i.proven && i.approved === null).length
        if (open) return `${open} line${open === 1 ? " still needs" : "s still need"} a decision.`
        b.approved = { by: who.name, at: new Date().toISOString() }
      } else return "Unknown step."
    })
    if (problem) return problem
    refresh()
    const b = (await readData()).keywordBatches.find((x) => x.id === batchId)
    const next =
      step === "proven"
        ? b?.items.some((i) => i.proven)
          ? "Review done. Next: approval."
          : "Review done. Nothing held up, so there's nothing to approve or push."
        : b?.items.some((i) => i.proven && i.approved)
          ? "Approval done. Next: an admin pushes the approved keywords."
          : "Approval done. Nothing was approved, so there's nothing to push."
    return { ok: true, message: next }
  } catch (e) {
    return failed(e)
  }
}

export async function reopenKeywordStep(batchId: string, step: "proven" | "approved", rawName: string): Promise<IdeaResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  try {
    const problem = await changeBatch(batchId, (b) => {
      if (b.pushed) return "This batch was already pushed, so it can't change."
      if (step === "proven") {
        if (!b.proven) return "The review step is still open."
        if (b.approved) return "Reopen the approval first."
        b.proven = undefined
        for (const i of b.items) {
          i.approved = null
          i.approvedBy = undefined
        }
      } else if (step === "approved") {
        if (!b.approved) return "The approval step is still open."
        b.approved = undefined
      } else return "Unknown step."
    })
    if (problem) return problem
    refresh()
    return { ok: true, message: `Reopened by ${who.name}.` }
  } catch (e) {
    return failed(e)
  }
}

export async function discardKeywordBatch(batchId: string, rawName: string): Promise<IdeaResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  try {
    let error: string | undefined
    await updateData((d) => {
      const b = d.keywordBatches.find((x) => x.id === batchId)
      if (!b) error = "That batch doesn't exist any more."
      else if (b.pushed) error = "This batch was pushed to Google Ads, so it stays in the record."
      if (error) return false
      d.keywordBatches = d.keywordBatches.filter((x) => x.id !== batchId)
    })
    if (error) return { ok: false, message: error }
    refresh()
    return { ok: true, message: "Batch discarded." }
  } catch (e) {
    return failed(e)
  }
}
