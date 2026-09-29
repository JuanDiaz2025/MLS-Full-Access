"use client"

// Pieces shared by the panels that change Google Ads: a campaign picker, a confirm step, and the
// result message. Every change goes through useChange, which shows a confirmation first.

import { useState, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2 } from "lucide-react"

import type { ActionResult } from "@/app/actions/changes"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type CampaignOption = { id: string; name: string; status: string }

// Running campaigns are chosen by default. The account also has many old paused campaigns, so
// those sit behind a search box.
export const runningIds = (campaigns: CampaignOption[]) => campaigns.filter((c) => c.status === "ENABLED").map((c) => c.id)

const MAX_SHOWN = 25

export function CampaignPicker({
  campaigns,
  selected,
  onChange,
  idPrefix,
}: {
  campaigns: CampaignOption[]
  selected: string[]
  onChange: (ids: string[]) => void
  idPrefix: string
}) {
  const [showPaused, setShowPaused] = useState(false)
  const [search, setSearch] = useState("")

  if (!campaigns.length) {
    return <p className="text-sm text-destructive">There are no campaigns that can take this change.</p>
  }

  const running = campaigns.filter((c) => c.status === "ENABLED")
  const paused = campaigns.filter((c) => c.status !== "ENABLED")
  const term = search.trim().toLowerCase()
  const matches = paused.filter((c) => !term || c.name.toLowerCase().includes(term))
  // Paused campaigns already chosen stay visible even when they don't match the search.
  const shownPaused = [
    ...paused.filter((c) => selected.includes(c.id)),
    ...matches.filter((c) => !selected.includes(c.id)).slice(0, MAX_SHOWN),
  ]

  const box = (c: CampaignOption) => {
    const id = `${idPrefix}-${c.id}`
    return (
      <label key={c.id} htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          className="size-4 shrink-0 accent-[var(--primary)]"
          checked={selected.includes(c.id)}
          onChange={(e) => onChange(e.target.checked ? [...selected, c.id] : selected.filter((s) => s !== c.id))}
        />
        <span className="truncate">{c.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">({c.status === "ENABLED" ? "running" : "paused"})</span>
      </label>
    )
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">
        Apply to campaigns ({selected.length} chosen)
      </legend>
      {running.length ? running.map(box) : <p className="text-sm text-muted-foreground">No campaigns are running right now.</p>}
      {paused.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setShowPaused(!showPaused)}
            aria-expanded={showPaused}
            className="self-start text-xs font-medium text-primary hover:underline"
          >
            {showPaused ? "Hide paused campaigns" : `Add paused campaigns (${paused.length})`}
          </button>
          {showPaused && (
            <>
              <input
                type="search"
                aria-label="Search paused campaigns"
                placeholder="Search paused campaigns"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 max-w-xs rounded-lg border border-input bg-background px-2 text-sm"
              />
              <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
                {shownPaused.map(box)}
                {matches.length > MAX_SHOWN && (
                  <p className="text-xs text-muted-foreground">
                    Showing {MAX_SHOWN} of {matches.length}. Search to narrow it down.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </fieldset>
  )
}

type Pending = {
  title: string
  details: ReactNode
  confirmLabel: string
  run: () => Promise<ActionResult>
  // Shown under the details. Defaults to the note about undoing from the list below.
  note?: string
}

// Asks before running a change, then shows what Google did and refreshes the page's data.
export function useChange() {
  const router = useRouter()
  const [pending, setPending] = useState<Pending | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [running, startTransition] = useTransition()

  function ask(p: Pending) {
    setResult(null)
    setPending(p)
  }

  function confirm() {
    const p = pending
    if (!p) return
    startTransition(async () => {
      const r = await p.run()
      setResult(r)
      setPending(null)
      router.refresh()
    })
  }

  const ui = (
    <>
      {pending && (
        <div
          role="alertdialog"
          aria-labelledby="confirm-title"
          className="flex flex-col gap-3 rounded-xl border-2 border-primary/40 bg-primary/5 p-4 text-sm"
        >
          <p id="confirm-title" className="font-semibold">
            {pending.title}
          </p>
          <div className="text-muted-foreground">{pending.details}</div>
          <p className="text-xs text-muted-foreground">
            {pending.note ?? "This changes your live Google Ads account. You can undo it from the list below."}
          </p>
          <div className="flex gap-2">
            <Button type="button" onClick={confirm} disabled={running}>
              {running ? "Sending to Google Ads…" : pending.confirmLabel}
            </Button>
            <Button type="button" variant="outline" onClick={() => setPending(null)} disabled={running}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {result && <ResultMessage result={result} onDismiss={() => setResult(null)} />}
    </>
  )

  return { ask, ui, busy: running || !!pending }
}

function ResultMessage({ result, onDismiss }: { result: ActionResult; onDismiss: () => void }) {
  const Icon = result.ok ? CheckCircle2 : AlertTriangle
  return (
    <div
      role="status"
      className={cn(
        "flex gap-3 rounded-xl border p-3 text-sm",
        result.ok ? "border-emerald-300 bg-emerald-50 text-emerald-950" : "border-destructive/30 bg-destructive/5",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", result.ok ? "text-emerald-600" : "text-destructive")} aria-hidden />
      <div className="flex flex-1 flex-col gap-1">
        <p>{result.message}</p>
        {!!result.failures?.length && (
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {result.failures.slice(0, 10).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" onClick={onDismiss} className="self-start text-xs text-muted-foreground hover:text-foreground">
        Dismiss
      </button>
    </div>
  )
}

export function List({ items }: { items: string[] }) {
  const shown = items.slice(0, 15)
  return (
    <ul className="mt-1 list-disc pl-5">
      {shown.map((i) => (
        <li key={i}>{i}</li>
      ))}
      {items.length > shown.length && <li>…and {items.length - shown.length} more</li>}
    </ul>
  )
}
