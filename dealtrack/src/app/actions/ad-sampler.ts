"use server"

// Competitors → Competitor ads: the weekly sampling's settings, and one test search. They use
// Bright Data's free searches, so only admins can change them.

import { refresh } from "next/cache"

import { isAdmin } from "@/lib/auth"
import { sampleOf, saveSample } from "@/lib/competitors/ad-samples"
import { MAX_PER_WEEK, getSampler, saveSampler, type SamplerSettings } from "@/lib/competitors/ad-sampler"
import { BrightDataError, brightReady, ranFrom, searchGoogle } from "@/lib/competitors/brightdata"
import { currentName } from "@/lib/people"
import { scanPlaces } from "@/lib/research/serp"

export type SamplerState = { ok: boolean; message: string }

const clean = (k: unknown) => String(k ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80)

export async function saveSamplerAction(input: Partial<SamplerSettings>): Promise<SamplerState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can change the sampling (it uses the free searches)." }
  const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : []).map(clean).filter(Boolean))].slice(0, 60)
  const allowed = new Set((await scanPlaces()).all)
  const places =
    input.places === "targeted" || !Array.isArray(input.places)
      ? ("targeted" as const)
      : [...new Set(input.places.map(String).filter((p) => allowed.has(p)))].slice(0, 80)
  const perWeek = Math.max(0, Math.min(MAX_PER_WEEK, Math.round(Number(input.perWeek) || 0)))
  const mobile = Math.max(0, Math.min(1, Number(input.mobile) || 0))
  const on = Boolean(input.on)
  if (on && !brightReady()) return { ok: false, message: "Add BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE to .env.local first, then restart the app." }
  if (on && !keywords.length) return { ok: false, message: "Add at least one keyword." }
  if (on && Array.isArray(places) && !places.length) return { ok: false, message: "Pick at least one city." }
  if (on && !perWeek) return { ok: false, message: "Set how many searches a week." }
  await saveSampler({ on, keywords, places, perWeek, mobile, by: (await currentName()) || "Someone", at: new Date().toISOString() })
  refresh()
  return { ok: true, message: on ? "Saved. The sampling runs while the app is open." : "Saved. The sampling is off." }
}

// One search from the first city, to check the setup. Kept as a sample like any other.
export async function testSearchAction(): Promise<SamplerState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can run a test search." }
  if (!brightReady()) return { ok: false, message: "Add BRIGHTDATA_API_KEY and BRIGHTDATA_SERP_ZONE to .env.local first, then restart the app." }
  const { settings, places } = await getSampler()
  const k = settings.keywords[0] ?? "sell my house fast"
  const loc = places[0] ?? "California"
  try {
    const found = await searchGoogle(k, loc, "desktop", "test")
    await saveSample(sampleOf(found, k, loc, "desktop", "scan"))
    refresh()
    const who = [...new Set(found.ads.map((a) => a.d))]
    // Where Google says it ran the search, so a wrong place shows.
    const where = !found.where
      ? ""
      : ranFrom(loc, found.where) === false
        ? ` But Google ran it from ${found.where}, not ${loc}, so its results and ads are for there.`
        : ` Google ran it from ${found.where}.`
    return {
      ok: true,
      message: `It works: “${k}” from ${loc} gave ${found.organic.length} results and ${found.ads.length} ad${found.ads.length === 1 ? "" : "s"}${who.length ? ` (${who.slice(0, 4).join(", ")})` : ""}.${where}${found.ads.length ? "" : " Searches without ads are normal and count too."}`,
    }
  } catch (e) {
    return { ok: false, message: e instanceof BrightDataError ? e.message : `The test search failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
