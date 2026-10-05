"use server"

// Competitors → Competitor sites: asking Keyword Planner about a competitor's website, removing a
// saved one, and adding chosen keywords to the Keyword explorer. Anyone signed in.

import { refresh } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { currentName } from "@/lib/people"
import { getCityVolumes } from "@/lib/research/city-volumes"
import { analyzeSite, deleteSiteReport, getSiteReports } from "@/lib/research/competitor-sites"
import { CALIFORNIA, STATEWIDE_VOLUMES, addKeywords } from "@/lib/research/keywords"

export type SiteResult = { ok: boolean; message: string; id?: string }

export async function analyzeSiteAction(site: string, placeName: string): Promise<SiteResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  let place = { name: STATEWIDE_VOLUMES, geo: CALIFORNIA }
  if (placeName && placeName !== STATEWIDE_VOLUMES) {
    const saved = (await getCityVolumes()).places[placeName]
    if (!saved) return { ok: false, message: "Unknown place. Reload the page." }
    place = { name: placeName, geo: saved.geo }
  }
  const res = await analyzeSite(String(site).slice(0, 200), place, (await currentName()) || "Someone")
  refresh()
  return res
}

export async function deleteSiteAction(id: string): Promise<SiteResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  await deleteSiteReport(String(id))
  refresh()
  return { ok: true, message: "Removed." }
}

// The chosen keywords go into the Keyword explorer, with this report's searches and bids as
// California's or that city's volumes.
export async function addSiteIdeasAction(id: string, texts: string[]): Promise<SiteResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const report = (await getSiteReports()).find((r) => r.id === id)
  if (!report) return { ok: false, message: "That report isn't there any more. Reload the page." }
  const want = new Set(texts.slice(0, 5000).map(String))
  const rows = report.ideas
    .filter((i) => want.has(i.text))
    .map((i) => ({ text: i.text, volume: i.volume, cpcLow: i.cpcLow, cpcHigh: i.cpcHigh, competition: i.competition }))
  if (!rows.length) return { ok: false, message: "Pick keywords first." }
  const { added } = await addKeywords(rows, "planner", `Keyword Planner, ${report.site}'s keywords (${report.place})`, report.place)
  refresh()
  return {
    ok: true,
    message: `${added.toLocaleString("en-US")} new keywords added to the Keyword explorer (${rows.length - added} were already there).`,
  }
}
