"use server"

// The weekly review's steps: making it, approving or rejecting proposals, ticking off the ones
// done by hand in Google Ads, sending approved blocks and keywords on to their batches, the AI
// summary, and (admins) the rules. Nothing here changes Google Ads itself.

import { refresh } from "next/cache"

import { askAssistant } from "@/lib/assistant/ask"
import { isAdmin, isSignedIn } from "@/lib/auth"
import { formatDay, today } from "@/lib/date-range"
import { rememberName } from "@/lib/people"
import { updateData } from "@/lib/store"
import {
  DEFAULT_RULES,
  STANDING_RULES,
  getReviews,
  makeReview,
  reviewText,
  reviewWeek,
  updateReviews,
  type ReviewRules,
  type WeeklyReview,
} from "@/lib/weekly-review"

export type ReviewResult = { ok: boolean; message: string }

async function person(rawName: unknown): Promise<{ name: string } | ReviewResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const name = await rememberName(rawName)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who approved what." }
  return { name }
}

const failed = (e: unknown): ReviewResult => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong, so nothing was saved." })

async function changeReview(id: string, edit: (r: WeeklyReview) => string | undefined): Promise<ReviewResult | null> {
  let error: string | undefined
  await updateReviews((f) => {
    const r = f.reviews.find((x) => x.id === id)
    error = r ? edit(r) : "That review doesn't exist any more. Reload the page."
  })
  return error ? { ok: false, message: error } : null
}

// Makes last week's review, or makes it again (only until its approvals were sent on).
export async function makeReviewAction(rawName: string): Promise<ReviewResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const week = reviewWeek()
  const existing = (await getReviews()).reviews.find((r) => r.id === week.id)
  if (existing?.sent) return { ok: false, message: "This week's approvals were already sent on, so the review stays as it is." }
  try {
    const review = await makeReview(who.name)
    await updateReviews((f) => {
      f.reviews = f.reviews.filter((r) => r.id !== review.id)
      f.reviews.push(review)
    })
    refresh()
    return { ok: true, message: `Made the review of ${formatDay(week.from)} – ${formatDay(week.to)}: ${review.proposals.length} proposals.` }
  } catch (e) {
    return failed(e)
  }
}

// Approve (true), reject (false) or undo (null) one proposal, or every undecided one ("all").
export async function decideAction(reviewId: string, proposalId: string, value: boolean | null, rawName: string): Promise<ReviewResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const error = await changeReview(reviewId, (r) => {
    if (r.sent) return "These approvals were already sent on. Change the lines on the Weekly negatives or Keyword ideas page instead."
    const list = proposalId === "all" ? r.proposals.filter((p) => p.decision === null) : r.proposals.filter((p) => p.id === proposalId)
    if (!list.length) return proposalId === "all" ? "Everything is already decided." : "That proposal isn't there any more. Reload the page."
    for (const p of list) {
      p.decision = value
      p.decidedBy = value === null ? undefined : who.name
    }
  })
  if (error) return error
  refresh()
  return { ok: true, message: proposalId === "all" ? `${value ? "Approved" : "Rejected"} everything left.` : "Saved." }
}

// Pauses, cities and budget are done by hand in Google Ads; this records who did it.
export async function markAppliedAction(reviewId: string, proposalId: string, done: boolean, rawName: string): Promise<ReviewResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const error = await changeReview(reviewId, (r) => {
    const p = r.proposals.find((x) => x.id === proposalId)
    if (!p) return "That proposal isn't there any more. Reload the page."
    if (p.decision !== true) return "Only approved proposals can be marked as done."
    p.applied = done ? { by: who.name, at: new Date().toISOString() } : undefined
  })
  if (error) return error
  refresh()
  return { ok: true, message: done ? "Marked as done in Google Ads." : "Unmarked." }
}

