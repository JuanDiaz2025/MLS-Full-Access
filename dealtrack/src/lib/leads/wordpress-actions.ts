"use server"

import { revalidatePath } from "next/cache"

import { isAdmin } from "@/lib/auth"
import { getWordPress, normalizeSite, setWordPressSite, syncWordPress } from "@/lib/leads/wordpress"

export type WordPressFormState = { error?: string; connected?: boolean; disconnected?: boolean } | undefined

// Saves the website's address from the Leads page and checks the Lead Saver plugin answers.
export async function connectWordPressAction(_: WordPressFormState, formData: FormData): Promise<WordPressFormState> {
  if (!(await isAdmin())) return { error: "Only admins can connect the website. Sign in as an admin." }
  if (formData.get("disconnect")) {
    await setWordPressSite(null)
    revalidatePath("/leads", "layout")
    return { disconnected: true }
  }
  const site = normalizeSite(String(formData.get("site") ?? ""))
  if (!site) return { error: "Type your website's address, e.g. twinhomebuyer.com" }
  await setWordPressSite(site)
  await syncWordPress(true)
  revalidatePath("/leads", "layout")
  const state = await getWordPress()
  return state.lastError ? { error: state.lastError } : { connected: true }
}
