"use server"

// The weekly negative keyword routine's steps that only touch DealTrack's saved data: drafting a
// batch, proving and approving its lines, and the result check a week after the push. Pushing
// to Google Ads is in actions/changes.ts, with the other changes, and needs an admin.

import { refresh } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { addDays, formatDay, today } from "@/lib/date-range"
import { draftStandard } from "@/lib/campaign-check"
import { getEditableCampaigns } from "@/lib/google-ads/changes"
import { MAX_DRAFT_DAYS, batchId, checkDay, draftBatch, measure, stageOf } from "@/lib/negative-batches"
import { rememberName } from "@/lib/people"
import { readData, updateData, type NegativeBatch } from "@/lib/store"

export type StepResult = { ok: boolean; message: string }

async function person(rawName: unknown): Promise<{ name: string } | StepResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const name = await rememberName(rawName)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who did each step." }
  return { name }
}

const failed = (e: unknown): StepResult => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong, so nothing was saved." })

// Runs `edit` on one batch inside a single save. `edit` returns an error message to cancel.
async function changeBatch(batchId: string, edit: (b: NegativeBatch, all: NegativeBatch[]) => string | undefined): Promise<StepResult | null> {
  let error: string | undefined
  await updateData((d) => {
    const b = d.batches.find((x) => x.id === batchId)
    error = b ? edit(b, d.batches) : "That batch doesn't exist any more. Reload the page."
    return !error
  })
  return error ? { ok: false, message: error } : null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

// Drafts a batch from the search terms between two dates, from one campaign ("" = all campaigns).
// Any campaign works, paused or ended ones too, so old campaigns can be tried out.
export async function draftNegativeBatch(input: { from: string; to: string; campaignId: string }, rawName: string): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const { from, to } = input
  if (!isDay(from) || !isDay(to)) return { ok: false, message: "Choose a start and an end date." }
  if (from > to) return { ok: false, message: "The start date has to come before the end date." }
  if (to > today()) return { ok: false, message: "The end date can't be in the future." }
  if (to > addDays(from, MAX_DRAFT_DAYS - 1)) return { ok: false, message: `Choose ${MAX_DRAFT_DAYS} days or fewer.` }
  const campaignId = input.campaignId || undefined
  if (campaignId && !/^\d+$/.test(campaignId)) return { ok: false, message: "Unknown campaign. Reload the page." }
  try {
    const campaign = campaignId ? (await getEditableCampaigns()).find((c) => c.id === campaignId) : undefined
    if (campaignId && !campaign) return { ok: false, message: "That campaign no longer exists or was removed. Reload the page." }
    const id = batchId({ from, to, campaignId })
    const taken = "There's already a batch for these dates and campaign. Discard it first to draft it again."
    if ((await readData()).batches.some((b) => b.id === id)) return { ok: false, message: taken }
    const draft = await draftBatch({ from, to, campaignId })
    let exists = false
    await updateData((d) => {
      exists = d.batches.some((b) => b.id === id)
      if (exists) return false
      d.batches.push({ id, from, to, campaignId, campaignName: campaign?.name, ...draft, drafted: { by: who.name, at: new Date().toISOString() } })
      d.batches.sort((a, b) => b.from.localeCompare(a.from) || b.id.localeCompare(a.id))
    })
    if (exists) return { ok: false, message: taken }
    refresh()
    const n = draft.items.length
    const where = campaign ? ` in ${campaign.name}` : ""
    return {
      ok: true,
      message: n
        ? `Drafted ${n} negative${n === 1 ? "" : "s"} from ${formatDay(from)} – ${formatDay(to)}${where}. Next: someone reviews each line.`
        : `Nothing to add: no search from ${formatDay(from)} – ${formatDay(to)}${where} matched the rules without converting.`,
    }
  } catch (e) {
    return failed(e)
  }
}

const MAX_CHECK_CAMPAIGNS = 30

// From the campaign check: one batch of the standard negatives the chosen campaigns don't have
// yet. It goes through the same review, approval, and admin push as any batch.
export async function draftStandardBatch(campaignIds: string[], rawName: string): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const ids = Array.isArray(campaignIds) ? [...new Set(campaignIds)] : []
  if (!ids.length || ids.length > MAX_CHECK_CAMPAIGNS || !ids.every((id) => typeof id === "string" && /^\d+$/.test(id))) {
    return { ok: false, message: "Choose at least one campaign." }
  }
  try {
    const names = new Map((await getEditableCampaigns()).map((c) => [c.id, c.name]))
    if (ids.some((id) => !names.has(id))) return { ok: false, message: "One of those campaigns no longer exists or was removed. Reload the page." }
    const id = `standard_${today()}_${ids.length === 1 ? `c${ids[0]}` : `${ids.length}`}`
    const taken = "A standard batch for these campaigns was already drafted today. Discard it first to draft it again."
    if ((await readData()).batches.some((b) => b.id === id)) return { ok: false, message: taken }
    const draft = await draftStandard(ids)
    let exists = false
    await updateData((d) => {
      exists = d.batches.some((b) => b.id === id)
      if (exists) return false
      d.batches.push({
        id,
        kind: "standard",
        from: draft.from,
        to: draft.to,
        campaignId: ids.length === 1 ? ids[0] : undefined,
        campaignName: ids.length === 1 ? names.get(ids[0]) : undefined,
        forCampaigns: ids.map((i) => names.get(i)!),
        items: draft.items,
        heldBack: draft.heldBack,
        alreadyNegative: [],
        drafted: { by: who.name, at: new Date().toISOString() },
      })
      d.batches.sort((a, b) => b.drafted.at.localeCompare(a.drafted.at))
    })
    if (exists) return { ok: false, message: taken }
    refresh()
    const n = draft.items.length
    return {
      ok: true,
      message: n
        ? `Drafted ${n} standard negative${n === 1 ? "" : "s"} for ${ids.length === 1 ? names.get(ids[0]) : `${ids.length} campaigns`}. It's at the top of the batches: next, someone reviews each line.`
        : "Those campaigns already block every standard negative.",
    }
  } catch (e) {
    return failed(e)
  }
}

