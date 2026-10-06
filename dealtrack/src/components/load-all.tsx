"use client"

// "Load all pages" in the header: opens every page and tab behind the scenes, a few at a time,
// so each one's Google Ads reports are fetched and kept (10 minutes fresh, shown instantly for 6
// hours). Each page loads with its default date range. Keep this tab open until it says done.

import { useState } from "react"
import { CircleCheck, Download, LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"

const AT_ONCE = 3

export default function LoadAll({ pages }: { pages: string[] }) {
  const [state, setState] = useState<{ running: boolean; done: number; failed: string[]; at?: string; seconds?: number }>({
    running: false,
    done: 0,
    failed: [],
  })

  async function run() {
    const started = Date.now()
    setState({ running: true, done: 0, failed: [] })
    const failed: string[] = []
    let next = 0
    let done = 0
    const worker = async () => {
      while (next < pages.length) {
        const url = pages[next++]
        try {
          // The whole page, streamed to the end: every report on it has been fetched once it finishes.
          const res = await fetch(url, { cache: "no-store", credentials: "same-origin" })
          await res.text()
          if (!res.ok) failed.push(url)
        } catch {
          failed.push(url)
        }
        done++
        setState((s) => ({ ...s, done }))
      }
    }
    await Promise.all(Array.from({ length: AT_ONCE }, worker))
    setState({
      running: false,
      done,
      failed,
      at: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
      seconds: Math.round((Date.now() - started) / 1000),
    })
  }

  const finished = !state.running && state.at
  return (
    <button
      type="button"
      onClick={run}
      disabled={state.running}
      title={
        state.running
          ? "Opening every page in the background. Keep this tab open."
          : finished
            ? `Loaded ${state.done - state.failed.length} of ${pages.length} pages at ${state.at} (${state.seconds}s)${state.failed.length ? `; couldn't load: ${state.failed.join(", ")}` : ""}. Click to load again.`
            : `Open all ${pages.length} pages and tabs in the background so each one is ready when you click it. Takes about a minute and around 100 Google Ads API operations.`
      }
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-wait",
        finished && !state.failed.length && "text-emerald-700",
        finished && state.failed.length > 0 && "text-amber-700",
      )}
    >
      {state.running ? (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
      ) : finished ? (
        <CircleCheck className="size-3.5" aria-hidden />
      ) : (
        <Download className="size-3.5" aria-hidden />
      )}
      <span className="tabular-nums">
        {state.running
          ? `Loading ${state.done} / ${pages.length}`
          : finished
            ? state.failed.length
              ? `Loaded (${state.failed.length} failed)`
              : "All pages loaded"
            : "Load all pages"}
      </span>
    </button>
  )
}
