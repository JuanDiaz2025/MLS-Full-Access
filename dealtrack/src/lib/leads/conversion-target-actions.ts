"use server"

import { readFile } from "node:fs/promises"
import path from "node:path"

import { revalidatePath } from "next/cache"

import { isAdmin, isSignedIn } from "@/lib/auth"
import { activeAccount, forgetConnection } from "@/lib/conversions/google"
import { checkSending, retryNow, sendPendingConversions, setConversionTarget, type CheckStep } from "@/lib/conversions/offline-conversions"
import { dryRun } from "@/lib/google-ads/client"
import { DATA_DIR } from "@/lib/store"

// Picks which Google Ads conversion action a lead stage is sent to (Leads page).
export async function setConversionTargetAction(kind: string, resourceName: string): Promise<{ error?: string }> {
  if (!(await isAdmin())) return { error: "Only admins can change where leads are sent. Sign in as an admin." }
  if (kind !== "interested" && kind !== "closed" && kind !== "invalid") return { error: "Unknown stage." }
  try {
    const active = await activeAccount()
    if (!active) return { error: "Connect Google Ads first." }
    await setConversionTarget(active.connection, active.account, kind, resourceName)
    void sendPendingConversions(active.connection, active.account).catch(() => {})
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't save that." }
  }
  revalidatePath("/leads", "layout")
  return {}
}

// "Check sending to Google Ads" on the Leads page: which version of the app this is, then each
// thing sending needs, in order.
export async function checkSendingAction(): Promise<{ steps: CheckStep[] }> {
  if (!(await isSignedIn())) return { steps: [{ ok: false, title: "Signed in", detail: "Sign in first." }] }
  let version = "unknown"
  try {
    version = (await readFile(path.join(DATA_DIR, "app-version"), "utf8")).trim().slice(0, 7) || version
  } catch {}
  const steps: CheckStep[] = [{ ok: true, title: "App version", detail: `${version}. If something below fails, close DealTrack and start it again to get the latest version first.` }]
  if (dryRun()) steps.push({ ok: true, title: "Test mode", detail: "DEALTRACK_VALIDATE_ONLY=1 is on: leads wait and nothing is sent until it's off. The checks below still run." })
  // DealTrack's Google client ID starts with its Google Cloud project's number: that's the project
  // Google checks for the Data Manager API.
  const project = process.env.GOOGLE_ADS_CLIENT_ID?.trim().match(/^(\d+)-/)?.[1]
  if (project) {
    steps.push({
      ok: true,
      title: "Google Cloud project",
      detail: `${project} (DealTrack's Google client, GOOGLE_ADS_CLIENT_ID, belongs to it). The Data Manager API must be on in this project, not another one: https://console.cloud.google.com/apis/library/datamanager.googleapis.com?project=${project}`,
    })
  }
  try {
    const active = await activeAccount()
    if (!active) return { steps: [...steps, { ok: false, title: "Google Ads connected", detail: "Google Ads isn't set up: fill in the GOOGLE_ADS_ keys in .env.local." }] }
    return { steps: [...steps, ...(await checkSending(active.connection, active.account))] }
  } catch (error) {
    return { steps: [...steps, { ok: false, title: "Google Ads connected", detail: error instanceof Error ? error.message : String(error) }] }
  }
}

// "Try again now": sends every waiting or failed lead again right away.
export async function retryNowAction(): Promise<{ error?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  if (dryRun()) return { error: "DealTrack is in test mode (DEALTRACK_VALIDATE_ONLY=1), so nothing is sent to Google Ads." }
  try {
    const active = await activeAccount()
    if (!active) return { error: "Connect Google Ads first." }
    await retryNow(active.connection, active.account)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  revalidatePath("/leads", "layout")
  return {}
}

// Forgets the key saved by "Connect Google for conversions" (Automation page).
export async function forgetConversionsConnectionAction(): Promise<{ error?: string }> {
  if (!(await isAdmin())) return { error: "Only admins can change this." }
  await forgetConnection()
  revalidatePath("/leads", "layout")
  return {}
}
