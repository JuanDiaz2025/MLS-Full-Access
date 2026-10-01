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
import { JUNK_LABELS, findJunkLeads, type JunkLead } from "@/lib/fraud/leads"
import {
  CLUSTER_SECONDS,
  NETWORK_FLAG_LABELS,
  REPEAT_CLICKS,
  findClusters,
  getAdVisits,
  groupNetworks,
  type Cluster,
  type Network,
} from "@/lib/fraud/visitors"
import { getEditableCampaigns } from "@/lib/google-ads/changes"
import { getAccount } from "@/lib/google-ads/reports"
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
      <Suspense key={`${view}|${range.from}|${range.to}|${campaignId}|${day}`} fallback={<PageLoading message={LOADING[view]} />}>
        <TabBody view={view} range={range} campaignId={chosen ? campaignId : undefined} day={day} />
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

async function TabBody({ view, range, campaignId, day }: { view: View; range: DateRange; campaignId?: string; day: string }) {
  if (view === "clicks") return <ClicksTab range={range} campaignId={campaignId} day={day} />
  if (view === "visitors") return <VisitorsTab range={range} />
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
      detail: "Junk leads counted as conversions teach Google to find more of the same. Check them and mark them in the CRM.",
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

async function VisitorsTab({ range }: { range: DateRange }) {
  const [{ visits, networks, known, clusters }, clarity, name] = await Promise.all([
    networksFor(range),
    load(() => getClarityBySource()),
    currentName(),
  ])
  // One visit from another state is common (people selling a California house from elsewhere),
  // so on its own it isn't listed.
  const flagged = networks.filter((n) => n.known || n.flags.some((f) => f !== "outside-ca") || n.adClicks >= 2)
  const shown = flagged.slice(0, NETWORKS_SHOWN)
  const total = visits.ok ? visits.data.length : 0

  return (
    <>
      <Section
        title="Ad visitors by connection"
        description={`Every visit that arrived from an ad, from PostHog, grouped by internet connection (an IP address; phones and homes on IPv6 by their /64 network). ${REPEAT_CLICKS} or more ad clicks from one connection is what a competitor or a click farm looks like. Mark your own team's connections so they stop showing up as attacks.`}
      >
        {!visits.ok ? (
          <ReportProblem problem={visits} />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {formatNumber(total)} ad visits from {formatNumber(networks.length)} connections; {formatNumber(flagged.length)} need a look.
            </p>
            <DataTable
              rows={shown}
              rowKey={(n) => n.network}
              empty="No suspicious ad visitors in this period."
              columns={[
                {
                  key: "network",
                  label: "Connection",
                  render: (n) => (
                    <span className="flex flex-col gap-0.5">
                      <span className="font-mono text-xs break-all">{n.network}</span>
                      <span className="text-xs text-muted-foreground">{n.place}</span>
                    </span>
                  ),
                },
                {
                  key: "flags",
                  label: "Why",
                  render: (n) => (
                    <span className="flex flex-wrap gap-1">
                      {n.known && <Pill tone="green">Team: {n.known}</Pill>}
                      {n.flags.map((f) => (
                        <Pill key={f} tone={n.known ? "gray" : f === "repeat" || f === "bot-agent" ? "red" : "amber"}>
                          {NETWORK_FLAG_LABELS[f]}
                        </Pill>
                      ))}
                    </span>
                  ),
                },
                { key: "clicks", label: "Ad clicks", align: "right", render: (n) => formatNumber(n.adClicks) },
                {
                  key: "when",
                  label: "When",
                  render: (n) => (
                    <span className="text-xs whitespace-nowrap">
                      {pacificTime(n.first)}
                      {n.visits.length > 1 && <> – {pacificTime(n.last)}</>}
                    </span>
                  ),
                },
                {
                  key: "how",
                  label: "Device",
                  render: (n) => (
                    <span className="text-xs">
                      {[...new Set(n.visits.map((v) => [v.browser, v.os].filter(Boolean).join(" on ")))].slice(0, 2).join("; ")}
                    </span>
                  ),
                },
                { key: "forms", label: "Forms", align: "right", render: (n) => formatNumber(n.submitted) },
                {
                  key: "mark",
                  label: "",
                  render: (n) => (
                    <NetworkMark network={n.network} known={known.find((k: KnownNetwork) => k.network === n.network)} personName={name} />
                  ),
                },
              ]}
            />
            {flagged.length > shown.length && (
              <p className="text-xs text-muted-foreground">
                Showing the first {shown.length} of {flagged.length}.
              </p>
            )}
          </>
        )}
      </Section>

      {visits.ok && <ClusterSection clusters={clusters} />}

      <Section
        title="Bots (Microsoft Clarity)"
        description="Sessions Clarity recognised as bots, by where they came from, over the last 3 days (all Clarity's export allows). Clarity leaves bots out of its session counts; a jump from Google is worth a look on the Click patterns tab."
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
  for (const j of junk.data) for (const r of j.reasons) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1)
  const shown = junk.data.slice(0, LEADS_SHOWN)

  return (
    <Section
      title="Junk form leads"
      description="Website form leads with signs of junk: a fake phone number, a made-up name, a throwaway email, the same person again, several forms from one ad click, or a competitor's wording. If they count as conversions in Google Ads, they teach its bidding to find more of the same, so mark them invalid in the CRM. Form leads come from the website webhook (Leads & calls page)."
    >
      {counts.size > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {[...counts].map(([reason, n]) => (
            <Pill key={reason} tone="amber">
              {JUNK_LABELS[reason as keyof typeof JUNK_LABELS]}: {n}
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
                {j.reasons.map((r) => (
                  <li key={r.reason}>
                    <span className="font-medium">{JUNK_LABELS[r.reason]}:</span> {r.detail}
                  </li>
                ))}
              </ul>
            ),
          },
          {
            key: "source",
            label: "From",
            render: (j) => <span className="text-xs">{j.lead.tracking?.gclid ? "Google Ads" : j.lead.source || "Website"}</span>,
          },
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
