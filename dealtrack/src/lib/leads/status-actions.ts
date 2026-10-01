"use server"

import { revalidatePath } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { activeAccount } from "@/lib/conversions/google"
import { sendPendingConversions, setLeadStatus } from "@/lib/conversions/offline-conversions"
import { leadStatuses, type LeadStatus } from "@/lib/leads/types"

// Sets a lead's status from the Leads table, and sends Google Ads the conversion it means.
export async function setLeadStatusAction(id: string, status: string): Promise<{ error?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  if (!leadStatuses.some((s) => s.id === status)) return { error: "Unknown status." }
  const lead = await setLeadStatus(id, status as LeadStatus)
  if (!lead) return { error: "That lead is gone." }
  try {
    const active = await activeAccount()
    if (active) await sendPendingConversions(active.connection, active.account)
  } catch (error) {
    console.error("Couldn't send conversions to Google Ads:", error)
  }
  revalidatePath("/leads", "layout")
  return {}
}
