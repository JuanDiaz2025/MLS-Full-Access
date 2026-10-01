"use server"

// The Compliance agent's steps, like a negatives batch: anyone signed in asks to turn campaigns
// on or off, someone checks it, someone approves it, and an admin applies it. Override requests
// for changes held during Google's learning period are filed by the push itself (actions/changes.ts)
// and go through the same check and approval; the push then goes through once.

import { refresh } from "next/cache"

import { isAdmin, isSignedIn } from "@/lib/auth"
import { newRequestId, requestStage } from "@/lib/compliance"
import { getEditableCampaigns, setCampaignStatus } from "@/lib/google-ads/changes"
import { GoogleAdsError, MissingKeysError, dryRun } from "@/lib/google-ads/client"
import { rememberName } from "@/lib/people"
import { readData, updateData } from "@/lib/store"

export type ComplianceResult = { ok: boolean; message: string }

const CAMPAIGN_ID = /^\d{1,20}$/
const MAX_CAMPAIGNS = 25

async function person(rawName: unknown): Promise<{ name: string } | ComplianceResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const name = await rememberName(rawName)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who did each step." }
  return { name }
}

export async function requestStatusAction(input: { campaignIds: string[]; status: string; reason: string; name: string }): Promise<ComplianceResult> {
  const who = await person(input?.name)
  if ("ok" in who) return who
  const ids = Array.isArray(input.campaignIds) ? [...new Set(input.campaignIds.filter((id) => typeof id === "string" && CAMPAIGN_ID.test(id)))] : []
  if (!ids.length || ids.length > MAX_CAMPAIGNS) return { ok: false, message: "Choose at least one campaign." }
  if (input.status !== "ENABLED" && input.status !== "PAUSED") return { ok: false, message: "Choose on or off." }
  const reason = String(input.reason ?? "")
    .trim()
    .slice(0, 500)
  if (!reason) return { ok: false, message: "Say why, so the checker and approver can decide." }
  const campaigns = new Map((await getEditableCampaigns()).map((c) => [c.id, c]))
  const picked = ids.filter((id) => campaigns.has(id) && campaigns.get(id)!.status !== input.status)
  if (!picked.length) return { ok: false, message: `Those campaigns are already ${input.status === "ENABLED" ? "on" : "off"}.` }
  await updateData((d) => {
    d.changeRequests.unshift({
      id: newRequestId(),
      kind: "status",
      campaigns: picked.map((id) => ({ id, name: campaigns.get(id)!.name })),
      status: input.status as "ENABLED" | "PAUSED",
      reason,
      requested: { by: who.name, at: new Date().toISOString() },
    })
  })
  refresh()
  return { ok: true, message: "Request added. Next, someone checks it, then it's approved, then an admin applies it." }
}

// Step 2 (check) and step 3 (approve). Saying no closes the request.
export async function decideRequestAction(
  id: string,
  step: "checked" | "approved",
  ok: boolean,
  rawName: string,
  note?: string,
): Promise<ComplianceResult> {
  const who = await person(rawName)
  if ("ok" in who) return who
  let error = ""
  await updateData((d) => {
    const r = d.changeRequests.find((x) => x.id === id)
    if (!r) error = "That request doesn't exist any more. Reload the page."
    else if (step === "checked" && requestStage(r) !== "checking") error = "This request was already checked."
    else if (step === "approved" && requestStage(r) !== "approving") error = "This request isn't waiting for approval."
    if (error || !r) return false
    r[step] = {
      by: who.name,
      at: new Date().toISOString(),
      ok: !!ok,
      note:
        String(note ?? "")
          .trim()
          .slice(0, 300) || undefined,
    }
  })
  if (error) return { ok: false, message: error }
  refresh()
  if (!ok) return { ok: true, message: "Closed. Nothing changes in Google Ads." }
  return { ok: true, message: step === "checked" ? "Checked. Next it needs an approval." : "Approved. An admin can now apply it." }
}

// Step 4 for on/off requests: an admin sets the campaigns' status in Google Ads.
export async function applyStatusRequestAction(id: string, rawName: string): Promise<ComplianceResult> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can change Google Ads. Sign in as an admin first." }
  const who = await person(rawName)
  if ("ok" in who) return who
  const r = (await readData()).changeRequests.find((x) => x.id === id)
  if (!r || r.kind !== "status" || !r.status) return { ok: false, message: "That request doesn't exist any more. Reload the page." }
  if (requestStage(r) !== "ready")
    return { ok: false, message: r.applied ? "This request was already applied." : "This request isn't checked and approved yet." }
  try {
    const summary = await setCampaignStatus(
      r.campaigns.map((c) => c.id),
      r.status,
    )
    await updateData((d) => {
      const x = d.changeRequests.find((y) => y.id === id)
      if (x && !x.applied) x.applied = { by: who.name, at: new Date().toISOString(), failures: summary.failures, dryRun: dryRun() || undefined }
    })
    refresh()
    const verb = r.status === "ENABLED" ? "Turned on" : "Paused"
    if (dryRun()) return { ok: true, message: `Dry run (DEALTRACK_VALIDATE_ONLY=1): Google checked the change and applied nothing.` }
    if (summary.failures.length)
      return { ok: false, message: `${verb} ${summary.applied}; ${summary.failures.length} failed: ${summary.failures.join("; ")}` }
    return {
      ok: true,
      message: summary.applied
        ? `${verb} ${summary.applied} campaign${summary.applied === 1 ? "" : "s"} in Google Ads.`
        : "Nothing to change: they were already set.",
    }
  } catch (err) {
    if (err instanceof MissingKeysError) return { ok: false, message: "Google Ads isn't connected, so nothing was changed." }
    if (err instanceof GoogleAdsError)
      return { ok: false, message: `Nothing was changed. ${err.message}${err.detail ? ` Google said: ${err.detail}` : ""}` }
    return { ok: false, message: err instanceof Error ? err.message : "Something went wrong, so nothing was changed." }
  }
}
