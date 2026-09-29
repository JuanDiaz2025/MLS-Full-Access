"use server"

// Entry points for campaign controls: pause/enable, daily budget, ad schedule, and ad text.
// Each checks for an admin session, validates the input, and returns an undo that restores the
// value the change replaced.

import { guarded, type ActionResult, type Undo } from "@/app/actions/guard"
import {
  setAdSchedule,
  setCampaignStatus,
  setDailyBudget,
  updateSearchAdText,
  type AdText,
  type Slot,
} from "@/lib/google-ads/controls"
import { weekdays } from "@/lib/google-ads/reports"

const ID = /^\d{1,20}$/
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" })
const dayName = (d: string) => d.charAt(0) + d.slice(1).toLowerCase()

function slotsFrom(value: unknown): Slot[] | null {
  if (!Array.isArray(value) || value.length > 7 * 6) return null
  const ok = value.every(
    (s) =>
      s && typeof s === "object" && weekdays.includes(s.day) && Number.isInteger(s.from) && Number.isInteger(s.to),
  )
  return ok ? value.map((s) => ({ day: s.day, from: s.from, to: s.to })) : null
}

function textsFrom(value: unknown): AdText[] | null {
  if (!Array.isArray(value) || value.length > 20) return null
  const ok = value.every((t) => t && typeof t === "object" && typeof t.text === "string" && t.text.length <= 200)
  return ok ? value.map((t) => ({ text: t.text, ...(typeof t.pin === "string" ? { pin: t.pin } : {}) })) : null
}

export async function setCampaignStatusAction(input: { campaignId: string; status: string }): Promise<ActionResult> {
  return guarded(async () => {
    if (!ID.test(input?.campaignId ?? "")) return { ok: false, message: "Choose a campaign." }
    if (input.status !== "ENABLED" && input.status !== "PAUSED") return { ok: false, message: "Choose pause or enable." }
    const r = await setCampaignStatus(input.campaignId, input.status)
    const verb = input.status === "PAUSED" ? "Paused" : "Turned on"
    if (!r.changed) return { ok: true, message: `${r.name} was already ${input.status === "PAUSED" ? "paused" : "on"}.` }
    return {
      ok: true,
      message: `${verb} ${r.name} in Google Ads.`,
      undo: { kind: "status", campaignId: input.campaignId, status: r.previous as "ENABLED" | "PAUSED" },
    }
  })
}

export async function setDailyBudgetAction(input: { campaignId: string; amount: number }): Promise<ActionResult> {
  return guarded(async () => {
    if (!ID.test(input?.campaignId ?? "")) return { ok: false, message: "Choose a campaign." }
    if (typeof input.amount !== "number") return { ok: false, message: "Enter a daily budget in dollars." }
    const r = await setDailyBudget(input.campaignId, input.amount)
    if (!r.changed) return { ok: true, message: `${r.name} already has a ${usd(input.amount)} daily budget.` }
    const others = r.campaigns.filter((n) => n !== r.name)
    return {
      ok: true,
      message: `Daily budget for ${r.name} is now ${usd(input.amount)} (was ${usd(r.previous)}).${
        others.length ? ` It's shared, so this also applies to ${others.join(", ")}.` : ""
      }`,
      undo: { kind: "budget", campaignId: input.campaignId, amount: r.previous },
    }
  })
}

export async function setAdScheduleAction(input: { campaignId: string; slots: unknown }): Promise<ActionResult> {
  return guarded(async () => {
    if (!ID.test(input?.campaignId ?? "")) return { ok: false, message: "Choose a campaign." }
    const slots = slotsFrom(input.slots)
    if (!slots) return { ok: false, message: "That schedule isn't valid." }
    const r = await setAdSchedule(input.campaignId, slots)
    if (!r.added && !r.removed) return { ok: true, message: `${r.name} already has that schedule.` }
    const days = [...new Set(slots.map((s) => dayName(s.day)))]
    return {
      ok: true,
      message: slots.length
        ? `Updated the ad schedule for ${r.name}: ads run on ${days.join(", ")} at the chosen hours.`
        : `Removed the ad schedule for ${r.name}. Ads can now run at any time.`,
      undo: { kind: "schedule", campaignId: input.campaignId, slots: r.previous },
    }
  })
}

export async function updateAdTextAction(input: { adId: string; headlines: unknown; descriptions: unknown }): Promise<ActionResult> {
  return guarded(async () => {
    if (!ID.test(input?.adId ?? "")) return { ok: false, message: "Choose an ad." }
    const headlines = textsFrom(input.headlines)
    const descriptions = textsFrom(input.descriptions)
    if (!headlines || !descriptions) return { ok: false, message: "Those headlines or descriptions aren't valid." }
    const r = await updateSearchAdText(input.adId, { headlines, descriptions })
    if (!r.changed) return { ok: true, message: "Nothing changed in that ad." }
    return {
      ok: true,
      message: `Updated the ad in ${r.adGroup}. Google will review it again, which usually takes up to a day.`,
      undo: { kind: "ad", adId: input.adId, ...r.previous },
    }
  })
}

// Restores what a change replaced. The result has no undo of its own.
export async function undoAction(undo: Undo): Promise<ActionResult> {
  const result = await (async () => {
    switch (undo?.kind) {
      case "status":
        return setCampaignStatusAction(undo)
      case "budget":
        return setDailyBudgetAction(undo)
      case "schedule":
        return setAdScheduleAction(undo)
      case "ad":
        return updateAdTextAction(undo)
      default:
        return { ok: false, message: "There's nothing to undo." }
    }
  })()
  return { ...result, message: result.ok ? `Undone. ${result.message}` : result.message, undo: undefined }
}
