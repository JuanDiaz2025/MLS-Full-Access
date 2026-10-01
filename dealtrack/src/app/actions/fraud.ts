"use server"

// The Fraud page only watches and reports: these actions read Google's click list for a refund
// claim and save which networks belong to the team. Nothing here changes Google Ads.

import { refresh } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { today } from "@/lib/date-range"
import { getClicks, type AdClick } from "@/lib/fraud/clicks"
import { rememberName } from "@/lib/people"
import { updateData } from "@/lib/store"

export type FraudResult = { ok: boolean; message: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 31
const NETWORK = /^[0-9a-f.:/]{3,60}$/i

// Google's billed clicks on these days, for the evidence pack. Google keeps them for 90 days.
export async function billedClicksAction(
  dates: string[],
  campaignId?: string,
): Promise<{ ok: true; clicks: AdClick[] } | { ok: false; message: string }> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const days = [...new Set((Array.isArray(dates) ? dates : []).filter((d) => typeof d === "string" && ISO_DATE.test(d)))]
  if (!days.length) return { ok: true, clicks: [] }
  if (days.length > MAX_DAYS) return { ok: false, message: `Pick up to ${MAX_DAYS} days at a time.` }
  try {
    return { ok: true, clicks: await getClicks(days, today(), typeof campaignId === "string" && /^\d+$/.test(campaignId) ? campaignId : undefined) }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Google Ads didn't answer. Try again." }
  }
}

export async function markNetworkAction(network: string, label: string, rawName: string): Promise<FraudResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const name = await rememberName(rawName)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who marked it." }
  if (typeof network !== "string" || !NETWORK.test(network)) return { ok: false, message: "That isn't a network address." }
  const text = String(label ?? "")
    .trim()
    .slice(0, 60)
  if (!text) return { ok: false, message: 'Say whose connection it is, e.g. "Office" or "Manila team".' }
  await updateData((d) => {
    d.knownNetworks = [...d.knownNetworks.filter((k) => k.network !== network), { network, label: text, by: name, at: new Date().toISOString() }]
  })
  refresh()
  return { ok: true, message: `Marked as ${text}.` }
}

export async function unmarkNetworkAction(network: string): Promise<FraudResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  await updateData((d) => {
    d.knownNetworks = d.knownNetworks.filter((k) => k.network !== network)
  })
  refresh()
  return { ok: true, message: "No longer marked as the team's." }
}
