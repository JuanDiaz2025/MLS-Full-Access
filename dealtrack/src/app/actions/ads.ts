"use server"

// Editing an ad's text. Only when someone asks: "Improve this ad" has the AI draft new headlines
// and descriptions (nothing is saved or sent), the person edits them and files a request, and it
// then goes through the Compliance steps like turning ads on or off: checked, approved, and
// applied in Google Ads by an admin. The old text is kept, so it can be put back the same way.

import { refresh } from "next/cache"

import { suggestAdFix, type AdFix } from "@/lib/ad-fix"
import { adTextProblems, clean, sameText, shownText, type AdTextSet } from "@/lib/ad-text"
import { AssistantError } from "@/lib/assistant/shared"
import { isAdmin, isSignedIn } from "@/lib/auth"
import { getLearning, newRequestId, requestStage } from "@/lib/compliance"
import { getAdText, updateAdText, validCampaignId } from "@/lib/google-ads/campaign"
import { GoogleAdsError, MissingKeysError, dryRun } from "@/lib/google-ads/client"
import { rememberName } from "@/lib/people"
import { readData, updateData } from "@/lib/store"

export type AdActionResult = { ok: boolean; message: string; requestId?: string }

const AD_ID = /^\d{1,20}$/

function googleError(err: unknown, what = "Nothing was changed.") {
  if (err instanceof MissingKeysError) return "Google Ads isn't connected, so nothing was changed."
  if (err instanceof GoogleAdsError) return `${what} ${err.message}${err.detail ? ` Google said: ${err.detail}` : ""}`
  return err instanceof Error ? err.message : what
}

// The AI's draft. Only runs when the person clicks the button; saves nothing.
export async function suggestAdFixAction(campaignId: string, adId: string): Promise<{ ok: true; fix: AdFix } | { ok: false; message: string }> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  if (!validCampaignId(campaignId) || !AD_ID.test(adId)) return { ok: false, message: "That ad couldn't be found." }
  try {
    return { ok: true, fix: await suggestAdFix(campaignId, adId) }
  } catch (err) {
    if (err instanceof AssistantError) return { ok: false, message: err.message }
    return { ok: false, message: googleError(err, "The AI couldn't draft a fix.") }
  }
}

function readSet(input: unknown): AdTextSet | null {
  const o = input as { headlines?: unknown; descriptions?: unknown }
  const lines = (v: unknown) =>
    Array.isArray(v)
      ? v
          .slice(0, 20)
          .map((l) => ({
            text: String((l as { text?: unknown })?.text ?? "").slice(0, 200),
            pinned: String((l as { pinned?: unknown })?.pinned ?? ""),
          }))
      : null
  const headlines = lines(o?.headlines)
  const descriptions = lines(o?.descriptions)
  return headlines && descriptions ? clean({ headlines, descriptions }) : null
}

async function fileRequest(
  who: string,
  adId: string,
  after: AdTextSet,
  reason: string,
  extra: { ai?: boolean; undoOf?: string; expectBefore?: AdTextSet },
): Promise<AdActionResult> {
  const problems = adTextProblems(after)
  if (problems.length) return { ok: false, message: `Google won't accept this yet: ${problems.slice(0, 3).join(" ")}` }
  const current = await getAdText(adId)
  if (!current) return { ok: false, message: "That ad isn't in Google Ads any more." }
  if (extra.expectBefore && !sameText(current, extra.expectBefore))
    return {
      ok: false,
      message:
        "The ad was changed in Google Ads since then, so putting the old text back could undo someone else's edit. Edit it on the campaign page instead.",
    }
  const before: AdTextSet = { headlines: current.headlines, descriptions: current.descriptions }
  if (sameText(before, after)) return { ok: false, message: "Nothing changed: that's what the ad already says." }
  const learning = await getLearning([current.campaignId]).catch(() => [])
  const id = newRequestId()
  await updateData((d) => {
    d.changeRequests.unshift({
      id,
      kind: "ad",
      campaigns: [{ id: current.campaignId, name: current.campaign }],
      ad: {
        id: adId,
        adGroup: current.adGroup,
        firstHeadline: shownText((after.headlines.find((h) => h.pinned === "HEADLINE_1") ?? after.headlines[0]).text),
        before,
        after,
        ai: extra.ai || undefined,
        undoOf: extra.undoOf,
      },
      learning: learning.length ? learning.map((l) => ({ campaign: l.name, reason: l.reason })) : undefined,
      reason,
      requested: { by: who, at: new Date().toISOString() },
    })
  })
  refresh()
  return {
    ok: true,
    requestId: id,
    message: "Sent for approval. Someone checks it, someone approves it, then an admin applies it on the Compliance page.",
  }
}

