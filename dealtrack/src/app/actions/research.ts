"use server"

// Competitors → Keyword explorer: adding keywords (from a file read in the browser, by hand, or
// from Google suggestions), getting their volumes, and removing them. Anyone signed in.

import { refresh } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { addKeywords, fetchVolumes, removeKeywords, suggestKeywords, type KeywordSource } from "@/lib/research/keywords"
import type { ParsedFile } from "@/lib/research/parse"

export type ResearchState = { ok?: boolean; message?: string; lines?: string[] }

const KINDS: Record<ParsedFile["kind"], { source: KeywordSource; what: string }> = {
  "ads-report": { source: "ads-report", what: "Google Ads keyword report (keywords only)" },
  planner: { source: "planner", what: "Keyword Planner export" },
  list: { source: "upload", what: "Keyword list" },
}

export async function importKeywordsAction(file: ParsedFile & { name: string }): Promise<ResearchState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const kind = KINDS[file.kind] ?? KINDS.list
  const rows = (Array.isArray(file.rows) ? file.rows : []).slice(0, 20_000).map((r) => ({
    text: String(r.text ?? ""),
    // Search volume and bids only come from a Keyword Planner export; a report's own numbers are never kept.
    ...(file.kind === "planner"
      ? {
          volume: typeof r.volume === "number" ? r.volume : undefined,
          cpcLow: typeof r.cpcLow === "number" ? r.cpcLow : undefined,
          cpcHigh: typeof r.cpcHigh === "number" ? r.cpcHigh : undefined,
          competition: typeof r.competition === "string" ? r.competition.slice(0, 20) : undefined,
          trend: Array.isArray(r.trend) ? r.trend.filter((n) => typeof n === "number").slice(0, 48) : undefined,
        }
      : {}),
  }))
  if (!rows.length) return { ok: false, message: "No keywords found in that file. It needs a “Keyword” column, or one keyword per line." }
  const location = file.kind === "planner" && typeof file.location === "string" ? file.location.slice(0, 120) : undefined
  const cities = Object.keys(file.kind === "planner" && file.placeTotals && typeof file.placeTotals === "object" ? file.placeTotals : {}).filter(
    (p) => p.toLowerCase() !== "california",
  ).length
  const { added, updated } = await addKeywords(
    rows,
    kind.source,
    `${kind.what}${location ? ` (${location})` : ""}: ${String(file.name).slice(0, 80)}`,
    location,
    file.kind === "planner" && file.placeTotals && typeof file.placeTotals === "object"
      ? Object.fromEntries(
          Object.entries(file.placeTotals)
            .slice(0, 500)
            .map(([k, v]) => [String(k).slice(0, 80), Number(v) || 0]),
        )
      : undefined,
  )
  refresh()
  return {
    ok: true,
    message:
      file.kind === "planner"
        ? `Keyword Planner file${location ? ` for ${location}` : ""}: volumes for ${(added + updated).toLocaleString("en-US")} keywords (${added.toLocaleString("en-US")} new).${
            location && location.toLowerCase() !== "california" ? ` Pick “${location}” under “Volumes for” to see them.` : ""
          }${
            cities > 1
              ? ` Google adds the cities together per keyword, but gives each city's total, so ${cities} cities now have estimated volumes (marked “est.” under “Volumes for”).`
              : ""
          }`
        : `${rows.length.toLocaleString("en-US")} keywords read, ${added.toLocaleString("en-US")} new.${file.kind === "ads-report" ? " Only the keywords were kept, not the report's numbers." : ""}`,
  }
}

export async function addKeywordsAction(_prev: ResearchState, form: FormData): Promise<ResearchState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const rows = String(form.get("keywords") ?? "")
    .split(/[\n,]/)
    .map((text) => ({ text }))
  const { added } = await addKeywords(rows, "manual", "Added by hand")
  refresh()
  return { ok: true, message: added ? `${added} keyword${added === 1 ? "" : "s"} added.` : "Those are already on the list." }
}

export async function suggestAction(_prev: ResearchState, form: FormData): Promise<ResearchState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const res = await suggestKeywords(String(form.get("seed") ?? ""))
  refresh()
  return res
}

export async function volumesAction(): Promise<ResearchState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const res = await fetchVolumes()
  refresh()
  return res
}

export async function removeKeywordsAction(texts: string[]): Promise<ResearchState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const removed = await removeKeywords(texts.slice(0, 20_000).map(String))
  refresh()
  return { ok: true, message: `${removed} removed.` }
}
