"use client"

// Small pieces the Weekly negatives tabs share: the batch view type, stage labels, titles, and
// the two-button choices used in review and approval.

import { Check, X } from "lucide-react"

import type { CampaignOption } from "@/components/changes/shared"
import { formatUsd } from "@/components/dashboard/format"
import { Pill, type PillTone } from "@/components/pill"
import type { Stage } from "@/lib/negative-batches"
import type { NegativeBatch } from "@/lib/store"
import { cn } from "@/lib/utils"

export type BatchView = NegativeBatch & {
  stage: Stage
  periodLabel: string
  times: Partial<Record<"drafted" | "proven" | "approved" | "pushed" | "checked", string>> // formatted
  checkDayLabel: string | null
  checkReady: boolean
}

// What every tab needs from the page.
export type Shared = {
  campaigns: CampaignOption[] // every campaign that isn't removed, running ones first
  admin: boolean
  adminLink: React.ReactNode
  brakeNote: string | null // set while a push in the last 7 days blocks the next one
  dryRun: boolean
  listName: string // the shared list a push can go into
}

export const stageLabel: Record<Stage, { tone: PillTone; label: string }> = {
  empty: { tone: "gray", label: "Nothing to add" },
  proving: { tone: "violet", label: "In review" },
  approving: { tone: "violet", label: "Waiting for approval" },
  ready: { tone: "amber", label: "Ready to push" },
  "nothing-approved": { tone: "gray", label: "Nothing approved" },
  pushed: { tone: "green", label: "Pushed" },
  checked: { tone: "green", label: "Result checked" },
}

// Batches someone has to act on now: review, approve, push, or a result check that's due.
export const needsAction = (b: BatchView) =>
  b.stage === "proving" || b.stage === "approving" || b.stage === "ready" || (b.stage === "pushed" && b.checkReady)

// Pushed, and the week before the result check isn't over yet.
export const waiting = (b: BatchView) => b.stage === "pushed" && !b.checkReady

export const batchTitle = (b: BatchView) => (b.kind === "standard" ? "Standard negatives" : b.periodLabel)

export function batchScope(b: BatchView) {
  if (b.kind === "standard") return b.forCampaigns?.length === 1 ? b.forCampaigns[0] : `${b.forCampaigns?.length ?? 0} campaigns`
  return b.campaignName ?? "All campaigns"
}

export const batchCost = (b: BatchView) => b.items.reduce((s, i) => s + i.cost, 0)

export function batchSummary(b: BatchView) {
  const n = b.items.length
  if (!n) return "Nothing to add"
  return `${n} line${n === 1 ? "" : "s"} · ${formatUsd(batchCost(b))}`
}

export function Choice({
  value,
  yes,
  no,
  disabled,
  busy,
  label,
  onPick,
}: {
  value: boolean | null
  yes: string
  no: string
  disabled: boolean
  busy: boolean
  label: string // what the choice is about, for screen readers
  onPick: (v: boolean | null) => void
}) {
  const base = "inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-medium whitespace-nowrap disabled:opacity-50"
  return (
    <span className="inline-flex gap-1" role="group" aria-label={label} aria-busy={busy || undefined}>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === true}
        onClick={() => onPick(value === true ? null : true)}
        className={cn(base, value === true ? "border-emerald-600 bg-emerald-600 text-white" : "hover:bg-muted")}
      >
        <Check className="size-3" aria-hidden />
        {yes}
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === false}
        onClick={() => onPick(value === false ? null : false)}
        className={cn(base, value === false ? "border-destructive bg-destructive text-white" : "hover:bg-muted")}
      >
        <X className="size-3" aria-hidden />
        {no}
      </button>
    </span>
  )
}

export function Decision({ value, by, yes, no }: { value: boolean | null; by?: string; yes: string; no: string }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Pill tone={value ? "green" : "red"}>{value ? yes : no}</Pill>
      {by && <span className="text-[11px] text-muted-foreground">{by}</span>}
    </span>
  )
}

// A row of pill-shaped toggle buttons, e.g. a filter. One is pressed at a time.
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs font-medium",
            o.id === value ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
