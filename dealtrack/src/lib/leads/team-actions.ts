"use server"

// Joining a teammate's team (the team code from their Leads page, DealTrack's or One Marketing
// Command Center's) and moving the sending to Google Ads to this computer (team-sync.ts).

import { revalidatePath } from "next/cache"

import { isAdmin } from "@/lib/auth"
import { activeAccount } from "@/lib/conversions/google"
import { computerName, installId, newInstallId, readTeamCode } from "@/lib/leads/team-sync"
import { setWebhookSecret, webhookSecret } from "@/lib/leads/webhook"
import { bareHost, claimSender, getWordPress, normalizeSite, setWordPressSite, siteKeyProblem, syncWordPress } from "@/lib/leads/wordpress"

export type TeamFormState = { error?: string; joined?: string } | undefined

// The team code connects this copy to the same website with the same key, so it gets the same
// leads and everyone's statuses. Nothing changes here unless the website takes the code's key.
export async function joinTeamAction(_: TeamFormState, formData: FormData): Promise<TeamFormState> {
  if (!(await isAdmin())) return { error: "Only admins can join a team. Sign in as an admin." }
  const team = readTeamCode(String(formData.get("code") ?? ""))
  const site = team && normalizeSite(team.site)
  if (!team || !site) return { error: "That isn't a team code. Copy it again from your teammate's Leads page (Website leads → Your team)." }
  const before = await getWordPress()
  if (team.key === (await webhookSecret()) && before.site && bareHost(before.site) === bareHost(site)) {
    return { error: "This computer is already on that team: it's this computer's own team code. Send it to your teammate instead." }
  }
  const wrong = await siteKeyProblem(site, team.key)
  if (wrong) return { error: wrong }
  try {
    await setWebhookSecret(team.key)
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  // A new member of the team. If this computer was the one sending to Google Ads, it still is.
  const oldId = await installId()
  await newInstallId()
  await setWordPressSite(site)
  await syncWordPress(true)
  if ((await getWordPress()).sender?.id === oldId) await claimSender(computerName(), true).catch(() => null)
  revalidatePath("/leads", "layout")
  const state = await getWordPress()
  return state.lastError ? { error: state.lastError } : { joined: site.replace(/^https?:\/\//, "") }
}

// "Send to Google Ads from this computer": moves that job here.
export async function takeSenderAction(): Promise<{ error?: string }> {
  if (!(await isAdmin())) return { error: "Only admins can change this. Sign in as an admin." }
  let active
  try {
    active = await activeAccount()
  } catch (e) {
    return { error: `Couldn't reach Google Ads from this computer: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!active) return { error: "Google Ads isn't connected on this computer, so it can't send to it." }
  const sender = await claimSender(computerName(), true).catch(() => null)
  if (!sender) return { error: "Couldn't reach your website. Try again in a moment." }
  revalidatePath("/leads", "layout")
  return {}
}
