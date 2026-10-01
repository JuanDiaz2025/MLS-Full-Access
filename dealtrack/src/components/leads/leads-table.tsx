"use client"

import { useMemo, useState, useTransition } from "react"
import { ChevronLeft, ChevronRight, RotateCcw, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { setLeadStatusAction } from "@/lib/leads/status-actions"
import { leadStatuses } from "@/lib/leads/types"
import { formatPhone, telHref } from "@/lib/phone"
import { cn } from "@/lib/utils"

export type LeadRow = {
  id: string
  received: string // already formatted, e.g. "Sep 30, 2:14 PM"
  receivedAt: string // ISO, for sorting
  name: string
  phone?: string
  email?: string
  address?: string
  channel: string
  form: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmTerm?: string
  gclid?: string
  landingPage?: string
  landingPath?: string
  referrer?: string
  notes?: string
  status: string
  statusBy?: "auto" | "you"
  statusRule?: string
  score?: { value: number; grade: "hot" | "warm" | "cold" | "junk"; reasons: string[] }
  // What Google Ads heard: a conversion sent, waiting to be sent, failed or skipped.
  google?: { state: "sent" | "pending" | "failed" | "skipped" | "held" | "retracting" | "retracted" | "retract_failed" | "checking" | "accepted" | "rejected" | "invalid" | "invalid_pending"; detail?: string }
}

const PAGE = 25

// The date choices above the table. Days are counted in this computer's time zone.
const ranges = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7", label: "Last 7 days" },
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
  { id: "month", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "custom", label: "Pick dates…" },
] as const
type RangeId = (typeof ranges)[number]["id"]

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const fromInput = (v: string) => {
  const [y, m, d] = v.split("-").map(Number)
  return y && m && d ? new Date(y, m - 1, d) : null
}
const toInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

// [from, to) for a choice, or null for all time.
function rangeBounds(id: RangeId, from: string, to: string): [Date, Date] | null {
  const today = startOfDay(new Date())
  switch (id) {
    case "today":
      return [today, addDays(today, 1)]
    case "yesterday":
      return [addDays(today, -1), today]
    case "7":
    case "30":
    case "90":
      return [addDays(today, -(Number(id) - 1)), addDays(today, 1)]
    case "month":
      return [new Date(today.getFullYear(), today.getMonth(), 1), addDays(today, 1)]
    case "lastmonth":
      return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 1)]
    case "custom": {
      const a = fromInput(from)
      const b = fromInput(to)
      if (!a && !b) return null
      return [a ?? new Date(0), b ? addDays(b, 1) : addDays(today, 1)]
    }
    default:
      return null
  }
}

const statusTone: Record<string, string> = {
  new: "border-border bg-card",
  interested: "border-emerald-500/50 bg-emerald-500/10 text-emerald-800",
  appointment: "border-sky-500/50 bg-sky-500/10 text-sky-800",
  offer: "border-violet-500/50 bg-violet-500/10 text-violet-800",
  closed: "border-emerald-700/60 bg-emerald-600 text-white",
  not_interested: "border-border bg-muted text-muted-foreground",
}

const gradeStyle = {
  hot: { label: "Hot", cls: "bg-red-600 text-white" },
  warm: { label: "Warm", cls: "bg-amber-400 text-amber-950" },
  cold: { label: "Cold", cls: "bg-sky-100 text-sky-900" },
  junk: { label: "Junk", cls: "bg-muted text-muted-foreground line-through" },
} as const

