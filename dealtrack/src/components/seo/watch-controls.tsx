"use client"

// Competitors → SEO → Competitor watch: the buttons and the changes to review. The settings and
// "Check now" (admins), adding sites from Google Ads or by hand (admins), and Act / Watch / Ignore
// on each change (anyone signed in).

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, ExternalLink, Eye, LoaderCircle, Pause, Play, Plus, RefreshCw, Save, Trash2, X } from "lucide-react"

import {
  addCompetitorAction,
  checkNowAction,
  decideChangesAction,
  noteChangeAction,
  removeCompetitorAction,
  saveWatchSettingsAction,
  updateCompetitorAction,
  type SeoState,
} from "@/app/actions/seo"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { Change, ChangeStatus, WatchSettings } from "@/lib/seo/site-watch"
import { cn } from "@/lib/utils"

const fmt = (n: number) => n.toLocaleString("en-US")
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const pathOf = (url: string) => {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}` || "/"
  } catch {
    return url
  }
}

function useAct() {
  const router = useRouter()
  const [message, setMessage] = useState<SeoState | null>(null)
  const [busy, start] = useTransition()
  const act = (fn: () => Promise<SeoState>, after?: (r: SeoState) => void) =>
    start(async () => {
      setMessage(null)
      const r = await fn()
      setMessage(r)
      after?.(r)
      router.refresh()
    })
  return { message, busy, act }
}

function Message({ m }: { m: SeoState | null }) {
  if (!m) return null
  return (
    <p role="status" className={cn("text-xs", m.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
      {m.message}
    </p>
  )
}

const select = "h-8 rounded-md border border-input bg-background px-2 text-sm"
const input = "h-8 rounded-md border border-input bg-background px-2.5 text-sm"

// While a check runs, the page refreshes itself every few seconds to show how far it got.
export function WatchProgress({ progress }: { progress: { site: string; started: string; read: number; total: number } | null }) {
  const router = useRouter()
  useEffect(() => {
    if (!progress) return
    const t = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(t)
  }, [progress, router])
  if (!progress) return null
  return (
    <p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm" role="status">
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      Checking <b>{progress.site}</b>: {progress.total ? `${fmt(progress.read)} of ${fmt(progress.total)} pages` : "reading its robots.txt and sitemap"} (started {when(progress.started)}).
    </p>
  )
}

export function WatchSettingsCard({
  admin,
  settings,
  everyChoices,
  pageChoices,
  sites,
}: {
  admin: boolean
  settings: WatchSettings
  everyChoices: number[]
  pageChoices: number[]
  sites: number
}) {
  const [on, setOn] = useState(settings.on)
  const [every, setEvery] = useState(String(settings.every))
  const [maxPages, setMaxPages] = useState(String(settings.maxPages))
  const { message, busy, act } = useAct()
  const everyLabel = (d: number) => (d === 7 ? "Every week" : d === 14 ? "Every 2 weeks" : `Every ${d} days`)
  if (!admin)
    return (
      <p className="text-sm text-muted-foreground">
        {settings.on ? `${everyLabel(settings.every)}, up to ${fmt(settings.maxPages)} pages a site.` : "Automatic checks are off."} Admins change this.
      </p>
    )
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          Check automatically
        </label>
        <select value={every} onChange={(e) => setEvery(e.target.value)} className={select} aria-label="How often">
          {everyChoices.map((d) => (
            <option key={d} value={d}>
              {everyLabel(d)}
            </option>
          ))}
        </select>
        <select value={maxPages} onChange={(e) => setMaxPages(e.target.value)} className={select} aria-label="Pages a site, at most">
          {pageChoices.map((n) => (
            <option key={n} value={n}>
              Up to {n} pages a site
            </option>
          ))}
        </select>
        <Button type="button" size="sm" disabled={busy} onClick={() => act(() => saveWatchSettingsAction({ on, every: Number(every), maxPages: Number(maxPages) }))}>
          {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || !sites} onClick={() => act(() => checkNowAction())}>
          <RefreshCw data-icon="inline-start" />
          Check all now
        </Button>
      </div>
      <Message m={message} />
    </div>
  )
}

export function AddCompetitor({ admin }: { admin: boolean }) {
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")
  const [tier, setTier] = useState("")
  const { message, busy, act } = useAct()
  if (!admin) return null
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        act(
          () => addCompetitorAction({ url, name, tier: tier || null }),
          (r) => {
            if (r.ok) {
              setUrl("")
              setName("")
            }
          },
        )
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Their website: maplehomebuyers.com" aria-label="Website" className={cn(input, "w-72 max-w-full")} required />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" className={cn(input, "w-44")} />
        <select value={tier} onChange={(e) => setTier(e.target.value)} className={select} aria-label="Tier">
          <option value="">No tier</option>
          <option value="1">Tier 1</option>
          <option value="2">Tier 2</option>
        </select>
        <Button type="submit" size="sm" disabled={busy || !url.trim()}>
          {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}
          Add
        </Button>
      </div>
      <Message m={message} />
    </form>
  )
}

// Advertisers from Google Ads (Auction insights, Competitor ads) not on the list yet.
export function Suggestions({ admin, items }: { admin: boolean; items: { site: string; from: "auction" | "ads"; seen: number }[] }) {
  const { message, busy, act } = useAct()
  const [added, setAdded] = useState<Set<string>>(new Set())
  if (!items.length)
    return <p className="text-sm text-muted-foreground">No advertisers to suggest: they come from Auction insights downloads and the Competitor ads searches.</p>
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-2">
        {items.map((s) => (
          <li key={s.site} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
            <span className="font-medium">{s.site}</span>
            <span className="text-xs text-muted-foreground">
              {s.from === "auction" ? `Auction insights, ${s.seen} download${s.seen === 1 ? "" : "s"}` : `${fmt(s.seen)} ad${s.seen === 1 ? "" : "s"} seen`}
            </span>
            {admin &&
              (added.has(s.site) ? (
                <Check className="size-4 text-emerald-600" aria-label="Added" />
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => act(() => addCompetitorAction({ url: s.site, from: s.from }), (r) => r.ok && setAdded(new Set([...added, s.site])))}
                >
                  <Eye data-icon="inline-start" />
                  Watch
                </Button>
              ))}
          </li>
        ))}
      </ul>
      <Message m={message} />
    </div>
  )
}

// "Watch website" next to a competitor on the other Competitors pages (admins).
export function WatchButton({ site, from, watching }: { site: string; from?: "auction" | "ads"; watching: boolean }) {
  const { message, busy, act } = useAct()
  const [done, setDone] = useState(false)
  if (watching || done)
    return (
      <a href="/competitors/seo?tab=watch" className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-emerald-700 hover:underline dark:text-emerald-400">
        <Eye className="size-3" /> Watching
      </a>
    )
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => act(() => addCompetitorAction({ url: site, from }), (r) => r.ok && setDone(true))}>
        <Eye data-icon="inline-start" />
        Watch website
      </Button>
      {message && !message.ok && <Message m={message} />}
    </span>
  )
}

export function SiteActions({ admin, site, on, tier, stopped }: { admin: boolean; site: string; on: boolean; tier: 1 | 2 | null; stopped: boolean }) {
  const { message, busy, act } = useAct()
  if (!admin) return null
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button type="button" size="xs" variant={stopped ? "default" : "outline"} disabled={busy} onClick={() => act(() => checkNowAction(site))} title="Check this site now">
          <RefreshCw data-icon="inline-start" />
          {stopped ? "Try again" : "Check now"}
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => act(() => updateCompetitorAction(site, { on: !on }))}>
          {on ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          {on ? "Pause" : "Resume"}
        </Button>
        <select
          value={tier ?? ""}
          disabled={busy}
          onChange={(e) => act(() => updateCompetitorAction(site, { tier: e.target.value || null }))}
          className="h-6 rounded-md border border-input bg-background px-1 text-xs"
          aria-label={`Tier for ${site}`}
        >
          <option value="">No tier</option>
          <option value="1">Tier 1</option>
          <option value="2">Tier 2</option>
        </select>
        <Button
          type="button"
          size="xs"
          variant="destructive"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Take ${site} off the list? Its pages and changes are forgotten.`)) act(() => removeCompetitorAction(site))
          }}
          aria-label={`Remove ${site}`}
        >
          <Trash2 />
        </Button>
      </div>
      <Message m={message} />
    </div>
  )
}

