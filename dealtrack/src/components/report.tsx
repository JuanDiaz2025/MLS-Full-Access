// Building blocks shared by every report page: heading with the date range, KPI tiles, tables,
// status pills, and the "keys missing" / "Google returned an error" states.

import type { ReactNode } from "react"
import { headers } from "next/headers"
import Link from "next/link"
import { AlertTriangle, KeyRound } from "lucide-react"

import { Pill } from "@/components/pill"
import RangePicker from "@/components/range-picker"
import { changesEnabled } from "@/lib/auth"
import type { DateRange } from "@/lib/date-range"
import type { Problem } from "@/lib/load"
import { cn } from "@/lib/utils"

export { Pill }

export function PageHeader({
  title,
  description,
  range,
}: {
  title: string
  description: string
  // Pages that cover a fixed period (Forecast, Alerts) leave out the date picker.
  range?: DateRange
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {description}
        </p>
        {range && (
          <p className="text-xs text-muted-foreground">
            Date range: <span className="font-medium text-foreground">{range.label}</span>
          </p>
        )}
      </div>
      {range && <RangePicker range={range} />}
    </div>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
  id,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  id?: string
}) {
  return (
    <section id={id} className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export type Kpi = { label: string; value: string; note?: string; tone?: "default" | "bad" | "good" }

export function KpiGrid({ items }: { items: Kpi[] }) {
  return (
    <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {items.map((kpi) => (
        <div key={kpi.label} className="rounded-2xl border bg-card p-4 shadow-xs">
          <p className="text-xs text-muted-foreground">{kpi.label}</p>
          <p
            className={cn(
              "mt-1.5 text-2xl font-semibold tracking-tight tabular-nums",
              kpi.tone === "bad" && "text-destructive",
              kpi.tone === "good" && "text-emerald-600",
            )}
          >
            {kpi.value}
          </p>
          {kpi.note && <p className="mt-1 text-xs text-muted-foreground">{kpi.note}</p>}
        </div>
      ))}
    </section>
  )
}

export type Column<T> = {
  key: string
  label: string
  align?: "left" | "right"
  className?: string
  render: (row: T) => ReactNode
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  empty = "No data for this date range.",
  rowClassName,
  footer,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  empty?: string
  rowClassName?: (row: T) => string | undefined
  footer?: ReactNode
}) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>

  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  "px-4 py-2 font-medium whitespace-nowrap first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
                  c.align === "right" ? "text-right" : "text-left",
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={cn("border-b border-border/60 last:border-0 hover:bg-muted/40", rowClassName?.(row))}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "px-4 py-2 align-top first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
                    c.align === "right" && "text-right tabular-nums whitespace-nowrap",
                    c.className,
                  )}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer}
      </table>
    </div>
  )
}

// ENABLED → "Enabled", EXACT → "Exact", MAXIMIZE_CONVERSIONS → "Maximize conversions".
export function enumLabel(value: string) {
  if (!value || value === "UNSPECIFIED" || value === "UNKNOWN") return "—"
  const text = value.toLowerCase().replace(/_/g, " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function StatusPill({ status }: { status: string }) {
  const tone = status === "ENABLED" ? "green" : status === "PAUSED" ? "amber" : "gray"
  return <Pill tone={tone}>{enumLabel(status)}</Pill>
}

// Shown to viewers where admins get change buttons.
export async function AdminLink() {
  if (!changesEnabled()) {
    return <span className="text-xs text-muted-foreground">Set ADMIN_PASSWORD to make changes from here.</span>
  }
  const path = (await headers()).get("x-pathname") ?? "/overview"
  return (
    <Link
      href={`/login?admin=1&next=${encodeURIComponent(path)}`}
      className="text-sm font-medium text-primary hover:underline"
    >
      Sign in as admin to make changes
    </Link>
  )
}

export function ReportProblem({ problem }: { problem: Problem }) {
  if (problem.kind === "missing") {
    return (
      <div className="flex gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950">
        <KeyRound className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="flex flex-col gap-2">
          <p className="font-medium">{problem.service ?? "Google Ads"} isn&apos;t connected yet.</p>
          <p>
            Add these to the server&apos;s environment variables (<code className="font-mono">.env.local</code> on your
            computer, or the hosting provider&apos;s settings), then restart the app:
          </p>
          <ul className="list-disc pl-5 font-mono text-xs">
            {problem.keys.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      </div>
    )
  }
  return (
    <div role="alert" className="flex gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium">{problem.message}</p>
        {problem.detail && (
          <p className="text-muted-foreground">
            {problem.service ?? "Google"} said: {problem.detail}
          </p>
        )}
      </div>
    </div>
  )
}
