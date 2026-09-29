import type { Metadata } from "next"

import { formatNumber, formatPercent } from "@/components/dashboard/format"
import { DataTable, KpiGrid, PageHeader, ReportProblem, Section } from "@/components/report"
import { parseRange } from "@/lib/date-range"
import { load } from "@/lib/load"
import { getSessions, type Session } from "@/lib/posthog"

export const metadata: Metadata = { title: "Behavior · DealTrack" }

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

type Group = { key: string; sessions: number; conversions: number; bounced: number; medianPages: number }

const median = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// A bounce: one page and gone within 10 seconds.
const bounced = (s: Session) => s.pageviews === 1 && s.durationS < 10

function groupBy(sessions: Session[], key: (s: Session) => string, minSessions = 20): Group[] {
  const groups = new Map<string, Session[]>()
  for (const s of sessions) {
    const k = key(s)
    const list = groups.get(k)
    if (list) list.push(s)
    else groups.set(k, [s])
  }
  return [...groups.entries()]
    .map(([k, list]) => ({
      key: k,
      sessions: list.length,
      conversions: list.filter((s) => s.converted).length,
      bounced: list.filter(bounced).length,
      medianPages: median(list.map((s) => s.pageviews)),
    }))
    .filter((g) => g.sessions >= minSessions)
    .sort((a, b) => b.conversions / b.sessions - a.conversions / a.sessions || b.sessions - a.sessions)
}

export default async function BehaviorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const range = parseRange(await searchParams)
  const result = await load(() => getSessions(range))

  return (
    <>
      <PageHeader
        title="Behavior"
        description="How visitors use twinhomebuyer.com and what the ones who fill in the form do differently. From PostHog, with the team and the staging site left out. PostHog data starts May 12, 2026."
        range={range}
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body sessions={result.data} />}
    </>
  )
}

function Body({ sessions }: { sessions: Session[] }) {
  if (!sessions.length) {
    return <p className="rounded-2xl border bg-card p-5 text-sm">No visitor sessions in PostHog for this date range.</p>
  }
  const converters = sessions.filter((s) => s.converted)
  const rate = (list: Session[]) => (list.length ? list.filter((s) => s.converted).length / list.length : 0)
  const mobile = sessions.filter((s) => s.device === "Mobile")
  const desktop = sessions.filter((s) => s.device === "Desktop")
  const toSubmit = median(converters.map((s) => s.secondsToSubmit ?? 0).filter((v) => v > 0))
  const rage = converters.length ? converters.filter((s) => s.rageClicked).length / converters.length : 0

  const columns = (label: string) => [
    { key: "key", label, render: (g: Group) => <span className="font-medium">{g.key}</span> },
    { key: "sessions", label: "Visits", align: "right" as const, render: (g: Group) => formatNumber(g.sessions) },
    { key: "conv", label: "Form submits", align: "right" as const, render: (g: Group) => formatNumber(g.conversions) },
    { key: "rate", label: "Submit rate", align: "right" as const, render: (g: Group) => formatPercent(g.conversions / g.sessions) },
    {
      key: "bounce",
      label: "Left right away",
      align: "right" as const,
      render: (g: Group) => (
        <span className={g.bounced / g.sessions > 0.7 ? "text-destructive" : undefined}>{formatPercent(g.bounced / g.sessions, 0)}</span>
      ),
    },
    { key: "pages", label: "Pages (median)", align: "right" as const, render: (g: Group) => formatNumber(g.medianPages) },
  ]

  const hours = groupBy(sessions, (s) => String(s.hour), 1)
  const hourRate = new Map(hours.map((h) => [Number(h.key), h]))
  const bestHours = hours
    .filter((h) => h.sessions >= 20)
    .slice(0, 3)
    .map((h) => new Date(Date.UTC(2000, 0, 1, Number(h.key))).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" }))

  return (
    <>
      <KpiGrid
        items={[
          { label: "Visits", value: formatNumber(sessions.length) },
          { label: "Form submits", value: formatNumber(converters.length), note: `${formatPercent(rate(sessions))} of visits` },
          {
            label: "Phone vs computer",
            value: `${formatPercent(rate(mobile))} / ${formatPercent(rate(desktop))}`,
            note: "Submit rate",
            tone: rate(mobile) < rate(desktop) * 0.75 ? "bad" : "default",
          },
          { label: "Time to submit", value: converters.length ? `${Math.round(toSubmit)}s` : "—", note: "Median, from landing" },
          { label: "Pages before submitting", value: formatNumber(median(converters.map((s) => s.pageviews))), note: "Median" },
          {
            label: "Rage-clicked first",
            value: formatPercent(rage, 0),
            note: "Of people who submitted",
            tone: rage > 0.05 ? "bad" : "default",
          },
        ]}
      />

      <Section title="By traffic source" description="Google Ads visits are ones that arrived with a Google click ID or a cpc/ppc tag.">
        <DataTable rows={groupBy(sessions, (s) => s.source, 1)} rowKey={(g) => g.key} columns={columns("Source")} />
      </Section>

      <Section title="By device">
        <DataTable rows={groupBy(sessions, (s) => s.device, 1)} rowKey={(g) => g.key} columns={columns("Device")} />
      </Section>

      <Section title="By landing page" description="The first page of each visit. Pages with fewer than 20 visits are hidden.">
        <DataTable rows={groupBy(sessions, (s) => s.entryPage)} rowKey={(g) => g.key} columns={columns("Page")} empty="No page had 20 visits in this range." />
      </Section>

      <Section title="By day" description="Los Angeles time.">
        <DataTable
          rows={groupBy(sessions, (s) => WEEKDAYS[s.weekday], 1).sort((a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key))}
          rowKey={(g) => g.key}
          columns={columns("Day")}
        />
      </Section>

      <Section
        title="By hour"
        description={
          bestHours.length ? `Best hours to show ads (most form submits per visit): ${bestHours.join(", ")}.` : "Los Angeles time."
        }
      >
        <div className="grid grid-cols-6 gap-1 sm:grid-cols-12 lg:grid-cols-24">
          {Array.from({ length: 24 }, (_, h) => {
            const g = hourRate.get(h)
            const r = g ? g.conversions / g.sessions : 0
            const max = Math.max(...hours.map((x) => x.conversions / x.sessions), 0.0001)
            return (
              <div
                key={h}
                className="flex flex-col items-center rounded-md border p-1 text-[11px] tabular-nums"
                style={{ backgroundColor: `color-mix(in oklch, var(--primary) ${Math.round((r / max) * 45)}%, transparent)` }}
                title={`${g?.sessions ?? 0} visits, ${g?.conversions ?? 0} submits`}
              >
                <span className="text-muted-foreground">{h}:00</span>
                <span className="font-medium">{g ? formatPercent(r, 1) : "—"}</span>
              </div>
            )
          })}
        </div>
      </Section>
    </>
  )
}
