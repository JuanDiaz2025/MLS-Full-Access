"use client"

// A thin bar across the top of the window that starts the moment you click a link, change the
// date range, or pick a filter, and finishes when the new page is on screen. It covers the
// moments where the old page stays up while the new numbers load (e.g. a new date range).

import { useEffect, useRef, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"

export const NAVIGATE_EVENT = "dealtrack:navigate"

export default function NavProgress() {
  const route = `${usePathname()}?${useSearchParams().toString()}`
  const routeRef = useRef(route)
  // Set when a navigation starts: the page it started from.
  const [from, setFrom] = useState<string | null>(null)
  const arrived = from !== null && from !== route

  useEffect(() => {
    routeRef.current = route
  }, [route])

  // The new page is on screen: let the bar fill and fade, then reset. If a navigation never
  // lands (cancelled, or an error), give up after 30 seconds.
  useEffect(() => {
    if (from === null) return
    const t = setTimeout(() => setFrom(null), arrived ? 450 : 30_000)
    return () => clearTimeout(t)
  }, [from, arrived])

  useEffect(() => {
    const start = () => setFrom(routeRef.current)
    // Capture phase: Next's <Link> cancels the click to navigate in place, so listen before it does.
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.("a")
      if (!a || !a.href || (a.target && a.target !== "_self") || a.hasAttribute("download")) return
      const url = new URL(a.href, location.href)
      if (url.origin !== location.origin) return
      if (url.pathname === location.pathname && url.search === location.search) return
      start()
    }
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement
      if (!e.defaultPrevented && (form.getAttribute("method") ?? "get").toLowerCase() === "get") start()
    }
    document.addEventListener("click", onClick, true)
    document.addEventListener("submit", onSubmit)
    window.addEventListener(NAVIGATE_EVENT, start)
    return () => {
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("submit", onSubmit)
      window.removeEventListener(NAVIGATE_EVENT, start)
    }
  }, [])

  const style =
    from === null
      ? { width: "0%", opacity: 0, transition: "none" }
      : arrived
        ? { width: "100%", opacity: 0, transition: "width .2s ease-out, opacity .3s ease .15s" }
        : { width: "85%", opacity: 1, transition: "width 10s cubic-bezier(.08,.7,.2,1), opacity .1s" }

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[3px] print:hidden">
      <div className="h-full rounded-r-full bg-primary shadow-[0_0_8px_var(--primary)]" style={style} />
    </div>
  )
}
