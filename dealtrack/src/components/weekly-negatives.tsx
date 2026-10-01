"use client"

// The weekly negative keyword routine: draft, review, approve, push (admin), and
// the result check a week later. Every step records the name typed at the top.

import { useState, useTransition, type ReactNode } from "react"
import { Check, X } from "lucide-react"

import { pushNegativeBatchAction } from "@/app/actions/changes"
import {
  checkNegativeBatch,
  discardNegativeBatch,
  draftNegativeBatch,
  finishNegativeStep,
  markAllNegativeLines,
  markNegativeLine,
  reopenNegativeStep,
  type StepResult,
} from "@/app/actions/negatives"
import { CampaignPicker, List, runningIds, useChange, type CampaignOption } from "@/components/changes/shared"
import { formatNumber, formatUsd } from "@/components/dashboard/format"
import { useName } from "@/components/negatives-name"
import { Pill, type PillTone } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { Stage } from "@/lib/negative-batches"
import type { NegativeBatch } from "@/lib/store"
import { cn } from "@/lib/utils"

export type BatchView = NegativeBatch & {
  stage: Stage
  periodLabel: string
  times: Partial<Record<"drafted" | "proven" | "approved" | "pushed" | "checked", string>> // formatted
  checkDayLabel: string | null
  checkReady: boolean
}

type Props = {
  batches: BatchView[]
  lastWeek: { from: string; to: string } // the default period: the last complete Monday–Sunday week
  today: string
  campaigns: CampaignOption[] // every campaign that isn't removed, running ones first
  admin: boolean
  adminLink: ReactNode
  brakeNote: string | null // set while a push in the last 7 days blocks the next one
  dryRun: boolean
  listName: string // the shared list a push can go into
}

const stageLabel: Record<Stage, { tone: PillTone; label: string }> = {
  empty: { tone: "gray", label: "Nothing to add" },
  proving: { tone: "violet", label: "In review" },
  approving: { tone: "violet", label: "Waiting for approval" },
  ready: { tone: "amber", label: "Ready to push" },
  "nothing-approved": { tone: "gray", label: "Nothing approved" },
  pushed: { tone: "green", label: "Pushed" },
  checked: { tone: "green", label: "Result checked" },
}

// Shortcuts for the period; "Bateman" is the agency's run (see lib/date-range.ts).
function quickPeriods(lastWeek: Props["lastWeek"], today: string) {
  const back = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toISOString().slice(0, 10)
  }
  return [
    { label: "Last week", from: lastWeek.from, to: lastWeek.to },
    { label: "Last 30 days", from: back(29), to: today },
    { label: "Last 90 days", from: back(89), to: today },
    { label: "Bateman (Jun 5 – Jul 23)", from: "2026-06-05", to: "2026-07-23" },
  ]
}

