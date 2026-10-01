"use client"

// A small set of buttons that sets one URL setting (e.g. ?level=county), keeping the rest of the
// URL (date range, tab, campaign). The first option is the default and leaves the setting out.

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { NAVIGATE_EVENT } from "@/components/nav-progress"
import { Segmented } from "@/components/negatives/parts"

export default function ParamSwitch<T extends string>({
  param,
  value,
  options,
  label,
}: {
  param: string
  value: T
  options: { id: T; label: string }[]
  label: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const pick = (id: T) => {
    if (id === value) return
    const next = new URLSearchParams(params.toString())
    if (id === options[0].id) next.delete(param)
    else next.set(param, id)
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
    router.push(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false })
  }
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Segmented<T> label={label} value={value} onChange={pick} options={options} />
    </span>
  )
}
