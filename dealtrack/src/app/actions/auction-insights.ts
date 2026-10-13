"use server"

// Competitors → Auction insights: saving a download read in the browser, and removing one. Anyone
// signed in.

import { refresh } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { deleteAuctionUpload, saveAuctionUpload } from "@/lib/competitors/auction-insights"
import type { AuctionReport } from "@/lib/competitors/auction-parse"
import { currentName } from "@/lib/people"

export type AuctionResult = { ok: boolean; message: string }

export async function saveAuctionAction(report: AuctionReport, fileName: string): Promise<AuctionResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const saved = await saveAuctionUpload(report, String(fileName ?? ""), (await currentName()) || "Someone")
  if (!saved) return { ok: false, message: "That download had no advertisers in it." }
  refresh()
  const others = saved.rows.filter((r) => !r.you).length
  return { ok: true, message: `Saved: ${others} competitor row${others === 1 ? "" : "s"}${saved.range ? ` for ${saved.range}` : ""}.` }
}

export async function deleteAuctionAction(id: string): Promise<AuctionResult> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  await deleteAuctionUpload(String(id))
  refresh()
  return { ok: true, message: "Removed." }
}
