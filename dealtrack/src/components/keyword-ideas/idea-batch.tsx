"use client"

// One keyword ideas batch: its steps, what to do next, and the ideas (filter by kind and decision,
// search, change match type or ad group while in review or approval).

import { useState, useTransition } from "react"
import { Check, Info } from "lucide-react"

import { pushKeywordBatchAction } from "@/app/actions/changes"
import {
  discardKeywordBatch,
  editKeywordIdea,
  finishKeywordStep,
  markAllKeywordIdeas,
  markKeywordIdea,
  reopenKeywordStep,
  type IdeaResult,
} from "@/app/actions/keyword-ideas"
import { List, useChange } from "@/components/changes/shared"
import { formatNumber, formatUsd } from "@/components/dashboard/format"
import { Choice, Decision, Segmented } from "@/components/negatives/parts"
import { Pill, type PillTone } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { IdeaStage } from "@/lib/keyword-ideas"
import type { IdeaSource, KeywordBatch, KeywordIdea } from "@/lib/store"
import { cn } from "@/lib/utils"

export type IdeaBatchView = KeywordBatch & {
  stage: IdeaStage
  periodLabel: string
  times: Partial<Record<"drafted" | "proven" | "approved" | "pushed", string>>
}

export type AdGroupOption = { id: string; name: string; campaignId: string; campaignName: string; running: boolean }

export type IdeaShared = {
  adGroups: AdGroupOption[]
  admin: boolean
  adminLink: React.ReactNode
  dryRun: boolean
  name: string
  setNotice: (r: IdeaResult | null) => void
}

export const ideaStageLabel: Record<IdeaStage, { tone: PillTone; label: string }> = {
  empty: { tone: "gray", label: "No ideas" },
  proving: { tone: "violet", label: "In review" },
  approving: { tone: "violet", label: "Waiting for approval" },
  ready: { tone: "amber", label: "Ready to push" },
  "nothing-approved": { tone: "gray", label: "Nothing approved" },
  pushed: { tone: "green", label: "Pushed" },
}

export const SOURCE_SHORT: Record<IdeaSource, { label: string; tone: PillTone }> = {
  proven: { label: "Converted", tone: "green" },
  phrase: { label: "Phrase", tone: "violet" },
  situation: { label: "Situation", tone: "amber" },
  planner: { label: "Planner", tone: "gray" },
}

type Decided = "all" | "open" | "kept" | "dropped"
const SHOWN_SEARCHES = 3