// ---- Changes ------------------------------------------------------------------------------------

const STATUS_LABEL: Record<ChangeStatus, string> = { new: "To review", act: "Act", watch: "Watch", ignore: "Ignore" }
const STATUS_TONE: Record<ChangeStatus, "amber" | "green" | "violet" | "gray"> = { new: "amber", act: "green", watch: "violet", ignore: "gray" }
const FILTERS: { id: ChangeStatus | "all"; label: string }[] = [
  { id: "new", label: "To review" },
  { id: "act", label: "Act" },
  { id: "watch", label: "Watch" },
  { id: "ignore", label: "Ignored" },
  { id: "all", label: "All" },
]
const PAGE = 40

type Labels = { offers: Record<string, string>; situations: Record<string, string>; names: Record<string, string> }

function Diffs({ c, labels }: { c: Change; labels: Labels }) {
  const lines: { label: string; added?: string[]; removed?: string[] }[] = []
  const l = (list: string[] | undefined, map?: Record<string, string>) => (list ?? []).map((x) => map?.[x] ?? x)
  if (c.added || c.removed) {
    const pairs: [string, keyof NonNullable<Change["added"]>, Record<string, string>?][] = [
      ["Offers", "offers", labels.offers],
      ["Cities", "places"],
      ["Seller situations", "situations", labels.situations],
      ["Phone", "phones"],
      ["Headings", "headings"],
    ]
    for (const [label, key, map] of pairs) {
      const added = l(c.added?.[key], map)
      const removed = l(c.removed?.[key], map)
      if (added.length || removed.length) lines.push({ label, added, removed })
    }
  }
  const before = c.before
  const after = c.after
  return (
    <div className="flex flex-col gap-1 text-xs">
      {c.kind === "changed" && before && after && (
        <>
          {before.title !== after.title && (
            <p>
              <span className="text-muted-foreground">Title: </span>
              <del className="text-muted-foreground">{before.title || "(none)"}</del> → <b>{after.title || "(none)"}</b>
            </p>
          )}
          {before.h1 !== after.h1 && (
            <p>
              <span className="text-muted-foreground">Headline: </span>
              <del className="text-muted-foreground">{before.h1 || "(none)"}</del> → <b>{after.h1 || "(none)"}</b>
            </p>
          )}
          {c.what.includes("Description") && (
            <p>
              <span className="text-muted-foreground">Description: </span>
              {after.desc || "(none)"}
            </p>
          )}
          {(c.what.includes("More text") || c.what.includes("Less text")) && (
            <p className="text-muted-foreground">
              Text: {fmt(before.words)} → {fmt(after.words)} words
            </p>
          )}
        </>
      )}
      {c.kind === "new" && after && (
        <p>
          <b>{after.title || after.h1 || pathOf(c.url)}</b>
          {after.h1 && after.h1 !== after.title && <span className="text-muted-foreground"> · {after.h1}</span>}
          {after.offers.length > 0 && <span className="text-muted-foreground"> · offers: {l(after.offers, labels.offers).join(", ")}</span>}
        </p>
      )}
      {c.kind === "removed" && (
        <p className="text-muted-foreground">
          {before?.title ? <>Was: {before.title}. </> : null}
          {c.movedTo ? <>Now sends visitors to {pathOf(c.movedTo)}.</> : <>Answers “not found” now.</>}
        </p>
      )}
      {lines.map((x) => (
        <p key={x.label}>
          <span className="text-muted-foreground">{x.label}: </span>
          {x.added?.length ? <span className="text-emerald-700 dark:text-emerald-400">+ {x.added.join(" · ")}</span> : null}
          {x.added?.length && x.removed?.length ? " " : null}
          {x.removed?.length ? <span className="text-destructive">− {x.removed.join(" · ")}</span> : null}
        </p>
      ))}
    </div>
  )
}

