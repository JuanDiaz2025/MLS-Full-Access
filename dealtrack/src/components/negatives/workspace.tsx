"use client"

// The Weekly negatives workspace: a toolbar (name, push status, how it works), three tabs
// (Batches, New batch, Campaign check), and one status line for every step's result.

import { useRef, type KeyboardEvent, type ReactNode } from "react"
import { CheckCircle2, AlertTriangle, X } from "lucide-react"

import BatchDetail from "@/components/negatives/batch-detail"
import BatchList from "@/components/negatives/batch-list"
import { useWorkspace } from "@/components/negatives/context"
import { TABS, type Tab } from "@/components/negatives/tabs"
import NewBatch from "@/components/negatives/new-batch"
import { needsAction, type BatchView, type Shared } from "@/components/negatives/parts"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Props = Shared & {
  batches: BatchView[] // newest first
  lastWeek: { from: string; to: string }
  today: string
  checkPanel: ReactNode // the campaign check, streamed in by the page
  brakeDays: number
  lookbackDays: number
}

const STEPS = [
  { title: "Draft", text: "DealTrack lists wasted searches as negative keywords, with the evidence" },
  { title: "Review", text: "Someone checks each line's searches: holds up or drop" },
  { title: "Approve", text: "Ideally a second person approves or rejects each line" },
  { title: "Push", text: "An admin sends the approved lines to Google Ads in one change" },
  { title: "Check", text: "A week later: did that spend stop, and did leads hold up?" },
]

export default function Workspace(props: Props) {
  const { batches, campaigns, lastWeek, today, checkPanel, brakeNote, dryRun, brakeDays, lookbackDays } = props
  const { name, setName, tab, setTab, batchId, selectBatch, notice, setNotice } = useWorkspace()
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ batches: null, new: null, check: null })
  const detailRef = useRef<HTMLDivElement>(null)

  const open = batches.filter(needsAction)
  // The chosen batch, or the first one that needs someone, or the newest.
  const selected = batches.find((b) => b.id === batchId) ?? open[0] ?? batches[0] ?? null

  const labels: Record<Tab, string> = { batches: "Batches", new: "New batch", check: "Campaign check" }
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab)
    const next = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i - 1 + TABS.length) % TABS.length] : null
    if (!next) return
    e.preventDefault()
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  const pick = (id: string) => {
    selectBatch(id)
    // On narrow screens the detail sits under the list, so bring it into view.
    if (window.matchMedia("(max-width: 1023px)").matches) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border bg-card px-4 py-3 shadow-xs">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Seth"
            aria-describedby="name-hint"
            className={cn("h-8 w-40 rounded-lg border bg-background px-2", name.trim() ? "border-input" : "border-amber-400")}
          />
        </label>
        <span id="name-hint" className="sr-only">
          Goes on every step you take
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={cn("rounded-full px-2 py-0.5 font-medium", brakeNote ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800")} title={brakeNote ?? undefined}>
            {brakeNote ? "Next push is on hold" : "A push is allowed now"}
          </span>
          {dryRun && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">Dry run: nothing is applied</span>}
        </span>
        <details className="relative ml-auto text-sm">
          <summary className="cursor-pointer list-none text-xs font-medium text-primary hover:underline">How it works</summary>
          <div className="absolute right-0 z-20 mt-2 w-[min(92vw,34rem)] rounded-2xl border bg-card p-4 shadow-lg">
            <ol className="flex flex-col gap-2">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
                  <span>
                    <span className="font-medium">{s.title}.</span> <span className="text-muted-foreground">{s.text}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              Never blocked: a search that converted in the last {lookbackDays} days, or a seller saying &ldquo;sell&rdquo; (competitor names and cities
              outside the buy area aside). At most one push every {brakeDays} days, so Google&apos;s learning stays steady. Batches are saved on this computer.
            </p>
          </div>
        </details>
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Weekly negatives" className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el
            }}
            id={`tab-${t}`}
            role="tab"
            type="button"
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            tabIndex={tab === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={onTabKey}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {labels[t]}
            {t === "batches" && open.length > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[11px] leading-5 text-primary-foreground" aria-label={`${open.length} need action`}>
                {open.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* One place for every step's result */}
      <div aria-live="polite">
        {notice && (
          <div
            role="status"
            className={cn(
              "flex items-start gap-2 rounded-xl border px-3 py-2 text-sm",
              notice.ok ? "border-emerald-300 bg-emerald-50 text-emerald-950" : "border-destructive/30 bg-destructive/5",
            )}
          >
            {notice.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            )}
            <p className="flex-1">{notice.message}</p>
            <button type="button" onClick={() => setNotice(null)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
              <X className="size-4" aria-hidden />
            </button>
          </div>
        )}
      </div>

      <div role="tabpanel" id="panel-batches" aria-labelledby="tab-batches" hidden={tab !== "batches"}>
        {batches.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed bg-card p-10 text-center">
            <p className="font-medium">No batches yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Start with last week&apos;s search terms, or check which standard negatives your campaigns are missing.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" onClick={() => setTab("new")}>
                New batch
              </Button>
              <Button type="button" variant="outline" onClick={() => setTab("check")}>
                Campaign check
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
            <div className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pr-1">
              <BatchList batches={batches} selectedId={selected?.id ?? null} onPick={pick} />
            </div>
            <div ref={detailRef} className="min-w-0 scroll-mt-24">
              {selected && <BatchDetail key={selected.id} batch={selected} shared={props} />}
            </div>
          </div>
        )}
      </div>

      <div role="tabpanel" id="panel-new" aria-labelledby="tab-new" hidden={tab !== "new"}>
        <NewBatch campaigns={campaigns} lastWeek={lastWeek} today={today} />
      </div>

      {/* Kept mounted so the check keeps loading in the background. */}
      <div role="tabpanel" id="panel-check" aria-labelledby="tab-check" hidden={tab !== "check"}>
        {checkPanel}
      </div>
    </div>
  )
}
