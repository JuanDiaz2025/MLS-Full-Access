"use client"

import Link from "next/link"
import { useState, useTransition } from "react"

import { requestStatusAction } from "@/app/actions/compliance"
import type { CampaignOption } from "@/components/changes/shared"
import { Button } from "@/components/ui/button"

// Shown once spend reaches the pause line. Pausing goes through the Compliance check like any
// on/off change: this files the request, and it's checked, approved, and applied there.
export default function PausePanel({ campaigns, personName }: { campaigns: CampaignOption[]; personName: string }) {
  const [picked, setPicked] = useState(() => campaigns.map((c) => c.id))
  const [name, setName] = useState(personName)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()

  if (!campaigns.length) return <p className="text-sm text-muted-foreground">No campaigns are running, so there&apos;s nothing to pause.</p>

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Running campaigns</legend>
        {campaigns.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={picked.includes(c.id)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((p) => p !== c.id))}
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      {!personName && (
        <input
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          className="h-8 max-w-60 rounded-lg border border-input bg-background px-2 text-sm"
        />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="destructive"
          disabled={busy || !picked.length}
          onClick={() =>
            start(async () => {
              const r = await requestStatusAction({ campaignIds: picked, status: "PAUSED", reason: "Spend reached the budget's pause line.", name })
              setMessage({ ok: r.ok, text: r.message })
            })
          }
        >
          Ask to pause {picked.length} campaign{picked.length === 1 ? "" : "s"}
        </Button>
        <span className="text-xs text-muted-foreground">
          It goes to the{" "}
          <Link href="/compliance" className="font-medium text-primary hover:underline">
            Compliance page
          </Link>{" "}
          to be checked, approved, and applied.
        </span>
      </div>
      {message && (
        <p role="status" className={message.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>
          {message.text}
        </p>
      )}
    </div>
  )
}
