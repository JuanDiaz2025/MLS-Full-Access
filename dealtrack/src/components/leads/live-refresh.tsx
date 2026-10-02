"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"

// Keeps the Leads page current: every few seconds it asks the app whether anything changed (a new
// website lead, a status, a Google Ads result) and reloads the page's data only then. Pauses
// while the tab is in the background.
export default function LiveRefresh({ version, seconds = 10 }: { version: string; seconds?: number }) {
  const router = useRouter()
  const shown = useRef(version)
  const lastRefresh = useRef(0)
  useEffect(() => {
    shown.current = version
  }, [version])
  useEffect(() => {
    lastRefresh.current = Date.now()
    let busy = false
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return
      busy = true
      try {
        const res = await fetch("/api/leads/changes", { cache: "no-store" })
        const { version: now } = (await res.json()) as { version?: string }
        // Also once a minute regardless, for what isn't saved in the app (calls from Google Ads).
        if ((now && now !== shown.current) || Date.now() - lastRefresh.current > 60_000) {
          if (now) shown.current = now
          lastRefresh.current = Date.now()
          router.refresh()
        }
      } catch {
        // Offline for a moment: try again next time.
      } finally {
        busy = false
      }
    }
    const timer = setInterval(tick, seconds * 1000)
    document.addEventListener("visibilitychange", tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [router, seconds])
  return null
}
