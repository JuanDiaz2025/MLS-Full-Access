"use client"

// The campaign check table: what standard negatives each campaign is missing, and a button that
// drafts them into a normal batch for the chosen campaigns.

import { useState, useTransition } from "react"

import { draftStandardBatch, type StepResult } from "@/app/actions/negatives"
import { formatNumber, formatUsd } from "@/components/dashboard/format"
import { useName } from "@/components/negatives-name"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { CheckResult } from "@/lib/campaign-check"
import { cn } from "@/lib/utils"

const WORDS_SHOWN = 8

export default function CampaignCheck({ check, listName }: { check: CheckResult; listName: string }) {
  const { name } = useName()
  const running = check.campaigns.filter((c) => c.status === "ENABLED").map((c) => c.id)
  const [picked, setPicked] = useState<string[]>(running)
  const [message, setMessage] = useState<StepResult | null>(null)
  const [busy, startTransition] = useTransition()

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const withGaps = check.campaigns.filter((c) => c.missing > 0).map((c) => c.id)
  const draft = () =>
    startTransition(async () => {
      setMessage(await draftStandardBatch(picked, name))
    })

  const chip = "rounded-full border bg-background px-2.5 py-0.5 text-xs font-medium hover:bg-muted"
  return (
    <section id="campaign-check" className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">Campaign check</h2>
        <p className="text-sm text-muted-foreground">
          Which of the {check.standard} standard negatives (competitors, cities outside the buy area, agents, home buyers, renters, loans, jobs, listing
          sites, price checks) each campaign doesn&apos;t block yet, and what it spent in the last 12 months on such searches that nothing blocks. A
          campaign that bids on one of these words itself (a competitor or city campaign) isn&apos;t counted as missing it. Running campaigns first, then
          the paused ones with the most search spend.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Choose:</span>
        <button type="button" className={chip} onClick={() => setPicked(running)}>
          Running ({running.length})
        </button>
        <button type="button" className={chip} onClick={() => setPicked(withGaps)}>
          All missing something ({withGaps.length})
        </button>
        <button type="button" className={chip} onClick={() => setPicked([])}>
          None
        </button>
        <Button type="button" className="ml-auto" disabled={busy || !picked.length} onClick={draft}>
          {busy ? "Drafting…" : `Draft a batch for ${picked.length} campaign${picked.length === 1 ? "" : "s"}`}
        </Button>
      </div>
      {message && (
        <p role="status" className={cn("text-sm", message.ok ? "text-emerald-700" : "text-destructive")}>
          {message.message}
        </p>
      )}

      <div className="-mx-4 overflow-x-auto sm:-mx-5">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="w-8 px-4 py-2 sm:pl-5">
                <span className="sr-only">Choose</span>
              </th>
              <th scope="col" className="px-4 py-2 font-medium">Campaign</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Search spend</th>
              <th scope="col" className="px-4 py-2 font-medium">Negatives it has</th>
              <th scope="col" className="px-4 py-2 font-medium">Standard ones missing</th>
              <th scope="col" className="px-4 py-2 text-right font-medium sm:pr-5">Still not blocked</th>
            </tr>
          </thead>
          <tbody>
            {check.campaigns.map((c) => (
              <tr key={c.id} className="border-b border-border/60 align-top last:border-0">
                <td className="px-4 py-2.5 sm:pl-5">
                  <input
                    type="checkbox"
                    aria-label={`Choose ${c.name}`}
                    checked={picked.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    className="mt-0.5 size-4"
                  />
                </td>
                <td className="px-4 py-2.5">
                  <span className="flex flex-col items-start gap-1">
                    <span className="font-medium">{c.name}</span>
                    <Pill tone={c.status === "ENABLED" ? "green" : "gray"}>{c.status === "ENABLED" ? "Running" : "Paused"}</Pill>
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatUsd(c.spend)}</td>
                <td className="px-4 py-2.5">
                  <span className="flex flex-col gap-0.5 text-xs">
                    <span className="text-sm tabular-nums">{formatNumber(c.negatives)}</span>
                    {c.hasStandardList && <Pill tone="green">Has “{listName}”</Pill>}
                    <span className="text-muted-foreground">{c.lists.filter((l) => l !== listName).join(", ") || "No shared lists"}</span>
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  {c.missing === 0 ? (
                    <Pill tone="green">None</Pill>
                  ) : (
                    <details>
                      <summary className="cursor-pointer text-sm">
                        <span className="font-medium tabular-nums">{c.missing}</span>
                        <span className="text-xs text-muted-foreground"> · {c.gaps.map((g) => `${g.label} ${g.missing.length}`).join(", ")}</span>
                      </summary>
                      <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                        {c.gaps.map((g) => (
                          <li key={g.rule}>
                            <span className="font-medium text-foreground">{g.label}:</span> {g.missing.slice(0, WORDS_SHOWN).join(", ")}
                            {g.missing.length > WORDS_SHOWN && ` and ${g.missing.length - WORDS_SHOWN} more`}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right sm:pr-5">
                  <span className="flex flex-col items-end gap-0.5">
                    <span className={cn("tabular-nums", c.waste >= 100 && "font-medium text-amber-800")}>{formatUsd(c.waste)}</span>
                    {c.wasteSearches.length > 0 && (
                      <span className="max-w-56 text-[11px] text-muted-foreground" title={c.wasteSearches.join("; ")}>
                        {c.wasteSearches.slice(0, 2).join("; ")}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {check.heldBack.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-primary">
            Never suggested here: {check.heldBack.length} standard negative{check.heldBack.length === 1 ? "" : "s"} that would block good searches
          </summary>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
            {check.heldBack.map((h) => (
              <li key={h.negative}>
                <span className="font-medium text-foreground">&ldquo;{h.negative}&rdquo;</span> would block {h.converting.join("; ")}
              </li>
            ))}
          </ul>
          <p className="mt-1">These blocked a search that converted in the last 12 months, or one from a seller saying &ldquo;sell&rdquo;. Add them by hand only for campaigns where that&apos;s fine.</p>
        </details>
      )}
    </section>
  )
}
