"use client"

// A small settings form: labeled fields, the person's name (so saves show who made them), and a
// save button with the server's answer underneath. The server action checks for an admin.

import { useActionState } from "react"

import type { FormState } from "@/app/actions/settings"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type SettingsField = {
  name: string
  label: string
  hint?: string
  value: string
  prefix?: string // e.g. "$"
  suffix?: string // e.g. "%"
  placeholder?: string
}

export default function SettingsForm({
  action,
  fields,
  personName,
  submitLabel = "Save",
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>
  fields: SettingsField[]
  personName: string
  submitLabel?: string
}) {
  const [state, formAction, pending] = useActionState(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
            <span className="flex items-center gap-1">
              {f.prefix && <span className="text-muted-foreground">{f.prefix}</span>}
              <input
                name={f.name}
                defaultValue={f.value}
                inputMode="decimal"
                placeholder={f.placeholder}
                className="h-9 w-full rounded-lg border border-input bg-background px-2 tabular-nums"
              />
              {f.suffix && <span className="text-muted-foreground">{f.suffix}</span>}
            </span>
            {f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Your name</span>
          <input name="name" defaultValue={personName} required className="h-9 w-48 rounded-lg border border-input bg-background px-2" />
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        {state.message && (
          <span role="status" className={cn("text-sm", state.ok ? "text-emerald-700" : "text-destructive")}>
            {state.message}
          </span>
        )}
      </div>
    </form>
  )
}
