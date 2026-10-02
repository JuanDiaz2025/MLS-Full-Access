"use client"

// Jumps to another campaign's page, keeping the date range and the tab. A searchable list: type
// part of a name (every word must match), arrow keys to move, Enter to open, Esc to close.

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronDown, Search } from "lucide-react"

import { cn } from "@/lib/utils"

type Option = { id: string; name: string; status: string }

const GROUPS = [
  { label: "Running", match: (s: string) => s === "ENABLED" },
  { label: "Paused", match: (s: string) => s === "PAUSED" },
  { label: "Removed", match: (s: string) => s !== "ENABLED" && s !== "PAUSED" },
]

export default function CampaignSwitcher({
  current,
  campaigns,
  query,
  tab,
}: {
  current: string
  campaigns: Option[]
  query: string
  tab?: string // stay on the same tab of the campaign page
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const selected = campaigns.find((c) => c.id === current)

  // In group order (running, paused, removed), filtered by every typed word.
  const shown = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean)
    const hits = campaigns.filter((c) => words.every((w) => c.name.toLowerCase().includes(w)))
    return GROUPS.map((g) => ({ label: g.label, items: hits.filter((c) => g.match(c.status)) })).filter((g) => g.items.length)
  }, [campaigns, search])
  const flat = shown.flatMap((g) => g.items)

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  function go(id: string) {
    setOpen(false)
    if (id === current) return
    router.push(`/campaigns/${id}${query}${tab && tab !== "summary" ? `${query ? "&" : "?"}tab=${tab}` : ""}`)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (flat[active]) go(flat[active].id)
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  const position = new Map(flat.map((c, i) => [c.id, i]))
  return (
    <div ref={box} className="relative flex w-full min-w-0 items-center gap-2 text-sm sm:w-auto">
      <span className="text-xs font-medium text-muted-foreground">Campaign</span>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o)
          setSearch("")
          setActive(
            Math.max(
              0,
              flat.findIndex((c) => c.id === current),
            ),
          )
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-input bg-background px-2.5 text-left sm:w-[22rem] sm:flex-none"
      >
        <span className="truncate">{selected?.name ?? "Pick a campaign"}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 flex w-full flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg sm:w-[28rem]">
          <label className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={input}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setActive(0)
              }}
              onKeyDown={onKey}
              placeholder={`Search ${campaigns.length} campaigns…`}
              aria-label="Search campaigns"
              aria-controls="campaign-options"
              className="h-10 w-full bg-transparent text-sm outline-none"
            />
          </label>
          <ul ref={list} id="campaign-options" role="listbox" aria-label="Campaigns" className="max-h-80 overflow-y-auto py-1">
            {shown.map((g) => (
              <li key={g.label} role="presentation">
                <p className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground">
                  {g.label} ({g.items.length})
                </p>
                <ul role="presentation">
                  {g.items.map((c) => {
                    const i = position.get(c.id)!
                    return (
                      <li
                        key={c.id}
                        role="option"
                        aria-selected={c.id === current}
                        data-index={i}
                        onMouseEnter={() => setActive(i)}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          go(c.id)
                        }}
                        className={cn(
                          "flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5",
                          i === active && "bg-primary text-primary-foreground",
                        )}
                      >
                        <span className="truncate">{c.name}</span>
                        {c.id === current && <Check className="size-4 shrink-0" aria-hidden />}
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
            {!flat.length && <li className="px-3 py-3 text-sm text-muted-foreground">No campaign matches “{search}”.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
