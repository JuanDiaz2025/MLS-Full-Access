"use client"

// Asking to turn campaigns on or off. Nothing changes in Google Ads here: the request is checked,
// approved, and then applied by an admin.

import { useState, useTransition } from "react"

import { requestStatusAction } from "@/app/actions/compliance"
import { Segmented } from "@/components/negatives/parts"
import { Button } from "@/components/ui/button"

type Campaign = { id: string; name: string; status: string; learning?: string }

export default function StatusRequestForm({ campaigns, personName }: { campaigns: Campaign[]; personName: string }) {
  const [status, setStatus] = useState<"PAUSED" | "ENABLED">("PAUSED")
  const [picked, setPicked] = useState<string[]>([])
  const [reason, setReason] = useState("")
  const [name, setName] = useState(personName)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()
  // Turning off lists the running campaigns; turning on lists the paused ones.
  const list = campaigns.filter((c) => (status === "PAUSED" ? c.status === "ENABLED" : c.status === "PAUSED"))

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        start(async () => {
          const r = await requestStatusAction({ campaignIds: picked, status, reason, name })
          setMessage({ ok: r.ok, text: r.message })
          if (r.ok) {
            setPicked([])
            setReason("")
          }
        })
      }}
    >
      <Segmented<"PAUSED" | "ENABLED">
        label="Turn on or off"
        value={status}
        onChange={(v) => {
          setStatus(v)
          setPicked([])
        }}
        options={[
          { id: "PAUSED", label: "Turn off" },
          { id: "ENABLED", label: "Turn on" },
        ]}
      />
      <fieldset className="flex max-h-64 flex-col gap-1.5 overflow-y-auto rounded-xl border p-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">{status === "PAUSED" ? "Running campaigns" : "Paused campaigns"}</legend>
        {list.length ? (
          list.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={picked.includes(c.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((p) => p !== c.id))}
              />
              {c.name}
              {c.learning && <span className="text-xs text-amber-700">· {c.learning.toLowerCase()}</span>}
            </label>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">{status === "PAUSED" ? "No campaign is running." : "No paused campaigns."}</p>
        )}
      </fieldset>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        autoComplete="off"
        placeholder={status === "PAUSED" ? "Why turn them off? e.g. Spend hit the pause line" : "Why turn them on? e.g. New month's budget approved"}
        aria-label="Why"
        className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        {!personName && (
          <input
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            aria-label="Your name"
            className="h-8 w-40 rounded-lg border border-input bg-background px-2 text-sm"
          />
        )}
        <Button type="submit" size="sm" disabled={busy || !picked.length || !reason.trim()}>
          Ask to turn {picked.length || ""} {status === "PAUSED" ? "off" : "on"}
        </Button>
      </div>
      {message && (
        <p role="status" className={message.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>
          {message.text}
        </p>
      )}
    </form>
  )
}
