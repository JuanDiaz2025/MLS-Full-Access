"use client"

// A dropdown that opens the same page with one setting changed (?place=San Jose).

import { useRouter } from "next/navigation"

export function NavSelect({
  value,
  options,
  param,
  base,
  label,
}: {
  value: string
  options: { value: string; label: string }[]
  param: string
  base: Record<string, string>
  label: string
}) {
  const router = useRouter()
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => {
        const p = new URLSearchParams(base)
        if (e.target.value) p.set(param, e.target.value)
        else p.delete(param)
        router.push(`?${p}`, { scroll: false })
      }}
      className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
