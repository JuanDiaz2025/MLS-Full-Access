"use client"

// Pieces the leads table and the lead panel share: the status picker, the score, and how what
// Google Ads heard is labeled.
import { useState, useTransition } from "react"

import { setLeadStatusAction } from "@/lib/leads/status-actions"
import { leadStatuses } from "@/lib/leads/types"
import { cn } from "@/lib/utils"

export type Grade = "hot" | "warm" | "cold" | "junk"
export type Score = { value: number; grade: Grade; reasons: string[] }

export const statusTone: Record<string, string> = {
  new: "border-border bg-card",
  unresponsive: "border-amber-500/50 bg-amber-500/10 text-amber-800",
  interested: "border-emerald-500/50 bg-emerald-500/10 text-emerald-800",
  appointment: "border-sky-500/50 bg-sky-500/10 text-sky-800",
  offer: "border-violet-500/50 bg-violet-500/10 text-violet-800",
  closed: "border-emerald-700/60 bg-emerald-600 text-white",
  not_interested: "border-border bg-muted text-muted-foreground",
}

export const gradeStyle = {
  hot: { label: "Hot", cls: "bg-red-600 text-white" },
  warm: { label: "Warm", cls: "bg-amber-400 text-amber-950" },
  cold: { label: "Cold", cls: "bg-sky-100 text-sky-900" },
  junk: { label: "Junk", cls: "bg-muted text-muted-foreground line-through" },
} as const

export const statusLabel = (id: string) => leadStatuses.find((s) => s.id === id)?.label ?? id

// The lead's score, with the reasons one click away.
export function ScoreCell({ score }: { score?: Score }) {
  if (!score) return <span className="text-muted-foreground/60">–</span>
  const g = gradeStyle[score.grade]
  return (
    <details className="group/score">
      <summary className="flex cursor-pointer list-none items-center gap-1.5">
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", g.cls)}>{g.label}</span>
        <span className="text-xs font-medium tabular-nums">{score.grade === "junk" ? "" : score.value}</span>
        <span className="text-xs text-primary underline-offset-2 group-open/score:hidden hover:underline">why?</span>
      </summary>
      <ul className="mt-1 max-w-64 space-y-0.5 text-xs whitespace-normal text-muted-foreground">
        {score.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </details>
  )
}

export const googleLabel = {
  sent: { text: "Sent to Google ✓", cls: "bg-emerald-500/10 text-emerald-700" },
  pending: { text: "Waiting for Google", cls: "bg-amber-500/15 text-amber-800" },
  failed: { text: "Not sent", cls: "bg-destructive/10 text-destructive" },
  skipped: { text: "Can't match", cls: "bg-muted text-muted-foreground" },
  held: { text: "Not sent (rule)", cls: "bg-muted text-muted-foreground" },
  checking: { text: "Sent, Google checking", cls: "bg-sky-500/10 text-sky-800" },
  accepted: { text: "Accepted by Google ✓", cls: "bg-emerald-500/15 text-emerald-800" },
  rejected: { text: "Rejected by Google", cls: "bg-destructive/10 text-destructive" },
  retracting: { text: "Taking back from Google", cls: "bg-amber-500/15 text-amber-800" },
  invalid: { text: "Reported as invalid ✓", cls: "bg-muted text-foreground" },
  invalid_pending: { text: "Reporting as invalid", cls: "bg-muted text-muted-foreground" },
  retracted: { text: "Taken back from Google ✓", cls: "bg-muted text-foreground" },
  elsewhere: { text: "Sent by the main computer", cls: "bg-muted text-muted-foreground" },
  retract_failed: { text: "Couldn't take back", cls: "bg-destructive/10 text-destructive" },
} as const
export type GoogleState = keyof typeof googleLabel

// The status picker. Interested and later stages tell Google Ads this lead was good. `by` is who
// on the team set it.
export function StatusCell({ id, status, auto, rule, by, className }: { id: string; status: string; auto: boolean; rule?: string; by?: string; className?: string }) {
  const [value, setValue] = useState(status)
  const [byApp, setByApp] = useState(auto)
  const [byName, setByName] = useState(by)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label="Lead status"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value
          setValue(next)
          setByApp(false)
          // Whoever set it before didn't set this: the page shows the new name once it's saved.
          setByName(undefined)
          setError(null)
          start(async () => {
            const res = await setLeadStatusAction(id, next)
            if (res.error) {
              setError(res.error)
              setValue(status)
              setByApp(auto)
              setByName(by)
            }
          })
        }}
        className={cn("h-8 rounded-lg border px-1.5 text-xs font-semibold", statusTone[value] ?? statusTone.new, className)}
      >
        {leadStatuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {byApp && value !== "new" && (
        <span className="max-w-40 text-xs whitespace-normal text-muted-foreground">{rule ? `Set by rule: ${rule}` : "Set by its score"}</span>
      )}
      {!byApp && byName && <span className="max-w-40 truncate text-xs text-muted-foreground">by {byName}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
