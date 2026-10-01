"use server"

import { revalidatePath } from "next/cache"

import { isAdmin } from "@/lib/auth"
import { setAutoStatus } from "@/lib/leads/scoring"

// Turns automatic status from the lead score on or off (Leads page).
export async function setAutoStatusAction(on: boolean): Promise<{ error?: string }> {
  if (!(await isAdmin())) return { error: "Only admins can change this. Sign in as an admin." }
  await setAutoStatus(on)
  revalidatePath("/leads", "layout")
  return {}
}
