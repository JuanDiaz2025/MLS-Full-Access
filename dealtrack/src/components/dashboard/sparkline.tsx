// A tiny trend line for a KPI tile. Gaps (null) break the line, e.g. cost per lead on days with
// no leads.

import { cn } from "@/lib/utils"

export default function Sparkline({ values, className }: { values: (number | null)[]; className?: string }) {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (nums.length < 2) return <div className={cn("h-7", className)} aria-hidden />
  const max = Math.max(...nums)
  const min = Math.min(0, ...nums)
  const range = max - min || 1
  const last = Math.max(values.length - 1, 1)
  let d = ""
  let pen = false
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false
      return
    }
    d += `${pen ? "L" : "M"}${((i / last) * 100).toFixed(2)} ${(27 - ((v - min) / range) * 26).toFixed(2)} `
    pen = true
  })
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={cn("h-7 w-full overflow-visible", className)} aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
