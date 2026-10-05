"use server"

// A phone call from a Google Ads ad turned into a lead. Calls carry no Google click ID (Google only
// shares the time, length and area code), so the lead is matched to the ad click by the caller's
// phone number instead, the way Google matches form leads without a click ID.
import { revalidatePath } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { activeAccount } from "@/lib/conversions/google"
import { sendPendingConversions, setLeadStatus } from "@/lib/conversions/offline-conversions"
import { gaql } from "@/lib/google-ads/client"
import { callIdOf, type CallInfo } from "@/lib/leads/call-id"
import { addLead, listLeads, updateLead } from "@/lib/leads/store"
import { leadStatuses, type LeadStatus } from "@/lib/leads/types"

// "2026-09-06 08:11:00" is in the Google Ads account's time zone; turn it into the real moment.
async function callTime(start: string) {
  const local = new Date(`${start.replace(" ", "T")}Z`) // the wall-clock time, read as if UTC
  if (Number.isNaN(local.getTime())) return local
  try {
    const [row] = await gaql<{ customer?: { timeZone?: string } }>("SELECT customer.time_zone FROM customer LIMIT 1")
    const zone = row?.customer?.timeZone
    if (!zone) throw new Error("no time zone")
    // The zone's offset from UTC at that moment (e.g. -7 hours for California in summer).
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(local)
        .map((p) => [p.type, p.value]),
    )
    const asZone = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
    return new Date(local.getTime() - (asZone - local.getTime()))
  } catch {
    return new Date(start.replace(" ", "T")) // this computer's time zone
  }
}

export async function addCallLeadAction(
  call: CallInfo,
  input: { phone: string; name: string; status: string; notes: string },
): Promise<{ error?: string; ok?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  const digits = String(input.phone ?? "").replace(/\D/g, "")
  if (digits.length < 10) return { error: "Type the caller's full phone number (with area code)." }
  if (!leadStatuses.some((s) => s.id === input.status)) return { error: "Pick a status." }
  const callId = callIdOf({ start: String(call.start), areaCode: String(call.areaCode ?? "") })
  if ((await listLeads()).some((l) => l.callId === callId)) return { error: "This call is already a lead." }

  const at = await callTime(String(call.start))
  const lead = await addLead(
    {
      name: String(input.name ?? "").trim().slice(0, 120) || `Caller from (${call.areaCode || "?"})`,
      phone: String(input.phone).trim().slice(0, 40),
      notes: [`Phone call from Google Ads, ${Math.max(1, Math.round(Number(call.seconds) / 60))} min.`, String(input.notes ?? "").trim().slice(0, 2000)].filter(Boolean).join("\n"),
      source: "Google Ads phone call",
      tracking: { utmSource: "google", utmMedium: "cpc", utmCampaign: String(call.campaign ?? "") || undefined },
      callId,
    },
    Number.isNaN(at.getTime()) ? undefined : at.toISOString(),
  )
  await updateLead(lead.id, (l) => {
    l.callId = callId
  })
  if (input.status !== "new") await setLeadStatus(lead.id, input.status as LeadStatus)
  try {
    const active = await activeAccount()
    if (active) await sendPendingConversions(active.connection, active.account)
  } catch (error) {
    console.error("Couldn't send conversions to Google Ads:", error)
  }
  revalidatePath("/leads", "layout")
  return { ok: input.status === "new" ? "Added to your leads." : "Added to your leads and sent to Google Ads, matched by the phone number." }
}