function ChangeRow({ c, labels, signedIn }: { c: Change; labels: Labels; signedIn: boolean }) {
  const [note, setNote] = useState(c.note ?? "")
  const [noteSaved, setNoteSaved] = useState(c.note ?? "")
  const { message, busy, act } = useAct()
  // Saving a note on its own doesn't hold up the buttons: leaving the note box to click Act
  // saves both.
  const [, startNote] = useTransition()
  const tags = [...c.tags.places, ...c.tags.situations.map((s) => labels.situations[s] ?? s), ...c.tags.offers.map((o) => labels.offers[o] ?? o)]
  return (
    <li className="flex flex-col gap-2 border-b border-border/60 py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium">{labels.names[c.site] ?? c.site}</span>
            <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-0.5 break-all text-primary hover:underline">
              {pathOf(c.url)} <ExternalLink className="size-3 shrink-0" />
            </a>
          </p>
          <div className="flex flex-wrap gap-1">
            <Pill tone={c.kind === "new" ? "green" : c.kind === "removed" ? "red" : "violet"}>{c.kind === "new" ? "New" : c.kind === "removed" ? "Gone" : "Changed"}</Pill>
            {c.what
              .filter((w) => !["New page", "Taken down"].includes(w))
              .map((w) => (
                <Pill key={w}>{w}</Pill>
              ))}
            {tags.length > 0 && <span className="text-xs text-muted-foreground">about {tags.join(", ")}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Pill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Pill>
          {day(c.at)}
        </div>
      </div>
      <Diffs c={c} labels={labels} />
      {signedIn && (
        <div className="flex flex-wrap items-center gap-1.5">
          {(["act", "watch", "ignore"] as const).map((s) => (
            <Button
              key={s}
              type="button"
              size="xs"
              variant={c.status === s ? "default" : "outline"}
              disabled={busy}
              onClick={() => act(() => decideChangesAction([c.id], c.status === s ? "new" : s, note))}
              aria-pressed={c.status === s}
            >
              {s === "act" ? <Check data-icon="inline-start" /> : s === "watch" ? <Eye data-icon="inline-start" /> : <X data-icon="inline-start" />}
              {STATUS_LABEL[s]}
            </Button>
          ))}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              if (note === noteSaved) return
              setNoteSaved(note)
              startNote(async () => {
                await noteChangeAction(c.id, note)
              })
            }}
            placeholder="Note: what we'll do (optional)"
            aria-label="Note"
            className="h-6 min-w-40 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          />
          {c.by && c.decidedAt && (
            <span className="text-xs text-muted-foreground">
              {STATUS_LABEL[c.status]} by {c.by}, {day(c.decidedAt)}
            </span>
          )}
          <Message m={message} />
        </div>
      )}
    </li>
  )
}

