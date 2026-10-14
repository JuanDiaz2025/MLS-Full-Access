// Competitors → Competitor ads and SEO: every Bright Data search is kept as a sample, with the ads
// it showed (none is a result too: searches without ads are what the shares are out of), the top 10
// results, and "People also ask" and related searches. One line per search in
// .data/ads/<year-month>.jsonl, from the weekly sampling and from Google rankings scans.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"

import type { Device, GoogleResult, SeenAd } from "@/lib/competitors/brightdata"
import { siteOf } from "@/lib/research/site"
import { DATA_DIR } from "@/lib/store"

// at: when (UTC); k: keyword; loc: the place it was searched from; dev: computer or phone;
// src: the weekly sampling or a Google rankings scan; org: the top 10 (site, position, address);
// paa: "People also ask"; rel: related searches; ai/maps: Google also showed an AI Overview or the
// Google Maps box (both leave less room for ads). Samples saved before DealTrack kept the top 10
// (October 2026) have no org, paa or rel.
export type OrganicHit = { d: string; p: number; u: string }
export type AdSample = {
  at: string
  k: string
  loc: string
  dev: Device
  src: "sampler" | "scan"
  ads: SeenAd[]
  org?: OrganicHit[]
  paa?: string[]
  rel?: string[]
  ai?: boolean
  maps?: boolean
}

// A sample from one Bright Data search.
export function sampleOf(found: GoogleResult, k: string, loc: string, dev: Device, src: AdSample["src"]): AdSample {
  const org = found.organic.map((r) => ({ d: siteOf(r.u), p: r.p, u: r.u.slice(0, 200) })).filter((r) => r.d)
  return {
    at: new Date().toISOString(),
    k,
    loc,
    dev,
    src,
    ads: found.ads,
    ...(org.length ? { org } : {}),
    ...(found.questions.length ? { paa: found.questions } : {}),
    ...(found.related.length ? { rel: found.related } : {}),
    ...(found.aiOverview ? { ai: true } : {}),
    ...(found.mapPack ? { maps: true } : {}),
  }
}

const dir = path.join(DATA_DIR, "ads")
const monthFile = (iso: string) => path.join(dir, `${iso.slice(0, 7)}.jsonl`)

export async function saveSample(sample: AdSample) {
  try {
    await mkdir(dir, { recursive: true })
    await appendFile(monthFile(sample.at), `${JSON.stringify(sample)}\n`)
  } catch {
    // No disk to write to (online hosting): the search still counts, it just isn't kept.
  }
}

// The samples from the last `days` days, oldest first.
export async function readSamples(days: number): Promise<AdSample[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const months: string[] = []
  for (let d = new Date(`${since.slice(0, 7)}-01T00:00:00Z`); d.getTime() <= Date.now(); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString())
  const out: AdSample[] = []
  for (const m of months) {
    const lines = await readFile(monthFile(m), "utf8").catch(() => "")
    for (const line of lines.split("\n")) {
      if (!line.trim()) continue
      try {
        const s = JSON.parse(line) as AdSample
        if (s.at >= since && Array.isArray(s.ads)) out.push(s)
      } catch {
        // A line cut short (the app closed mid-write) is skipped.
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}
