"use client"

import { useState, useTransition } from "react"
import { Target } from "lucide-react"

import { setConversionTargetAction } from "@/lib/leads/conversion-target-actions"

type Option = { resourceName: string; name: string; importable: boolean; primary?: boolean }
export type TargetsView = {
  options: Option[]
  interested?: { resourceName: string; name: string }
  closed?: { resourceName: string; name: string }
  invalid?: { resourceName: string; name: string }
  chosen: { interested?: boolean; closed?: boolean; invalid?: boolean }
  // Your own action with that name, if it can't receive imported leads.
  blocked: { interested?: string; closed?: string }
}

const NEW = "" // nothing picked yet: the app creates its own action the first time

function Picker({ kind, label, stages, view }: { kind: "interested" | "closed" | "invalid"; label: string; stages: string; view: TargetsView }) {
  const [value, setValue] = useState(view[kind]?.resourceName ?? NEW)
  const [pending, start] = useTransition()
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span>
        <strong>{stages}</strong> <span className="text-muted-foreground">→ {label}</span>
      </span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value
          const before = value
          setValue(next)
          setNote(null)
          start(async () => {
            const res = await setConversionTargetAction(kind, next)
            if (res.error) {
              setValue(before)
              setNote({ ok: false, text: res.error })
            } else setNote({ ok: true, text: "Saved. New conversions go here." })
          })
        }}
        className="h-10 w-full rounded-lg border bg-card px-2 text-sm"
      >
        {value === NEW && (
          <option value={NEW}>
            {kind === "invalid" ? "Invalid lead (Command Center, reporting only), made on first use" : `${label[0].toUpperCase()}${label.slice(1)} (Command Center import), made on first use`}
          </option>
        )}
        {view.options.map((o) => (
          <option key={o.resourceName} value={o.resourceName} disabled={!o.importable || (kind === "invalid" && o.primary)}>
            {o.name}
            {!o.importable ? " (can't receive imported leads)" : kind === "invalid" && o.primary ? " (primary: would teach bidding to find more)" : ""}
          </option>
        ))}
      </select>
      <span className={note ? (note.ok ? "text-xs text-emerald-700" : "text-xs text-destructive") : "text-xs text-muted-foreground"}>
        {note?.text ??
          (view.chosen[kind]
            ? "Picked by you."
            : view[kind] && !view[kind]!.name.includes("Command Center")
              ? "✓ Found in your account and ready to receive leads."
              : kind !== "invalid" && view.blocked[kind as "interested" | "closed"]
                ? `Your “${view.blocked[kind as "interested" | "closed"]}” action counts something else (like a website form) and can't receive imported leads, so the app uses its own “${label}” import action instead.`
                : `No ${label} action that takes imports was found, so the app makes its own the first time a lead reaches this stage.`)}
      </span>
    </label>
  )
}

// Which Google Ads conversion action each lead stage is reported as.
export default function ConversionTargets({ view }: { view: TargetsView }) {
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 text-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Target className="size-5" />
        </span>
        <div>
          <p className="font-semibold">Where conversions go in Google Ads</p>
          <p className="text-muted-foreground">
            The app sends each stage to your own conversion actions, found automatically (&ldquo;Qualified lead&rdquo; and
            &ldquo;Converted lead&rdquo;). Pick a different one here if you like; only actions whose source is <em>Import from clicks</em>{" "}
            can receive leads.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Picker kind="interested" label="qualified lead" stages="Interested, Appointment, Offer made" view={view} />
        <Picker kind="closed" label="converted lead" stages="Closed deal" view={view} />
        <Picker kind="invalid" label="invalid lead (reporting only)" stages="Not interested, junk" view={view} />
      </div>
    </div>
  )
}
