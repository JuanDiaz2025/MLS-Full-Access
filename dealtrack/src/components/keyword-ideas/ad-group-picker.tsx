"use client"

// Picks one or more ad groups, grouped by campaign (running campaigns first), with a search box.
// Opens as a small panel under the button; changes apply when "Done" is pressed.

import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"

import type { AdGroupOption } from "@/components/keyword-ideas/idea-batch"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const SHOWN = 60
const inCampaigns = (n: number) => (n === 1 ? "All in one campaign" : `In ${n} campaigns`)

export default function AdGroupPicker({
  options,
  selected,
  onDone,
  disabled,
  label,
}: {
  options: AdGroupOption[]
  selected: string[]
  onDone: (ids: string[]) => void
  disabled?: boolean
  label: string // for screen readers, e.g. "Ad groups for sell my home"
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState(selected)
  const [search, setSearch] = useState("")
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  // The panel floats above the page (the lines table scrolls and would clip it).
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)

  // Close when clicking outside or pressing Escape, without saving.
  useEffect(() => {
    if (!open) return
    // Focus the search without scrolling, so opening doesn't count as a scroll that closes it.
    searchBox.current?.focus({ preventScroll: true })
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    // Scrolling anything but the panel itself moves the button away, so close. A scroll that was
    // already under way when the panel opened doesn't count.
    const openedAt = Date.now()
    const onScroll = (e: Event) => {
      if (Date.now() - openedAt < 400) return
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [open])

  const names = new Map(options.map((o) => [o.id, o]))
  const first = selected.map((id) => names.get(id)).filter(Boolean)[0]
  const term = search.trim().toLowerCase()
  const matches = options.filter((o) => !term || `${o.campaignName} ${o.name}`.toLowerCase().includes(term))
  // Chosen ones stay visible whatever the search says.
  const shown = [...options.filter((o) => picked.includes(o.id)), ...matches.filter((o) => !picked.includes(o.id))].slice(0, Math.max(SHOWN, picked.length))
  const campaigns = [...new Map(shown.map((o) => [o.campaignId, { name: o.campaignName, running: o.running }])).entries()].sort(
    ([, a], [, b]) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name),
  )

  return (
    <div ref={box} className="relative">
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          const r = button.current!.getBoundingClientRect()
          const width = 320
          const height = 400
          setAt({
            left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
            top: r.bottom + height + 8 > window.innerHeight ? Math.max(8, r.top - height - 4) : r.bottom + 4,
          })
          setPicked(selected)
          setSearch("")
          setOpen(!open)
        }}
        className={cn(
          "flex h-7 w-full max-w-60 items-center justify-between gap-1 rounded-lg border bg-background px-2 text-left text-xs disabled:opacity-60",
          selected.length ? "border-input" : "border-amber-400 text-amber-900",
        )}
      >
        <span className="truncate">
          {first ? first.name : "Choose ad groups"}
          {selected.length > 1 && <span className="text-muted-foreground"> +{selected.length - 1} more</span>}
        </span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </button>
      {first && <span className="mt-0.5 block max-w-60 truncate text-[11px] text-muted-foreground">{selected.length > 1 ? inCampaigns(new Set(selected.map((id) => names.get(id)?.campaignId)).size) : first.campaignName}</span>}

      {open && at && (
        <div
          role="dialog"
          aria-label={label}
          style={{ position: "fixed", top: at.top, left: at.left }}
          className="z-50 flex max-h-[400px] w-80 flex-col gap-2 rounded-xl border bg-card p-2 shadow-lg"
        >
          <input
            ref={searchBox}
            type="search"
            aria-label="Search ad groups"
            placeholder="Search campaigns or ad groups"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
          />
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {campaigns.map(([id, c]) => (
              <fieldset key={id} className="flex flex-col gap-1">
                <legend className="mb-0.5 text-[11px] font-semibold text-muted-foreground">
                  {c.name}
                  {c.running ? " (running)" : ""}
                </legend>
                {shown
                  .filter((o) => o.campaignId === id)
                  .map((o) => (
                    <label key={o.id} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-muted">
                      <input
                        type="checkbox"
                        autoComplete="off"
                        checked={picked.includes(o.id)}
                        onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))}
                        className="size-3.5 shrink-0"
                      />
                      <span className="truncate">{o.name}</span>
                    </label>
                  ))}
              </fieldset>
            ))}
            {!campaigns.length && <p className="px-1 text-xs text-muted-foreground">No ad group matches.</p>}
            {matches.length > SHOWN && <p className="px-1 text-[11px] text-muted-foreground">Showing {SHOWN} of {matches.length}. Search to narrow it down.</p>}
          </div>
          <div className="flex items-center justify-between gap-2 border-t pt-2">
            <span className="text-xs text-muted-foreground">{picked.length} chosen</span>
            <span className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  onDone(picked)
                }}
              >
                Done
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
