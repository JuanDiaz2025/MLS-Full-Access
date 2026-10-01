"use client"

// Narrows a report to one campaign through the URL (?campaign=), keeping the date range and tab.

import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { NAVIGATE_EVENT } from "@/components/nav-progress"

export default function CampaignFilter({ campaigns, value }: { campaigns: { id: string; name: string; status: string }[]; value: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const running = campaigns.filter((c) => c.status === "ENABLED")
  const others = campaigns.filter((c) => c.status !== "ENABLED")

  const pick = (id: string) => {
    const next = new URLSearchParams(params.toString())
    if (id) next.set("campaign", id)
    else next.delete("campaign")
    window.dispatchEvent(new Event(NAVIGATE_EVENT))
    router.push(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false })
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-xs font-medium text-muted-foreground">Campaign</span>
      <select
        autoComplete="off"
        value={value}
        onChange={(e) => pick(e.target.value)}
        className="h-8 max-w-72 rounded-lg border border-input bg-background px-2 text-sm"
      >
        <option value="">All campaigns</option>
        {running.length > 0 && (
          <optgroup label="Running">
            {running.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
        {others.length > 0 && (
          <optgroup label="Paused or ended">
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  )
}
