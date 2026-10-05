"use client"

// The weekly review's interactive parts: making it, approving each proposal (or all at once),
// ticking off what was done by hand in Google Ads, sending approvals on, the AI summary, and the
// rules form.

import { createContext, useActionState, useContext, useState, useTransition, type ReactNode } from "react"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { CircleAlert, CircleCheck, LoaderCircle, Send, Sparkles } from "lucide-react"

import {
  decideAction,
  makeReviewAction,
  markAppliedAction,
  saveRulesAction,
  sendApprovedAction,
  summaryAction,
  type ReviewResult,
} from "@/app/actions/weekly-review"
import { Choice } from "@/components/negatives/parts"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Proposal, ProposalKind, ReviewRules, WeeklyReview } from "@/lib/weekly-review"

const SECTIONS: { kind: ProposalKind; title: string; empty: string; where?: { href: string; label: string } }[] = [
  {
    kind: "add",
    title: "1. New search terms to add as keywords",
    empty: "No search converted without already being a keyword.",
    where: { href: "/keyword-ideas", label: "Keyword ideas" },
  },
  {
    kind: "block",
    title: "2. Search terms to block",
    empty: "No not-a-seller search cost money last week.",
    where: { href: "/negatives", label: "Weekly negatives" },
  },
  { kind: "pause", title: "3. Keywords to pause", empty: "No running keyword hit the pause rule.", where: { href: "/keywords", label: "Keywords" } },
  {
    kind: "city",
    title: "4. Cities to drop or push",
    empty: "No city hit the drop or push rules.",
    where: { href: "/locations", label: "Locations" },
  },
  { kind: "budget", title: "5. Budget change", empty: "No budget proposal.", where: { href: "/budget", label: "Budget & pacing" } },
]
// Done by hand in Google Ads, then ticked off here.
const BY_HAND = new Set<ProposalKind>(["pause", "city", "budget"])

// One name for the whole page (approvals, ticks, making the review); the server remembers it.
const NameContext = createContext<{ name: string; setName: (v: string) => void } | null>(null)
export function NameProvider({ initialName, children }: { initialName: string; children: ReactNode }) {
  const [name, setName] = useState(initialName)
  return <NameContext.Provider value={{ name, setName }}>{children}</NameContext.Provider>
}
function useName() {
  const v = useContext(NameContext)
  if (!v) throw new Error("useName needs a NameProvider")
  return v
}

// `showName`: the name box goes here when there's no review below with its own.
export function MakeReview({ label, disabled, showName }: { label: string; disabled?: boolean; showName?: boolean }) {
  const { name, setName } = useName()
  const [busy, start] = useTransition()
  const [result, setResult] = useState<ReviewResult | null>(null)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {showName && <NameBox name={name} setName={setName} />}
      <Button type="button" disabled={busy || disabled} onClick={() => start(async () => setResult(await makeReviewAction(name)))}>
        {busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
        {busy ? "Reading Google Ads… (about a minute)" : label}
      </Button>
      <Message result={result} />
    </div>
  )
}

function NameBox({ name, setName }: { name: string; setName: (v: string) => void }) {
  return (
    <input
      value={name}
      onChange={(e) => setName(e.target.value)}
      placeholder="Your name"
      aria-label="Your name"
      className="h-8 w-36 rounded-lg border border-input bg-background px-2 text-sm"
    />
  )
}

function Message({ result }: { result: ReviewResult | null }) {
  if (!result) return null
  return (
    <span role="status" className={cn("text-sm", result.ok ? "text-emerald-700" : "text-destructive")}>
      {result.message}
    </span>
  )
}