export default function IdeaBatch({ batch: b, shared }: { batch: IdeaBatchView; shared: IdeaShared }) {
  const { name, setNotice } = shared
  const [busy, setBusy] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const [kind, setKind] = useState<"all" | IdeaSource>("all")
  const [decided, setDecided] = useState<Decided>("all")
  const [search, setSearch] = useState("")

  const run = (key: string, step: () => Promise<IdeaResult>) => {
    setBusy(key)
    startTransition(async () => {
      setNotice(await step())
      setBusy(null)
    })
  }

  const approving = b.stage === "approving"
  const editable = b.stage === "proving" || approving
  const decision = (i: KeywordIdea) => (approving || b.approved ? (i.proven ? i.approved : false) : i.proven)
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const rows = b.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const d = decision(item)
      const text = [item.text, item.why, item.campaignName, item.adGroupName, ...item.searches].join(" ").toLowerCase()
      return (
        (kind === "all" || item.source === kind) &&
        (decided === "all" || (decided === "open" ? d === null : decided === "kept" ? d === true : d === false)) &&
        words.every((w) => text.includes(w))
      )
    })
  const kinds = (["proven", "phrase", "situation", "planner"] as IdeaSource[]).filter((s) => b.items.some((i) => i.source === s))
  const hasPlanner = b.items.some((i) => i.volume !== undefined)
  const count = (d: Decided) => b.items.filter((i) => (d === "open" ? decision(i) === null : d === "kept" ? decision(i) === true : decision(i) === false)).length
  const stage = ideaStageLabel[b.stage]

  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5" aria-labelledby="idea-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="idea-title" className="text-lg font-semibold">
            {b.periodLabel}
            <span className="font-normal text-muted-foreground"> · {b.campaignName ?? "All campaigns"}</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {b.items.length
              ? `${b.items.length} keyword idea${b.items.length === 1 ? "" : "s"}: ${kinds.map((k) => `${b.items.filter((i) => i.source === k).length} ${SOURCE_SHORT[k].label.toLowerCase()}`).join(", ")}.`
              : "No new ideas in this period."}
          </p>
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
                if (window.confirm("Discard this batch? Its reviews and approvals are deleted.")) run("discard", () => discardKeywordBatch(b.id, name))
              }}
            >
              Discard
            </Button>
          )}
        </div>
      </header>

      <Steps b={b} />
      {b.notes.map((n) => (
        <p key={n} className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50/60 px-3 py-2 text-sm text-amber-950">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {n}
        </p>
      ))}
      <NextStep b={b} shared={shared} busy={busy} run={run} />

      {b.items.length > 0 && (
        <section aria-label="Ideas" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">
              Ideas
              {(words.length > 0 || kind !== "all" || decided !== "all") && (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {rows.length} of {b.items.length}
                </span>
              )}
            </h3>
            <input
              type="search"
              aria-label="Search ideas"
              placeholder="Search keywords, searches, ad groups"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm sm:w-64 lg:ml-auto"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<"all" | IdeaSource>
              label="Kind of idea"
              value={kind}
              onChange={setKind}
              options={[{ id: "all", label: `All ${b.items.length}` }, ...kinds.map((k) => ({ id: k, label: `${SOURCE_SHORT[k].label} ${b.items.filter((i) => i.source === k).length}` }))]}
            />
            <Segmented<Decided>
              label="Decision"
              value={decided}
              onChange={setDecided}
              options={[
                { id: "all", label: "Any decision" },
                { id: "open", label: `Needs a decision ${count("open")}` },
                { id: "kept", label: `${approving || b.approved ? "Approved" : "Holds up"} ${count("kept")}` },
                { id: "dropped", label: `Dropped ${count("dropped")}` },
              ]}
            />
          </div>
          <div className="max-h-[62vh] overflow-auto rounded-xl border">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">Keyword</th>
                  <th scope="col" className="px-3 py-2 font-medium">Evidence</th>
                  {hasPlanner && <th scope="col" className="px-3 py-2 text-right font-medium">Monthly searches</th>}
                  <th scope="col" className="px-3 py-2 font-medium">Goes into</th>
                  <th scope="col" className="px-3 py-2 font-medium">Review</th>
                  <th scope="col" className="px-3 py-2 font-medium">Approval</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item, index }) => (
                  <Line key={index} b={b} item={item} index={index} editable={editable} hasPlanner={hasPlanner} busy={busy} run={run} shared={shared} />
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={hasPlanner ? 6 : 5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      No idea matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {b.skipped.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-primary">Left out by a safety check: {b.skipped.length}</summary>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
            {b.skipped.map((s) => (
              <li key={`${s.text}|${s.why}`}>
                <span className="font-medium text-foreground">&ldquo;{s.text}&rdquo;</span>: {s.why}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  )
}

function Steps({ b }: { b: IdeaBatchView }) {
  const steps = [
    { key: "drafted", done: "Drafted", todo: "Draft", who: b.drafted.by },
    { key: "proven", done: "Reviewed", todo: "Review", who: b.proven?.by },
    { key: "approved", done: "Approved", todo: "Approve", who: b.approved?.by },
    { key: "pushed", done: b.pushed?.dryRun ? "Pushed (dry run)" : "Pushed", todo: "Admin pushes", who: b.pushed?.by },
  ] as const
  const closed = b.stage === "empty" || b.stage === "nothing-approved"
  const current = steps.findIndex((s) => !s.who)
  return (
    <ol className="grid grid-cols-4 gap-1 text-[11px] sm:text-xs" aria-label="Steps">
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
              <span className="truncate text-muted-foreground">
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

function NextStep({ b, shared, busy, run }: { b: IdeaBatchView; shared: IdeaShared; busy: string | null; run: (k: string, s: () => Promise<IdeaResult>) => void }) {
  const { name } = shared
  const openProof = b.items.filter((i) => i.proven === null).length
  const openApproval = b.items.filter((i) => i.proven && i.approved === null).length
  const noGroup = b.items.filter((i) => i.proven && i.approved === null && !i.adGroupId).length
  const off = busy !== null

  const box = (tone: "violet" | "gray" | "green", title: string, body: React.ReactNode, actions?: React.ReactNode) => (
    <section
      aria-label="Next step"
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        tone === "violet" && "border-primary/30 bg-primary/5",
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
        `Review: ${openProof ? `${openProof} of ${b.items.length} ideas need a decision` : "every idea has a decision"}`,
        "Holds up if it's a search sellers make and worth paying for. Change the match type or ad group in the line if needed.",
        <>
          <Button type="button" disabled={off || openProof > 0} onClick={() => run("prove", () => finishKeywordStep(b.id, "proven", name))}>
            {busy === "prove" ? "Saving…" : "Review done"}
          </Button>
          {openProof > 1 && (
            <>
              <Button type="button" variant="outline" disabled={off} onClick={() => run("all-p1", () => markAllKeywordIdeas(b.id, "proven", true, name))}>
                The {openProof} left hold up
              </Button>
              <Button type="button" variant="outline" disabled={off} onClick={() => run("all-p0", () => markAllKeywordIdeas(b.id, "proven", false, name))}>
                Drop the {openProof} left
              </Button>
            </>
          )}
        </>,
      )
    case "approving":
      return box(
        "violet",
        `Approve: ${openApproval ? `${openApproval} idea${openApproval === 1 ? "" : "s"} to approve or reject` : "every idea has a decision"}`,
        noGroup ? `${noGroup} still need an ad group before they can be approved.` : "Ideally someone other than the reviewer.",
        <>
          <Button type="button" disabled={off || openApproval > 0} onClick={() => run("approve", () => finishKeywordStep(b.id, "approved", name))}>
            {busy === "approve" ? "Saving…" : "Approval done"}
          </Button>
          {openApproval > 1 && (
            <>
              <Button type="button" variant="outline" disabled={off} onClick={() => run("all-a1", () => markAllKeywordIdeas(b.id, "approved", true, name))}>
                Approve the {openApproval} left
              </Button>
              <Button type="button" variant="outline" disabled={off} onClick={() => run("all-a0", () => markAllKeywordIdeas(b.id, "approved", false, name))}>
                Reject the {openApproval} left
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" disabled={off} onClick={() => run("reopen-p", () => reopenKeywordStep(b.id, "proven", name))}>
            Reopen review
          </Button>
        </>,
      )
    case "ready":
      return <PushBox b={b} shared={shared} busy={busy} run={run} />
    case "nothing-approved":
      return box(
        "gray",
        "Nothing to push",
        b.approved ? "No idea was approved, so this batch is done." : "No idea held up in review, so this batch is done.",
        <Button
          type="button"
          variant="outline"
          disabled={off}
          onClick={() => run("reopen", () => reopenKeywordStep(b.id, b.approved ? "approved" : "proven", name))}
        >
          {b.approved ? "Reopen approval" : "Reopen review"}
        </Button>,
      )
    case "empty":
      return box("gray", "No ideas", "Everything that converted is already a keyword, or a safety check left it out. You can discard this batch.")
    case "pushed": {
      const p = b.pushed!
      return box(
        "green",
        "Done",
        <div className="flex flex-col gap-1 text-foreground">
          {p.dryRun && <p className="text-xs font-medium text-amber-800">Dry run: Google checked this push and changed nothing.</p>}
          <p>
            Pushed by {p.by}
            {b.times.pushed ? ` on ${b.times.pushed}` : ""}: {formatNumber(p.added)} keyword{p.added === 1 ? "" : "s"} added{p.paused ? " paused (switch them on in Google Ads)" : ""}
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
        </div>,
      )
    }
  }
}

function PushBox({ b, shared, busy, run }: { b: IdeaBatchView; shared: IdeaShared; busy: string | null; run: (k: string, s: () => Promise<IdeaResult>) => void }) {
  const { admin, adminLink, dryRun, name } = shared
  const [paused, setPaused] = useState(true)
  const { ask, ui, busy: asking } = useChange()
  const lines = b.items.filter((i) => i.proven && i.approved)
  const groups = new Set(lines.map((l) => l.adGroupId)).size
  return (
    <section aria-label="Next step" className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">
            Push: {lines.length} approved keyword{lines.length === 1 ? "" : "s"} into {groups} ad group{groups === 1 ? "" : "s"}
          </h3>
          <p className="text-sm text-muted-foreground">Each goes into the ad group shown on its line.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => run("reopen-a", () => reopenKeywordStep(b.id, "approved", name))}>
          Reopen approval
        </Button>
      </div>
      {!admin ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-muted-foreground">An admin pushes the approved keywords.</p>
          {adminLink}
        </div>
      ) : (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" autoComplete="off" checked={paused} onChange={(e) => setPaused(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
            <span>
              Add them paused
              <span className="block text-xs text-muted-foreground">They won&apos;t spend until someone switches them on in Google Ads. Safer for campaigns that are running.</span>
            </span>
          </label>
          <div>
            <Button
              type="button"
              disabled={asking}
              onClick={() =>
                ask({
                  title: `Add ${lines.length} keyword${lines.length === 1 ? "" : "s"}${paused ? ", paused," : ""} to Google Ads?`,
                  details: <List items={lines.map((l) => `${l.matchType === "EXACT" ? `[${l.text}]` : `"${l.text}"`} → ${l.campaignName} › ${l.adGroupName}`)} />,
                  note: dryRun
                    ? "Dry run is on (DEALTRACK_VALIDATE_ONLY=1): Google checks the change and applies nothing."
                    : paused
                      ? "They're added paused, so nothing spends until they're switched on."
                      : "This changes your live Google Ads account, and the keywords can start spending right away.",
                  confirmLabel: "Push to Google Ads",
                  run: () => pushKeywordBatchAction(b.id, paused, name),
                })
              }
            >
              Push {lines.length} keyword{lines.length === 1 ? "" : "s"}
            </Button>
          </div>
        </>
      )}
      {ui}
    </section>
  )
}

function Line({
  b,
  item,
  index,
  editable,
  hasPlanner,
  busy,
  run,
  shared,
}: {
  b: IdeaBatchView
  item: KeywordIdea
  index: number
  editable: boolean
  hasPlanner: boolean
  busy: string | null
  run: (k: string, s: () => Promise<IdeaResult>) => void
  shared: IdeaShared
}) {
  const { name, adGroups } = shared
  const shown = item.matchType === "EXACT" ? `[${item.text}]` : `"${item.text}"`
  const src = SOURCE_SHORT[item.source]
  // The line's own ad group, then running campaigns', then the rest of the campaigns in this batch.
  const batchCampaigns = new Set(b.items.map((i) => i.campaignId))
  const options = adGroups.filter((g) => g.running || batchCampaigns.has(g.campaignId) || g.id === item.adGroupId)
  const byCampaign = [...new Map(options.map((g) => [g.campaignId, { name: g.campaignName, running: g.running, groups: options.filter((x) => x.campaignId === g.campaignId) }])).values()].sort(
    (a, c) => Number(c.running) - Number(a.running) || a.name.localeCompare(c.name),
  )
  const field = "h-7 rounded-lg border border-input bg-background px-1.5 text-xs disabled:opacity-60"

  return (
    <tr className="border-t border-border/60 align-top">
      <td className="px-3 py-2.5">
        <span className="flex flex-col items-start gap-1">
          <span className="font-medium">{shown}</span>
          <span className="flex flex-wrap items-center gap-1">
            <Pill tone={src.tone}>{src.label}</Pill>
            {editable ? (
              <select
                aria-label={`Match type for ${item.text}`}
                autoComplete="off"
                value={item.matchType}
                disabled={busy !== null}
                onChange={(e) => run(`m${index}`, () => editKeywordIdea(b.id, index, { matchType: e.target.value }, name))}
                className={field}
              >
                <option value="EXACT">Exact</option>
                <option value="PHRASE">Phrase</option>
              </select>
            ) : (
              <span className="text-xs text-muted-foreground">{item.matchType === "EXACT" ? "Exact" : "Phrase"}</span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{item.why}</span>
        </span>
      </td>
      <td className="px-3 py-2.5 text-xs">
        {item.searchCount > 0 ? (
          <>
            <ul className="flex flex-col gap-0.5">
              {item.searches.slice(0, SHOWN_SEARCHES).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {item.searchCount > SHOWN_SEARCHES && <span className="text-[11px] text-muted-foreground">and {formatNumber(item.searchCount - SHOWN_SEARCHES)} more searches</span>}
            <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
              {formatNumber(item.impressions)} impr · {formatNumber(item.clicks)} clicks · {formatUsd(item.cost)} · {formatNumber(Math.round(item.conversions * 10) / 10)} conv
              {item.conversions > 0 ? ` · ${formatUsd(item.cost / item.conversions)}/conv` : ""}
            </p>
          </>
        ) : (
          <span className="text-muted-foreground">No searches yet in this period</span>
        )}
      </td>
      {hasPlanner && (
        <td className="px-3 py-2.5 text-right text-xs tabular-nums">
          {item.volume !== undefined ? formatNumber(item.volume) : "—"}
          {item.lowBid !== undefined && item.highBid !== undefined && (
            <span className="block text-[11px] text-muted-foreground">
              {formatUsd(item.lowBid)}–{formatUsd(item.highBid)} bid
            </span>
          )}
        </td>
      )}
      <td className="px-3 py-2.5 text-xs">
        {editable ? (
          <select
            aria-label={`Ad group for ${item.text}`}
            autoComplete="off"
            value={item.adGroupId}
            disabled={busy !== null}
            onChange={(e) => run(`g${index}`, () => editKeywordIdea(b.id, index, { adGroupId: e.target.value }, name))}
            className={cn(field, "max-w-56", !item.adGroupId && "border-amber-400")}
          >
            {!item.adGroupId && <option value="">Choose an ad group</option>}
            {byCampaign.map((c) => (
              <optgroup key={c.name} label={`${c.name}${c.running ? " (running)" : ""}`}>
                {c.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : (
          <span>
            {item.campaignName} › {item.adGroupName}
          </span>
        )}
        {editable && item.campaignName && <span className="mt-0.5 block max-w-56 truncate text-[11px] text-muted-foreground">{item.campaignName}</span>}
      </td>
      <td className="px-3 py-2.5">
        {b.stage === "proving" ? (
          <Choice
            label={`Review ${shown}`}
            value={item.proven}
            yes="Holds up"
            no="Drop"
            disabled={busy !== null}
            busy={busy === `p${index}`}
            onPick={(v) => run(`p${index}`, () => markKeywordIdea(b.id, index, "proven", v, name))}
          />
        ) : (
          <Decision value={item.proven} by={item.provenBy} yes="Holds up" no="Dropped" />
        )}
      </td>
      <td className="px-3 py-2.5">
        {b.stage === "approving" && item.proven ? (
          <Choice
            label={`Approve ${shown}`}
            value={item.approved}
            yes="Approve"
            no="Reject"
            disabled={busy !== null || (!item.adGroupId && item.approved === null)}
            busy={busy === `a${index}`}
            onPick={(v) => run(`a${index}`, () => markKeywordIdea(b.id, index, "approved", v, name))}
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