export function ChangeList({ changes, labels, signedIn }: { changes: Change[]; labels: Labels; signedIn: boolean }) {
  const [filter, setFilter] = useState<ChangeStatus | "all">("new")
  const [site, setSite] = useState("")
  const [kind, setKind] = useState("")
  const [shown, setShown] = useState(PAGE)
  const { message, busy, act } = useAct()
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: changes.length }
    for (const x of changes) c[x.status] = (c[x.status] ?? 0) + 1
    return c
  }, [changes])
  const sites = useMemo(() => [...new Set(changes.map((c) => c.site))].sort(), [changes])
  const rows = changes.filter((c) => (filter === "all" || c.status === filter) && (!site || c.site === site) && (!kind || c.kind === kind))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 font-medium" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setFilter(f.id)
                setShown(PAGE)
              }}
              aria-pressed={filter === f.id}
              className={cn("rounded-md px-2.5 py-1", filter === f.id ? "bg-background shadow-xs" : "text-muted-foreground")}
            >
              {f.label} <span className="opacity-70">({fmt(counts[f.id] ?? 0)})</span>
            </button>
          ))}
        </div>
        <select value={site} onChange={(e) => setSite(e.target.value)} className={select} aria-label="Competitor">
          <option value="">Every competitor</option>
          {sites.map((s) => (
            <option key={s} value={s}>
              {labels.names[s] ?? s}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={select} aria-label="Kind of change">
          <option value="">New, changed and gone</option>
          <option value="new">New pages</option>
          <option value="changed">Changed pages</option>
          <option value="removed">Gone pages</option>
        </select>
        {signedIn && filter === "new" && rows.length > 1 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Mark all ${rows.length} shown as Ignore?`)) act(() => decideChangesAction(rows.map((r) => r.id), "ignore"))
            }}
          >
            <X data-icon="inline-start" />
            Ignore all {fmt(rows.length)} shown
          </Button>
        )}
      </div>
      <Message m={message} />
      {rows.length ? (
        <ul className="flex flex-col">
          {rows.slice(0, shown).map((c) => (
            <ChangeRow key={c.id} c={c} labels={labels} signedIn={signedIn} />
          ))}
        </ul>
      ) : (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {changes.length ? "Nothing here with these filters." : "No changes yet. A site's first check is the starting point; changes show from its next check."}
        </p>
      )}
      {rows.length > shown && (
        <Button type="button" variant="outline" size="sm" className="self-center" onClick={() => setShown(shown + PAGE)}>
          Show more ({fmt(rows.length - shown)} left)
        </Button>
      )}
    </div>
  )
}
