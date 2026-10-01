"use client"

// The Keyword ideas workspace: a toolbar (name, dry run, how it works), two tabs (Batches,
// New ideas), and one status line for every step's result. Laid out like Weekly negatives.

import { useEffect, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react"
import { AlertTriangle, CheckCircle2, X } from "lucide-react"

import { draftKeywordIdeas, type IdeaResult } from "@/app/actions/keyword-ideas"
import type { CampaignOption } from "@/components/changes/shared"
import IdeaBatch, { ideaStageLabel, type AdGroupOption, type IdeaBatchView } from "@/components/keyword-ideas/idea-batch"
import { Segmented } from "@/components/negatives/parts"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { IdeaSource } from "@/lib/store"
import { cn } from "@/lib/utils"

const TABS = ["batches", "new"] as const
type Tab = (typeof TABS)[number]

type Props = {
  batches: IdeaBatchView[] // newest first
  campaigns: CampaignOption[]
  adGroups: AdGroupOption[]
  admin: boolean
  adminLink: ReactNode
  dryRun: boolean
  personName: string
  today: string
  initial: { tab: string | null; batchId: string | null }
}

const SOURCES: { id: IdeaSource; title: string; text: string }[] = [
  { id: "proven", title: "Searches that converted", text: "The exact searches that brought a conversion but aren't keywords yet. The strongest ideas." },
  { id: "phrase", title: "Phrases converting searches share", text: "A phrase several converting searches have in common, as a phrase-match keyword." },
  { id: "situation", title: "Seller situations", text: "Inherited, probate, divorce, foreclosure, repairs, tenants… with how often they show up in your searches." },
  { id: "planner", title: "Keyword Planner ideas", text: "Related searches with monthly volume for California. Needs Basic access on the developer token." },
]

const needsAction = (b: IdeaBatchView) => b.stage === "proving" || b.stage === "approving" || b.stage === "ready"

export default function KeywordIdeas(props: Props) {
  const { batches, adGroups, admin, adminLink, dryRun, personName, initial } = props
  const [name, setName] = useState(personName)
  const [tab, setTabRaw] = useState<Tab>(TABS.includes(initial.tab as Tab) ? (initial.tab as Tab) : batches.length ? "batches" : "new")
  const [batchId, setBatchId] = useState<string | null>(initial.batchId)
  const [notice, setNotice] = useState<IdeaResult | null>(null)
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ batches: null, new: null })

  const setTab = (t: Tab) => {
    if (t !== tab) setNotice(null)
    setTabRaw(t)
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set("tab", tab)
    if (batchId && tab === "batches") params.set("batch", batchId)
    else params.delete("batch")
    const next = `${window.location.pathname}?${params}`
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next)
  }, [tab, batchId])

  const open = batches.filter(needsAction)
  const selected = batches.find((b) => b.id === batchId) ?? open[0] ?? batches[0] ?? null
  const labels: Record<Tab, string> = { batches: "Batches", new: "New ideas" }
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const next = tab === "batches" ? "new" : "batches"
    setTab(next)
    tabRefs.current[next]?.focus()
  }
  const shared = { adGroups, admin, adminLink, dryRun, name, setNotice }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border bg-card px-4 py-3 shadow-xs">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Seth"
            className={cn("h-8 w-40 rounded-lg border bg-background px-2", name.trim() ? "border-input" : "border-amber-400")}
          />
        </label>
        {dryRun && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Dry run: nothing is applied</span>}
        <details className="relative ml-auto text-sm">
          <summary className="cursor-pointer list-none text-xs font-medium text-primary hover:underline">How it works</summary>
          <div className="absolute right-0 z-20 mt-2 w-[min(92vw,34rem)] rounded-2xl border bg-card p-4 text-sm shadow-lg">
            <ol className="flex list-decimal flex-col gap-1.5 pl-5">
              <li>
                <span className="font-medium">Draft.</span> <span className="text-muted-foreground">DealTrack looks through your search terms for keywords worth adding.</span>
              </li>
              <li>
                <span className="font-medium">Review.</span> <span className="text-muted-foreground">Someone checks each idea, its match type, and the ad group it goes into.</span>
              </li>
              <li>
                <span className="font-medium">Approve.</span> <span className="text-muted-foreground">Ideally a second person approves or rejects each one.</span>
              </li>
              <li>
                <span className="font-medium">Push.</span> <span className="text-muted-foreground">An admin adds the approved keywords to Google Ads, paused by default.</span>
              </li>
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              Never suggested: anything the negative rules block (agents, renters, places outside California…), competitor names unless you include them,
              anything a negative already blocks, and keywords the campaign already has.
            </p>
          </div>
        </details>
      </div>

      <div role="tablist" aria-label="Keyword ideas" className="flex gap-1 border-b">
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
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {labels[t]}
            {t === "batches" && open.length > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] leading-5 text-primary-foreground">{open.length}</span>}
          </button>
        ))}
      </div>

      <div aria-live="polite">
        {notice && (
          <div
            role="status"
            className={cn("flex items-start gap-2 rounded-xl border px-3 py-2 text-sm", notice.ok ? "border-emerald-300 bg-emerald-50 text-emerald-950" : "border-destructive/30 bg-destructive/5")}
          >
            {notice.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
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
            <p className="font-medium">No keyword ideas yet</p>
            <p className="max-w-md text-sm text-muted-foreground">Draft the first batch from the last 12 months of search terms.</p>
            <Button type="button" onClick={() => setTab("new")}>
              New ideas
            </Button>
          </div>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
            <nav aria-label="Batches" className="flex flex-col gap-1.5 lg:sticky lg:top-24">
              {batches.map((b) => {
                const stage = ideaStageLabel[b.stage]
                const isSel = b.id === selected?.id
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBatchId(b.id)}
                    aria-current={isSel ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-xl border bg-card px-3 py-2.5 text-left hover:border-primary/40",
                      isSel && "border-primary bg-primary/5 ring-1 ring-primary/30",
                    )}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium">{b.periodLabel}</span>
                      <Pill tone={stage.tone}>{stage.label}</Pill>
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{b.campaignName ?? "All campaigns"}</span>
                    <span className="text-xs text-muted-foreground">
                      {b.items.length} idea{b.items.length === 1 ? "" : "s"} · drafted by {b.drafted.by}
                    </span>
                  </button>
                )
              })}
            </nav>
            <div className="min-w-0">{selected && <IdeaBatch key={selected.id} batch={selected} shared={shared} />}</div>
          </div>
        )}
      </div>

      <div role="tabpanel" id="panel-new" aria-labelledby="tab-new" hidden={tab !== "new"}>
        <NewIdeas
          {...props}
          name={name}
          onDrafted={(r) => {
            setNotice(r)
            if (r.ok && r.batchId) {
              setBatchId(r.batchId)
              setTabRaw("batches")
            }
          }}
        />
      </div>
    </div>
  )
}

