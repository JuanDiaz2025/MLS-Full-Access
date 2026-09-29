"use client"

// Go-live checks that Google Ads can't see. Whoever confirms one ticks it with their name; the
// tick is saved on the computer running DealTrack.

import { useState, useTransition } from "react"

import { setManualCheck, type FormState } from "@/app/actions/settings"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ManualItem = { id: string; title: string; plan?: string; done: boolean; by?: string; when?: string }

export default function ManualChecks({ items, personName }: { items: ManualItem[]; personName: string }) {
  const [name, setName] = useState(personName)
  const [state, setState] = useState<FormState>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const toggle = (id: string, done: boolean) => {
    setSaving(id)
    startTransition(async () => {
      setState(await setManualCheck(id, done, name))
      setSaving(null)
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex w-fit flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Your name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Seth"
          className="h-9 w-48 rounded-lg border border-input bg-background px-2"
        />
      </label>
      <ul className="flex flex-col divide-y divide-border/60">
        {items.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <Pill tone={m.done ? "green" : "violet"}>{m.done ? "Checked" : "To check"}</Pill>
                {m.title}
              </span>
              <span className="text-xs text-muted-foreground">
                {m.done ? `Checked by ${m.by}${m.when ? ` on ${m.when}` : ""}` : "Not checked yet"}
                {m.plan ? ` · Plan: ${m.plan}` : ""}
              </span>
            </div>
            <Button size="sm" variant={m.done ? "outline" : "default"} disabled={saving !== null} onClick={() => toggle(m.id, !m.done)}>
              {saving === m.id ? "Saving…" : m.done ? "Untick" : "Mark as checked"}
            </Button>
          </li>
        ))}
      </ul>
      {state.message && (
        <p role="status" className={cn("text-sm", state.ok ? "text-emerald-700" : "text-destructive")}>
          {state.message}
        </p>
      )}
    </div>
  )
}