// Approved blocks become a Weekly negatives batch and approved keywords a Keyword ideas batch,
// both already reviewed and approved, ready for an admin to push from those pages.
export async function sendApprovedAction(reviewId: string, rawName: string): Promise<ReviewResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const { rules, reviews } = await getReviews()
  const r = reviews.find((x) => x.id === reviewId)
  if (!r) return { ok: false, message: "That review doesn't exist any more. Reload the page." }
  if (rules.dryRun) return { ok: false, message: "The dry run is on: proposals only, nothing is sent. An admin turns it off under Rules." }
  if (r.sent) return { ok: false, message: "Already sent." }
  const blocks = r.proposals.filter((p) => p.kind === "block" && p.decision === true && p.block)
  const adds = r.proposals.filter((p) => p.kind === "add" && p.decision === true && p.idea)
  if (!blocks.length && !adds.length) return { ok: false, message: "No approved searches to block or keywords to add." }
  const at = new Date().toISOString()
  const step = { by: who.name, at, note: `Weekly review of ${formatDay(r.week.from)} – ${formatDay(r.week.to)}` }
  const negId = blocks.length ? `${r.week.from}_${r.week.to}_review` : undefined
  const ideasId = adds.length ? `ideas_review_${r.id}` : undefined
  let taken = false
  await updateData((d) => {
    taken = (!!negId && d.batches.some((b) => b.id === negId)) || (!!ideasId && d.keywordBatches.some((b) => b.id === ideasId))
    if (taken) return false
    if (negId) {
      d.batches.push({
        id: negId,
        from: r.week.from,
        to: r.week.to,
        items: blocks.map((p) => ({ ...p.block!, proven: true, provenBy: p.decidedBy, approved: true, approvedBy: p.decidedBy })),
        heldBack: [],
        alreadyNegative: [],
        drafted: step,
        proven: step,
        approved: step,
      })
      d.batches.sort((a, b) => b.from.localeCompare(a.from) || b.id.localeCompare(a.id))
    }
    if (ideasId) {
      d.keywordBatches.unshift({
        id: ideasId,
        from: r.long.from,
        to: r.long.to,
        sources: ["proven", "phrase"],
        items: adds.map((p) => ({ ...p.idea!, proven: true, provenBy: p.decidedBy, approved: true, approvedBy: p.decidedBy })),
        skipped: [],
        notes: [`From the weekly review of ${formatDay(r.week.from)} – ${formatDay(r.week.to)}.`],
        drafted: step,
        proven: step,
        approved: step,
      })
    }
  })
  if (taken) return { ok: false, message: "This week's review batches already exist on the Weekly negatives or Keyword ideas page." }
  await changeReview(reviewId, (x) => {
    x.sent = { by: who.name, at, negatives: negId, ideas: ideasId }
    return undefined
  })
  refresh()
  return {
    ok: true,
    message: [
      blocks.length && `${blocks.length} block${blocks.length === 1 ? " is" : "s are"} ready to push on Weekly negatives`,
      adds.length && `${adds.length} keyword${adds.length === 1 ? " is" : "s are"} ready to push on Keyword ideas`,
    ]
      .filter(Boolean)
      .join("; ")
      .concat(". An admin pushes them there."),
  }
}

// The one-page summary from the AI that's set up for the chat, with its own check of the totals.
export async function summaryAction(reviewId: string, rawName: string): Promise<ReviewResult> {
  const who = await person(rawName)
  if (!("name" in who)) return who
  const r = (await getReviews()).reviews.find((x) => x.id === reviewId)
  if (!r) return { ok: false, message: "That review doesn't exist any more. Reload the page." }
  const question = `Here is this week's Google Ads review for Twin Home Buyer, already worked out by DealTrack from the account (last 7 days and last 90 days):

${reviewText(r)}

Our rules:
${[...STANDING_RULES, `Target: $${r.rules.targetLow.toLocaleString("en-US")} to $${r.rules.targetHigh.toLocaleString("en-US")} ad spend per closed deal.`].map((x) => `- ${x}`).join("\n")}

Write a one-page summary for Juan, who approves the changes: what happened this week, then the five sections (new keywords, searches to block, keywords to pause, cities to drop or push, budget) with the number that decides each, keeping only changes the rules allow. Say plainly if a proposal looks wrong and why. Then run a check on yourself: recompute the totals from the numbers above and list anything you corrected. Plain language, short bullets, Markdown, no tables.`
  try {
    const text = await askAssistant({
      turns: [{ role: "user", content: question }],
      situation: `Today is ${today()} (Pacific time). Everything needed is in the question; answer from it without running queries.`,
    })
    await changeReview(reviewId, (x) => {
      x.summary = { text: text.slice(0, 20_000), by: who.name, at: new Date().toISOString() }
      return undefined
    })
    refresh()
    return { ok: true, message: "Summary written." }
  } catch (e) {
    return failed(e)
  }
}

const NUMBER_RULES: (keyof ReviewRules)[] = [
  "targetLow",
  "targetHigh",
  "pauseKeywordSpend",
  "dropCitySpend",
  "cityCostTimes",
  "pushCityConversions",
  "pushCityCostShare",
  "outsideSpend",
  "budgetStep",
  "maxPerSection",
]

export async function saveRulesAction(_prev: ReviewResult | null, form: FormData): Promise<ReviewResult> {
  if (!(await isAdmin())) return { ok: false, message: "Only an admin can change the rules." }
  const name = await rememberName(form.get("name"))
  if (!name) return { ok: false, message: "Type your name first." }
  const next: ReviewRules = { ...DEFAULT_RULES, dryRun: form.get("dryRun") === "on", updatedBy: name, updatedAt: new Date().toISOString() }
  for (const key of NUMBER_RULES) {
    const raw = String(form.get(key) ?? "").replace(/[$,%\s]/g, "")
    const n = Number(raw)
    if (raw === "" || !Number.isFinite(n) || n < 0) return { ok: false, message: `“${key}” needs a number of 0 or more.` }
    ;(next as Record<string, unknown>)[key] = key === "pushCityCostShare" || key === "budgetStep" ? (n > 1 ? n / 100 : n) : n
  }
  if (next.targetLow > next.targetHigh) return { ok: false, message: "The low target has to be below the high one." }
  next.maxPerSection = Math.max(1, Math.min(50, Math.round(next.maxPerSection)))
  await updateReviews((f) => {
    f.rules = next
  })
  refresh()
  return { ok: true, message: "Rules saved. They apply to the next review made." }
}
