import type { Metadata } from "next"
import Link from "next/link"
import { Suspense } from "react"

import CampaignFilter from "@/components/campaign-filter"
import { formatConversions, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import ClaimBuilder from "@/components/fraud/claim-builder"
import NetworkMark from "@/components/fraud/network-mark"
import PageLoading from "@/components/page-loading"
import { DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { getClarityBySource, type ClaritySource } from "@/lib/clarity"
import { addDays, formatDay, parseRange, rangeQuery, today, type DateRange } from "@/lib/date-range"
import { accountNumber, dayInPacific } from "@/lib/fraud/claim"
import {
  CLICK_DETAIL_DAYS,
  FLAG_LABELS,
  clickDetailAvailable,
  getClickPatterns,
  getClicks,
  summarizeClicks,
  type ClickPatterns,
  type FraudDay,
} from "@/lib/fraud/clicks"
import { findJunkLeads, mainReason, type JunkLead } from "@/lib/fraud/leads"
import {
  CLUSTER_SECONDS,
  KIND_LABELS,
  REPEAT_CLICKS,
  classifyVisits,
  findClusters,
  getAdVisits,
  groupNetworks,
  type AdVisit,
  type ClassifiedVisit,
  type Cluster,
  type Network,
  type VisitKind,
} from "@/lib/fraud/visitors"
import { getEditableCampaigns } from "@/lib/google-ads/changes"
import { getAccount, getCampaignNames } from "@/lib/google-ads/reports"
import { getRecordings, replayUrl } from "@/lib/posthog"
import { listLeads } from "@/lib/leads/store"
import { load, type Loaded } from "@/lib/load"
import { currentName } from "@/lib/people"
import { readData, type KnownNetwork } from "@/lib/store"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Fraud · DealTrack" }

const VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "clicks", label: "Click patterns" },
  { id: "visitors", label: "Visitors" },
  { id: "leads", label: "Junk leads" },
  { id: "claim", label: "Refund claim" },
] as const
type View = (typeof VIEWS)[number]["id"]

// Google takes invalid-click claims for clicks up to 60 days old.
const CLAIM_DAYS = 60
const CLAIM_FORM = "https://support.google.com/google-ads/contact/click_quality"
const NETWORKS_SHOWN = 60
const LEADS_SHOWN = 100

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const pacificTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const ageDays = (date: string) => Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000)

