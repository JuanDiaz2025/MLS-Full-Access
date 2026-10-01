"use client"

// The New batch tab: two ways to start a batch, side by side. From a period's search terms
// (last week by default, or any dates and any one campaign), or from the campaign check.

import { useState, useTransition } from "react"
import { ListChecks, Search } from "lucide-react"

import { draftNegativeBatch } from "@/app/actions/negatives"
import type { CampaignOption } from "@/components/changes/shared"
import { useWorkspace } from "@/components/negatives/context"
import { Segmented } from "@/components/negatives/parts"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Shortcuts for the period; "Bateman" is the agency's run (see lib/date-range.ts).
function quickPeriods(lastWeek: { from: string; to: string }, today: string) {
  const back = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toISOString().slice(0, 10)
  }
  return [
    { id: "week", label: "Last week", from: lastWeek.from, to: lastWeek.to },
    { id: "30", label: "Last 30 days", from: back(29), to: today },
    { id: "90", label: "Last 90 days", from: back(89), to: today },
    { id: "bateman", label: "Bateman (Jun 5 – Jul 23)", from: "2026-06-05", to: "2026-07-23" },
  ]
}

export default function NewBatch({
  campaigns,
  lastWeek,
  today,
}: {
  campaigns: CampaignOption[]
  lastWeek: { from: string; to: string }
  today: string
}) {
  const { name, openBatch, setNotice, setTab } = useWorkspace()
  const [from, setFrom] = useState(lastWeek.from)
  const [to, setTo] = useState(lastWeek.to)
  const [campaignId, setCampaignId] = useState("")
  const [busy, startTransition] = useTransition()
  const quick = quickPeriods(lastWeek, today)
  const preset = quick.find((q) => q.from === from && q.to === to)?.id ?? "custom"
  const running = campaigns.filter((c) => c.status === "ENABLED")
  const others = campaigns.filter((c) => c.status !== "ENABLED")
  const field = "h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"

  const draft = () =>
    startTransition(async () => {
      const r = await draftNegativeBatch({ from, to, campaignId }, name)
      setNotice(r)
      if (r.ok && r.batchId) openBatch(r.batchId)
    })

  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <section aria-labelledby="from-terms" className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Search className="size-4" aria-hidden />
          </span>
          <div>
            <h2 id="from-terms" className="font-semibold">
              From search terms
            </h2>
            <p className="text-sm text-muted-foreground">
              The weekly routine: last week&apos;s searches that cost money and brought nothing. Or pick any dates and one campaign, paused ones too, to
              clean up older campaigns.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Period</span>
          <Segmented
            label="Period"
            value={preset}
            onChange={(id) => {
              const q = quick.find((x) => x.id === id)
              if (q) {
                setFrom(q.from)
                setTo(q.to)
              }
            }}
            options={[...quick.map((q) => ({ id: q.id, label: q.label })), ...(preset === "custom" ? [{ id: "custom", label: "Custom" }] : [])]}
          />
          <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <input type="date" autoComplete="off" aria-label="From" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className={field} />
            <span className="text-sm text-muted-foreground">to</span>
            <input type="date" autoComplete="off" aria-label="To" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className={field} />
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Campaign</span>
          <select autoComplete="off" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={field}>
            <option value="">All campaigns</option>
            {running.length > 0 && (
              <optgroup label="Running">
                {running.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Paused or ended">
                {others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="lg" disabled={busy || !from || !to} onClick={draft}>
            {busy ? "Drafting…" : "Draft batch"}
          </Button>
          <span className={cn("text-xs text-muted-foreground", !name.trim() && "text-amber-800")}>
            {name.trim() ? `Drafted by ${name.trim()}` : "Type your name at the top first"}
          </span>
        </div>
      </section>

      <section aria-labelledby="from-check" className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ListChecks className="size-4" aria-hidden />
          </span>
          <div>
            <h2 id="from-check" className="font-semibold">
              From the campaign check
            </h2>
            <p className="text-sm text-muted-foreground">
              The standard negatives a campaign is missing: competitors, places outside California, agents, renters, loans and more. Best before you
              turn a paused campaign back on.
            </p>
          </div>
        </div>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          <li>See what each campaign has and misses</li>
          <li>Tick campaigns, draft one batch for all of them</li>
          <li>Push into one shared list every campaign can use</li>
        </ul>
        <div className="mt-auto">
          <Button type="button" variant="outline" size="lg" onClick={() => setTab("check")}>
            Open the campaign check
          </Button>
        </div>
      </section>
    </div>
  )
}
