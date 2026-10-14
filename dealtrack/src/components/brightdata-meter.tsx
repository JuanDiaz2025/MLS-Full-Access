"use client"

// "Bright Data 4,790 left" in the header: how many of Bright Data's free Google searches are left
// (DealTrack stops itself at 4,800 in any 32 days, under the free 5,000 a month). Refreshes every
// minute and on every page change. Click it for what used them. Not shown on a computer without
// Bright Data's keys.

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { ExternalLink, Search } from "lucide-react"

import type { FreeSearches, SearchUse } from "@/lib/competitors/free-searches"
import { cn } from "@/lib/utils"

type View = ({ ready: true } & FreeSearches) | { ready: false }

const USES: [SearchUse | "other", string][] = [
  ["sampler", "Weekly Competitor ads searches"],
  ["scan", "Google rankings scans"],
  ["trends", "Google Trends checks (SEO)"],
  ["test", "Test searches"],
  ["other", "Earlier (not split by use)"],
]

const fmt = (n: number) => n.toLocaleString("en-US")
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const monthOf = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })

export default function BrightDataMeter() {
  const pathname = usePathname()
  const [view, setView] = useState<View | null>(null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      fetch("/api/brightdata-usage", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((v: View | null) => alive && v && typeof v.ready === "boolean" && setView(v))
        .catch(() => undefined)
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [pathname])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", esc)
    }
  }, [open])

  if (!view?.ready) return null
  const share = view.cap ? Math.min(1, view.used / view.cap) : 1
  const leftShare = 1 - share
  const tone = view.left <= 0 || leftShare <= 0.05 ? "red" : leftShare <= 0.25 ? "amber" : "green"
  const bar = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500" }[tone]
  const text = { green: "text-muted-foreground", amber: "text-amber-700", red: "text-red-700" }[tone]
  const today = view.daily.at(-1)?.day ?? ""
  const peak = Math.max(1, ...view.daily.map((d) => d.n))
  const uses = USES.filter(([u]) => view.byUse[u] > 0)

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Bright Data free searches left"
        className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-xs whitespace-nowrap hover:bg-muted", text)}
      >
        <Search className="size-3.5" aria-hidden />
        <span className="tabular-nums">Bright Data {fmt(view.left)} left</span>
        <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-muted lg:block" aria-hidden>
          <span className={cn("block h-full rounded-full", bar)} style={{ width: `${Math.max(2, share * 100)}%` }} />
        </span>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 flex w-80 flex-col gap-3 rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg">
          <div className="flex flex-col gap-0.5">
            <p className="font-semibold">Bright Data free searches</p>
            <p className={cn("text-2xl font-semibold tabular-nums", tone === "green" ? "text-foreground" : text)}>
              {fmt(view.left)} <span className="text-sm font-normal text-muted-foreground">left of {fmt(view.cap)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {fmt(view.used)} used in the last 32 days: {fmt(view.today)} today, {fmt(view.week)} in the last 7 days, {fmt(view.month)} in {today ? monthOf(today) : "this month"}.
            </p>
            {view.failed > 0 && (
              <p className="text-xs text-muted-foreground">
                {fmt(view.failed)} more got an error from Bright Data instead of results: Bright Data doesn&apos;t count those, so DealTrack gave them back.
              </p>
            )}
            {view.moreOn ? (
              <p className="text-xs font-medium text-red-700">All used: DealTrack makes no more until {day(view.moreOn)}, so nothing can be charged.</p>
            ) : view.nextFree ? (
              <p className="text-xs text-muted-foreground">
                The oldest {fmt(view.nextFree.n)} free up on {day(view.nextFree.day)}.
              </p>
            ) : null}
          </div>
          {view.used > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">Each day, the last 32</p>
              <div className="flex h-12 items-end gap-px" role="img" aria-label="Searches each day, the last 32 days">
                {view.daily.map((d) => (
                  <span
                    key={d.day}
                    title={`${day(d.day)}: ${fmt(d.n)}`}
                    className={cn("flex-1 rounded-sm", d.n ? bar : "bg-muted")}
                    style={{ height: `${Math.max(4, (d.n / peak) * 100)}%` }}
                  />
                ))}
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>{view.daily[0] ? day(view.daily[0].day) : ""}</span>
                <span>today</span>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">What used them (32 days)</p>
            {uses.length ? (
              <ul className="flex flex-col gap-0.5 text-xs">
                {uses.map(([u, label]) => (
                  <li key={u} className="flex justify-between gap-3">
                    <span>{label}</span>
                    <span className="tabular-nums">{fmt(view.byUse[u])}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">None yet.</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Bright Data&apos;s free tier is 5,000 searches a month. DealTrack stops itself at {fmt(view.cap)} in any 32 days, so no Bright Data month can go over,
            whenever it starts. This is this computer&apos;s count: searches made with the same key elsewhere (another computer, Bright Data&apos;s playground)
            aren&apos;t in it.{" "}
            <a href="https://brightdata.com/cp" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
              Bright Data&apos;s own count <ExternalLink className="size-3" />
            </a>
          </p>
        </div>
      )}
    </div>
  )
}