export function ReviewBody({ review, dryRun, canAsk }: { review: WeeklyReview; dryRun: boolean; canAsk: boolean }) {
  const { name, setName } = useName()
  const [busy, start] = useTransition()
  const [result, setResult] = useState<ReviewResult | null>(null)
  const act = (fn: () => Promise<ReviewResult>) => start(async () => setResult(await fn()))
  const locked = !!review.sent
  const undecided = review.proposals.filter((p) => p.decision === null).length
  const approved = review.proposals.filter((p) => p.decision === true)
  const toSend = approved.filter((p) => p.kind === "block" || p.kind === "add").length

  return (
    <div className="flex flex-col gap-5">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-2xl border bg-card p-3 shadow-xs">
        <NameBox name={name} setName={setName} />
        <Button type="button" size="sm" disabled={busy || locked || !undecided} onClick={() => act(() => decideAction(review.id, "all", true, name))}>
          <CircleCheck data-icon="inline-start" /> Approve all {undecided ? `(${undecided})` : ""}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || locked || !toSend || dryRun}
          onClick={() => act(() => sendApprovedAction(review.id, name))}
        >
          <Send data-icon="inline-start" /> Send approved blocks and keywords on
        </Button>
        {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />}
        <span className="text-xs text-muted-foreground">
          {approved.length} approved · {review.proposals.filter((p) => p.decision === false).length} rejected · {undecided} to decide
        </span>
        <Message result={result} />
      </div>
      {dryRun && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Dry run:</strong> proposals only. Approve or reject them as usual so the team sees what would happen, but nothing is sent on and
          nothing changes in Google Ads. Run it this way for two weeks, then an admin turns it off under Rules.
        </p>
      )}
      {review.sent && (
        <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">
          Sent on by {review.sent.by}:{" "}
          {review.sent.negatives && (
            <Link className="font-medium underline" href={`/negatives?tab=batches&batch=${encodeURIComponent(review.sent.negatives)}`}>
              the blocks on Weekly negatives
            </Link>
          )}
          {review.sent.negatives && review.sent.ideas && " and "}
          {review.sent.ideas && (
            <Link className="font-medium underline" href="/keyword-ideas">
              the keywords on Keyword ideas
            </Link>
          )}
          , ready for an admin to push.
        </p>
      )}

      {SECTIONS.map((s) => {
        const list = review.proposals.filter((p) => p.kind === s.kind)
        return (
          <section key={s.kind} className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold">{s.title}</h2>
              <span className="text-xs text-muted-foreground">
                {BY_HAND.has(s.kind) ? "Applied by hand in Google Ads, then ticked off here" : "Approved ones go to "}
                {!BY_HAND.has(s.kind) && s.where && s.where.label}
                {s.where && (
                  <>
                    {" · "}
                    <Link href={s.where.href} className="text-primary hover:underline">
                      Open {s.where.label}
                    </Link>
                  </>
                )}
              </span>
            </div>
            {list.length ? (
              <ul className="flex flex-col divide-y rounded-xl border">
                {list.map((p) => (
                  <Row
                    key={p.id}
                    p={p}
                    busy={busy}
                    locked={locked}
                    onDecide={(v) => act(() => decideAction(review.id, p.id, v, name))}
                    onApplied={(v) => act(() => markAppliedAction(review.id, p.id, v, name))}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{s.empty}</p>
            )}
          </section>
        )
      })}

      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
        <h2 className="font-semibold">Check on itself</h2>
        <p className="text-sm text-muted-foreground">Totals recomputed a second way, and proposals that contradict each other taken out.</p>
        <ul className="flex flex-col gap-1.5 text-sm">
          {review.checks.map((c, i) => (
            <li key={i} className="flex items-start gap-2">
              {c.ok ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
              )}
              {c.text}
            </li>
          ))}
        </ul>
        {review.notes.length > 0 && (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
            {review.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">One-page summary (AI)</h2>
            <p className="text-sm text-muted-foreground">
              Written from the numbers above by the AI the chat uses, with its own recount of the totals.
            </p>
          </div>
          {canAsk && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(() => summaryAction(review.id, name))}>
              <Sparkles data-icon="inline-start" /> {review.summary ? "Write it again" : "Write the summary"}
            </Button>
          )}
        </div>
        {review.summary ? (
          <div className="prose prose-sm max-w-none text-sm dark:prose-invert [&_li]:my-0.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-semibold [&_p]:my-1.5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{review.summary.text}</ReactMarkdown>
            <p className="text-xs text-muted-foreground">
              Written for {review.summary.by}, {new Date(review.summary.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {canAsk ? "Not written yet." : "No AI is set up for the chat yet, so there's no written summary. Everything above works without it."}
          </p>
        )}
      </section>
    </div>
  )
}

function Row({
  p,
  busy,
  locked,
  onDecide,
  onApplied,
}: {
  p: Proposal
  busy: boolean
  locked: boolean
  onDecide: (v: boolean | null) => void
  onApplied: (v: boolean) => void
}) {
  const tone = p.action === "push" || p.action === "raise" ? "green" : p.action === "drop" || p.action === "lower" ? "red" : null
  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {p.title}
          {tone && <Pill tone={tone}>{p.action}</Pill>}
        </span>
        <span className="text-sm tabular-nums">{p.number}</span>
        {p.detail && <span className="text-xs text-muted-foreground">{p.detail}</span>}
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        {p.action === "hold" ? (
          <span className="text-xs text-muted-foreground">Nothing to approve</span>
        ) : (
          <Choice value={p.decision} yes="Approve" no="Reject" disabled={busy || locked} busy={busy} label={p.title} onPick={onDecide} />
        )}
        {p.decidedBy && (
          <span className="text-[11px] text-muted-foreground">
            {p.decision ? "Approved" : "Rejected"} by {p.decidedBy}
          </span>
        )}
        {BY_HAND.has(p.kind) && p.decision === true && p.action !== "hold" && (
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={!!p.applied} disabled={busy} onChange={(e) => onApplied(e.target.checked)} />
            {p.applied ? `Done in Google Ads by ${p.applied.by}` : "Done in Google Ads"}
          </label>
        )}
      </div>
    </li>
  )
}

const FIELDS: { key: keyof ReviewRules; label: string; prefix?: string; suffix?: string; percent?: boolean; hint?: string }[] = [
  { key: "targetLow", label: "Target ad spend per deal, low", prefix: "$" },
  { key: "targetHigh", label: "Target ad spend per deal, high", prefix: "$" },
  { key: "pauseKeywordSpend", label: "Pause a keyword after spending", prefix: "$", hint: "in 90 days with no conversion" },
  { key: "dropCitySpend", label: "Drop a California city after spending", prefix: "$", hint: "in 90 days with no conversion" },
  { key: "cityCostTimes", label: "…or costing this many times the average", suffix: "×", hint: "per conversion" },
  { key: "outsideSpend", label: "Drop a city outside California after", prefix: "$", hint: "in 90 days" },
  { key: "pushCityConversions", label: "Push a city with at least", suffix: "conversions", hint: "in 90 days…" },
  { key: "pushCityCostShare", label: "…at this share of the average cost or less", suffix: "%", percent: true },
  { key: "budgetStep", label: "Budget change step", suffix: "%", percent: true },
  { key: "maxPerSection", label: "Most proposals per section" },
]

export function RulesForm({ rules, admin, initialName }: { rules: ReviewRules; admin: boolean; initialName: string }) {
  const [state, action, pending] = useActionState(saveRulesAction, null)
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
            <span className="flex items-center gap-1">
              {f.prefix && <span className="text-muted-foreground">{f.prefix}</span>}
              <input
                name={f.key}
                disabled={!admin}
                defaultValue={f.percent ? Math.round(Number(rules[f.key]) * 100) : String(rules[f.key])}
                inputMode="decimal"
                className="h-9 w-full rounded-lg border border-input bg-background px-2 tabular-nums disabled:opacity-70"
              />
              {f.suffix && <span className="shrink-0 text-muted-foreground">{f.suffix}</span>}
            </span>
            {f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="dryRun" defaultChecked={rules.dryRun} disabled={!admin} />
        Dry run: proposals only, nothing is sent on (keep it on for the first two weeks)
      </label>
      {admin ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Your name</span>
            <input name="name" defaultValue={initialName} required className="h-9 w-48 rounded-lg border border-input bg-background px-2" />
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save rules"}
          </Button>
          <Message result={state} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only an admin can change the rules.</p>
      )}
    </form>
  )
}
