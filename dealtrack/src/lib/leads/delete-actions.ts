"use server"

import { revalidatePath } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { deleteLead, restoreLead } from "@/lib/leads/store"

// Deletes a lead from the Not interested list: it moves to the Deleted list, where Restore puts it
// back exactly as it was. Nothing is sent to Google Ads either way.
export async function deleteLeadAction(id: string): Promise<{ error?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  const res = await deleteLead(String(id))
  revalidatePath("/leads", "layout")
  return res
}

export async function restoreLeadAction(id: string): Promise<{ error?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  const res = await restoreLead(String(id))
  revalidatePath("/leads", "layout")
  return res
}
