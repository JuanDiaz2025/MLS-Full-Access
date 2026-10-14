"use server"

// Competitors → SEO: the page's buttons. Search Console's property, Google Trends checks (Bright
// Data's free searches, so admins only), adding keyword ideas to the Keyword explorer, and the
// Competitor watch: the list and its settings (admins), "Check now", and Act / Watch / Ignore
// (anyone signed in, with their name).

import { refresh } from "next/cache"

import { isAdmin, isSignedIn } from "@/lib/auth"
import { brightReady } from "@/lib/competitors/brightdata"
import { personName } from "@/lib/people"
import { addKeywords, type KeywordSource } from "@/lib/research/keywords"
import { addCompetitor, getWatchList, removeCompetitor, updateCompetitor, type WatchedSite } from "@/lib/seo/competitors"
import { SearchConsoleError, listSites, searchConsoleReport, setSearchConsoleSite } from "@/lib/seo/search-console"
import { EVERY_CHOICES, PAGE_CHOICES, decideChanges, forgetSite, noteChange, requestCheck, saveWatchSettings, type ChangeStatus } from "@/lib/seo/site-watch"
import { TRENDS_PER_RUN, startTrendsCheck } from "@/lib/seo/trends"

export type SeoState = { ok: boolean; message: string }

const who = async () => (await personName()) || "Someone"
const ADMINS_ONLY = { ok: false, message: "Only admins can change this." }

// ---- Search Console -----------------------------------------------------------------------------

