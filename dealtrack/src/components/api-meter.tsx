"use client"

// "API 312 / 2,880" in the header: how much of today's Google Ads API allowance DealTrack has
// used. Refreshes every minute and on every page change. Click it for the details.

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { Gauge } from "lucide-react"

import { cn } from "@/lib/utils"

type Usage = { day: string; used: number; hours: number[]; limit: number; limitHit?: string }

const fmt = (n: number) => n.toLocaleString("en-US")

// When the Pacific day ends, in the viewer's own time.
function resetTime() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, Number(p.value)]),
  ) as { hour: number; minute: number; second: number }
  const left = ((24 - parts.hour) * 3600 - parts.minute * 60 - parts.second) * 1000
  const at = new Date(Date.now() + left)
  const hours = Math.floor(left / 3_600_000)
  const mins = Math.round((left % 3_600_000) / 60_000)
  return { at: at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), inText: hours ? `${hours}h ${mins}m` : `${mins}m` }
}

export default function ApiMeter() {
  const pathname = usePathname()
  const [usage, setUsage] = useState<Usage | null>(null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      fetch("/api/ads-usage", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((u: Usage | null) => alive && u && typeof u.used === "number" && setUsage(u))
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

  if (!usage) return null
  const share = Math.min(1, usage.used / usage.limit)
  const out = Boolean(usage.limitHit) || share >= 1
  const tone = out || share >= 0.9 ? "red" : share >= 0.7 ? "amber" : "green"
  const bar = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500" }[tone]
  const text = { green: "text-muted-foreground", amber: "text-amber-700", red: "text-red-700" }[tone]
  const reset = resetTime()
  const peak = Math.max(1, ...usage.hours)

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Google Ads API operations used today"
        className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted", text)}
      >
        <Gauge className="size-3.5" aria-hidden />
        <span className="tabular-nums">
          API {fmt(usage.used)} / {fmt(usage.limit)}
        </span>
        <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-muted sm:block" aria-hidden>
          <span className={cn("block h-full rounded-full", bar)} style={{ width: `${Math.max(2, share * 100)}%` }} />
        </span>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 flex w-80 flex-col gap-3 rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg">
          <div className="flex flex-col gap-0.5">
            <p className="font-semibold">Google Ads API used today</p>
            <p className={cn("text-2xl font-semibold tabular-nums", tone === "green" ? "text-foreground" : text)}>
              {fmt(usage.used)} <span className="text-sm font-normal text-muted-foreground">of {fmt(usage.limit)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {out
                ? `The daily limit was reached. DealTrack shows saved data until it resets at ${reset.at} (in ${reset.inText}). The ads keep running.`
                : `${fmt(Math.max(0, usage.limit - usage.used))} left. Resets at ${reset.at} your time (midnight Pacific), in ${reset.inText}.`}
            </p>
          </div>
          {usage.hours.some(Boolean) && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">By hour (Pacific)</p>
              <div className="flex h-12 items-end gap-px" role="img" aria-label="Operations used each hour today">
                {Array.from({ length: 24 }, (_, h) => (
                  <span
                    key={h}
                    title={`${h}:00 — ${fmt(usage.hours[h] ?? 0)}`}
                    className={cn("flex-1 rounded-sm", (usage.hours[h] ?? 0) ? bar : "bg-muted")}
                    style={{ height: `${Math.max(4, ((usage.hours[h] ?? 0) / peak) * 100)}%` }}
                  />
                ))}
              </div>
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>12 AM</span>
                <span>noon</span>
                <span>11 PM</span>
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Pages reuse data for 10 minutes, so clicking around is cheap. Restarting DealTrack, new date ranges and the 15-minute checks use the most.
            This is DealTrack&apos;s own count: other apps using the same Google Ads key aren&apos;t included.
          </p>
        </div>
      )}
    </div>
  )
}
