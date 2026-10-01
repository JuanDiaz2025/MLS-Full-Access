"use client"

import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Search } from "lucide-react"

import { Button } from "@/components/ui/button"

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
  utmContent?: string
  gclid?: string
  landingPage?: string
  landingPath?: string
  referrer?: string
  notes?: string
}

const PAGE = 25
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`

// Leads as a spreadsheet: one row per lead, a column per detail, searchable and filterable.
export default function LeadsTable({ rows }: { rows: LeadRow[] }) {
  const [query, setQuery] = useState("")
  const [channel, setChannel] = useState("")
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
        (!channel || r.channel === channel) &&
        (!q ||
          [r.name, r.phone, r.email, r.address, r.utmCampaign, r.utmTerm, r.utmSource, r.notes, r.form]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(q))),
    )
  }, [rows, query, channel])

  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const current = Math.min(page, pages - 1)
  const visible = shown.slice(current * PAGE, (current + 1) * PAGE)

  const th = "sticky top-0 z-10 border-b border-r bg-muted px-3 py-2 text-left text-xs font-semibold whitespace-nowrap text-muted-foreground last:border-r-0"
  const td = "border-r px-3 py-2 align-top whitespace-nowrap last:border-r-0"
  const empty = <span className="text-muted-foreground/60">–</span>

  return (
    <div className="flex flex-col gap-3">
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
      </div>

      <div className="max-h-[70vh] overflow-auto rounded-xl border">
        <table className="w-full min-w-[1500px] border-collapse text-sm tabular-nums">
          <thead>
            <tr>
              <th className={th}>#</th>
              <th className={th}>Received</th>
              <th className={th}>Name</th>
              <th className={th}>Phone</th>
              <th className={th}>Email</th>
              <th className={th}>Property address</th>
              <th className={th}>Channel</th>
              <th className={th}>UTM source</th>
              <th className={th}>UTM medium</th>
              <th className={th}>UTM campaign</th>
              <th className={th}>UTM term (keyword)</th>
              <th className={th}>UTM content</th>
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
                <td className={`${td} text-muted-foreground`}>{current * PAGE + i + 1}</td>
                <td className={td}>{r.received}</td>
                <td className={`${td} font-medium`}>{r.name}</td>
                <td className={td}>
                  {r.phone ? (
                    <a href={telHref(r.phone)} className="text-primary hover:underline">
                      {r.phone}
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
                <td className={`${td} max-w-40 truncate`} title={r.utmContent}>
                  {r.utmContent || empty}
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
                <td colSpan={17} className="px-3 py-6 text-center text-muted-foreground">
                  No leads match.
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
