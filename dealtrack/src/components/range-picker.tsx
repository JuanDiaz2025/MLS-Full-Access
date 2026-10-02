"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"

import LinkPending from "@/components/link-pending"

import { presets, type DateRange } from "@/lib/date-range"
import { cn } from "@/lib/utils"

// Preset ranges as links, plus a custom from/to form. The page reads the range from the URL.
export default function RangePicker({ range }: { range: DateRange }) {
  const pathname = usePathname()
  // Other filters on the page (campaign status, traffic, months) survive a date change.
  const kept = [...useSearchParams().entries()].filter(([k]) => !["range", "from", "to"].includes(k))
  const withKept = (query: string) => {
    const params = new URLSearchParams(query)
    for (const [k, v] of kept) params.set(k, v)
    return `${pathname}?${params}`
  }

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Date range">
        {presets.map((p) => (
          <Link
            key={p.id}
            href={withKept(`range=${p.id}`)}
            aria-current={range.preset === p.id ? "true" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
              range.preset === p.id && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
            )}
          >
            {p.label}
            <LinkPending />
          </Link>
        ))}
      </div>
      <form action={pathname} className="flex flex-wrap items-center gap-2 text-xs">
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
        {kept.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <button type="submit" className="h-8 rounded-lg border px-3 font-medium hover:bg-muted">
          Apply
        </button>
      </form>
    </div>
  )
}
