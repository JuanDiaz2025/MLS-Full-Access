"use server"

// The weekly negative keyword routine's steps that only touch DealTrack's saved data: drafting a
// batch, proving and approving its lines, and the result check a week after the push. Pushing
// to Google Ads is in actions/changes.ts, with the other changes, and needs an admin.

import { refresh } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { formatDay, today } from "@/lib/date-range"
import { checkDay, completeWeeks, draftWeek, measure, stageOf } from "@/lib/negative-batches"
import { rememberName } from "@/lib/people"
import { readData, updateData, type NegativeBatch } from "@/lib/store"

export type StepResult = { ok: boolean; message: string }

const DRAFT_WEEKS = 8

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

export async function draftNegativeBatch(weekId: string, rawName: string): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const week = completeWeeks(DRAFT_WEEKS).find((w) => w.id === weekId)
  if (!week) return { ok: false, message: "Choose one of the last 8 complete weeks." }
  try {
    if ((await readData()).batches.some((b) => b.id === week.id)) return { ok: false, message: "That week already has a batch." }
    const draft = await draftWeek(week)
    let exists = false
    await updateData((d) => {
      exists = d.batches.some((b) => b.id === week.id)
      if (exists) return false
      d.batches.push({ id: week.id, from: week.from, to: week.to, ...draft, drafted: { by: who.name, at: new Date().toISOString() } })
      d.batches.sort((a, b) => b.id.localeCompare(a.id))
    })
    if (exists) return { ok: false, message: "Someone else just drafted that week." }
    refresh()
    const n = draft.items.length
    return {
      ok: true,
      message: n
        ? `Drafted ${n} negative${n === 1 ? "" : "s"} from ${formatDay(week.from)} – ${formatDay(week.to)}. Next: Seth proves each line.`
        : "Nothing to add this week: no search matched the rules without converting.",
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
        if (stage !== "proving") return "The proof step is closed. Reopen it to change a line."
        item.proven = value
        item.provenBy = value === null ? undefined : who.name
      } else {
        if (stage !== "approving") return b.proven ? "The approval step is closed. Reopen it to change a line." : "Seth proves the lines first."
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

export async function finishNegativeStep(batchId: string, step: "proven" | "approved", rawName: string): Promise<StepResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  try {
    const problem = await changeBatch(batchId, (b) => {
      const stage = stageOf(b)
      if (step === "proven") {
        if (stage !== "proving") return "The proof step is already done."
        const open = b.items.filter((i) => i.proven === null).length
        if (open) return `${open} line${open === 1 ? " still needs" : "s still need"} a decision.`
        b.proven = { by: who.name, at: new Date().toISOString() }
      } else if (step === "approved") {
        if (stage !== "approving") return b.approved ? "The approval step is already done." : "Seth proves the lines first."
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
          ? "Proof done. Next: the PPC owner approves."
          : "Proof done. Nothing held up, so there's nothing to approve or push."
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
        if (!b.proven) return "The proof step is still open."
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
