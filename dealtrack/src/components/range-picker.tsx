"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { presets, type DateRange } from "@/lib/date-range"
import { cn } from "@/lib/utils"

// Preset ranges as links, plus a custom from/to form. The page reads the range from the URL.
// keep: other URL settings to carry over, such as the chosen campaign.
export default function RangePicker({ range, keep = {} }: { range: DateRange; keep?: Record<string, string> }) {
  const pathname = usePathname()
  const extra = Object.entries(keep)
    .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("")

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Date range">
        {presets.map((p) => (
          <Link
            key={p.id}
            href={`${pathname}?range=${p.id}${extra}`}
            aria-current={range.preset === p.id ? "true" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
              range.preset === p.id && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
            )}
          >
            {p.label}
          </Link>
        ))}
      </div>
      <form action={pathname} className="flex flex-wrap items-center gap-2 text-xs">
        {Object.entries(keep).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label htmlFor="range-from" className="text-muted-foreground">
          From
        </label>
        <input
          id="range-from"
          name="from"
          type="date"
          defaultValue={range.from}
          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
        />
        <label htmlFor="range-to" className="text-muted-foreground">
          to
        </label>
        <input
          id="range-to"
          name="to"
          type="date"
          defaultValue={range.to}
          className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
        />
        <button type="submit" className="h-8 rounded-lg border px-3 font-medium hover:bg-muted">
          Apply
        </button>
      </form>
    </div>
  )
}