export default async function FraudPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const range = parseRange(params)
  const asked = first(params.view)
  const view: View = VIEWS.some((v) => v.id === asked) ? (asked as View) : "overview"
  const campaignId = /^\d+$/.test(first(params.campaign) ?? "") ? first(params.campaign)! : ""
  const day = /^\d{4}-\d{2}-\d{2}$/.test(first(params.day) ?? "") ? first(params.day)! : ""
  const who = KINDS.some((k) => k.id === first(params.who)) ? (first(params.who) as VisitKind | "all") : "all"
  const ip = /^[0-9a-f.:/]{3,60}$/i.test(first(params.ip) ?? "") ? first(params.ip)! : ""
  const campaigns = await load(() => getEditableCampaigns())
  const list = campaigns.ok ? campaigns.data : []
  const chosen = list.find((c) => c.id === campaignId)

  return (
    <>
      <PageHeader
        title="Fraud"
        description="Watches for click fraud and junk: bursts of clicks, the same people clicking the ads again and again, bots, and fake leads. When an attack gets through, it puts together the evidence for a refund claim to Google. It only flags things and never changes the ads."
        range={range}
      />
      <div className="flex flex-wrap items-end justify-between gap-2 border-b">
        <nav aria-label="Fraud views" className="flex gap-1 overflow-x-auto">
          {VIEWS.map((v) => {
            const q = new URLSearchParams(rangeQuery(range).replace(/^\?/, ""))
            if (v.id !== "overview") q.set("view", v.id)
            if (campaignId) q.set("campaign", campaignId)
            return (
              <Link
                key={v.id}
                href={`/fraud${q.size ? `?${q}` : ""}`}
                aria-current={view === v.id ? "page" : undefined}
                className={cn(
                  "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium",
                  view === v.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {v.label}
              </Link>
            )
          })}
        </nav>
        {(view === "clicks" || view === "claim" || view === "overview") && (
          <div className="pb-1.5">
            <CampaignFilter campaigns={list.map((c) => ({ id: c.id, name: c.name, status: c.status }))} value={chosen ? campaignId : ""} />
          </div>
        )}
      </div>
      {!campaigns.ok && <ReportProblem problem={campaigns} />}
      {chosen && view !== "visitors" && view !== "leads" && (
        <p className="text-sm">
          Showing only <span className="font-medium">{chosen.name}</span> ({chosen.status === "ENABLED" ? "running" : "paused"}).
        </p>
      )}
      <Suspense key={`${view}|${range.from}|${range.to}|${campaignId}|${day}|${who}|${ip}`} fallback={<PageLoading message={LOADING[view]} />}>
        <TabBody view={view} range={range} campaignId={chosen ? campaignId : undefined} day={day} who={who} ip={ip} />
      </Suspense>
    </>
  )
}

const LOADING: Record<View, string> = {
  overview: "Checking clicks, visitors, and leads…",
  clicks: "Comparing each day with the days before it…",
  visitors: "Grouping ad visitors by connection…",
  leads: "Checking each form lead…",
  claim: "Collecting the clicks for a claim…",
}

async function TabBody({
  view,
  range,
  campaignId,
  day,
  who,
  ip,
}: {
  view: View
  range: DateRange
  campaignId?: string
  day: string
  who: VisitKind | "all"
  ip: string
}) {
  if (view === "clicks") return <ClicksTab range={range} campaignId={campaignId} day={day} />
  if (view === "visitors") return <VisitorsTab range={range} who={who} ip={ip} />
  if (view === "leads") return <LeadsTab range={range} />
  if (view === "claim") return <ClaimTab range={range} campaignId={campaignId} />
  return <OverviewTab range={range} campaignId={campaignId} />
}

// ---- Shared loaders -------------------------------------------------------------------------

async function networksFor(range: DateRange) {
  const [visits, data] = await Promise.all([load(() => getAdVisits(range)), readData()])
  return {
    visits,
    known: data.knownNetworks,
    networks: visits.ok ? groupNetworks(visits.data, data.knownNetworks) : [],
    clusters: visits.ok ? findClusters(visits.data, data.knownNetworks) : [],
  }
}

async function junkFor(range: DateRange): Promise<Loaded<JunkLead[]>> {
  return load(async () => {
    const leads = await listLeads()
    return findJunkLeads(leads, (l) => {
      const d = dayInPacific(l.createdAt)
      return d >= range.from && d <= range.to
    })
  })
}

const suspicious = (n: Network) => !n.known && (n.flags.includes("repeat") || n.flags.includes("bot-agent"))

// ---- Overview ---------------------------------------------------------------------------------

async function OverviewTab({ range, campaignId }: { range: DateRange; campaignId?: string }) {
  const [patterns, visitors, junk, clarity] = await Promise.all([
    load(() => getClickPatterns(range, campaignId)),
    networksFor(range),
    junkFor(range),
    load(() => getClarityBySource()),
  ])
  const q = rangeQuery(range)
  const join = q ? `${q}&` : "?"
  const camp = campaignId ? `&campaign=${campaignId}` : ""
  const link = (view: View) => `/fraud${join}view=${view}${camp}`

  const p = patterns.ok ? patterns.data : null
  const flagged = p?.flagged ?? []
  const flaggedCost = flagged.reduce((s, d) => s + d.cost, 0)
  const repeaters = visitors.networks.filter(suspicious)
  const abroad = visitors.networks.filter((n) => !n.known && n.flags.includes("abroad"))
  const team = visitors.networks.filter((n) => n.known)
  const google = clarity.ok ? clarity.data.find((s) => s.source === "google") : undefined
  const bots = clarity.ok ? clarity.data.reduce((s, c) => s + c.botSessions, 0) : null
  const claimable = flagged.filter((d) => ageDays(d.date) <= CLAIM_DAYS)

  const findings: { tone: "red" | "amber" | "gray"; title: string; detail: string; href: string }[] = []
  for (const d of flagged.slice(0, 5)) {
    findings.push({
      tone: d.flags.length > 1 || d.flags.includes("click-spike") ? "red" : "amber",
      title: `${formatDay(d.date)}: ${d.flags.map((f) => FLAG_LABELS[f].toLowerCase()).join(", ")}`,
      detail: `${d.reasons.join(". ")}. ${formatUsd(d.cost)} billed${d.campaigns[0] ? `, mostly on ${d.campaigns[0].name}` : ""}.`,
      href: `/fraud${join}view=clicks&day=${d.date}${camp}`,
    })
  }
  for (const n of repeaters.slice(0, 3)) {
    findings.push({
      tone: "red",
      title: `${n.adClicks} ad clicks from one connection in ${n.place}`,
      detail: `${n.network}, ${pacificTime(n.first)} to ${pacificTime(n.last)}. If it's your own team, mark it as yours on the Visitors tab; otherwise it's the kind of pattern Google refunds.`,
      href: link("visitors"),
    })
  }
  for (const c of visitors.clusters.slice(0, 2)) {
    findings.push({
      tone: c.visits.length >= 5 ? "red" : "amber",
      title: `${c.visits.length} ad clicks from different connections at the same moment, ${pacificTime(c.start)}`,
      detail: `${c.places.slice(0, 4).join("; ")}${c.places.length > 4 ? "…" : ""}. Lockstep clicks from far-apart places look like a click farm or bots.`,
      href: link("visitors"),
    })
  }
  if (abroad.length) {
    findings.push({
      tone: "amber",
      title: `${abroad.length} ${abroad.length === 1 ? "connection" : "connections"} outside the US clicked the ads`,
      detail: `${abroad
        .map((n) => n.place)
        .filter((place, i, all) => all.indexOf(place) === i)
        .slice(0, 4)
        .join("; ")}. The ads target California, so these are either the team, a VPN, or a location setting letting people abroad in.`,
      href: link("visitors"),
    })
  }
  if (junk.ok && junk.data.length) {
    findings.push({
      tone: "amber",
      title: `${junk.data.length} form ${junk.data.length === 1 ? "lead looks" : "leads look"} like junk`,
      detail: "Graded Junk by the lead scoring. The default rule reports them to Google as invalid leads (reporting only), so bidding doesn't learn from them.",
      href: link("leads"),
    })
  }

  return (
    <>
      <KpiGrid
        items={[
          {
            label: "Suspicious days",
            value: p ? formatNumber(flagged.length) : "—",
            note: p ? `${formatUsd(flaggedCost)} billed on them` : "Google Ads didn't load",
            tone: flagged.length ? "bad" : "default",
          },
          {
            label: "Still claimable",
            value: p ? formatNumber(claimable.length) : "—",
            note: `Google takes claims up to ${CLAIM_DAYS} days after the clicks`,
            tone: claimable.length ? "bad" : "default",
          },
          {
            label: "Invalid clicks filtered",
            value: p ? formatNumber(p.totals.invalid) : "—",
            note:
              p && p.totals.invalid + p.totals.clicks
                ? `${formatPercent(p.totals.invalid / (p.totals.invalid + p.totals.clicks), 0)} of clicks; not charged`
                : undefined,
          },
          {
            label: "Repeat-click connections",
            value: visitors.visits.ok ? formatNumber(repeaters.length) : "—",
            note: visitors.visits.ok
              ? `${REPEAT_CLICKS}+ ad clicks each${team.length ? `; ${team.length} marked as the team's` : ""}`
              : "PostHog didn't load",
            tone: repeaters.length ? "bad" : "default",
          },
          {
            label: "Junk leads",
            value: junk.ok ? formatNumber(junk.data.length) : "—",
            note: "Form leads in this period",
            tone: junk.ok && junk.data.length ? "bad" : "default",
          },
          {
            label: "Bot sessions",
            value: bots === null ? "—" : formatNumber(bots),
            note: clarity.ok ? `Last 3 days (Clarity)${google ? `; ${google.botSessions} from Google` : ""}` : "Clarity didn't load",
          },
        ]}
      />
      {!patterns.ok && <ReportProblem problem={patterns} />}

      <Section title="What needs a look" description="The most suspicious things in this period, worst first. Nothing is changed in Google Ads.">
        {findings.length ? (
          <ul className="flex flex-col divide-y rounded-xl border">
            {findings.map((f) => (
              <li key={f.title}>
                <Link href={f.href} className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/40">
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      f.tone === "red" ? "bg-red-500" : f.tone === "amber" ? "bg-amber-500" : "bg-muted-foreground",
                    )}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{f.title}</span>
                    <span className="text-xs text-muted-foreground">{f.detail}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">Nothing suspicious in this period.</p>
        )}
      </Section>

      <Section title="How a refund claim works" description="What got the John Buys Houses clicks refunded, made repeatable.">
        <ol className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {[
            [
              "Spot it",
              "This page checks every day against the 28 days before it, and every ad visitor's connection, and flags bursts and repeat clickers.",
            ],
            [
              "Collect the evidence",
              "The Refund claim tab lists every billed click (its Google click ID) and matches each one to the IP address, time, and browser from PostHog and your WP Engine logs.",
            ],
            [
              "File it",
              `Paste the summary into Google's invalid-click form and attach the spreadsheet. File within ${CLAIM_DAYS} days of the clicks.`,
            ],
            [
              "Follow up",
              "Google reviews the clicks and credits the account for the ones it finds invalid. Note the claim on the Changes page so the team knows.",
            ],
          ].map(([title, text], i) => (
            <li key={title} className="flex flex-col gap-1 rounded-xl border p-3">
              <span className="text-xs font-medium text-muted-foreground">Step {i + 1}</span>
              <span className="font-medium">{title}</span>
              <span className="text-muted-foreground">{text}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href={link("claim")} className="font-medium text-primary hover:underline">
            Build a refund claim
          </Link>
          <a href={CLAIM_FORM} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
            Google&apos;s invalid-click form ↗
          </a>
        </div>
      </Section>
    </>
  )
}

// ---- Click patterns -------------------------------------------------------------------------

function HourStrip({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours)
  return (
    <span className="flex h-6 items-end gap-px" aria-hidden>
      {hours.map((c, h) => (
        <span
          key={h}
          className={cn("w-1.5 rounded-sm", h < 5 ? "bg-amber-500/80" : "bg-primary/70", !c && "bg-muted")}
          style={{ height: `${Math.max(8, (c / max) * 100)}%` }}
          title={`${h}:00 · ${c} clicks`}
        />
      ))}
    </span>
  )
}

function DayChart({ days, selected, hrefFor }: { days: FraudDay[]; selected: string; hrefFor: (date: string) => string }) {
  const max = Math.max(1, ...days.map((d) => d.clicks + d.invalid))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-32 items-end gap-px overflow-hidden">
        {days.map((d) => (
          <Link
            key={d.date}
            href={hrefFor(d.date)}
            scroll={false}
            className={cn("flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm hover:bg-muted", d.date === selected && "bg-muted")}
            title={`${formatDay(d.date)}: ${d.clicks} clicks, ${d.invalid} invalid, normal ${Math.round(d.normalClicks)}${d.flags.length ? ` · ${d.flags.map((f) => FLAG_LABELS[f]).join(", ")}` : ""}`}
          >
            <span className="w-full bg-red-400" style={{ height: `${(d.invalid / max) * 100}%` }} />
            <span className={cn("w-full", d.flags.length ? "bg-amber-500" : "bg-primary/60")} style={{ height: `${(d.clicks / max) * 100}%` }} />
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary/60" /> Billed clicks
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-amber-500" /> On a suspicious day
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-red-400" /> Invalid (filtered by Google, not charged)
        </span>
        <span>Click a day for its clicks.</span>
      </div>
    </div>
  )
}

async function ClicksTab({ range, campaignId, day }: { range: DateRange; campaignId?: string; day: string }) {
  const patterns = await load(() => getClickPatterns(range, campaignId))
  if (!patterns.ok) return <ReportProblem problem={patterns} />
  const p = patterns.data
  const q = rangeQuery(range)
  const join = q ? `${q}&` : "?"
  const camp = campaignId ? `&campaign=${campaignId}` : ""
  const hrefFor = (date: string) => `/fraud${join}view=clicks&day=${date}${camp}`
  const selected = p.days.find((d) => d.date === day) ?? p.flagged[0]

  return (
    <>
      <Section
        title="Clicks by day"
        description="Each day against the 28 days before it. Google already takes out the clicks it calls invalid (red); a suspicious day (amber) is one where billed clicks jumped too, or arrived at night or all in one hour."
      >
        <DayChart days={p.days} selected={selected?.date ?? ""} hrefFor={hrefFor} />
      </Section>

      <Section
        title="Suspicious days"
        description={`Worst first. Google takes claims up to ${CLAIM_DAYS} days after the clicks, and keeps each click's details for ${CLICK_DETAIL_DAYS} days.`}
      >
        <DataTable
          rows={p.flagged}
          rowKey={(d) => d.date}
          empty="No suspicious days in this period."
          rowClassName={(d) => (d.date === selected?.date ? "bg-muted/50" : undefined)}
          columns={[
            {
              key: "date",
              label: "Day",
              render: (d) => (
                <Link href={hrefFor(d.date)} scroll={false} className="font-medium text-primary hover:underline">
                  {formatDay(d.date)}
                </Link>
              ),
            },
            {
              key: "why",
              label: "Why",
              render: (d) => (
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap gap-1">
                    {d.flags.map((f) => (
                      <Pill key={f} tone={f === "click-spike" || f === "invalid-spike" ? "red" : "amber"}>
                        {FLAG_LABELS[f]}
                      </Pill>
                    ))}
                  </span>
                  <span className="text-xs text-muted-foreground">{d.reasons.join(". ")}</span>
                  {d.campaigns[0] && <span className="text-xs text-muted-foreground">Mostly {d.campaigns[0].name}</span>}
                </span>
              ),
            },
            { key: "hours", label: "By hour", render: (d) => <HourStrip hours={d.hours} /> },
            {
              key: "clicks",
              label: "Clicks",
              align: "right",
              render: (d) => `${formatNumber(d.clicks)} / ${formatNumber(Math.round(d.normalClicks))}`,
            },
            { key: "invalid", label: "Invalid", align: "right", render: (d) => formatNumber(d.invalid) },
            { key: "cost", label: "Billed", align: "right", render: (d) => formatUsd(d.cost) },
            { key: "conv", label: "Conv.", align: "right", render: (d) => formatConversions(d.conversions) },
            {
              key: "claim",
              label: "Claim",
              align: "right",
              render: (d) => {
                const left = CLAIM_DAYS - ageDays(d.date)
                return left > 0 ? <Pill tone={left <= 14 ? "red" : "amber"}>{left} days left</Pill> : <Pill>Too old</Pill>
              },
            },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          Clicks shows the day&apos;s billed clicks / a normal day. The hour bars run midnight to midnight, Pacific; amber is midnight to 5am.
        </p>
      </Section>

      {selected && <DayDetail day={selected} campaignId={campaignId} />}
    </>
  )
}

async function DayDetail({ day, campaignId }: { day: FraudDay; campaignId?: string }) {
  const available = clickDetailAvailable(day.date, today())
  const clicks = available ? await load(() => getClicks([day.date], today(), campaignId)) : null
  const s = clicks?.ok ? summarizeClicks(clicks.data) : null
  const list = (title: string, rows: { label: string; clicks: number }[]) => (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map((r) => (
          <li key={r.label} className="flex justify-between gap-3">
            <span className="truncate">{r.label}</span>
            <span className="tabular-nums text-muted-foreground">{r.clicks}</span>
          </li>
        ))}
      </ul>
    </div>
  )

  return (
    <Section
      id="day"
      title={`${formatDay(day.date)}: where the clicks came from`}
      description={
        available
          ? "Every billed click Google lists for this day. Clicks bunched in one place, on one keyword, or on one device point at one person or one bot."
          : `Google only keeps single clicks for ${CLICK_DETAIL_DAYS} days, so this day's clicks can't be listed. The daily numbers above still count for a claim.`
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border p-3 text-sm">
          <p className="text-xs text-muted-foreground">Billed clicks</p>
          <p className="text-xl font-semibold tabular-nums">{formatNumber(day.clicks)}</p>
          <p className="text-xs text-muted-foreground">Normal: {formatNumber(Math.round(day.normalClicks))}</p>
        </div>
        <div className="rounded-xl border p-3 text-sm">
          <p className="text-xs text-muted-foreground">Invalid, not charged</p>
          <p className="text-xl font-semibold tabular-nums">{formatNumber(day.invalid)}</p>
          <p className="text-xs text-muted-foreground">Normal: {formatNumber(Math.round(day.normalInvalid))}</p>
        </div>
        <div className="rounded-xl border p-3 text-sm">
          <p className="text-xs text-muted-foreground">Billed</p>
          <p className="text-xl font-semibold tabular-nums">{formatUsd(day.cost)}</p>
          <p className="text-xs text-muted-foreground">{formatConversions(day.conversions)} conversions</p>
        </div>
        <div className="rounded-xl border p-3 text-sm">
          <p className="text-xs text-muted-foreground">Outside California</p>
          <p className="text-xl font-semibold tabular-nums">{s ? formatNumber(s.outside) : "—"}</p>
          <p className="text-xs text-muted-foreground">Billed clicks</p>
        </div>
      </div>
      {clicks && !clicks.ok && <ReportProblem problem={clicks} />}
      {s && (
        <div className="grid gap-4 sm:grid-cols-3">
          {list("Places", s.places)}
          {list("Keywords", s.keywords)}
          {list("Devices", s.devices)}
        </div>
      )}
      {day.campaigns.length > 0 && (
        <DataTable
          rows={day.campaigns}
          rowKey={(c) => c.id}
          columns={[
            { key: "name", label: "Campaign", render: (c) => c.name },
            { key: "clicks", label: "Clicks", align: "right", render: (c) => formatNumber(c.clicks) },
            { key: "invalid", label: "Invalid", align: "right", render: (c) => formatNumber(c.invalid) },
            { key: "cost", label: "Billed", align: "right", render: (c) => formatUsd(c.cost) },
            { key: "conv", label: "Conv.", align: "right", render: (c) => formatConversions(c.conversions) },
          ]}
        />
      )}
    </Section>
  )
}

// ---- Visitors --------------------------------------------------------------------------------

const KINDS: { id: VisitKind | "all"; label: string }[] = [
  { id: "all", label: "All ad visits" },
  { id: "real", label: KIND_LABELS.real },
  { id: "suspicious", label: KIND_LABELS.suspicious },
  { id: "bot", label: "Bots" },
  { id: "team", label: KIND_LABELS.team },
]
const KIND_TONES: Record<VisitKind, "green" | "red" | "amber" | "gray" | "violet"> = {
  real: "green",
  suspicious: "red",
  bot: "amber",
  team: "violet",
}
const VISITS_SHOWN = 50
const PLACES_SHOWN = 40

const placeOf = (v: AdVisit) => [v.city, v.region, v.country].filter(Boolean).join(", ") || "Unknown"
const quick = (v: AdVisit) => v.pageviews <= 1 && v.durationS < 10 && !v.submitted
function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

type VisitGroup = { key: string; label: string; sub?: string; visits: ClassifiedVisit[] }
function groupVisits(visits: ClassifiedVisit[], key: (v: ClassifiedVisit) => string, label: (v: ClassifiedVisit) => string = key): VisitGroup[] {
  const by = new Map<string, VisitGroup>()
  for (const v of visits) {
    const k = key(v)
    const g = by.get(k) ?? { key: k, label: label(v), visits: [] }
    g.visits.push(v)
    by.set(k, g)
  }
  return [...by.values()].sort((x, y) => y.visits.length - x.visits.length)
}

// Suspicious and bot visits in a group, as one number with the split on hover.
function NotReal({ visits }: { visits: ClassifiedVisit[] }) {
  const sus = visits.filter((v) => v.kind === "suspicious").length
  const bots = visits.filter((v) => v.kind === "bot").length
  if (!sus && !bots) return <span className="text-muted-foreground">0</span>
  return (
    <span className="font-medium text-destructive" title={`${sus} suspicious, ${bots} bots (${formatPercent((sus + bots) / visits.length, 0)} of visits)`}>
      {formatNumber(sus + bots)}
    </span>
  )
}

async function VisitorsTab({ range, who, ip }: { range: DateRange; who: VisitKind | "all"; ip: string }) {
  const [visits, data, clarity, names, name] = await Promise.all([
    load(() => getAdVisits(range)),
    readData(),
    load(() => getClarityBySource()),
    load(() => getCampaignNames()),
    currentName(),
  ])
  if (!visits.ok) return <ReportProblem problem={visits} />
  const known = data.knownNetworks
  const everyone = classifyVisits(visits.data, known)
  const counts = Object.fromEntries(KINDS.map((k) => [k.id, k.id === "all" ? everyone.length : everyone.filter((v) => v.kind === k.id).length]))
  const kindOnly = who === "all" ? everyone : everyone.filter((v) => v.kind === who)
  const shown = ip ? kindOnly.filter((v) => v.network === ip) : kindOnly
  const clusters = findClusters(visits.data, known)
  // gad_campaignid is the Google Ads campaign; IDs that aren't in this account come from ads run
  // in another account pointing at the same site.
  const campaignName = (v: AdVisit) => {
    const id = v.campaignId || (/^\d{8,}$/.test(v.utmCampaign) ? v.utmCampaign : "")
    if (id) return (names.ok && names.data.get(id)) || `Another account (${id})`
    return v.utmCampaign && !/^(none|\(not set\))$/i.test(v.utmCampaign) ? v.utmCampaign : "Campaign not tagged"
  }

  const q = new URLSearchParams(rangeQuery(range).replace(/^\?/, ""))
  q.set("view", "visitors")
  const href = (next: { who?: string; ip?: string }) => {
    const u = new URLSearchParams(q)
    const w = next.who ?? who
    if (w !== "all") u.set("who", w)
    const i = next.ip ?? ip
    if (i) u.set("ip", i)
    return `/fraud?${u}`
  }

  const connections = groupVisits(
    shown,
    (v) => v.network || v.ip || "Unknown",
    (v) => v.network || "Unknown",
  )
  const latest = [...shown].sort((x, y) => y.startedAt.localeCompare(x.startedAt)).slice(0, VISITS_SHOWN)
  const replays = await load(() => getRecordings(latest.map((v) => v.sessionId)))

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {KINDS.map((k) => (
          <Link
            key={k.id}
            href={href({ who: k.id, ip: "" })}
            scroll={false}
            aria-current={who === k.id ? "true" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
              who === k.id && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
            )}
          >
            {k.label} ({formatNumber(counts[k.id] ?? 0)})
          </Link>
        ))}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Only visits that came from Google Ads: a Google click ID or campaign ID on the landing address, or a paid UTM tag. From PostHog, the team
        included. Bots are automated browsers and Google&apos;s own landing page checks; suspicious means repeat clicks from one connection, clicks in
        lockstep with other connections, or from outside the US.
      </p>
      {ip && (
        <p className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-sm">
          Showing only <span className="font-mono text-xs">{ip}</span>
          <Link href={href({ ip: "" })} scroll={false} className="font-medium text-primary hover:underline">
            Show everyone
          </Link>
        </p>
      )}

      <KpiGrid
        items={[
          {
            label: "Ad visits",
            value: formatNumber(shown.length),
            note: `${formatNumber(new Set(shown.map((v) => v.gclid).filter(Boolean)).size)} with a click ID`,
          },
          { label: "Connections", value: formatNumber(connections.length), note: "Different IP addresses / networks" },
          {
            label: "Came back from an ad",
            value: formatNumber(connections.filter((c) => c.visits.length >= 2).length),
            note: `Connections with 2+ ad visits`,
            tone: connections.some((c) => c.visits.length >= REPEAT_CLICKS && c.visits.some((v) => v.kind === "suspicious")) ? "bad" : "default",
          },
          {
            label: "Outside California",
            value: shown.length ? formatPercent(shown.filter((v) => v.region && v.region !== "California").length / shown.length, 0) : "—",
            note: "Of these visits",
          },
          { label: "Sent a form", value: formatNumber(shown.filter((v) => v.submitted).length) },
          {
            label: "Left right away",
            value: shown.length ? formatPercent(shown.filter(quick).length / shown.length, 0) : "—",
            note: "One page, under 10 seconds",
          },
        ]}
      />

      <Section
        title="Top IP addresses"
        description={`Who came from the ads most often, grouped by connection (an IP address; phones and homes on IPv6 by their /64 network). ${REPEAT_CLICKS} or more ad clicks from one connection is what a competitor or a click farm looks like. Mark your own team's connections so they stop counting as attacks.`}
      >
        <div className="-mx-4 max-h-[560px] overflow-y-auto px-4 sm:-mx-5 sm:px-5">
          <DataTable
            rows={connections.slice(0, NETWORKS_SHOWN)}
            rowKey={(g) => g.key}
            empty="No ad visits match."
            columns={[
              {
                key: "ip",
                label: "Connection",
                render: (g) => (
                  <span className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs break-all">{g.label}</span>
                    <span className="text-xs text-muted-foreground">{placeOf(g.visits[0])}</span>
                  </span>
                ),
              },
              {
                key: "kind",
                label: "Looks like",
                render: (g) => {
                  const v = g.visits.find((x) => x.kind !== "real") ?? g.visits[0]
                  return (
                    <span className="flex flex-col gap-0.5">
                      <span>
                        <Pill tone={KIND_TONES[v.kind]}>{v.kind === "team" ? `Team: ${v.why[0]}` : KIND_LABELS[v.kind]}</Pill>
                      </span>
                      {v.kind !== "team" && v.why.length > 0 && <span className="text-xs text-muted-foreground">{v.why.join(" · ")}</span>}
                    </span>
                  )
                },
              },
              { key: "visits", label: "Ad visits", align: "right", render: (g) => formatNumber(g.visits.length) },
              {
                key: "campaigns",
                label: "Campaigns",
                className: "min-w-40",
                render: (g) => <span className="text-xs">{[...new Set(g.visits.map(campaignName))].slice(0, 2).join("; ")}</span>,
              },
              {
                key: "when",
                label: "When",
                render: (g) => (
                  <span className="text-xs whitespace-nowrap">
                    {pacificTime(g.visits[0].startedAt)}
                    {g.visits.length > 1 && <> – {pacificTime(g.visits[g.visits.length - 1].startedAt)}</>}
                  </span>
                ),
              },
              {
                key: "device",
                label: "Device",
                render: (g) => (
                  <span className="text-xs">
                    {[...new Set(g.visits.map((v) => [v.browser, v.os].filter(Boolean).join(" on ")))].slice(0, 2).join("; ")}
                  </span>
                ),
              },
              { key: "forms", label: "Forms", align: "right", render: (g) => formatNumber(g.visits.filter((v) => v.submitted).length) },
              {
                key: "actions",
                label: "",
                render: (g) => (
                  <span className="flex flex-col items-end gap-1">
                    {!ip && (
                      <Link href={href({ ip: g.key })} scroll={false} className="text-xs font-medium whitespace-nowrap text-primary hover:underline">
                        See visits
                      </Link>
                    )}
                    {g.visits[0].kind !== "bot" && (
                      <NetworkMark network={g.key} known={known.find((k: KnownNetwork) => k.network === g.key)} personName={name} />
                    )}
                  </span>
                ),
              },
            ]}
          />
        </div>
        {connections.length > NETWORKS_SHOWN && (
          <p className="text-xs text-muted-foreground">
            Showing the top {NETWORKS_SHOWN} of {connections.length}.
          </p>
        )}
      </Section>

      <div className="grid gap-6">
        <Section title="By location" description="Where the ad visitors were, from their IP address. The ads target California.">
          <div className="-mx-4 max-h-[560px] overflow-y-auto px-4 sm:-mx-5 sm:px-5">
            <DataTable
              rows={groupVisits(shown, placeOf).slice(0, PLACES_SHOWN)}
              rowKey={(g) => g.key}
              empty="No ad visits match."
              columns={[
                {
                  key: "place",
                  label: "Place",
                  render: (g) => (
                    <span className={cn(g.visits[0].region && g.visits[0].region !== "California" && "text-destructive")}>{g.label}</span>
                  ),
                },
                { key: "visits", label: "Visits", align: "right", render: (g) => formatNumber(g.visits.length) },
                { key: "ips", label: "IPs", align: "right", render: (g) => formatNumber(new Set(g.visits.map((v) => v.network)).size) },
                { key: "forms", label: "Forms", align: "right", render: (g) => formatNumber(g.visits.filter((v) => v.submitted).length) },
                { key: "mix", label: "Flagged", align: "right", render: (g) => <NotReal visits={g.visits} /> },
              ]}
            />
          </div>
        </Section>
        <Section title="By campaign" description="From the campaign ID Google adds to the ad click, or the utm_campaign tag.">
          <div className="-mx-4 max-h-[560px] overflow-y-auto px-4 sm:-mx-5 sm:px-5">
            <DataTable
              rows={groupVisits(shown, campaignName)}
              rowKey={(g) => g.key}
              empty="No ad visits match."
              columns={[
                { key: "campaign", label: "Campaign", render: (g) => g.label },
                { key: "visits", label: "Visits", align: "right", render: (g) => formatNumber(g.visits.length) },
                { key: "forms", label: "Forms", align: "right", render: (g) => formatNumber(g.visits.filter((v) => v.submitted).length) },
                {
                  key: "quick",
                  label: "Left fast",
                  align: "right",
                  render: (g) => formatPercent(g.visits.filter(quick).length / g.visits.length, 0),
                },
                { key: "mix", label: "Flagged", align: "right", render: (g) => <NotReal visits={g.visits} /> },
              ]}
            />
          </div>
        </Section>
      </div>

      <Section
        title="Recent ad visits"
        description={`The latest ${latest.length} visits from the ads, newest first, Los Angeles time. "Watch" opens PostHog's replay; older visits may have none.`}
      >
        <div className="-mx-4 max-h-[560px] overflow-y-auto px-4 sm:-mx-5 sm:px-5">
          <DataTable
            rows={latest}
            rowKey={(v) => v.sessionId}
            empty="No ad visits match."
            columns={[
              { key: "when", label: "When", render: (v) => <span className="text-xs whitespace-nowrap">{pacificTime(v.startedAt)}</span> },
              {
                key: "kind",
                label: "Looks like",
                render: (v) => (
                  <span className="flex flex-col gap-0.5">
                    <span>
                      <Pill tone={KIND_TONES[v.kind]}>{KIND_LABELS[v.kind]}</Pill>
                    </span>
                    {v.kind !== "real" && <span className="max-w-48 text-xs text-muted-foreground">{v.why.join(" · ")}</span>}
                  </span>
                ),
              },
              {
                key: "ip",
                label: "IP / place",
                render: (v) => (
                  <span className="flex flex-col gap-0.5">
                    <Link href={href({ ip: v.network })} scroll={false} className="font-mono text-xs break-all text-primary hover:underline">
                      {v.ip || "—"}
                    </Link>
                    <span className="text-xs text-muted-foreground">{placeOf(v)}</span>
                  </span>
                ),
              },
              {
                key: "campaign",
                label: "Campaign / keyword",
                className: "min-w-40",
                render: (v) => (
                  <span className="flex flex-col text-xs">
                    <span>{campaignName(v)}</span>
                    {v.keyword && <span className="text-muted-foreground">“{v.keyword}”</span>}
                  </span>
                ),
              },
              { key: "page", label: "Landed on", render: (v) => <span className="text-xs">{v.entryPage}</span> },
              { key: "time", label: "Time on site", align: "right", render: (v) => duration(v.durationS) },
              {
                key: "device",
                label: "Device",
                render: (v) => <span className="text-xs text-muted-foreground">{[v.browser, v.os].filter(Boolean).join(" on ")}</span>,
              },
              {
                key: "result",
                label: "Result",
                render: (v) =>
                  v.submitted ? <Pill tone="green">Sent a form</Pill> : quick(v) ? <Pill tone="red">Left right away</Pill> : <Pill>Browsed</Pill>,
              },
              {
                key: "replay",
                label: "Replay",
                render: (v) => {
                  const seconds = replays.ok ? replays.data.get(v.sessionId) : undefined
                  return seconds !== undefined ? (
                    <a
                      href={replayUrl(v.sessionId)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium whitespace-nowrap text-primary hover:underline"
                    >
                      Watch ({duration(Math.round(seconds))})
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                },
              },
            ]}
          />
        </div>
      </Section>

      {!ip && who !== "real" && who !== "team" && <ClusterSection clusters={clusters} />}

      <Section
        title="Bots (Microsoft Clarity)"
        description="Sessions Clarity recognised as bots, by where they came from, over the last 3 days (all Clarity's export allows). This is all site traffic, not only ads: Clarity can't tell which bot sessions came from an ad."
      >
        {!clarity.ok ? <ReportProblem problem={clarity} /> : <ClarityTable rows={clarity.data} />}
      </Section>
    </>
  )
}

function ClusterSection({ clusters }: { clusters: Cluster[] }) {
  return (
    <Section
      title="Clicks at the same moment"
      description={`Ad clicks from several different connections within ${CLUSTER_SECONDS / 60} minutes of each other. Real sellers don't arrive in lockstep from different states; a click farm or a bot network does.`}
    >
      {clusters.length ? (
        <ul className="flex flex-col divide-y rounded-xl border">
          {clusters.slice(0, 20).map((c) => (
            <li key={c.start} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{pacificTime(c.start)}</span>
                <Pill tone={c.visits.length >= 5 ? "red" : "amber"}>{c.visits.length} ad clicks</Pill>
                <span className="text-xs text-muted-foreground">{c.visits.filter((v) => v.submitted).length} sent a form</span>
              </span>
              <span className="text-xs text-muted-foreground">{c.places.join("; ")}</span>
              <span className="font-mono text-[11px] break-all text-muted-foreground">{c.visits.map((v) => v.ip).join(", ")}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">No bursts of ad clicks from different connections at once.</p>
      )}
    </Section>
  )
}

function ClarityTable({ rows }: { rows: ClaritySource[] }) {
  return (
    <DataTable
      rows={rows.filter((r) => r.sessions || r.botSessions)}
      rowKey={(r) => r.source}
      empty="Clarity saw no visits in the last 3 days."
      columns={[
        { key: "source", label: "Source", render: (r) => r.source },
        { key: "sessions", label: "Real sessions", align: "right", render: (r) => formatNumber(r.sessions) },
        {
          key: "bots",
          label: "Bot sessions",
          align: "right",
          render: (r) => (
            <span className={cn(r.botSessions > r.sessions && r.botSessions >= 5 && "font-medium text-destructive")}>
              {formatNumber(r.botSessions)}
            </span>
          ),
        },
        {
          key: "share",
          label: "Bot share",
          align: "right",
          render: (r) => (r.sessions + r.botSessions ? formatPercent(r.botSessions / (r.sessions + r.botSessions), 0) : "—"),
        },
      ]}
    />
  )
}

// ---- Junk leads ------------------------------------------------------------------------------

async function LeadsTab({ range }: { range: DateRange }) {
  const junk = await junkFor(range)
  if (!junk.ok) return <ReportProblem problem={junk} />
  const counts = new Map<string, number>()
  for (const j of junk.data) counts.set(mainReason(j), (counts.get(mainReason(j)) ?? 0) + 1)
  const shown = junk.data.slice(0, LEADS_SHOWN)

  return (
    <Section
      title="Junk form leads"
      description={
        <>
          Form leads the lead scoring graded Junk when they arrived: tests and fake names, advertising instead of a seller, or no real phone
          or email. The default lead rule reports junk to Google Ads as an invalid lead (reporting only), so Google never bids for more like
          it. Scores and rules live on the{" "}
          <Link href="/leads/automation" className="font-medium text-primary hover:underline">
            Leads page&apos;s automation
          </Link>
          .
        </>
      }
    >
      {counts.size > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {[...counts].map(([reason, n]) => (
            <Pill key={reason} tone="amber">
              {reason}: {n}
            </Pill>
          ))}
        </div>
      )}
      <DataTable
        rows={shown}
        rowKey={(j) => j.lead.id}
        empty="No junk among this period's form leads."
        columns={[
          { key: "when", label: "Sent", render: (j) => <span className="text-xs whitespace-nowrap">{pacificTime(j.lead.createdAt)}</span> },
          {
            key: "who",
            label: "Lead",
            render: (j) => (
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{j.lead.name || "(no name)"}</span>
                <span className="text-xs text-muted-foreground">{[j.lead.phone, j.lead.email].filter(Boolean).join(" · ")}</span>
                {j.lead.propertyAddress && <span className="text-xs text-muted-foreground">{j.lead.propertyAddress}</span>}
              </span>
            ),
          },
          {
            key: "why",
            label: "Why",
            render: (j) => (
              <ul className="flex flex-col gap-0.5 text-xs">
                {j.reasons.slice(0, 4).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ),
          },
          {
            key: "source",
            label: "From",
            render: (j) => <span className="text-xs">{j.lead.tracking?.gclid ? "Google Ads" : j.lead.source || "Website"}</span>,
          },
          { key: "google", label: "Google Ads", render: (j) => <span className="text-xs">{j.google}</span> },
        ]}
      />
      {junk.data.length > shown.length && (
        <p className="text-xs text-muted-foreground">
          Showing the newest {shown.length} of {junk.data.length}.
        </p>
      )}
    </Section>
  )
}

// ---- Refund claim ----------------------------------------------------------------------------

async function ClaimTab({ range, campaignId }: { range: DateRange; campaignId?: string }) {
  const [patterns, account, visits] = await Promise.all([
    load(() => getClickPatterns(range, campaignId)),
    load(() => getAccount()),
    load(() => getAdVisits(range)),
  ])
  if (!patterns.ok) return <ReportProblem problem={patterns} />
  const p: ClickPatterns = patterns.data
  // The suspicious days Google still has single clicks for are loaded up front.
  const preload = p.flagged
    .filter((d) => clickDetailAvailable(d.date, today()))
    .slice(0, 14)
    .map((d) => d.date)
  const clicks = preload.length ? await load(() => getClicks(preload, today(), campaignId)) : null

  return (
    <>
      {!visits.ok && <ReportProblem problem={visits} />}
      {clicks && !clicks.ok && <ReportProblem problem={clicks} />}
      <ClaimBuilder
        account={account.ok ? { id: account.data.id, name: account.data.name } : { id: "", name: "" }}
        accountLabel={account.ok ? accountNumber(account.data.id) : ""}
        days={p.days.filter((d) => d.clicks || d.invalid)}
        flagged={p.flagged.map((d) => d.date)}
        initialClicks={clicks?.ok ? clicks.data : []}
        loadedDays={clicks?.ok ? preload : []}
        visits={visits.ok ? visits.data : []}
        campaignId={campaignId}
        today={today()}
        oldestClaimable={addDays(today(), -CLAIM_DAYS)}
        oldestDetail={addDays(today(), -(CLICK_DETAIL_DAYS - 1))}
        formUrl={CLAIM_FORM}
      />
    </>
  )
}
