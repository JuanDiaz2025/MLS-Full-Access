"use client"

// The campaign check table: what standard negatives each campaign is missing, and a button that
// drafts them into a normal batch for the chosen campaigns.

import { useState, useTransition } from "react"

import { draftStandardBatch } from "@/app/actions/negatives"
import { formatNumber, formatUsd } from "@/components/dashboard/format"
import { useWorkspace } from "@/components/negatives/context"
import { Segmented } from "@/components/negatives/parts"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { CheckResult } from "@/lib/campaign-check"
import { cn } from "@/lib/utils"

const WORDS_SHOWN = 8

type Show = "all" | "running" | "paused" | "waste"

export default function CampaignCheck({ check, listName }: { check: CheckResult; listName: string }) {
  const { name, openBatch, setNotice } = useWorkspace()
  const running = check.campaigns.filter((c) => c.status === "ENABLED").map((c) => c.id)
  const [picked, setPicked] = useState<string[]>(running)
  const [show, setShow] = useState<Show>("all")
  const [search, setSearch] = useState("")
  const [busy, startTransition] = useTransition()

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const term = search.trim().toLowerCase()
  const shown = check.campaigns.filter(
    (c) =>
      (show === "all" || (show === "running" ? c.status === "ENABLED" : show === "paused" ? c.status !== "ENABLED" : c.waste > 0)) &&
      (!term || c.name.toLowerCase().includes(term)),
  )
  const allShownPicked = shown.length > 0 && shown.every((c) => picked.includes(c.id))
  const totalWaste = check.campaigns.reduce((s, c) => s + c.waste, 0)
  const draft = () =>
    startTransition(async () => {
      const r = await draftStandardBatch(picked, name)
      setNotice(r)
      if (r.ok && r.batchId) openBatch(r.batchId)
    })

  return (
    <section id="campaign-check" aria-labelledby="check-title" className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-3xl flex-col gap-1">
          <h2 id="check-title" className="font-semibold">
            Campaign check
          </h2>
          <p className="text-sm text-muted-foreground">
            Which of the {check.standard} standard negatives each campaign doesn&apos;t block yet, and what it spent in the last 12 months on such
            searches that nothing blocks. A campaign that bids on a word itself (a competitor or city campaign) isn&apos;t counted as missing it.
          </p>
        </div>
        <dl className="flex gap-4 text-right text-xs text-muted-foreground">
          <div>
            <dt>Campaigns</dt>
            <dd className="text-lg font-semibold text-foreground tabular-nums">{check.campaigns.length}</dd>
          </div>
          <div>
            <dt>Still not blocked</dt>
            <dd className="text-lg font-semibold text-amber-800 tabular-nums">{formatUsd(totalWaste)}</dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Show>
          label="Show campaigns"
          value={show}
          onChange={setShow}
          options={[
            { id: "all", label: `All ${check.campaigns.length}` },
            { id: "running", label: `Running ${running.length}` },
            { id: "paused", label: `Paused ${check.campaigns.length - running.length}` },
            { id: "waste", label: `Still spending ${check.campaigns.filter((c) => c.waste > 0).length}` },
          ]}
        />
        <input
          type="search"
          aria-label="Search campaigns"
          placeholder="Search campaigns"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm sm:ml-auto sm:w-56"
        />
      </div>

      <div className="max-h-[62vh] overflow-auto rounded-xl border">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  autoComplete="off"
                  aria-label="Choose every campaign shown"
                  checked={allShownPicked}
                  onChange={() =>
                    setPicked((p) => (allShownPicked ? p.filter((id) => !shown.some((c) => c.id === id)) : [...new Set([...p, ...shown.map((c) => c.id)])]))
                  }
                  className="size-4"
                />
              </th>
              <th scope="col" className="px-3 py-2 font-medium">Campaign</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Search spend</th>
              <th scope="col" className="px-3 py-2 font-medium">Negatives it has</th>
              <th scope="col" className="px-3 py-2 font-medium">Standard ones missing</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Still not blocked</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} className={cn("border-t border-border/60 align-top", picked.includes(c.id) && "bg-primary/5")}>
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                  autoComplete="off"
                    aria-label={`Choose ${c.name}`}
                    checked={picked.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    className="mt-0.5 size-4"
                  />
                </td>
                <td className="px-3 py-2.5">
                  <span className="flex flex-col items-start gap-1">
                    <span className="font-medium">{c.name}</span>
                    <Pill tone={c.status === "ENABLED" ? "green" : "gray"}>{c.status === "ENABLED" ? "Running" : "Paused"}</Pill>
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatUsd(c.spend)}</td>
                <td className="px-3 py-2.5">
                  <span className="flex flex-col gap-0.5 text-xs">
                    <span className="text-sm tabular-nums">{formatNumber(c.negatives)}</span>
                    {c.hasStandardList && <Pill tone="green">Has “{listName}”</Pill>}
                    <span className="text-muted-foreground">{c.lists.filter((l) => l !== listName).join(", ") || "No shared lists"}</span>
                  </span>
                </td>
                <td className="px-3 py-2.5">
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
                <td className="px-3 py-2.5 text-right">
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
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No campaign matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Stays in reach while scrolling the table. */}
      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-xl border bg-card/95 px-3 py-2 shadow-lg backdrop-blur">
        <Button type="button" disabled={busy || !picked.length} onClick={draft}>
          {busy ? "Drafting…" : `Draft a batch for ${picked.length} campaign${picked.length === 1 ? "" : "s"}`}
        </Button>
        <span className="text-sm">
          <span className="font-medium tabular-nums">{picked.length}</span> chosen
        </span>
        <span className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(running)}>
            Running only
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(check.campaigns.filter((c) => c.missing > 0).map((c) => c.id))}>
            All missing something
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!picked.length} onClick={() => setPicked([])}>
            Clear
          </Button>
        </span>
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
