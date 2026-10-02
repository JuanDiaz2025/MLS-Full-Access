"use client"

import { useState, useTransition } from "react"
import { Gauge } from "lucide-react"

import { setAutoStatusAction } from "@/lib/leads/scoring-actions"
import { cn } from "@/lib/utils"

// Automatic lead scoring: what it does, how points are given, and the switch for setting the
// status from the score.
export default function ScoringSettings({ autoStatus }: { autoStatus: boolean }) {
  const [on, setOn] = useState(autoStatus)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Gauge className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Automatic lead scoring</p>
          <p className="text-muted-foreground">
            Every lead gets a score from 0 to 100 the moment it arrives: <strong className="text-red-700">Hot</strong> (70+ and a sign
            they want to sell: a seller search or their own words),{" "}
            <strong className="text-amber-700">Warm</strong> (40 to 69), <strong className="text-sky-800">Cold</strong> or{" "}
            <strong>Junk</strong> (tests, fake numbers, spam). Click <strong>why?</strong> in the Score column to see how it was scored.
          </p>
        </div>
        <label className={cn("flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2", pending && "opacity-60")}>
          <input
            type="checkbox"
            role="switch"
            checked={on}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked
              setOn(next)
              setError(null)
              start(async () => {
                const res = await setAutoStatusAction(next)
                if (res.error) {
                  setOn(!next)
                  setError(res.error)
                }
              })
            }}
            className="size-5 accent-[var(--primary)]"
          />
          <span className="font-medium">Send new leads to Google Ads automatically</span>
        </label>
      </div>
      <p className={cn("rounded-lg p-3", on ? "bg-emerald-500/10 text-emerald-900" : "bg-card text-muted-foreground")}>
        {on ? (
          <>
            <strong>On.</strong> New leads go to Google Ads automatically: Hot leads as <strong>Qualified leads</strong>, and Junk is
            reported as an invalid lead (reporting only, never bid for). Google Ads recommends sending back only
            qualified leads like this, so its bidding finds more real sellers instead of more form-fillers. Lead statuses stay yours.
          </>
        ) : (
          <>
            <strong>Off.</strong> Leads are still scored, but Google Ads only hears about a lead when you set its status (Interested,
            Closed deal…).
          </>
        )}
      </p>
      <details>
        <summary className="cursor-pointer font-medium">How the points add up</summary>
        <ul className="mt-2 grid gap-x-6 gap-y-1 text-muted-foreground sm:grid-cols-2">
          <li>+25 a real phone number</li>
          <li>+20 a property address with a house number</li>
          <li>+15 a motivated seller (inherited, foreclosure, repairs, divorce, tenants, vacant…)</li>
          <li>+10 an email address</li>
          <li>+10 came from a paid ad click</li>
          <li>+10 searched like a seller (&ldquo;sell my house fast&rdquo;, &ldquo;cash offer&rdquo;…)</li>
          <li>+5 a full name</li>
          <li>+5 came back: sent a form before</li>
          <li>−15 a phone number that looks fake or incomplete</li>
          <li>−25 blocked as spam on the website (often reCAPTCHA; may be a real person)</li>
          <li>−30 a message with links, other than Zillow, Redfin, Realtor.com or map links (often spam)</li>
          <li>Junk: a test or fake name, an advert, or no real phone or email</li>
        </ul>
        <p className="mt-3 font-medium">When you change the status, the score updates right away</p>
        <ul className="mt-1 grid gap-x-6 gap-y-1 text-muted-foreground sm:grid-cols-2">
          <li>Interested: +15, at least 50</li>
          <li>Appointment: +25, at least 75 (Hot)</li>
          <li>Offer made: +35, at least 85 (Hot)</li>
          <li>Closed deal: 100 (Hot)</li>
          <li>Not interested: −40, never Hot</li>
          <li>Marking a lead Interested or further means it&apos;s real, so it&apos;s never counted as Junk</li>
        </ul>
        <p className="mt-2 text-muted-foreground">
          Only leads that arrived in the last 24 hours are sent automatically. Older leads (from before scoring, or brought in
          late from the website) are scored too, but nothing old is sent to Google Ads without you.
          A lead whose form fields weren&apos;t recognized is never sent automatically.
        </p>
      </details>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  )
}