export async function markNegativeLine(
  batchId: string,
  index: number,
  field: "proven" | "approved",
  value: boolean | null,
  rawName: string,
): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  if (field !== "proven" && field !== "approved") return { ok: false, message: "Unknown step." }
  if (value !== true && value !== false && value !== null) return { ok: false, message: "Unknown choice." }
  try {
    const problem = await changeBatch(batchId, (b) => {
      const item = b.items[index]
      if (!Number.isInteger(index) || !item) return "That line doesn't exist any more. Reload the page."
      const stage = stageOf(b)
      if (field === "proven") {
        if (stage !== "proving") return "The review step is closed. Reopen it to change a line."
        item.proven = value
        item.provenBy = value === null ? undefined : who.name
      } else {
        if (stage !== "approving") return b.proven ? "The approval step is closed. Reopen it to change a line." : "The lines need a review first."
        if (!item.proven) return "Only lines whose evidence holds up can be approved."
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

// Marks every line still without a decision at once, e.g. "Holds up" for a long standard batch.
export async function markAllNegativeLines(batchId: string, field: "proven" | "approved", value: boolean, rawName: string): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  if ((field !== "proven" && field !== "approved") || typeof value !== "boolean") return { ok: false, message: "Unknown choice." }
  try {
    let n = 0
    const problem = await changeBatch(batchId, (b) => {
      const stage = stageOf(b)
      if (field === "proven" && stage !== "proving") return "The review step is closed. Reopen it to change a line."
      if (field === "approved" && stage !== "approving") return b.proven ? "The approval step is closed. Reopen it to change a line." : "The lines need a review first."
      for (const item of b.items) {
        if (field === "proven" && item.proven === null) {
          item.proven = value
          item.provenBy = who.name
          n++
        } else if (field === "approved" && item.proven && item.approved === null) {
          item.approved = value
          item.approvedBy = who.name
          n++
        }
      }
    })
    if (problem) return problem
    refresh()
    return { ok: true, message: `Marked ${n} line${n === 1 ? "" : "s"}.` }
  } catch (e) {
    return failed(e)
  }
}

export async function finishNegativeStep(batchId: string, step: "proven" | "approved", rawName: string): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  try {
    const problem = await changeBatch(batchId, (b) => {
      const stage = stageOf(b)
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
    const batch = (await readData()).batches.find((b) => b.id === batchId)
    const next =
      step === "proven"
        ? batch?.items.some((i) => i.proven)
          ? "Review done. Next: approval."
          : "Review done. Nothing held up, so there's nothing to approve or push."
        : batch?.items.some((i) => i.proven && i.approved)
          ? "Approval done. Next: an admin pushes the approved lines."
          : "Approval done. Nothing was approved, so there's nothing to push."
    return { ok: true, message: next }
  } catch (e) {
    return failed(e)
  }
}

// Undo a finished step before anything was pushed, e.g. to change a line.
export async function reopenNegativeStep(batchId: string, step: "proven" | "approved", rawName: string): Promise<StepResult> {
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

export async function discardNegativeBatch(batchId: string, rawName: string): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  try {
    let error: string | undefined
    await updateData((d) => {
      const b = d.batches.find((x) => x.id === batchId)
      if (!b) error = "That batch doesn't exist any more."
      else if (b.pushed) error = "This batch was pushed to Google Ads, so it stays in the record."
      if (error) return false
      d.batches = d.batches.filter((x) => x.id !== batchId)
    })
    if (error) return { ok: false, message: error }
    refresh()
    return { ok: true, message: "Batch discarded. You can draft that week again." }
  } catch (e) {
    return failed(e)
  }
}

// A week after the push: spend on the blocked searches and leads, the week before vs the week after.
export async function checkNegativeBatch(batchId: string, rawName: string): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  try {
    const batch = (await readData()).batches.find((b) => b.id === batchId)
    if (!batch?.pushed) return { ok: false, message: "This batch hasn't been pushed yet." }
    if (batch.checked) return { ok: false, message: "The result was already checked." }
    const day = checkDay(batch)!
    if (today() < day) return { ok: false, message: `Check on ${formatDay(day)}, once a full week has passed since the push.` }
    const result = await measure(batch)
    const problem = await changeBatch(batchId, (b) => {
      if (b.checked) return "The result was already checked."
      b.checked = { by: who.name, at: new Date().toISOString(), ...result }
    })
    if (problem) return problem
    refresh()
    return { ok: true, message: "Result saved." }
  } catch (e) {
    return failed(e)
  }
}