// Files the edited text as a request. Nothing changes in Google Ads yet.
export async function requestAdEditAction(input: {
  adId: string
  text: AdTextSet
  reason: string
  name: string
  ai?: boolean
}): Promise<AdActionResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const name = await rememberName(input?.name)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who asked." }
  if (!AD_ID.test(String(input?.adId))) return { ok: false, message: "That ad couldn't be found." }
  const after = readSet(input.text)
  if (!after) return { ok: false, message: "The ad text couldn't be read." }
  const reason = String(input.reason ?? "")
    .trim()
    .slice(0, 500)
  if (!reason) return { ok: false, message: "Say why, so the checker and approver can decide." }
  try {
    return await fileRequest(name, input.adId, after, reason, { ai: !!input.ai })
  } catch (err) {
    return { ok: false, message: googleError(err, "The request couldn't be filed.") }
  }
}

// Step 4: an admin sends the approved text to Google Ads, if the ad still says what it said when
// the edit was asked (otherwise someone else's change would be lost).
export async function applyAdEditAction(id: string, rawName: string): Promise<AdActionResult> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can change Google Ads. Sign in as an admin first." }
  const name = await rememberName(rawName)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who applied it." }
  const r = (await readData()).changeRequests.find((x) => x.id === id)
  if (!r || r.kind !== "ad" || !r.ad) return { ok: false, message: "That request doesn't exist any more. Reload the page." }
  if (requestStage(r) !== "ready")
    return { ok: false, message: r.applied ? "This edit was already applied." : "This edit isn't checked and approved yet." }
  try {
    const current = await getAdText(r.ad.id)
    if (!current) return { ok: false, message: "That ad isn't in Google Ads any more." }
    if (!sameText(current, r.ad.before))
      return {
        ok: false,
        message:
          "The ad was changed in Google Ads after this was asked, so applying it would undo that change. Stop this request and ask again from the campaign page.",
      }
    const failure = await updateAdText(r.ad.id, r.ad.after)
    await updateData((d) => {
      const x = d.changeRequests.find((y) => y.id === id)
      if (x && !x.applied) x.applied = { by: name, at: new Date().toISOString(), failures: failure ? [failure] : [], dryRun: dryRun() || undefined }
    })
    refresh()
    if (failure) return { ok: false, message: `Google refused the new text: ${failure}` }
    if (dryRun()) return { ok: true, message: "Dry run (DEALTRACK_VALIDATE_ONLY=1): Google checked the new text and applied nothing." }
    return {
      ok: true,
      message: "Sent to Google Ads. Google reviews the new text (usually within a few hours); the approved version keeps showing until then.",
    }
  } catch (err) {
    return { ok: false, message: googleError(err) }
  }
}

// Files a new request to put an applied edit's old text back (it's checked and approved too).
export async function undoAdEditAction(id: string, rawName: string): Promise<AdActionResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const name = await rememberName(rawName)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who asked." }
  const r = (await readData()).changeRequests.find((x) => x.id === id)
  if (!r || r.kind !== "ad" || !r.ad || !r.applied || r.applied.failures.length || r.applied.dryRun)
    return { ok: false, message: "Only an edit that was applied in Google Ads can be put back." }
  try {
    return await fileRequest(name, r.ad.id, r.ad.before, `Put back the text from before “${r.reason}”`, { undoOf: r.id, expectBefore: r.ad.after })
  } catch (err) {
    return { ok: false, message: googleError(err, "The request couldn't be filed.") }
  }
}
