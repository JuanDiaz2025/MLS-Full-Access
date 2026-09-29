import type { Metadata } from "next"
import Link from "next/link"

import ScheduleEditor, { type EditorSlot } from "@/components/changes/schedule-editor"
import { formatConversions, formatUsd } from "@/components/dashboard/format"
import { AdminLink, PageHeader, ReportProblem, Section } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { parseRange, rangeQuery, type DateRange } from "@/lib/date-range"
import { getAdSchedules, getCampaignControls } from "@/lib/google-ads/controls"
import { getSchedule, rates, sumMetrics, weekdays, type Metrics, type ScheduleGrid } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Day & hour · DealTrack" }

const metrics = [
  { id: "cost", label: "Spend" },
  { id: "conversions", label: "Conversions" },
] as const
type MetricId = (typeof metrics)[number]["id"]

const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`)

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const range = parseRange(params)
  const metric: MetricId = params.metric === "conversions" ? "conversions" : "cost"
  const admin = await isAdmin()
  const [result, editor] = await Promise.all([
    load(() => getSchedule(range)),
    admin
      ? load(async () => {
          const [campaigns, schedules] = await Promise.all([getCampaignControls(), getAdSchedules()])
          return {
            campaigns: campaigns.map(({ id, name, status }) => ({ id, name, status })),
            schedules: Object.fromEntries(
              campaigns.map((c) => [
                c.id,
                (schedules.get(c.id) ?? []).map(({ day, from, to, bidModifier }): EditorSlot => ({ day, from, to, bidModifier })),
              ]),
            ),
          }
        })
      : null,
  ])

  return (
    <>
      <PageHeader
        title="Day & hour"
        description="When your budget gets spent and when conversions happen, in Pacific time. Use it to spot hours that cost money but rarely bring leads."
        range={range}
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body grid={result.data} metric={metric} range={range} />}
      <Section
        title="Ad schedule"
        description="Choose the days and hours a campaign can show ads. Use the heat map above to find hours that spend without bringing leads."
        actions={!admin && <AdminLink />}
      >
        {!editor ? (
          <p className="text-sm text-muted-foreground">Admins can set when each campaign shows ads here.</p>
        ) : !editor.ok ? (
          <ReportProblem problem={editor} />
        ) : (
          <ScheduleEditor {...editor.data} />
        )}
      </Section>
    </>
  )
}

function Body({ grid, metric, range }: { grid: ScheduleGrid; metric: MetricId; range: DateRange }) {
  const max = Math.max(0, ...grid.flat().map((m) => m[metric]))
  const format = (m: Metrics) => (metric === "cost" ? formatUsd(m.cost) : formatConversions(m.conversions))
  const q = rangeQuery(range)
  const join = q ? `${q}&` : "?"

  const byDay = grid.map((hours, i) => ({ label: weekdays[i], metrics: sumMetrics(hours.map((m) => ({ metrics: m }))) }))
  const byHour = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    metrics: sumMetrics(grid.map((hours) => ({ metrics: hours[h] }))),
  }))

  return (
    <>
      <Section
        title="Heat map"
        description="Darker cells mean more of the selected measure. Hover a cell for spend, clicks, and conversions."
        actions={
          <div className="flex gap-1.5" role="group" aria-label="Measure">
            {metrics.map((m) => (
              <Link
                key={m.id}
                href={`/schedule${join}metric=${m.id}`}
                aria-current={metric === m.id ? "true" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground",
                  metric === m.id && "border-foreground bg-foreground text-background hover:text-background",
                )}
              >
                {m.label}
              </Link>
            ))}
          </div>
        }
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[760px] border-separate border-spacing-0.5 text-[11px]">
            <thead>
              <tr>
                <th scope="col" className="w-10" />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} scope="col" className="font-normal text-muted-foreground">
                    {hourLabel(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((hours, d) => (
                <tr key={weekdays[d]}>
                  <th scope="row" className="pr-2 text-left font-medium text-muted-foreground">
                    {dayLabels[d]}
                  </th>
                  {hours.map((m, h) => {
                    const intensity = max ? m[metric] / max : 0
                    return (
                      <td
                        key={h}
                        title={`${dayLabels[d]} ${hourLabel(h)}: ${formatUsd(m.cost)} spend, ${m.clicks} clicks, ${formatConversions(m.conversions)} conversions`}
                        className="h-8 rounded text-center tabular-nums"
                        style={{
                          background: `color-mix(in oklch, var(--primary) ${Math.round(intensity * 85)}%, var(--muted))`,
                          color: intensity > 0.5 ? "var(--primary-foreground)" : undefined,
                        }}
                      >
                        {metric === "conversions" && m.conversions > 0 ? formatConversions(m.conversions) : ""}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="By day of week">
          <Totals rows={byDay.map((d, i) => ({ key: d.label, label: dayLabels[i], metrics: d.metrics }))} format={format} />
        </Section>
        <Section title="By hour of day">
          <Totals rows={byHour.map((h) => ({ key: String(h.hour), label: hourLabel(h.hour), metrics: h.metrics }))} format={format} />
        </Section>
      </div>
    </>
  )
}

function Totals({
  rows,
  format,
}: {
  rows: { key: string; label: string; metrics: Metrics }[]
  format: (m: Metrics) => string
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-xs text-muted-foreground">
          <th scope="col" className="py-1.5 text-left font-medium">
            When
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Selected
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Spend
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Conversions
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Cost / conv.
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const cpa = rates(r.metrics).costPerConversion
          return (
            <tr key={r.key} className="border-b border-border/60 last:border-0">
              <td className="py-1.5">{r.label}</td>
              <td className="py-1.5 text-right tabular-nums">{format(r.metrics)}</td>
              <td className="py-1.5 text-right tabular-nums">{formatUsd(r.metrics.cost)}</td>
              <td className="py-1.5 text-right tabular-nums">{formatConversions(r.metrics.conversions)}</td>
              <td className="py-1.5 text-right tabular-nums">{cpa === null ? "—" : formatUsd(cpa)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