export async function pickSearchConsoleSiteAction(site: string): Promise<SeoState> {
  if (!(await isAdmin())) return ADMINS_ONLY
  try {
    const sites = await listSites()
    if (!sites.some((s) => s.site === site)) return { ok: false, message: "That property isn't one the connected Google account can read." }
    await setSearchConsoleSite(site, await who())
    refresh()
    return { ok: true, message: `Reading ${site}.` }
  } catch (e) {
    return { ok: false, message: e instanceof SearchConsoleError ? e.message : `Search Console: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function refreshSearchConsoleAction(days: number): Promise<SeoState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  try {
    await searchConsoleReport([7, 28, 90].includes(days) ? days : 28, true)
    refresh()
    return { ok: true, message: "Updated from Search Console." }
  } catch (e) {
    return { ok: false, message: e instanceof SearchConsoleError ? e.message : `Search Console: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ---- Keywords -----------------------------------------------------------------------------------

// Google Trends lines for the picked keywords, else the first ones without one: one free search
// each, in the background (10 at most, 1 after a check that got nothing back).
export async function checkTrendsAction(keywords: string[], picked = false): Promise<SeoState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can check Google Trends (it uses the free searches)." }
  if (!brightReady()) return { ok: false, message: "Add BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE to .env.local first, then restart the app." }
  const list = (Array.isArray(keywords) ? keywords : []).map((k) => String(k).slice(0, 80)).slice(0, TRENDS_PER_RUN * 5)
  if (!list.length) return { ok: false, message: "No keywords to check." }
  const result = await startTrendsCheck(list, Boolean(picked), await who())
  refresh()
  return result
}

const IDEA_SOURCES: Record<string, KeywordSource> = {
  "Search Console": "search-console",
  "People also ask": "google-results",
  "Related searches": "google-results",
  "Google Trends (rising)": "trends",
}

// New keyword ideas into the Keyword explorer, each with where it came from.
export async function addIdeasAction(ideas: { text: string; from: string }[]): Promise<SeoState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const by = new Map<KeywordSource, { text: string }[]>()
  for (const i of (Array.isArray(ideas) ? ideas : []).slice(0, 500)) {
    const source = IDEA_SOURCES[String(i?.from)]
    const text = String(i?.text ?? "").slice(0, 80)
    if (source && text) by.set(source, [...(by.get(source) ?? []), { text }])
  }
  if (!by.size) return { ok: false, message: "Pick at least one idea." }
  let added = 0
  for (const [source, rows] of by) {
    const r = await addKeywords(rows, source, `SEO ideas: ${rows.length} from ${source === "trends" ? "Google Trends" : source === "search-console" ? "Search Console" : "Google's results"}`)
    added += r.added
  }
  refresh()
  return { ok: true, message: `Added ${added} keyword${added === 1 ? "" : "s"} to the Keyword explorer. Get their searches there (Keyword Planner).` }
}

// ---- Competitor watch ---------------------------------------------------------------------------

const tierOf = (t: unknown): 1 | 2 | null => (t === 1 || t === "1" ? 1 : t === 2 || t === "2" ? 2 : null)

export async function addCompetitorAction(input: { url: string; name?: string; tier?: number | string | null; from?: string }): Promise<SeoState> {
  if (!(await isAdmin())) return ADMINS_ONLY
  const from: WatchedSite["from"] = input.from === "auction" || input.from === "ads" ? input.from : "manual"
  const result = await addCompetitor({ url: String(input.url ?? ""), name: input.name ? String(input.name) : undefined, tier: tierOf(input.tier), from }, await who())
  if (result.ok) refresh()
  return result
}

export async function updateCompetitorAction(site: string, patch: { name?: string; tier?: number | string | null; on?: boolean }): Promise<SeoState> {
  if (!(await isAdmin())) return ADMINS_ONLY
  if (!(await getWatchList()).some((s) => s.site === site)) return { ok: false, message: "That site isn't on the list." }
  await updateCompetitor(site, {
    ...(patch.name !== undefined ? { name: String(patch.name) } : {}),
    ...(patch.tier !== undefined ? { tier: tierOf(patch.tier) } : {}),
    ...(patch.on !== undefined ? { on: Boolean(patch.on) } : {}),
  })
  refresh()
  return { ok: true, message: "Saved." }
}

export async function removeCompetitorAction(site: string): Promise<SeoState> {
  if (!(await isAdmin())) return ADMINS_ONLY
  await removeCompetitor(site)
  await forgetSite(site)
  refresh()
  return { ok: true, message: `Removed ${site} and its history.` }
}

// One site, or every site on the list that's on, checked right away.
export async function checkNowAction(site?: string): Promise<SeoState> {
  if (!(await isAdmin())) return ADMINS_ONLY
  const list = await getWatchList()
  const sites = site ? list.filter((s) => s.site === site).map((s) => s.site) : list.filter((s) => s.on).map((s) => s.site)
  if (!sites.length) return { ok: false, message: site ? "That site isn't on the list." : "No sites to check." }
  await requestCheck(sites)
  refresh()
  return { ok: true, message: `Checking ${sites.length === 1 ? sites[0] : `${sites.length} sites`} now, one at a time, two seconds or more between pages. Refresh in a minute or two.` }
}

export async function saveWatchSettingsAction(input: { on?: boolean; every?: number; maxPages?: number }): Promise<SeoState> {
  if (!(await isAdmin())) return ADMINS_ONLY
  await saveWatchSettings(
    {
      ...(input.on !== undefined ? { on: Boolean(input.on) } : {}),
      ...(EVERY_CHOICES.includes(Number(input.every)) ? { every: Number(input.every) } : {}),
      ...(PAGE_CHOICES.includes(Number(input.maxPages)) ? { maxPages: Number(input.maxPages) } : {}),
    },
    await who(),
  )
  refresh()
  return { ok: true, message: "Saved." }
}

const STATUSES: ChangeStatus[] = ["new", "act", "watch", "ignore"]

export async function decideChangesAction(ids: string[], status: ChangeStatus, note?: string): Promise<SeoState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  if (!STATUSES.includes(status)) return { ok: false, message: "Pick Act, Watch or Ignore." }
  const list = (Array.isArray(ids) ? ids : []).map(String).slice(0, 500)
  const n = await decideChanges(list, status, await who(), note === undefined ? undefined : String(note))
  refresh()
  return { ok: n > 0, message: n ? `Marked ${n}.` : "Those changes are gone." }
}

export async function noteChangeAction(id: string, note: string): Promise<SeoState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const saved = await noteChange(String(id), String(note ?? ""))
  return { ok: saved, message: saved ? "Note saved." : "That change is gone." }
}