function NewIdeas({ campaigns, today, name, onDrafted }: Props & { name: string; onDrafted: (r: IdeaResult) => void }) {
  const back = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toISOString().slice(0, 10)
  }
  const quick = [
    { id: "12m", label: "Last 12 months", from: back(364), to: today },
    { id: "90", label: "Last 90 days", from: back(89), to: today },
    { id: "ytd", label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
    { id: "bateman", label: "Bateman (Jun 5 – Jul 23)", from: "2026-06-05", to: "2026-07-23" },
  ]
  const [from, setFrom] = useState(quick[0].from)
  const [to, setTo] = useState(quick[0].to)
  const [campaignId, setCampaignId] = useState("")
  const [sources, setSources] = useState<IdeaSource[]>(["proven", "phrase", "situation"])
  const [competitors, setCompetitors] = useState(false)
  const [busy, startTransition] = useTransition()
  const preset = quick.find((q) => q.from === from && q.to === to)?.id ?? "custom"
  const field = "h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
  const running = campaigns.filter((c) => c.status === "ENABLED")
  const others = campaigns.filter((c) => c.status !== "ENABLED")

  return (
    <section aria-labelledby="new-ideas" className="flex max-w-3xl flex-col gap-5 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <div>
        <h2 id="new-ideas" className="font-semibold">
          Find keywords worth adding
        </h2>
        <p className="text-sm text-muted-foreground">From the search terms in a period. A longer period means more evidence; 12 months is a good start.</p>
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
        <span className="text-xs font-medium text-muted-foreground">Searches from</span>
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

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Kinds of ideas</legend>
        {SOURCES.map((s) => (
          <label key={s.id} className="flex items-start gap-2 rounded-xl border p-3 text-sm has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
            <input
              type="checkbox"
              autoComplete="off"
              checked={sources.includes(s.id)}
              onChange={(e) => setSources((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
              className="mt-0.5 size-4 shrink-0"
            />
            <span>
              <span className="font-medium">{s.title}</span>
              <span className="block text-xs text-muted-foreground">{s.text}</span>
            </span>
          </label>
        ))}
        <label className="flex items-start gap-2 px-1 pt-1 text-sm">
          <input type="checkbox" autoComplete="off" checked={competitors} onChange={(e) => setCompetitors(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
          <span>
            Include competitor names
            <span className="block text-xs text-muted-foreground">Off by default. Some competitor searches have converted (e.g. &ldquo;liz buys houses&rdquo;), so you may want them in a competitor campaign.</span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="lg"
          disabled={busy || !from || !to || !sources.length}
          onClick={() => startTransition(async () => onDrafted(await draftKeywordIdeas({ from, to, campaignId, sources, competitors }, name)))}
        >
          {busy ? "Looking through your searches…" : "Draft keyword ideas"}
        </Button>
        <span className={cn("text-xs text-muted-foreground", !name.trim() && "text-amber-800")}>
          {name.trim() ? `Drafted by ${name.trim()}` : "Type your name at the top first"}
        </span>
      </div>
    </section>
  )
}
