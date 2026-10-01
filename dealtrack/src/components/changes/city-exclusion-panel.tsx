"use client"

import { useState } from "react"

import { excludeLocationsAction } from "@/app/actions/changes"
import { CampaignPicker, List, runningIds, useChange, type CampaignOption } from "@/components/changes/shared"
import { formatConversions, formatUsd } from "@/components/dashboard/format"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type OutsideCity = { geo: string; city: string; region: string; cost: number; conversions: number }

export default function CityExclusionPanel({
  cities,
  campaigns,
  existing,
  inside = false,
}: {
  cities: OutsideCity[]
  campaigns: CampaignOption[]
  // "campaignId|geoTargetConstants/…" for locations already excluded.
  existing: string[]
  // California cities (the expensive ones): nothing is pre-selected, since they're in the buy area.
  inside?: boolean
}) {
  const [campaignIds, setCampaignIds] = useState(() => runningIds(campaigns))
  const [picked, setPicked] = useState(
    // Only cities that cost money and brought nothing: a converting one is the person's call.
    inside ? [] : cities.filter((c) => c.cost > 0 && c.conversions === 0).map((c) => c.geo),
  )
  const { ask, ui, busy } = useChange()

  const existingSet = new Set(existing)
  const inAll = (geo: string) => campaignIds.length > 0 && campaignIds.every((id) => existingSet.has(`${id}|${geo}`))
  const toExclude = picked.filter((g) => !inAll(g))
  const campaignNames = campaigns.filter((c) => campaignIds.includes(c.id)).map((c) => c.name)

  if (!cities.length) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        {inside ? "No California city spent a lot without results in this period." : "No clicks or spend outside the buy area in this period."}
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border bg-muted/30 p-4">
        <CampaignPicker campaigns={campaigns} selected={campaignIds} onChange={setCampaignIds} idPrefix="geo-campaign" />
      </div>

      <div className="max-h-[50vh] overflow-auto rounded-xl border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="w-10 py-2 pl-4 sm:pl-5">
                <span className="sr-only">Select</span>
              </th>
              <th scope="col" className="px-4 py-2 text-left font-medium">City</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Spend</th>
              <th scope="col" className="px-4 py-2 pr-4 text-right font-medium sm:pr-5">Conversions</th>
            </tr>
          </thead>
          <tbody>
            {cities.map((c) => {
              const done = inAll(c.geo)
              const id = `geo-${c.geo.split("/")[1]}`
              return (
                <tr key={c.geo} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pl-4 sm:pl-5">
                    <input
                      id={id}
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      disabled={done}
                      checked={!done && picked.includes(c.geo)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, c.geo] : picked.filter((g) => g !== c.geo))}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <label htmlFor={id} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.city}</span>
                      <span className="text-xs text-muted-foreground">{c.region}</span>
                      {done && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">Excluded</span>}
                    </label>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatUsd(c.cost)}</td>
                  <td className={cn("px-4 py-2 pr-4 text-right tabular-nums sm:pr-5", c.conversions > 0 && "font-medium text-amber-700")}>
                    {formatConversions(c.conversions)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          disabled={busy || !toExclude.length || !campaignIds.length}
          onClick={() => {
            const names = cities.filter((c) => toExclude.includes(c.geo)).map((c) => `${c.city}, ${c.region}`)
            ask({
              title: `Exclude ${toExclude.length} ${toExclude.length === 1 ? "city" : "cities"}?`,
              details: (
                <>
                  <List items={names} />
                  <p className="mt-2">From: {campaignNames.join(", ")}</p>
                  <p className="mt-1">Ads will stop showing to people in these places.</p>
                </>
              ),
              confirmLabel: "Exclude in Google Ads",
              run: () => excludeLocationsAction({ campaignIds, geoIds: toExclude, allowInside: inside }),
            })
          }}
        >
          Exclude {toExclude.length} selected
        </Button>
        <span className="text-xs text-muted-foreground">
          {inside ? "These are in the buy area: exclude one only if you're sure it isn't worth it." : "Cities in the buy area can't be excluded from here."}
        </span>
      </div>

      {ui}
    </div>
  )
}
