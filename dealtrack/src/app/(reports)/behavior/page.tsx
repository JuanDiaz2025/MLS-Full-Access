import type { Metadata } from "next"
import Link from "next/link"

import { formatNumber, formatPercent } from "@/components/dashboard/format"
import { DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { ACCOUNT_TIME_ZONE, parseRange, rangeQuery, type DateRange } from "@/lib/date-range"
import { getCampaignNames } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"
import { getPaths, getRecordings, getSessions, replayUrl, type Session } from "@/lib/posthog"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Behavior · DealTrack" }

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const VISITS_SHOWN = 50

type Params = Record<string, string | string[] | undefined>
type Group = { key: string; sessions: number; conversions: number; bounced: number; medianPages: number }
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

const median = (a: number[]) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// A bounce: one page and gone within 10 seconds.
const bounced = (s: Session) => s.pageviews === 1 && s.durationS < 10

function groupBy(sessions: Session[], key: (s: Session) => string, minSessions = 1): Group[] {
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

function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export default async function BehaviorPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const range = parseRange(params)
  const allTraffic = first(params.traffic) === "all"
  const result = await load(() => getSessions(range))
  // Campaign names are a nice-to-have: without Google Ads, visits show the campaign ID.
  const names = await load(() => getCampaignNames())

  return (
    <>
      <PageHeader
        title="Behavior"
        description="What people who came from Google Ads did on twinhomebuyer.com: which campaign and keyword brought them, the pages they went through, whether they filled in the form, and a replay of the visit. From PostHog, with the team and the staging site left out. PostHog data starts May 12, 2026. Pages PostHog doesn't track, like Bateman's offers.twinhomebuyer.com, aren't included."
        range={range}
      />
      {!result.ok ? (
        <ReportProblem problem={result} />
      ) : (
        <Body sessions={result.data} range={range} allTraffic={allTraffic} names={names.ok ? names.data : new Map()} />
      )}
    </>
  )
}

async function Body({
  sessions: everyone,
  range,
  allTraffic,
  names,
}: {
  sessions: Session[]
  range: DateRange
  allTraffic: boolean
  names: Map<string, string>
}) {
  const sessions = allTraffic ? everyone : everyone.filter((s) => s.source === "Google Ads")
  const adCount = everyone.filter((s) => s.source === "Google Ads").length
  const campaignOf = (s: Session) => (s.campaignId ? (names.get(s.campaignId) ?? `Campaign ${s.campaignId}`) : "Campaign not tagged")
  const q = rangeQuery(range)
  const toggle = (all: boolean) => `/behavior${q ? `${q}&` : "?"}traffic=${all ? "all" : "ads"}`

  const switcher = (
    <nav aria-label="Traffic" className="flex flex-wrap gap-1.5">
      {[
        { all: false, label: `Google Ads visits (${formatNumber(adCount)})` },
        { all: true, label: `All visits (${formatNumber(everyone.length)})` },
      ].map((t) => (
        <Link
          key={String(t.all)}
          href={toggle(t.all)}
          aria-current={t.all === allTraffic ? "true" : undefined}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
            t.all === allTraffic && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )

  if (!sessions.length) {
    return (
      <>
        {switcher}
        <p className="rounded-2xl border bg-card p-5 text-sm">
          {allTraffic ? "No visitor sessions in PostHog for this date range." : "No visits from Google Ads in this date range. The ads have been off since Jul 24; try a longer range or the Bateman preset."}
        </p>
      </>
    )
  }

  const converters = sessions.filter((s) => s.converted)
  const rate = (list: Session[]) => (list.length ? list.filter((s) => s.converted).length / list.length : 0)
  const mobile = sessions.filter((s) => s.device === "Mobile")
  const desktop = sessions.filter((s) => s.device === "Desktop")
  const toSubmit = median(converters.map((s) => s.secondsToSubmit ?? 0).filter((v) => v > 0))
  const rage = converters.length ? converters.filter((s) => s.rageClicked).length / converters.length : 0
  // Low-volume ad traffic: show every group; site-wide, hide the long tail.
  const min = allTraffic ? 20 : 1

  const latest = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, VISITS_SHOWN)
  const [replays, paths] = await Promise.all([
    load(() => getRecordings(latest.map((s) => s.id))),
    load(() => getPaths(range, latest.map((s) => s.id))),
  ])
  const recent = latest.map((s) => ({ ...s, path: (paths.ok && paths.data.get(s.id)) || [s.entryPage] }))

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

  const hours = groupBy(sessions, (s) => String(s.hour))
  const hourRate = new Map(hours.map((h) => [Number(h.key), h]))
  const maxRate = Math.max(...hours.map((x) => x.conversions / x.sessions), 0.0001)
  const bestHours = hours
    .filter((h) => h.sessions >= (allTraffic ? 20 : 3) && h.conversions > 0)
    .slice(0, 3)
    .map((h) => new Date(Date.UTC(2000, 0, 1, Number(h.key))).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" }))

  return (
    <>
      {switcher}
      <KpiGrid
        items={[
          { label: allTraffic ? "Visits" : "Visits from Google Ads", value: formatNumber(sessions.length) },
          { label: "Form submits", value: formatNumber(converters.length), note: `${formatPercent(rate(sessions))} of visits` },
          {
            label: "Phone vs computer",
            value: `${formatPercent(rate(mobile))} / ${formatPercent(rate(desktop))}`,
            note: "Submit rate",
            tone: mobile.length >= 10 && rate(mobile) < rate(desktop) * 0.75 ? "bad" : "default",
          },
          { label: "Time to submit", value: converters.length ? `${Math.round(toSubmit)}s` : "—", note: "Median, from landing" },
          { label: "Left right away", value: formatPercent(sessions.filter(bounced).length / sessions.length, 0), note: "One page, under 10 seconds" },
          {
            label: "Rage-clicked first",
            value: converters.length ? formatPercent(rage, 0) : "—",
            note: "Of people who submitted",
            tone: rage > 0.05 ? "bad" : "default",
          },
        ]}
      />

      <Section
        title="Recent visits"
        description={`The latest ${recent.length} ${allTraffic ? "" : "Google Ads "}visits, newest first. Times are Los Angeles. "Watch" opens PostHog's replay of the visit; older visits may have none, because PostHog deletes recordings after its retention period.`}
      >
        {!replays.ok && <p className="text-xs text-muted-foreground">Replays aren&apos;t available right now: {replays.kind === "missing" ? replays.keys.join(", ") : replays.message}</p>}
        <DataTable<Session>
          rows={recent}
          rowKey={(s) => s.id}
          columns={[
            {
              key: "when",
              label: "When",
              render: (s) => (
                <span className="whitespace-nowrap">
                  {new Date(s.startedAt).toLocaleString("en-US", { timeZone: ACCOUNT_TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              ),
            },
            ...(allTraffic ? [{ key: "source", label: "Source", render: (s: Session) => <span className="text-muted-foreground">{s.source}</span> }] : []),
            {
              key: "from",
              label: "Campaign / keyword",
              className: "min-w-44",
              render: (s: Session) =>
                s.source === "Google Ads" ? (
                  <span className="flex flex-col">
                    <span>{campaignOf(s)}</span>
                    {s.keyword && <span className="text-xs text-muted-foreground">“{s.keyword}”</span>}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                ),
            },
            {
              key: "path",
              label: "Pages visited",
              className: "min-w-64",
              render: (s: Session) => (
                <span className="text-xs">
                  {s.path.slice(0, 6).join(" → ") || s.entryPage}
                  {s.pageviews > 6 && <span className="text-muted-foreground"> … +{s.pageviews - 6} more</span>}
                </span>
              ),
            },
            { key: "time", label: "Time on site", align: "right", render: (s: Session) => duration(s.durationS) },
            { key: "device", label: "Device", render: (s: Session) => <span className="text-muted-foreground">{s.device}</span> },
            { key: "city", label: "City", render: (s: Session) => <span className="text-muted-foreground">{s.city || "—"}</span> },
            {
              key: "result",
              label: "Result",
              render: (s: Session) => (
                <span className="flex flex-wrap gap-1">
                  {s.converted ? <Pill tone="green">Submitted form</Pill> : bounced(s) ? <Pill tone="red">Left right away</Pill> : <Pill>Browsed</Pill>}
                  {s.rageClicked && <Pill tone="amber">Rage click</Pill>}
                </span>
              ),
            },
            {
              key: "replay",
              label: "Replay",
              render: (s: Session) => {
                const seconds = replays.ok ? replays.data.get(s.id) : undefined
                return seconds !== undefined ? (
                  <a href={replayUrl(s.id)} target="_blank" rel="noreferrer" className="font-medium whitespace-nowrap text-primary hover:underline">
                    Watch ({duration(Math.round(seconds))})
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              },
            },
          ]}
        />
      </Section>

      {allTraffic ? (
        <Section title="By traffic source" description="Google Ads visits are ones that arrived with a Google click ID or a cpc/ppc tag.">
          <DataTable rows={groupBy(sessions, (s) => s.source)} rowKey={(g) => g.key} columns={columns("Source")} />
        </Section>
      ) : (
        <>
          <Section title="By campaign" description="Matched by the campaign ID Google adds to the ad click (gad_campaignid).">
            <DataTable rows={groupBy(sessions, campaignOf)} rowKey={(g) => g.key} columns={columns("Campaign")} />
          </Section>
          <Section
            title="By keyword"
            description="From the keyword the ad's tracking template adds to the landing URL. Campaigns without that template show as not tagged."
          >
            <DataTable rows={groupBy(sessions, (s) => s.keyword || "Not tagged")} rowKey={(g) => g.key} columns={columns("Keyword")} />
          </Section>
        </>
      )}

      <Section title="By landing page" description={`The first page of each visit.${allTraffic ? " Pages with fewer than 20 visits are hidden." : ""}`}>
        <DataTable rows={groupBy(sessions, (s) => s.entryPage, min)} rowKey={(g) => g.key} columns={columns("Page")} empty="No page had enough visits in this range." />
      </Section>

      <Section title="By device">
        <DataTable rows={groupBy(sessions, (s) => s.device)} rowKey={(g) => g.key} columns={columns("Device")} />
      </Section>

      <Section title="By day" description="Los Angeles time.">
        <DataTable
          rows={groupBy(sessions, (s) => WEEKDAYS[s.weekday]).sort((a, b) => WEEKDAYS.indexOf(a.key) - WEEKDAYS.indexOf(b.key))}
          rowKey={(g) => g.key}
          columns={columns("Day")}
        />
      </Section>

      <Section
        title="By hour"
        description={bestHours.length ? `Most form submits per visit: ${bestHours.join(", ")} (Los Angeles time).` : "Los Angeles time."}
      >
        <div className="grid grid-cols-6 gap-1 sm:grid-cols-12 lg:grid-cols-24">
          {Array.from({ length: 24 }, (_, h) => {
            const g = hourRate.get(h)
            const r = g ? g.conversions / g.sessions : 0
            return (
              <div
                key={h}
                className="flex flex-col items-center rounded-md border p-1 text-[11px] tabular-nums"
                style={{ backgroundColor: `color-mix(in oklch, var(--primary) ${Math.round((r / maxRate) * 45)}%, transparent)` }}
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