export default function WeeklyNegatives({ batches, lastWeek, today, campaigns, admin, adminLink, brakeNote, dryRun, listName }: Props) {
  const { name, setName } = useName()
  const [message, setMessage] = useState<StepResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const [from, setFrom] = useState(lastWeek.from)
  const [to, setTo] = useState(lastWeek.to)
  const [campaignId, setCampaignId] = useState("")
  const quick = quickPeriods(lastWeek, today)
  const running = campaigns.filter((c) => c.status === "ENABLED")
  const others = campaigns.filter((c) => c.status !== "ENABLED")
  const field = "h-9 rounded-lg border border-input bg-background px-2 text-sm"

  // Runs one step; `key` marks which button shows "Saving…".
  const run = (key: string, step: () => Promise<StepResult>) => {
    setBusy(key)
    startTransition(async () => {
      setMessage(await step())
      setBusy(null)
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Your name (goes on every step)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Seth"
            className="h-9 w-48 rounded-lg border border-input bg-background px-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Campaign</span>
          <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={cn(field, "max-w-72")}>
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
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Search terms from</span>
          <span className="flex items-center gap-1.5">
            <input type="date" aria-label="From" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className={field} />
            <span className="text-muted-foreground">to</span>
            <input type="date" aria-label="To" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className={field} />
          </span>
        </div>
        <Button
          type="button"
          disabled={busy !== null || !from || !to}
          onClick={() => run("draft", () => draftNegativeBatch({ from, to, campaignId }, name))}
        >
          {busy === "draft" ? "Drafting…" : "Draft batch"}
        </Button>
        <div className="flex basis-full flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Quick pick:</span>
          {quick.map((q) => (
            <button
              key={q.label}
              type="button"
              aria-pressed={q.from === from && q.to === to}
              onClick={() => {
                setFrom(q.from)
                setTo(q.to)
              }}
              className={cn(
                "rounded-full border px-2.5 py-0.5 font-medium",
                q.from === from && q.to === to ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {q.label}
            </button>
          ))}
        </div>
        {message && (
          <p role="status" className={cn("basis-full text-sm", message.ok ? "text-emerald-700" : "text-destructive")}>
            {message.message}
          </p>
        )}
      </div>

      {batches.length === 0 && <p className="text-sm text-muted-foreground">No batches yet. Draft last week&apos;s above to start, or pick older dates and a paused campaign to try it out.</p>}
      {batches.map((b) => (
        <BatchCard
          key={b.id}
          batch={b}
          name={name}
          busy={busy}
          run={run}
          campaigns={campaigns}
          admin={admin}
          adminLink={adminLink}
          brakeNote={brakeNote}
          dryRun={dryRun}
          listName={listName}
        />
      ))}
    </div>
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
  return (
    <ol className="flex flex-wrap gap-2 text-xs">
      {steps.map((s, i) => {
        const done = !!s.who
        const skipped = !done && closed
        return (
          <li
            key={s.key}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1",
              done ? "border-emerald-300 bg-emerald-50" : "text-muted-foreground",
              skipped && "border-dashed opacity-60",
            )}
          >
            <span className={cn("flex size-4 items-center justify-center rounded-full text-[10px] font-semibold", done ? "bg-emerald-600 text-white" : "bg-muted")}>
              {done ? <Check className="size-3" aria-hidden /> : i + 1}
            </span>
            <span className="font-medium">{done ? s.done : s.todo}</span>
            {done ? (
              <span className="text-muted-foreground">
                {s.who}
                {b.times[s.key] ? `, ${b.times[s.key]}` : ""}
              </span>
            ) : (
              skipped && <span>not needed</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Choice({
  value,
  yes,
  no,
  disabled,
  busy,
  onPick,
}: {
  value: boolean | null
  yes: string
  no: string
  disabled: boolean
  busy: boolean
  onPick: (v: boolean | null) => void
}) {
  const base = "inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-medium disabled:opacity-50"
  return (
    <span className="inline-flex gap-1" aria-busy={busy || undefined}>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === true}
        onClick={() => onPick(value === true ? null : true)}
        className={cn(base, value === true ? "border-emerald-600 bg-emerald-600 text-white" : "hover:bg-muted")}
      >
        <Check className="size-3" aria-hidden />
        {yes}
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === false}
        onClick={() => onPick(value === false ? null : false)}
        className={cn(base, value === false ? "border-destructive bg-destructive text-white" : "hover:bg-muted")}
      >
        <X className="size-3" aria-hidden />
        {no}
      </button>
    </span>
  )
}

function Decision({ value, by, yes, no }: { value: boolean | null; by?: string; yes: string; no: string }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Pill tone={value ? "green" : "red"}>{value ? yes : no}</Pill>
      {by && <span className="text-[11px] text-muted-foreground">{by}</span>}
    </span>
  )
}

function BatchCard({
  batch: b,
  name,
  busy,
  run,
  campaigns,
  admin,
  adminLink,
  brakeNote,
  dryRun,
  listName,
}: {
  batch: BatchView
  name: string
  busy: string | null
  run: (key: string, step: () => Promise<StepResult>) => void
  campaigns: CampaignOption[]
  admin: boolean
  adminLink: ReactNode
  brakeNote: string | null
  dryRun: boolean
  listName: string
}) {
  const stage = stageLabel[b.stage]
  const proving = b.stage === "proving"
  const approving = b.stage === "approving"
  const openProof = b.items.filter((i) => i.proven === null).length
  const openApproval = b.items.filter((i) => i.proven && i.approved === null).length
  const approvedLines = b.items.filter((i) => i.proven && i.approved)
  const cost = b.items.reduce((s, i) => s + i.cost, 0)
  const k = (what: string) => `${b.id}:${what}`

  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5" aria-labelledby={`batch-${b.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={`batch-${b.id}`} className="font-semibold">
            {b.kind === "standard" ? "Standard negatives" : b.periodLabel}
            <span className="font-normal text-muted-foreground">
              {" · "}
              {b.kind === "standard" ? (b.forCampaigns?.length === 1 ? b.forCampaigns[0] : `${b.forCampaigns?.length ?? 0} campaigns`) : (b.campaignName ?? "All campaigns")}
            </span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {b.kind === "standard"
              ? b.items.length
                ? `From the campaign check: ${b.items.length} standard negative${b.items.length === 1 ? "" : "s"} these campaigns don't block yet. Searches they'd have blocked in the last 12 months cost ${formatUsd(cost)}.`
                : "These campaigns already block every standard negative."
              : b.items.length
                ? `${b.items.length} negative keyword${b.items.length === 1 ? "" : "s"} for searches that cost ${formatUsd(cost)} and brought no conversions.`
                : "No search in this period matched the rules without converting."}
          </p>
          {b.kind === "standard" && b.forCampaigns && b.forCampaigns.length > 1 && (
            <p className="text-xs text-muted-foreground">For: {b.forCampaigns.join(", ")}</p>
          )}
        </div>
        <Pill tone={stage.tone}>{stage.label}</Pill>
      </div>
      <Steps b={b} />

      {b.items.length > 0 && (
        <div className="-mx-4 overflow-x-auto sm:-mx-5">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium sm:pl-5">Negative keyword</th>
                <th scope="col" className="px-4 py-2 font-medium">Evidence: searches it blocks</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Clicks</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Spend</th>
                <th scope="col" className="px-4 py-2 font-medium">Review</th>
                <th scope="col" className="px-4 py-2 font-medium sm:pr-5">Approval</th>
              </tr>
            </thead>
            <tbody>
              {b.items.map((item, i) => (
                <tr key={item.negative} className="border-b border-border/60 align-top last:border-0">
                  <td className="px-4 py-2.5 sm:pl-5">
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{item.matchType === "EXACT" ? `[${item.negative}]` : `"${item.negative}"`}</span>
                      <span className="text-xs text-muted-foreground">{item.why}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {item.terms.length === 0 && (
                      <p className="text-xs text-muted-foreground">No searches yet: standard protection for when these campaigns run.</p>
                    )}
                    <ul className="flex flex-col gap-0.5 text-xs">
                      {item.terms.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                    {item.termCount > item.terms.length && (
                      <span className="text-[11px] text-muted-foreground">and {formatNumber(item.termCount - item.terms.length)} more</span>
                    )}
                    {item.campaigns && item.campaigns.length > 0 && <CameFrom shares={item.campaigns} campaigns={campaigns} />}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(item.clicks)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatUsd(item.cost)}</td>
                  <td className="px-4 py-2.5">
                    {proving ? (
                      <Choice
                        value={item.proven}
                        yes="Holds up"
                        no="Drop"
                        disabled={busy !== null}
                        busy={busy === k(`p${i}`)}
                        onPick={(v) => run(k(`p${i}`), () => markNegativeLine(b.id, i, "proven", v, name))}
                      />
                    ) : (
                      <Decision value={item.proven} by={item.provenBy} yes="Holds up" no="Dropped" />
                    )}
                  </td>
                  <td className="px-4 py-2.5 sm:pr-5">
                    {approving && item.proven ? (
                      <Choice
                        value={item.approved}
                        yes="Approve"
                        no="Reject"
                        disabled={busy !== null}
                        busy={busy === k(`a${i}`)}
                        onPick={(v) => run(k(`a${i}`), () => markNegativeLine(b.id, i, "approved", v, name))}
                      />
                    ) : item.proven === false ? (
                      <span className="text-xs text-muted-foreground">Dropped in proof</span>
                    ) : (
                      <Decision value={item.approved} by={item.approvedBy} yes="Approved" no="Rejected" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {proving && (
          <>
            <Button type="button" disabled={busy !== null || openProof > 0} onClick={() => run(k("prove"), () => finishNegativeStep(b.id, "proven", name))}>
              {busy === k("prove") ? "Saving…" : openProof ? `Review done (${openProof} left)` : "Review done"}
            </Button>
            {openProof > 1 && (
              <>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => run(k("all-p1"), () => markAllNegativeLines(b.id, "proven", true, name))}>
                  The {openProof} left hold up
                </Button>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => run(k("all-p0"), () => markAllNegativeLines(b.id, "proven", false, name))}>
                  Drop the {openProof} left
                </Button>
              </>
            )}
          </>
        )}
        {approving && (
          <>
            <Button type="button" disabled={busy !== null || openApproval > 0} onClick={() => run(k("approve"), () => finishNegativeStep(b.id, "approved", name))}>
              {busy === k("approve") ? "Saving…" : openApproval ? `Approval done (${openApproval} left)` : "Approval done"}
            </Button>
            {openApproval > 1 && (
              <>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => run(k("all-a1"), () => markAllNegativeLines(b.id, "approved", true, name))}>
                  Approve the {openApproval} left
                </Button>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => run(k("all-a0"), () => markAllNegativeLines(b.id, "approved", false, name))}>
                  Reject the {openApproval} left
                </Button>
              </>
            )}
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => run(k("reopen-p"), () => reopenNegativeStep(b.id, "proven", name))}>
              Reopen review
            </Button>
          </>
        )}
        {(b.stage === "ready" || (b.stage === "nothing-approved" && b.approved)) && (
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => run(k("reopen-a"), () => reopenNegativeStep(b.id, "approved", name))}>
            Reopen approval
          </Button>
        )}
        {b.stage === "nothing-approved" && !b.approved && b.proven && (
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => run(k("reopen-p"), () => reopenNegativeStep(b.id, "proven", name))}>
            Reopen review
          </Button>
        )}
        {!b.pushed && (
          <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => run(k("discard"), () => discardNegativeBatch(b.id, name))}>
            Discard batch
          </Button>
        )}
        {b.stage === "pushed" &&
          (b.checkReady ? (
            <Button type="button" disabled={busy !== null} onClick={() => run(k("check"), () => checkNegativeBatch(b.id, name))}>
              {busy === k("check") ? "Checking…" : "Check the result"}
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">Result check on {b.checkDayLabel}, once a full week has passed.</span>
          ))}
      </div>

      {b.stage === "ready" && (
        <PushPanel
          batch={b}
          lines={approvedLines.map((l) => l.negative)}
          name={name}
          campaigns={campaigns}
          admin={admin}
          adminLink={adminLink}
          brakeNote={brakeNote}
          dryRun={dryRun}
          listName={listName}
        />
      )}
      {b.pushed && <Pushed b={b} />}
      {b.checked && <Result b={b} />}

      {(b.heldBack.length > 0 || b.alreadyNegative.length > 0) && (
        <div className="flex flex-col gap-1.5 text-sm">
          {b.heldBack.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-medium text-primary">
                Held back: {b.heldBack.length} suggestion{b.heldBack.length === 1 ? "" : "s"} that would also block good searches
              </summary>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
                {b.heldBack.map((h) => (
                  <li key={h.negative}>
                    <span className="font-medium text-foreground">&ldquo;{h.negative}&rdquo;</span> ({h.why.toLowerCase()}) would block {h.converting.join("; ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {b.alreadyNegative.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Left out because negatives already in Google Ads block them: {b.alreadyNegative.slice(0, COVERING_SHOWN).join(", ")}
              {b.alreadyNegative.length > COVERING_SHOWN ? ` and ${b.alreadyNegative.length - COVERING_SHOWN} more` : ""}.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

const SHOWN_CAMPAIGNS = 3
const COVERING_SHOWN = 12

// Under each line: the campaigns its searches came from, so you know where it belongs.
function CameFrom({ shares, campaigns }: { shares: NonNullable<BatchView["items"][number]["campaigns"]>; campaigns: CampaignOption[] }) {
  const status = new Map(campaigns.map((c) => [c.id, c.status]))
  return (
    <p className="mt-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">From: </span>
      {shares.slice(0, SHOWN_CAMPAIGNS).map((c, i) => (
        <span key={c.id}>
          {i > 0 && "; "}
          {c.name} ({formatUsd(c.cost)}
          {status.get(c.id) === "ENABLED" ? ", running" : ""})
        </span>
      ))}
      {shares.length > SHOWN_CAMPAIGNS && ` and ${shares.length - SHOWN_CAMPAIGNS} more`}
    </p>
  )
}

function PushPanel({
  batch: b,
  lines,
  name,
  campaigns,
  admin,
  adminLink,
  brakeNote,
  dryRun,
  listName,
}: {
  batch: BatchView
  lines: string[]
  name: string
  campaigns: CampaignOption[]
  admin: boolean
  adminLink: ReactNode
  brakeNote: string | null
  dryRun: boolean
  listName: string
}) {
  // A batch drafted from one campaign goes back to that campaign by default.
  const approved = b.items.filter((i) => i.proven && i.approved)
  const known = new Set(campaigns.map((c) => c.id))
  const sources = [...new Set(approved.flatMap((i) => i.campaigns?.map((c) => c.id) ?? []))].filter((id) => known.has(id))
  const running = runningIds(campaigns)
  // A batch from one campaign goes back to it; a standard batch to the campaigns it was drafted for.
  const [picked, setPicked] = useState(() =>
    b.kind === "standard" && sources.length
      ? sources
      : b.campaignId && known.has(b.campaignId)
        ? [b.campaignId]
        : running,
  )
  const [toList, setToList] = useState(b.kind === "standard")
  const pick = (ids: string[]) => setPicked([...new Set(ids)])
  const { ask, ui, busy } = useChange()
  const sameName = b.proven?.by && b.approved?.by && b.proven.by.toLowerCase() === b.approved.by.toLowerCase()

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4">
      <p className="text-sm font-medium">
        Push {lines.length} approved negative{lines.length === 1 ? "" : "s"} to Google Ads in one change
      </p>
      {sameName && <p className="text-xs text-amber-900">The same person reviewed and approved this batch. A second person usually approves.</p>}
      {brakeNote ? (
        <p className="text-sm">{brakeNote}</p>
      ) : !admin ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-muted-foreground">An admin pushes the approved lines.</p>
          {adminLink}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 text-sm">
            <p className="text-xs text-muted-foreground">
              Competitor names and cities outside the buy area are wrong for every campaign, so they belong on all the campaigns you run, and on any
              you turn back on. A word line belongs where its searches came from (shown under each line).
            </p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <PickButton label={`Running campaigns (${running.length})`} onClick={() => pick(running)} />
              {sources.length > 0 && <PickButton label={`Where these searches came from (${sources.length})`} onClick={() => pick(sources)} />}
              {sources.length > 0 && running.length > 0 && (
                <PickButton label={`Both (${new Set([...running, ...sources]).size})`} onClick={() => pick([...running, ...sources])} />
              )}
            </div>
          </div>
          <CampaignPicker campaigns={campaigns} selected={picked} onChange={setPicked} idPrefix={`push-${b.id}`} />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={toList} onChange={(e) => setToList(e.target.checked)} className="mt-0.5 size-4" />
            <span>
              Put them in the shared list &ldquo;{listName}&rdquo; and attach it to the chosen campaigns, instead of adding them to each campaign
              <span className="block text-xs text-muted-foreground">
                One list to keep up: it&apos;s created the first time, and a campaign you attach it to later gets every negative in it.
              </span>
            </span>
          </label>
          <div>
            <Button
              type="button"
              disabled={busy || !picked.length}
              onClick={() =>
                ask({
                  title: toList
                    ? `Add ${lines.length} negative keyword${lines.length === 1 ? "" : "s"} to "${listName}" and attach it to ${picked.length} campaign${picked.length === 1 ? "" : "s"}?`
                    : `Add ${lines.length} negative keyword${lines.length === 1 ? "" : "s"} to ${picked.length} campaign${picked.length === 1 ? "" : "s"}?`,
                  details: <List items={lines.map((l) => `"${l}" (phrase)`)} />,
                  note: dryRun
                    ? "Dry run is on (DEALTRACK_VALIDATE_ONLY=1): Google checks the change and applies nothing."
                    : "This changes your live Google Ads account. Remove a negative later from the Search terms page if it blocks something good.",
                  confirmLabel: "Push to Google Ads",
                  run: () => pushNegativeBatchAction(b.id, picked, name, toList),
                })
              }
            >
              Push {lines.length} negative{lines.length === 1 ? "" : "s"}
            </Button>
          </div>
        </>
      )}
      {ui}
    </div>
  )
}

function PickButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full border bg-background px-2.5 py-0.5 font-medium hover:bg-muted">
      {label}
    </button>
  )
}

function Pushed({ b }: { b: BatchView }) {
  const p = b.pushed!
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-muted/30 p-3 text-sm">
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
    <div className="grid gap-3 rounded-xl border bg-muted/30 p-3 text-sm sm:grid-cols-3">
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
