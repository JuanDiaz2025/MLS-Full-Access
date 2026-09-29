"use client"

// Picks the two metrics the Overview chart compares. The choice lives in the URL (?m1=&m2=), so
// it survives date changes and can be bookmarked.

import { usePathname, useRouter, useSearchParams } from "next/navigation"

export default function MetricPicker({ options, m1, m2 }: { options: { id: string; label: string }[]; m1: string; m2: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const set = (key: "m1" | "m2", value: string) => {
    const next = new URLSearchParams(params.toString())
    next.set(key, value)
    router.push(`${pathname}?${next}`, { scroll: false })
  }

  const select = "h-8 rounded-lg border border-input bg-background px-2 text-sm"
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <select aria-label="First metric" value={m1} onChange={(e) => set("m1", e.target.value)} className={select}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="text-muted-foreground">vs</span>
      <select aria-label="Second metric" value={m2} onChange={(e) => set("m2", e.target.value)} className={select}>
        <option value="none">Nothing</option>
        {options
          .filter((o) => o.id !== m1)
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
      </select>
    </div>
  )
}
