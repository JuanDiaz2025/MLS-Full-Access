"use server"

// "Refresh now": forgets the cached Google Ads reports so the page asks Google again.
// PageSpeed results are kept (each test takes 10-30 seconds).

import { refresh } from "next/cache"

import { isSignedIn } from "@/lib/auth"
import { clearReportCache } from "@/lib/google-ads/client"

export async function refreshReports(): Promise<void> {
  if (!(await isSignedIn())) return
  clearReportCache()
  refresh()
}
