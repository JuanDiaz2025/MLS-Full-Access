"use client"

// Jumps to another campaign's page, keeping the date range.

import { useRouter } from "next/navigation"

export default function CampaignSwitcher({
  current,
  campaigns,
  query,
}: {
  current: string
  campaigns: { id: string; name: string; status: string }[]
  query: string
}) {
  const router = useRouter()
  const group = (label: string, status: string) => {
    const list = campaigns.filter((c) => (status === "OTHER" ? c.status !== "ENABLED" && c.status !== "PAUSED" : c.status === status))
    return list.length ? (
      <optgroup label={label}>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </optgroup>
    ) : null
  }
  return (
    <label className="flex w-full min-w-0 items-center gap-2 text-sm sm:w-auto">
      <span className="text-xs font-medium text-muted-foreground">Campaign</span>
      <select
        value={current}
        onChange={(e) => router.push(`/campaigns/${e.target.value}${query}`)}
        className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm sm:max-w-[22rem]"
      >
        {group("Running", "ENABLED")}
        {group("Paused", "PAUSED")}
        {group("Removed", "OTHER")}
      </select>
    </label>
  )
}