// The lead's score, with the reasons one click away.
function ScoreCell({ score }: { score?: LeadRow["score"] }) {
  if (!score) return <span className="text-muted-foreground/60">–</span>
  const g = gradeStyle[score.grade]
  return (
    <details className="group/score">
      <summary className="flex cursor-pointer list-none items-center gap-1.5">
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", g.cls)}>{g.label}</span>
        <span className="text-xs font-medium tabular-nums">{score.grade === "junk" ? "" : score.value}</span>
        <span className="text-xs text-primary underline-offset-2 group-open/score:hidden hover:underline">why?</span>
      </summary>
      <ul className="mt-1 max-w-64 space-y-0.5 text-xs whitespace-normal text-muted-foreground">
        {score.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </details>
  )
}

const googleLabel = {
  sent: { text: "Sent to Google ✓", cls: "bg-emerald-500/10 text-emerald-700" },
  pending: { text: "Waiting for Google", cls: "bg-amber-500/15 text-amber-800" },
  failed: { text: "Not sent", cls: "bg-destructive/10 text-destructive" },
  skipped: { text: "Can't match", cls: "bg-muted text-muted-foreground" },
  held: { text: "Not sent (rule)", cls: "bg-muted text-muted-foreground" },
  checking: { text: "Sent, Google checking", cls: "bg-sky-500/10 text-sky-800" },
  accepted: { text: "Accepted by Google ✓", cls: "bg-emerald-500/15 text-emerald-800" },
  rejected: { text: "Rejected by Google", cls: "bg-destructive/10 text-destructive" },
  retracting: { text: "Taking back from Google", cls: "bg-amber-500/15 text-amber-800" },
  invalid: { text: "Reported as invalid ✓", cls: "bg-muted text-foreground" },
  invalid_pending: { text: "Reporting as invalid", cls: "bg-muted text-muted-foreground" },
  retracted: { text: "Taken back from Google ✓", cls: "bg-muted text-foreground" },
  retract_failed: { text: "Couldn't take back", cls: "bg-destructive/10 text-destructive" },
} as const

// The status picker in each row. Interested and later stages tell Google Ads this lead was good.
function StatusCell({ id, status, auto, rule }: { id: string; status: string; auto: boolean; rule?: string }) {
  const [value, setValue] = useState(status)
  const [byApp, setByApp] = useState(auto)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label="Lead status"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value
          setValue(next)
          setByApp(false)
          setError(null)
          start(async () => {
            const res = await setLeadStatusAction(id, next)
            if (res.error) {
              setError(res.error)
              setValue(status)
            }
          })
        }}
        className={cn("h-8 rounded-lg border px-1.5 text-xs font-semibold", statusTone[value] ?? statusTone.new)}
      >
        {leadStatuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {byApp && value !== "new" && (
        <span className="max-w-40 text-xs whitespace-normal text-muted-foreground">{rule ? `Set by rule: ${rule}` : "Set by its score"}</span>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

// The ✕ on a lead: marks it Not interested in one click (it moves to the Not interested list,
// and Google Ads hears about it). In that list, ↺ puts it back as New.
function QuickStatus({ id, to, label }: { id: string; to: "not_interested" | "new"; label: string }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await setLeadStatusAction(id, to)
            if (res.error) setError(res.error)
          })
        }
        className={to === "not_interested" ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive" : "text-muted-foreground hover:text-primary"}
      >
        {to === "not_interested" ? <X /> : <RotateCcw />}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

// Leads as a spreadsheet: one row per lead, a column per detail, searchable and filterable.
export default function LeadsTable({ rows }: { rows: LeadRow[] }) {
  const [query, setQuery] = useState("")
  // Not interested leads live in their own list, out of the way of the ones you're working.
  const [list, setList] = useState<"active" | "not_interested">("active")
  const inList = (r: LeadRow) => (list === "active" ? r.status !== "not_interested" : r.status === "not_interested")
  const notInterested = rows.filter((r) => r.status === "not_interested").length
  const [channel, setChannel] = useState("")
  const [status, setStatus] = useState("")
  const [grade, setGrade] = useState("")
  const [range, setRange] = useState<RangeId>("all")
  const [from, setFrom] = useState(() => toInput(addDays(new Date(), -29)))
  const [to, setTo] = useState(() => toInput(new Date()))
  const bounds = rangeBounds(range, from, to)
  const inRange = (r: LeadRow) => {
    if (!bounds) return true
    const t = Date.parse(r.receivedAt)
    return t >= bounds[0].getTime() && t < bounds[1].getTime()
  }
  const [page, setPage] = useState(0)

  const channels = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.channel, (counts.get(r.channel) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        inList(r) &&
        inRange(r) &&
        (!channel || r.channel === channel) &&
        (!status || r.status === status) &&
        (!grade || r.score?.grade === grade) &&
        (!q ||
          [r.name, r.phone, r.email, r.address, r.utmCampaign, r.utmTerm, r.utmSource, r.notes, r.form]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(q)) ||
          // "(510) 394-5339", "510-394" or "5103945339" all find the same number.
          (q.replace(/\D/g, "").length >= 3 && Boolean(r.phone?.replace(/\D/g, "").includes(q.replace(/\D/g, ""))))),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, channel, status, grade, range, from, to, list])

  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const current = Math.min(page, pages - 1)
  const visible = shown.slice(current * PAGE, (current + 1) * PAGE)

  const th = "sticky top-0 z-10 border-b border-r bg-muted px-3 py-2 text-left text-xs font-semibold whitespace-nowrap text-muted-foreground last:border-r-0"
  const td = "border-r px-3 py-2 align-top whitespace-nowrap last:border-r-0"
  const empty = <span className="text-muted-foreground/60">–</span>

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Which leads" className="flex gap-1 border-b">
        {(
          [
            ["active", `Leads (${rows.length - notInterested})`],
            ["not_interested", `Not interested (${notInterested})`],
          ] as const
        ).map(([id, text]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={list === id}
            onClick={() => {
              setList(id)
              setPage(0)
            }}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium",
              list === id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {text}
          </button>
        ))}
      </div>
      {list === "not_interested" && (
        <p className="text-sm text-muted-foreground">
          Leads you marked Not interested. Anything already sent to Google Ads for them is taken back, and they&apos;re reported as
          invalid leads (reporting only), so Google&apos;s reports show which ads bring leads like these. ↺ puts a lead back in your list.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">Search leads</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            placeholder="Search name, phone, email, campaign…"
            className="h-10 w-full rounded-lg border bg-card pr-3 pl-9 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Date</span>
          <select
            value={range}
            onChange={(e) => {
              setRange(e.target.value as RangeId)
              setPage(0)
            }}
            className={cn("h-10 rounded-lg border bg-card px-2 text-sm", range !== "all" && "border-primary font-medium text-primary")}
          >
            {ranges.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {range === "custom" && (
          <div className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">From</span>
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setPage(0)
                }}
                className="h-10 rounded-lg border bg-card px-2 text-sm"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => {
                  setTo(e.target.value)
                  setPage(0)
                }}
                className="h-10 rounded-lg border bg-card px-2 text-sm"
              />
            </label>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Channel</span>
          <select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value)
              setPage(0)
            }}
            className="h-10 max-w-[14rem] rounded-lg border bg-card px-2 text-sm"
          >
            <option value="">All ({rows.length})</option>
            {channels.map(([name, n]) => (
              <option key={name} value={name}>
                {name} ({n})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Status</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(0)
            }}
            className="h-10 rounded-lg border bg-card px-2 text-sm"
          >
            <option value="">All</option>
            {leadStatuses.map((st) => (
              <option key={st.id} value={st.id}>
                {st.label} ({rows.filter((r) => r.status === st.id).length})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Score</span>
          <select
            value={grade}
            onChange={(e) => {
              setGrade(e.target.value)
              setPage(0)
            }}
            className="h-10 rounded-lg border bg-card px-2 text-sm"
          >
            <option value="">All</option>
            {(["hot", "warm", "cold", "junk"] as const).map((g) => (
              <option key={g} value={g}>
                {gradeStyle[g].label} ({rows.filter((r) => r.score?.grade === g).length})
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="max-h-[70vh] overflow-auto rounded-xl border">
        <table className="w-full min-w-[1800px] border-collapse text-sm tabular-nums">
          <thead>
            <tr>
              <th className={th}>
                <span className="sr-only">{list === "active" ? "Not interested" : "Put back"}</span>
              </th>
              <th className={th}>#</th>
              <th className={th}>Received</th>
              <th className={th}>Name</th>
              <th className={th} title="Scored when the lead arrived, from 0 to 100">Score</th>
              <th className={th}>Status</th>
              <th className={th} title="Interested and closed leads are sent back to Google Ads as conversions">Google Ads</th>
              <th className={th}>Phone</th>
              <th className={th}>Email</th>
              <th className={th}>Property address</th>
              <th className={th}>Channel</th>
              <th className={th}>UTM source</th>
              <th className={th}>UTM medium</th>
              <th className={th}>UTM campaign</th>
              <th className={th}>UTM term (keyword)</th>
              <th className={th}>Google click ID</th>
              <th className={th}>Landing page</th>
              <th className={th}>Referrer</th>
              <th className={th}>Form</th>
              <th className={th}>Message</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={r.id} className="border-b odd:bg-card even:bg-muted/30 hover:bg-primary/5">
                <td className={`${td} px-1 py-1`}>
                  {list === "active" ? (
                    <QuickStatus id={r.id} to="not_interested" label={`Not interested: ${r.name}`} />
                  ) : (
                    <QuickStatus id={r.id} to="new" label={`Put back in my leads: ${r.name}`} />
                  )}
                </td>
                <td className={`${td} text-muted-foreground`}>{current * PAGE + i + 1}</td>
                <td className={td}>{r.received}</td>
                <td className={`${td} font-medium`}>{r.name}</td>
                <td className={td}>
                  <ScoreCell score={r.score} />
                </td>
                <td className={td}>
                  <StatusCell id={r.id} status={r.status} auto={r.statusBy === "auto"} rule={r.statusRule} />
                </td>
                <td className={td} title={r.google?.detail}>
                  {r.google ? (
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", googleLabel[r.google.state].cls)}>
                      {googleLabel[r.google.state].text}
                    </span>
                  ) : (
                    empty
                  )}
                  {r.google && r.google.state !== "failed" && r.google.state !== "retract_failed" && r.google.state !== "rejected" && r.google.detail && (
                    <p className="mt-1 max-w-56 text-xs whitespace-normal text-muted-foreground">{r.google.detail}</p>
                  )}
                  {(r.google?.state === "failed" || r.google?.state === "retract_failed" || r.google?.state === "rejected") && r.google.detail && (
                    <p className="mt-1 max-w-56 text-xs whitespace-normal text-destructive">{r.google.detail}</p>
                  )}
                </td>
                <td className={td}>
                  {r.phone ? (
                    <a href={telHref(r.phone)} className="text-primary hover:underline">
                      {formatPhone(r.phone)}
                    </a>
                  ) : (
                    empty
                  )}
                </td>
                <td className={td}>
                  {r.email ? (
                    <a href={`mailto:${r.email}`} className="text-primary hover:underline">
                      {r.email}
                    </a>
                  ) : (
                    empty
                  )}
                </td>
                <td className={`${td} max-w-64 truncate`} title={r.address}>
                  {r.address || empty}
                </td>
                <td className={td}>
                  <span
                    className={
                      r.channel === "Unknown" || r.channel === "Direct"
                        ? "rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
                        : "rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                    }
                  >
                    {r.channel}
                  </span>
                </td>
                <td className={td}>{r.utmSource || empty}</td>
                <td className={td}>{r.utmMedium || empty}</td>
                <td className={`${td} max-w-48 truncate`} title={r.utmCampaign}>
                  {r.utmCampaign || empty}
                </td>
                <td className={`${td} max-w-48 truncate`} title={r.utmTerm}>
                  {r.utmTerm || empty}
                </td>
                <td className={td} title={r.gclid}>
                  {r.gclid ? `Yes · ${r.gclid.slice(0, 8)}…` : empty}
                </td>
                <td className={`${td} max-w-56 truncate`} title={r.landingPage}>
                  {r.landingPage ? (
                    <a href={r.landingPage} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {r.landingPath}
                    </a>
                  ) : (
                    empty
                  )}
                </td>
                <td className={`${td} max-w-48 truncate`} title={r.referrer}>
                  {r.referrer || empty}
                </td>
                <td className={td}>{r.form || empty}</td>
                <td className={`${td} max-w-80 truncate`} title={r.notes}>
                  {r.notes || empty}
                </td>
              </tr>
            ))}
            {!visible.length && (
              <tr>
                <td colSpan={20} className="px-3 py-6 text-center text-muted-foreground">
                  {list === "not_interested" && !notInterested ? "No leads marked Not interested." : "No leads match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {shown.length
            ? `Showing ${current * PAGE + 1}–${current * PAGE + visible.length} of ${shown.length} leads`
            : "0 leads"}
          {shown.length !== rows.length && ` (filtered from ${rows.length})`}
        </span>
        {pages > 1 && (
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => setPage(current - 1)} disabled={current === 0}>
              <ChevronLeft data-icon="inline-start" />
              Previous
            </Button>
            <span className="px-2 text-muted-foreground">
              Page {current + 1} of {pages}
            </span>
            <Button variant="outline" size="sm" onClick={() => setPage(current + 1)} disabled={current === pages - 1}>
              Next
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
