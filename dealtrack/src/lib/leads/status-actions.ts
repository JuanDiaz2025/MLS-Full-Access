"use server"

import { revalidatePath } from "next/cache"
import { after } from "next/server"

import { isSignedIn } from "@/lib/auth"
import { activeAccount } from "@/lib/conversions/google"
import { sendPendingConversions, setLeadStatus } from "@/lib/conversions/offline-conversions"
import { leadStatuses, type LeadStatus } from "@/lib/leads/types"
import { shareStatuses } from "@/lib/leads/wordpress"
import { personName } from "@/lib/people"

// Sets a lead's status from the Leads table, and sends Google Ads the conversion it means.
export async function setLeadStatusAction(id: string, status: string): Promise<{ error?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  if (!leadStatuses.some((s) => s.id === status)) return { error: "Unknown status." }
  const lead = await setLeadStatus(id, status as LeadStatus, await personName())
  if (!lead) return { error: "That lead is gone." }
  // The team's other computers pick it up at their next website check (team-sync.ts).
  after(() => shareStatuses())
  try {
    const active = await activeAccount()
    if (active) await sendPendingConversions(active.connection, active.account)
  } catch (error) {
    console.error("Couldn't send conversions to Google Ads:", error)
  }
  revalidatePath("/leads", "layout")
  return {}
}
