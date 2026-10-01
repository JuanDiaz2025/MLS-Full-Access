"use client"

// One Compliance request with its steps: requested → checked → approved → applied, like a
// negatives batch. Saying no at the check or the approval closes it.

import { Check, X } from "lucide-react"
import { useState, useTransition } from "react"

import { applyStatusRequestAction, decideRequestAction } from "@/app/actions/compliance"
import { Pill, type PillTone } from "@/components/pill"
import { Button } from "@/components/ui/button"
import { requestTitle, type RequestStage } from "@/lib/compliance-rules"
import type { ChangeRequest } from "@/lib/store"
import { cn } from "@/lib/utils"

export type RequestView = ChangeRequest & { stage: RequestStage; times: Partial<Record<"requested" | "checked" | "approved" | "applied", string>> }

const STAGES: Record<RequestStage, { tone: PillTone; label: string }> = {
  checking: { tone: "violet", label: "Waiting for a check" },
  approving: { tone: "violet", label: "Waiting for approval" },
  ready: { tone: "amber", label: "Approved, ready" },
  done: { tone: "green", label: "Done" },
  rejected: { tone: "gray", label: "Stopped" },
  expired: { tone: "gray", label: "Approval expired" },
}

export default function RequestCard({ r, admin, personName }: { r: RequestView; admin: boolean; personName: string }) {
  const [name, setName] = useState(personName)
  const [note, setNote] = useState("")
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()
  const stage = STAGES[r.stage]

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const res = await fn()
      setMessage({ ok: res.ok, text: res.message })
    })

  const step = (
    n: number,
    label: string,
    done: { by: string; ok?: boolean; note?: string } | undefined,
    time: string | undefined,
    active: boolean,
  ) => (
    <li className={cn("flex items-start gap-2 text-sm", !done && !active && "text-muted-foreground")}>
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
          done && done.ok !== false && "border-emerald-600 bg-emerald-600 text-white",
          done && done.ok === false && "border-destructive bg-destructive text-white",
          active && "border-primary text-primary",
        )}
      >
        {done ? done.ok === false ? <X className="size-3" /> : <Check className="size-3" /> : n}
      </span>
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        {done && (
          <span className="text-xs text-muted-foreground">
            {done.ok === false ? "Stopped" : "Yes"} · {done.by}
            {time ? ` · ${time}` : ""}
            {done.note ? ` · “${done.note}”` : ""}
          </span>
        )}
      </span>
    </li>
  )

  const deciding = r.stage === "checking" || r.stage === "approving"
  const decideStep = r.stage === "checking" ? "checked" : "approved"

  return (
    <article className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-muted-foreground">
            {r.kind === "status" ? "Ads on or off" : "Change during Google's learning period"}
          </span>
          <h3 className="font-semibold">{requestTitle(r)}</h3>
        </div>
        <Pill tone={stage.tone}>{stage.label}</Pill>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        {r.campaigns.length > 1 && <p className="text-muted-foreground">{r.campaigns.map((c) => c.name).join(", ")}</p>}
        {r.learning?.length ? (
          <ul className="flex flex-col gap-0.5 text-xs">
            {r.learning.map((l) => (
              <li key={l.campaign}>
                <span className="font-medium">{l.campaign}</span>: {l.reason.toLowerCase()}
              </li>
            ))}
          </ul>
        ) : null}
        <p>
          <span className="text-muted-foreground">Why: </span>
          {r.reason}
        </p>
      </div>

      <ol className="grid gap-2 sm:grid-cols-4">
        {step(1, "Requested", { by: r.requested.by }, r.times.requested, false)}
        {step(2, "Checked", r.checked, r.times.checked, r.stage === "checking")}
        {step(3, "Approved", r.approved, r.times.approved, r.stage === "approving")}
        {step(4, r.kind === "status" ? "Applied in Google Ads" : "Change went through", r.applied, r.times.applied, r.stage === "ready")}
      </ol>

      {deciding && (
        <div className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
          <p className="text-sm font-medium">
            {r.stage === "checking"
              ? r.kind === "status"
                ? "Check: is turning these campaigns " + (r.status === "ENABLED" ? "on" : "off") + " right?"
                : "Check: is this change worth resetting Google's learning for?"
              : "Approve it?"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!personName && (
              <input
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                aria-label="Your name"
                className="h-8 w-36 rounded-lg border border-input bg-background px-2 text-sm"
              />
            )}
            <input
              autoComplete="off"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              aria-label="Note"
              className="h-8 min-w-40 flex-1 rounded-lg border border-input bg-background px-2 text-sm"
            />
            <Button type="button" size="sm" disabled={busy} onClick={() => run(() => decideRequestAction(r.id, decideStep, true, name, note))}>
              <Check data-icon="inline-start" /> {r.stage === "checking" ? "Looks right" : "Approve"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => decideRequestAction(r.id, decideStep, false, name, note))}
            >
              <X data-icon="inline-start" /> {r.stage === "checking" ? "Stop it" : "Don't approve"}
            </Button>
          </div>
        </div>
      )}

      {r.stage === "ready" && r.kind === "status" && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
          {admin ? (
            <>
              {!personName && (
                <input
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  aria-label="Your name"
                  className="h-8 w-36 rounded-lg border border-input bg-background px-2 text-sm"
                />
              )}
              <Button
                type="button"
                size="sm"
                variant={r.status === "PAUSED" ? "destructive" : "default"}
                disabled={busy}
                onClick={() => run(() => applyStatusRequestAction(r.id, name))}
              >
                {r.status === "ENABLED" ? "Turn on in Google Ads" : "Pause in Google Ads"}
              </Button>
              <span className="text-xs">
                Turning ads on or off resets Google&apos;s learning, so it only happens here, after a check and an approval.
              </span>
            </>
          ) : (
            <span>Approved. An admin applies it in Google Ads from this page.</span>
          )}
        </div>
      )}

      {r.stage === "ready" && r.kind === "learning" && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
          Approved. Push the change again from where it was held; it goes through once. The approval lasts 7 days.
        </p>
      )}

      {r.applied?.failures.length ? <p className="text-xs text-destructive">Failed: {r.applied.failures.join("; ")}</p> : null}
      {r.applied?.dryRun && <p className="text-xs text-muted-foreground">Dry run: Google checked the change and applied nothing.</p>}
      {message && (
        <p role="status" className={message.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>
          {message.text}
        </p>
      )}
    </article>
  )
}
