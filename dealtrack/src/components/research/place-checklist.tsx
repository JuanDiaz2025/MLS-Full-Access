"use client"

// A searchable checklist of places to search from: our targeted cities first (all at once with one
// click), then the other California places; California itself when allowed. Used by Google
// rankings and Competitor ads.

import { useState } from "react"

import { Button } from "@/components/ui/button"

const STATEWIDE = "California"

export function PlaceChecklist({
  places,
  targeted,
  where,
  setWhere,
  allowState,
}: {
  places: string[]
  targeted: string[]
  where: string[]
  setWhere: (list: string[]) => void
  allowState: boolean
}) {
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const ours = new Set(targeted)
  const match = (p: string) => !q || p.toLowerCase().includes(q)
  const others = places.filter((p) => p !== STATEWIDE && !ours.has(p)).sort()
  const toggle = (p: string) => setWhere(where.includes(p) ? where.filter((x) => x !== p) : [...where, p])
  const allTargeted = targeted.length > 0 && targeted.every((p) => where.includes(p))
  const chosenCities = where.filter((p) => p !== STATEWIDE)
  const box = (p: string, label = p) => (
    <label key={p} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
      <input type="checkbox" checked={where.includes(p)} onChange={() => toggle(p)} />
      {label}
    </label>
  )
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search cities and counties…"
          aria-label="Search places"
          className="h-8 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-xs"
        />
        {targeted.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setWhere(allTargeted ? where.filter((p) => !ours.has(p)) : [...new Set([...where, ...targeted])])}
          >
            {allTargeted ? "Untick our cities" : `All ${targeted.length} of our cities`}
          </Button>
        )}
        {chosenCities.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setWhere(where.filter((p) => p === STATEWIDE))}>
            Clear cities
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {where.includes(STATEWIDE) && allowState ? "California + " : ""}
          {chosenCities.length} {chosenCities.length === 1 ? "city" : "cities"} picked
        </span>
      </div>
      <div className="flex max-h-64 flex-col overflow-y-auto text-xs">
        {allowState && match("california") && box(STATEWIDE, "California (whole state)")}
        {targeted.some(match) && <p className="mt-1 px-2 font-medium text-muted-foreground">Our targeted cities</p>}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3">{targeted.filter(match).map((p) => box(p))}</div>
        {others.some(match) && <p className="mt-2 px-2 font-medium text-muted-foreground">Other California places</p>}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3">{others.filter(match).map((p) => box(p))}</div>
        {!targeted.some(match) && !others.some(match) && !(allowState && match("california")) && (
          <p className="px-2 py-1 text-muted-foreground">No place matches.</p>
        )}
      </div>
      {!targeted.length && (
        <p className="text-xs text-muted-foreground">
          Your targeted cities show up here after “Get volumes: California + every targeted city” on the Keyword explorer.
        </p>
      )}
    </div>
  )
}
