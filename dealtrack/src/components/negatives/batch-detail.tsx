"use client"

// One batch, top to bottom: what it is, where it stands (the five steps), what to do next with
// its buttons, then the lines (filterable, in their own scroll area) and the extras.

import { useState, useTransition } from "react"
import { Check } from "lucide-react"

import {
  checkNegativeBatch,
  discardNegativeBatch,
  finishNegativeStep,
  markAllNegativeLines,
  markNegativeLine,
  reopenNegativeStep,
  type StepResult,
} from "@/app/actions/negatives"
import { formatNumber, formatUsd } from "@/components/dashboard/format"
import { useWorkspace } from "@/components/negatives/context"
import { Choice, Decision, Segmented, batchCost, batchScope, batchTitle, stageLabel, type BatchView, type Shared } from "@/components/negatives/parts"
import PushPanel from "@/components/negatives/push-panel"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { BatchItem } from "@/lib/store"
import { cn } from "@/lib/utils"

type Filter = "all" | "open" | "kept" | "dropped"
const SHOWN_CAMPAIGNS = 3
const COVERING_SHOWN = 12

export default function BatchDetail({ batch: b, shared }: { batch: BatchView; shared: Shared }) {
  const { name, setNotice } = useWorkspace()
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const [filter, setFilter] = useState<Filter>("all")

  const run = (key: string, step: () => Promise<StepResult>) => {
    setBusy(key)
    startTransition(async () => {
      setNotice(await step())
      setBusy(null)
    })
  }

  const proving = b.stage === "proving"
  const approving = b.stage === "approving"
  const stage = stageLabel[b.stage]
  const cost = batchCost(b)

  // The step a line is in decides what "open", "kept" and "dropped" mean.
  const decision = (i: BatchItem) => (approving || b.approved ? (i.proven ? i.approved : false) : i.proven)
  const rows = b.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const d = decision(item)
      return filter === "all" || (filter === "open" ? d === null : filter === "kept" ? d === true : d === false)
    })
  const count = (f: Filter) => b.items.filter((i) => (f === "open" ? decision(i) === null : f === "kept" ? decision(i) === true : decision(i) === false)).length

  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5" aria-labelledby="batch-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="batch-title" className="text-lg font-semibold">
            {batchTitle(b)}
            <span className="font-normal text-muted-foreground"> · {batchScope(b)}</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {b.kind === "standard"
              ? b.items.length
                ? `${b.items.length} standard negatives these campaigns don't block yet. Searches they'd have blocked in the last 12 months cost ${formatUsd(cost)}.`
                : "These campaigns already block every standard negative."
              : b.items.length
                ? `${b.items.length} negative keyword${b.items.length === 1 ? "" : "s"} for searches that cost ${formatUsd(cost)} and brought no conversions.`
                : "No search in this period matched the rules without converting."}
          </p>
          {b.kind === "standard" && (b.forCampaigns?.length ?? 0) > 1 && (
            <p className="text-xs text-muted-foreground">For: {b.forCampaigns!.join(", ")}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={stage.tone}>{stage.label}</Pill>
          {!b.pushed && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm("Discard this batch? Its reviews and approvals are deleted.")) run("discard", () => discardNegativeBatch(b.id, name))
              }}
            >
              Discard
            </Button>
          )}
        </div>
      </header>

      <Steps b={b} />
      <NextStep b={b} shared={shared} busy={busy} run={run} />

      {b.items.length > 0 && (
        <section aria-label="Lines" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Lines</h3>
            <Segmented<Filter>
              label="Show lines"
              value={filter}
              onChange={setFilter}
              options={[
                { id: "all", label: `All ${b.items.length}` },
                { id: "open", label: `Needs a decision ${count("open")}` },
                { id: "kept", label: `${approving || b.approved ? "Approved" : "Holds up"} ${count("kept")}` },
                { id: "dropped", label: `${approving || b.approved ? "Rejected or dropped" : "Dropped"} ${count("dropped")}` },
              ]}
            />
          </div>
          <div className="max-h-[60vh] overflow-auto rounded-xl border">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">Negative keyword</th>
                  <th scope="col" className="px-3 py-2 font-medium">Searches it blocks</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Clicks</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Spend</th>
                  <th scope="col" className="px-3 py-2 font-medium">Review</th>
                  <th scope="col" className="px-3 py-2 font-medium">Approval</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item, index }) => (
                  <Line key={item.negative} b={b} item={item} index={index} busy={busy} run={run} shared={shared} />
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      No lines here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(b.heldBack.length > 0 || b.alreadyNegative.length > 0) && (
        <section aria-label="Left out" className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          {b.heldBack.length > 0 && (
            <details>
              <summary className="cursor-pointer font-medium text-primary">
                Held back: {b.heldBack.length} suggestion{b.heldBack.length === 1 ? "" : "s"} that would also block good searches
              </summary>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
                {b.heldBack.map((h) => (
                  <li key={h.negative}>
                    <span className="font-medium text-foreground">&ldquo;{h.negative}&rdquo;</span> ({h.why.toLowerCase()}) would block {h.converting.join("; ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {b.alreadyNegative.length > 0 && (
            <p>
              Left out because negatives already in Google Ads block them: {b.alreadyNegative.slice(0, COVERING_SHOWN).join(", ")}
              {b.alreadyNegative.length > COVERING_SHOWN ? ` and ${b.alreadyNegative.length - COVERING_SHOWN} more` : ""}.
            </p>
          )}
        </section>
      )}
    </article>
  )
}

function Steps({ b }: { b: BatchView }) {
  const steps = [
    { key: "drafted", done: "Drafted", todo: "Draft", who: b.drafted.by },
    { key: "proven", done: "Reviewed", todo: "Review", who: b.proven?.by },
    { key: "approved", done: "Approved", todo: "Approve", who: b.approved?.by },
    { key: "pushed", done: b.pushed?.dryRun ? "Pushed (dry run)" : "Pushed", todo: "Admin pushes", who: b.pushed?.by },
    { key: "checked", done: "Result checked", todo: "Result check", who: b.checked?.by },
  ] as const
  // With nothing left to push, the remaining steps don't apply.
  const closed = b.stage === "empty" || b.stage === "nothing-approved"
  const current = steps.findIndex((s) => !s.who)
  return (
    <ol className="grid grid-cols-5 gap-1 text-[11px] sm:text-xs" aria-label="Steps">
      {steps.map((s, i) => {
        const done = !!s.who
        const now = !done && !closed && i === current
        return (
          <li key={s.key} aria-current={now ? "step" : undefined} className="flex min-w-0 flex-col gap-1">
            <span className={cn("h-1.5 rounded-full", done ? "bg-emerald-500" : now ? "bg-primary" : "bg-muted")} />
            <span className={cn("flex items-center gap-1 font-medium", !done && !now && "text-muted-foreground", closed && !done && "line-through opacity-60")}>
              {done && <Check className="size-3 shrink-0 text-emerald-600" aria-hidden />}
              <span className="truncate">{done ? s.done : s.todo}</span>
            </span>
            {done && (
              <span className="truncate text-muted-foreground" title={`${s.who}${b.times[s.key] ? `, ${b.times[s.key]}` : ""}`}>
                {s.who}
                {b.times[s.key] ? `, ${b.times[s.key]}` : ""}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// What to do now, with the buttons for it, so nobody has to scroll to the bottom of the lines.
function NextStep({
  b,
  shared,
  busy,
  run,
}: {
  b: BatchView
  shared: Shared
  busy: string | null
  run: (key: string, step: () => Promise<StepResult>) => void
}) {
  const { name } = useWorkspace()
  const openProof = b.items.filter((i) => i.proven === null).length
  const openApproval = b.items.filter((i) => i.proven && i.approved === null).length
  const approvedCount = b.items.filter((i) => i.proven && i.approved).length
  const off = busy !== null

  const box = (tone: "violet" | "amber" | "gray" | "green", title: string, body: React.ReactNode, actions?: React.ReactNode) => (
    <section
      aria-label="Next step"
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        tone === "violet" && "border-primary/30 bg-primary/5",
        tone === "amber" && "border-amber-300 bg-amber-50/60",
        tone === "gray" && "bg-muted/30",
        tone === "green" && "border-emerald-300 bg-emerald-50/60",
      )}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="text-sm text-muted-foreground">{body}</div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  )

  switch (b.stage) {
    case "proving":
      return box(
        "violet",
        `Review: ${openProof ? `${openProof} of ${b.items.length} lines need a decision` : "every line has a decision"}`,
        "For each line, check the searches it blocks: Holds up if they're not sellers you want, Drop if they are.",
        <>
          <Button type="button" disabled={off || openProof > 0} onClick={() => run("prove", () => finishNegativeStep(b.id, "proven", name))}>
            {busy === "prove" ? "Saving…" : "Review done"}
          </Button>
          {openProof > 1 && (
            <>
              <Button type="button" variant="outline" disabled={off} onClick={() => run("all-p1", () => markAllNegativeLines(b.id, "proven", true, name))}>
                The {openProof} left hold up
              </Button>
              <Button type="button" variant="outline" disabled={off} onClick={() => run("all-p0", () => markAllNegativeLines(b.id, "proven", false, name))}>
                Drop the {openProof} left
              </Button>
            </>
          )}
        </>,
      )
    case "approving":
      return box(
        "violet",
        `Approve: ${openApproval ? `${openApproval} reviewed line${openApproval === 1 ? "" : "s"} to approve or reject` : "every line has a decision"}`,
        "Ideally someone other than the reviewer. Only lines that held up are here.",
        <>
          <Button type="button" disabled={off || openApproval > 0} onClick={() => run("approve", () => finishNegativeStep(b.id, "approved", name))}>
            {busy === "approve" ? "Saving…" : "Approval done"}
          </Button>
          {openApproval > 1 && (
            <>
              <Button type="button" variant="outline" disabled={off} onClick={() => run("all-a1", () => markAllNegativeLines(b.id, "approved", true, name))}>
                Approve the {openApproval} left
              </Button>
              <Button type="button" variant="outline" disabled={off} onClick={() => run("all-a0", () => markAllNegativeLines(b.id, "approved", false, name))}>
                Reject the {openApproval} left
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" disabled={off} onClick={() => run("reopen-p", () => reopenNegativeStep(b.id, "proven", name))}>
            Reopen review
          </Button>
        </>,
      )
    case "ready":
      return (
        <section aria-label="Next step" className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">
                Push: {approvedCount} approved negative{approvedCount === 1 ? "" : "s"} go to Google Ads in one change
              </h3>
              <p className="text-sm text-muted-foreground">Choose where they go, then confirm.</p>
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={off} onClick={() => run("reopen-a", () => reopenNegativeStep(b.id, "approved", name))}>
              Reopen approval
            </Button>
          </div>
          <PushPanel batch={b} shared={shared} />
        </section>
      )
    case "nothing-approved":
      return box(
        "gray",
        "Nothing to push",
        b.approved ? "No line was approved, so this batch is done." : "No line held up in review, so this batch is done.",
        <Button
          type="button"
          variant="outline"
          disabled={off}
          onClick={() => run(b.approved ? "reopen-a" : "reopen-p", () => reopenNegativeStep(b.id, b.approved ? "approved" : "proven", name))}
        >
          {b.approved ? "Reopen approval" : "Reopen review"}
        </Button>,
      )
    case "empty":
      return box("gray", "Nothing to add", "Every search in this period either converted, says the person wants to sell, or is already blocked. You can discard this batch.")
    case "pushed":
      return box(
        "green",
        b.checkReady ? "Check the result" : `Result check on ${b.checkDayLabel}`,
        <Pushed b={b} />,
        b.checkReady && (
          <Button type="button" disabled={off} onClick={() => run("check", () => checkNegativeBatch(b.id, name))}>
            {busy === "check" ? "Checking…" : "Check the result"}
          </Button>
        ),
      )
    case "checked":
      return box(
        "green",
        "Done",
        <div className="flex flex-col gap-3">
          <Pushed b={b} />
          <Result b={b} />
        </div>,
      )
  }
}

function Line({
  b,
  item,
  index,
  busy,
  run,
  shared,
}: {
  b: BatchView
  item: BatchItem
  index: number
  busy: string | null
  run: (key: string, step: () => Promise<StepResult>) => void
  shared: Shared
}) {
  const { name } = useWorkspace()
  const proving = b.stage === "proving"
  const approving = b.stage === "approving"
  const status = new Map(shared.campaigns.map((c) => [c.id, c.status]))
  const shown = item.matchType === "EXACT" ? `[${item.negative}]` : `"${item.negative}"`
  return (
    <tr className="border-t border-border/60 align-top">
      <td className="px-3 py-2.5">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{shown}</span>
          <span className="text-xs text-muted-foreground">{item.why}</span>
        </span>
      </td>
      <td className="px-3 py-2.5 text-xs">
        {item.terms.length === 0 ? (
          <p className="text-muted-foreground">No searches yet: standard protection for when these campaigns run.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {item.terms.slice(0, 3).map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
        {item.termCount > Math.min(3, item.terms.length) && item.terms.length > 0 && (
          <span className="text-[11px] text-muted-foreground" title={item.terms.join("; ")}>
            and {formatNumber(item.termCount - Math.min(3, item.terms.length))} more
          </span>
        )}
        {item.campaigns && item.campaigns.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">From: </span>
            {item.campaigns
              .slice(0, SHOWN_CAMPAIGNS)
              .map((c) => `${c.name} (${formatUsd(c.cost)}${status.get(c.id) === "ENABLED" ? ", running" : ""})`)
              .join("; ")}
            {item.campaigns.length > SHOWN_CAMPAIGNS && ` and ${item.campaigns.length - SHOWN_CAMPAIGNS} more`}
          </p>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(item.clicks)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums">{formatUsd(item.cost)}</td>
      <td className="px-3 py-2.5">
        {proving ? (
          <Choice
            label={`Review ${shown}`}
            value={item.proven}
            yes="Holds up"
            no="Drop"
            disabled={busy !== null}
            busy={busy === `p${index}`}
            onPick={(v) => run(`p${index}`, () => markNegativeLine(b.id, index, "proven", v, name))}
          />
        ) : (
          <Decision value={item.proven} by={item.provenBy} yes="Holds up" no="Dropped" />
        )}
      </td>
      <td className="px-3 py-2.5">
        {approving && item.proven ? (
          <Choice
            label={`Approve ${shown}`}
            value={item.approved}
            yes="Approve"
            no="Reject"
            disabled={busy !== null}
            busy={busy === `a${index}`}
            onPick={(v) => run(`a${index}`, () => markNegativeLine(b.id, index, "approved", v, name))}
          />
        ) : item.proven === false ? (
          <span className="text-xs text-muted-foreground">Dropped in review</span>
        ) : (
          <Decision value={item.approved} by={item.approvedBy} yes="Approved" no="Rejected" />
        )}
      </td>
    </tr>
  )
}

function Pushed({ b }: { b: BatchView }) {
  const p = b.pushed!
  return (
    <div className="flex flex-col gap-1 text-sm text-foreground">
      {p.dryRun && <p className="text-xs font-medium text-amber-800">Dry run: Google checked this push and changed nothing.</p>}
      <p>
        <span className="font-medium">Pushed by {p.by}</span>
        {b.times.pushed ? ` on ${b.times.pushed}` : ""} to {p.list ? `the list "${p.list}", attached to ` : ""}
        {p.campaignNames.join(", ")}: {formatNumber(p.added)} added
        {p.skipped ? `, ${formatNumber(p.skipped)} already there` : ""}
        {p.failures.length ? `, ${p.failures.length} failed` : ""}.
      </p>
      {p.failures.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {p.failures.slice(0, 5).map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Result({ b }: { b: BatchView }) {
  const c = b.checked!
  const worked = c.blockedSpendAfter < c.blockedSpendBefore * 0.2 || c.blockedSpendAfter < 5
  const leadsHeld = c.leadsAfter >= c.leadsBefore * 0.8 || c.leadsBefore === 0
  return (
    <div className="grid gap-3 text-sm text-foreground sm:grid-cols-3">
      <div>
        <p className="text-xs text-muted-foreground">Spend on the blocked searches</p>
        <p className="font-medium tabular-nums">
          {formatUsd(c.blockedSpendBefore)} → {formatUsd(c.blockedSpendAfter)}
        </p>
        <p className={cn("text-xs", worked ? "text-emerald-700" : "text-amber-800")}>{worked ? "Blocked, as planned" : "Still spending: check the campaigns it went to"}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Leads, week before → week after</p>
        <p className="font-medium tabular-nums">
          {formatNumber(c.leadsBefore)} → {formatNumber(c.leadsAfter)}
        </p>
        <p className={cn("text-xs", leadsHeld ? "text-emerald-700" : "text-amber-800")}>{leadsHeld ? "Leads held up" : "Leads dropped: see if a negative blocked good searches"}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">All spend, week before → week after</p>
        <p className="font-medium tabular-nums">
          {formatUsd(c.spendBefore)} → {formatUsd(c.spendAfter)}
        </p>
        <p className="text-xs text-muted-foreground">
          Checked by {c.by}
          {b.times.checked ? ` on ${b.times.checked}` : ""}
        </p>
      </div>
    </div>
  )
}
