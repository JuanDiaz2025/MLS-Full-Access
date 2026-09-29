// The admin check and error handling every change action shares. Not a server action itself.

import { isAdmin } from "@/lib/auth"
import { GoogleAdsError, MissingKeysError } from "@/lib/google-ads/client"

// What the page gets back. undo, when present, restores what the change replaced.
export type ActionResult = { ok: boolean; message: string; failures?: string[]; undo?: Undo }

export type Undo =
  | { kind: "status"; campaignId: string; status: "ENABLED" | "PAUSED" }
  | { kind: "budget"; campaignId: string; amount: number }
  | { kind: "schedule"; campaignId: string; slots: { day: string; from: number; to: number }[] }
  | { kind: "ad"; adId: string; headlines: { text: string; pin?: string }[]; descriptions: { text: string; pin?: string }[] }

export async function guarded(run: () => Promise<ActionResult>): Promise<ActionResult> {
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
