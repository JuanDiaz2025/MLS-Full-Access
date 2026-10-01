"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

// Reloads the page's data every few seconds while it's open, so new website leads show up on
// their own. Pauses while the tab is in the background.
export default function LiveRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter()
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh()
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
