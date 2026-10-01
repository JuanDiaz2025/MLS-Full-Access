"use client"

import { useState, useTransition } from "react"
import { CircleAlert, CircleCheck, LoaderCircle, RefreshCw, Stethoscope } from "lucide-react"

import { Button } from "@/components/ui/button"
import { checkSendingAction, retryNowAction } from "@/lib/leads/conversion-target-actions"
import { cn } from "@/lib/utils"

type Step = { ok: boolean; title: string; detail: string }

// Google's messages carry links (e.g. straight to the switch for the right project): make them clickable.
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(https?:\/\/[^\s)“”]+)/).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="font-medium break-all underline">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  )
}

// "Check sending to Google Ads" and "Try again now", with what the check found, step by step.
export default function SendingCheck({ stuck, lastError }: { stuck: number; lastError?: string }) {
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [checking, startCheck] = useTransition()
  const [retrying, startRetry] = useTransition()
  const [note, setNote] = useState<string | null>(null)

  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border p-4 text-sm", stuck ? "border-destructive/40 bg-destructive/5" : "bg-muted/30")}>
      {stuck > 0 && (
        <div>
          <p className="font-semibold text-destructive">
            {stuck} lead{stuck === 1 ? "" : "s"} couldn&apos;t be sent to Google Ads yet
          </p>
          {lastError && (
            <p className="mt-1 text-destructive/90">
              Google said: <Linked text={lastError} />
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => startCheck(async () => setSteps((await checkSendingAction()).steps))} disabled={checking}>
          {checking ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Stethoscope data-icon="inline-start" />}
          {checking ? "Checking…" : "Check sending to Google Ads"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={retrying}
          onClick={() =>
            startRetry(async () => {
              setNote(null)
              const res = await retryNowAction()
              setNote(res.error ?? "Sent again. The Google Ads column shows how each lead did.")
            })
          }
        >
          {retrying ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          {retrying ? "Sending…" : "Try again now"}
        </Button>
        <a href="/api/conversions/connect" className="inline-flex items-center px-2 text-primary underline underline-offset-4">
          Connect Google for conversions
        </a>
      </div>
      {note && <p className="text-muted-foreground">{note}</p>}
      {steps && (
        <ol className="flex flex-col gap-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              {s.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
              <span>
                <strong>{s.title}:</strong> <span className={cn(!s.ok && "text-destructive")}>
                  <Linked text={s.detail} />
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
