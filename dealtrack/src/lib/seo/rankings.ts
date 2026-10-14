// Competitors → SEO → Rankings: who's in Google's top 10 for each keyword in each city, from the
// searches DealTrack already makes. The weekly Competitor ads searches (which now keep the top 10)
// and Google rankings scans made with Google results (Bright Data or Serper). No extra searches.
// Also what else people search around them: "People also ask" and related searches.
import { readSamples } from "@/lib/competitors/ad-samples"
import { normalizeKeyword } from "@/lib/research/parse"
import { isDirectory } from "@/lib/research/serp-analysis"
import { OUR_SITES, getScanResults, getScans, type Scan } from "@/lib/research/serp"

export type Check = { at: string; dev: "desktop" | "mobile"; ours: number | null; top: string[]; pages: Record<string, string> }
export type Ranking = {
  k: string
  loc: string
  now: Check
  before?: Check // the check before, for movement
  checks: number
}

const ours = (d: string) => OUR_SITES.includes(d)

// Every check in the last `days` days, newest last: weekly searches and Google scans.
async function checks(days: number) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const out: (Check & { k: string; loc: string })[] = []
  const samples = await readSamples(days)
  // Bright Data scans are in the samples since they keep the top 10; older ones come from the scan.
  const firstKept = samples.find((s) => s.org?.length)?.at ?? "9999"
  for (const s of samples) {
    if (!s.org?.length) continue
    const top = [...s.org].sort((a, b) => a.p - b.p).slice(0, 10)
    out.push({
      k: s.k,
      loc: s.loc,
      at: s.at,
      dev: s.dev,
      ours: top.find((h) => ours(h.d))?.p ?? null,
      top: top.map((h) => h.d),
      pages: Object.fromEntries(top.map((h) => [h.d, h.u])),
    })
  }
  const google = (s: Scan) => s.engine === "serper" || (s.engine === "brightdata" && s.at < firstKept)
  for (const scan of (await getScans()).filter((s) => (s.kind ?? "web") === "web" && google(s) && s.at >= since)) {
    for (const r of (await getScanResults(scan.id))?.results ?? []) {
      if (r.err || !r.org.length) continue
      const top = [...r.org].sort((a, b) => a.p - b.p).slice(0, 10)
      out.push({
        k: r.k,
        loc: r.loc,
        at: r.at,
        dev: "desktop",
        ours: top.find((h) => ours(h.d))?.p ?? null,
        top: top.map((h) => h.d),
        pages: Object.fromEntries(top.map((h) => [h.d, h.u])),
      })
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

export const rankKey = (loc: string, k: string) => `${loc.toLowerCase()}|${normalizeKeyword(k)}`

// The newest check of each keyword in each place (a computer's, when there is one), with the one before.
export async function latestRankings(days = 42): Promise<Ranking[]> {
  const by = new Map<string, (Check & { k: string; loc: string })[]>()
  for (const c of await checks(days)) by.set(rankKey(c.loc, c.k), [...(by.get(rankKey(c.loc, c.k)) ?? []), c])
  const rows: Ranking[] = []
  for (const list of by.values()) {
    const desktop = list.filter((c) => c.dev === "desktop")
    const use = desktop.length ? desktop : list
    const now = use.at(-1)!
    // The one before is at least a day older, so two searches the same day don't count as a move.
    const before = [...use].reverse().find((c) => Date.parse(now.at) - Date.parse(c.at) > 86_400_000)
    rows.push({ k: now.k, loc: now.loc, now, before, checks: list.length })
  }
  return rows.sort((a, b) => a.k.localeCompare(b.k) || a.loc.localeCompare(b.loc))
}

export type Mover = { site: string; results: number; top3: number; firsts: number; directory: boolean; ours: boolean }

// Who's in the top 10 most, across the newest checks: listing sites marked, so they can be hidden.
export function topSites(rows: Ranking[]): Mover[] {
  const by = new Map<string, Mover>()
  for (const r of rows)
    r.now.top.forEach((site, i) => {
      const m = by.get(site) ?? { site, results: 0, top3: 0, firsts: 0, directory: isDirectory(site), ours: ours(site) }
      m.results++
      if (i < 3) m.top3++
      if (i === 0) m.firsts++
      by.set(site, m)
    })
  return [...by.values()].sort((a, b) => b.results - a.results || b.top3 - a.top3)
}

export type Idea = { text: string; kind: "question" | "related"; seen: number; keywords: string[]; places: string[] }

// "People also ask" and related searches from the searches made, most seen first. `known` leaves out
// what's already in the keyword list.
export async function searchIdeas(days: number, known: Set<string>): Promise<Idea[]> {
  const by = new Map<string, Idea>()
  const add = (text: string, kind: Idea["kind"], k: string, loc: string) => {
    const t = text.trim()
    const key = normalizeKeyword(t)
    if (!key || known.has(key)) return
    const idea = by.get(key) ?? { text: t, kind, seen: 0, keywords: [], places: [] }
    idea.seen++
    if (!idea.keywords.includes(k)) idea.keywords.push(k)
    if (!idea.places.includes(loc)) idea.places.push(loc)
    by.set(key, idea)
  }
  for (const s of await readSamples(days)) {
    for (const q of s.paa ?? []) add(q, "question", s.k, s.loc)
    for (const r of s.rel ?? []) add(r, "related", s.k, s.loc)
  }
  return [...by.values()].sort((a, b) => b.seen - a.seen || a.text.localeCompare(b.text))
}
