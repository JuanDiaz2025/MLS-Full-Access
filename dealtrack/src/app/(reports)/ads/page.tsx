import type { Metadata } from "next"
import Link from "next/link"

import { formatNumber, formatUsd } from "@/components/dashboard/format"
import { DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section, enumLabel } from "@/components/report"
import { parseRange, rangeQuery, type DateRange } from "@/lib/date-range"
import { POLICY_TOPICS, getAds, getAssetRatings, type AdRow, type AssetRow } from "@/lib/google-ads/ads"
import { load } from "@/lib/load"
import { checkPage, type PageCheck } from "@/lib/pagespeed"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Ads & creatives · DealTrack" }

const VIEWS = [
  { id: "running", label: "Running campaigns", match: (a: AdRow) => a.campaignStatus === "ENABLED" },
  { id: "paused", label: "Paused campaigns", match: (a: AdRow) => a.campaignStatus === "PAUSED" },
  { id: "all", label: "All", match: () => true },
] as const
type ViewId = (typeof VIEWS)[number]["id"]

type Issue = { tone: "red" | "amber"; text: string }
type Checked = AdRow & { page?: PageCheck; issues: Issue[] }

type Params = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const topicReason = (t: string) => POLICY_TOPICS[t]?.reason ?? enumLabel(t)
const isRsa = (a: AdRow) => a.type === "RESPONSIVE_SEARCH_AD"

function issuesFor(a: AdRow, page?: PageCheck): Issue[] {
  const out: Issue[] = []
  if (a.approval === "DISAPPROVED") out.push(...(a.topics.length ? a.topics : ["UNKNOWN"]).map((t) => ({ tone: "red" as const, text: `Disapproved: ${topicReason(t)}` })))
  if (a.approval === "APPROVED_LIMITED") out.push(...a.topics.map((t) => ({ tone: "amber" as const, text: `Limited: ${topicReason(t)}` })))
  if (page && (!page.resolves || (page.status ?? 0) >= 400)) out.push({ tone: "red", text: page.resolves ? `Landing page broken (HTTP ${page.status})` : "Landing page domain is gone" })
  if (a.strength === "POOR") out.push({ tone: "red", text: "Poor ad strength" })
  if (a.strength === "AVERAGE") out.push({ tone: "amber", text: "Average ad strength" })
  if (isRsa(a) && a.headlines < 10) out.push({ tone: "amber", text: `Only ${a.headlines} headlines (use 10–15)` })
  if (isRsa(a) && a.descriptions < 4) out.push({ tone: "amber", text: `Only ${a.descriptions} descriptions (use 4)` })
  if (a.pinned >= 3) out.push({ tone: "amber", text: `${a.pinned} pinned headlines limit Google's combinations` })
  return out
}

const severity = (a: Checked) => a.issues.reduce((s, i) => s + (i.tone === "red" ? 10 : 1), 0)

export default async function AdsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const range = parseRange(params)
  const view = (VIEWS.find((v) => v.id === first(params.view))?.id ?? "running") as ViewId
  const problemsOnly = first(params.problems) === "1"
  const result = await load(() => getAds(range))

  return (
    <>
      <PageHeader
        title="Ads & creatives"
        description="Every enabled ad and what's wrong with it: disapprovals and the reason in plain English, ad strength, too few headlines or descriptions, heavy pinning, and landing pages that don't load. Results are for the date range."
        range={range}
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body ads={result.data} view={view} problemsOnly={problemsOnly} range={range} />}
    </>
  )
}

async function Body({ ads, view, problemsOnly, range }: { ads: AdRow[]; view: ViewId; problemsOnly: boolean; range: DateRange }) {
  const current = VIEWS.find((v) => v.id === view)!
  const inView = ads.filter(current.match)

  // Check each landing page once, eight at a time.
  const urls = [...new Set(inView.map((a) => a.finalUrl).filter(Boolean))]
  const pages = new Map<string, PageCheck>()
  for (let i = 0; i < urls.length; i += 8) {
    const batch = urls.slice(i, i + 8)
    const checked = await Promise.all(batch.map((u) => load(() => checkPage(u))))
    checked.forEach((c, j) => c.ok && pages.set(batch[j], c.data))
  }

  const checked: Checked[] = inView
    .map((a) => {
      const page = a.finalUrl ? pages.get(a.finalUrl) : undefined
      return { ...a, page, issues: issuesFor(a, page) }
    })
    .sort((a, b) => severity(b) - severity(a) || b.metrics.cost - a.metrics.cost)
  const rows = problemsOnly ? checked.filter((a) => a.issues.length) : checked

  const count = (f: (a: Checked) => boolean) => checked.filter(f).length
  const disapproved = count((a) => a.approval === "DISAPPROVED")
  const brokenPages = count((a) => !!a.page && (!a.page.resolves || (a.page.status ?? 0) >= 400))

  const topics = new Map<string, number>()
  for (const a of checked) if (a.approval === "DISAPPROVED" || a.approval === "APPROVED_LIMITED") for (const t of a.topics) topics.set(t, (topics.get(t) ?? 0) + 1)

  const q = rangeQuery(range)
  const href = (v: ViewId, p: boolean) => `/ads${q ? `${q}&` : "?"}view=${v}${p ? "&problems=1" : ""}`
  const pill = (active: boolean) =>
    cn(
      "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
      active && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
    )

  const assets = view === "paused" ? null : await load(() => getAssetRatings())

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {VIEWS.map((v) => (
          <Link key={v.id} href={href(v.id, problemsOnly)} aria-current={v.id === view ? "true" : undefined} className={pill(v.id === view)}>
            {v.label} ({ads.filter(v.match).length})
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Link href={href(view, !problemsOnly)} aria-current={problemsOnly ? "true" : undefined} className={pill(problemsOnly)}>
          Problems only
        </Link>
      </div>

      <KpiGrid
        items={[
          { label: "Enabled ads", value: formatNumber(checked.length), note: current.label },
          { label: "Disapproved", value: formatNumber(disapproved), tone: disapproved ? "bad" : "good" },
          { label: "Limited", value: formatNumber(count((a) => a.approval === "APPROVED_LIMITED")), note: "Show in some places only" },
          { label: "Poor ad strength", value: formatNumber(count((a) => a.strength === "POOR")), tone: count((a) => a.strength === "POOR") ? "bad" : "default" },
          { label: "Heavily pinned", value: formatNumber(count((a) => a.pinned >= 3)), note: "3+ pinned headlines" },
          { label: "Broken landing page", value: formatNumber(brokenPages), tone: brokenPages ? "bad" : "good" },
        ]}
      />

      {topics.size > 0 && (
        <Section title="Why ads are disapproved or limited" description="Google's policy reasons for the ads in this view, with what fixes them.">
          <DataTable<[string, number]>
            rows={[...topics.entries()].sort((a, b) => b[1] - a[1])}
            rowKey={([t]) => t}
            columns={[
              { key: "reason", label: "Reason", render: ([t]) => <span className="font-medium">{topicReason(t)}</span> },
              { key: "ads", label: "Ads", align: "right", render: ([, n]) => formatNumber(n) },
              { key: "fix", label: "Fix", render: ([t]) => <span className="text-muted-foreground">{POLICY_TOPICS[t]?.fix ?? "See the policy details in Google Ads."}</span> },
            ]}
          />
        </Section>
      )}

      <Section title={`${rows.length} ${rows.length === 1 ? "ad" : "ads"}`} description="Worst problems first, then by spend.">
        <DataTable<Checked>
          rows={rows}
          rowKey={(a) => a.id}
          empty={problemsOnly ? "No problems found in this view." : "No enabled ads in this view."}
          columns={[
            {
              key: "ad",
              label: "Campaign / ad group",
              className: "min-w-52",
              render: (a) => (
                <span className="flex flex-col">
                  <span className="font-medium">{a.campaign}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.adGroup} · {enumLabel(a.type)}
                  </span>
                </span>
              ),
            },
            {
              key: "approval",
              label: "Approval",
              render: (a) => (
                <Pill tone={a.approval === "APPROVED" ? "green" : a.approval === "DISAPPROVED" ? "red" : "amber"}>{enumLabel(a.approval)}</Pill>
              ),
            },
            {
              key: "strength",
              label: "Strength",
              render: (a) =>
                isRsa(a) ? (
                  <Pill tone={a.strength === "EXCELLENT" || a.strength === "GOOD" ? "green" : a.strength === "POOR" ? "red" : a.strength === "AVERAGE" ? "amber" : "gray"}>
                    {enumLabel(a.strength)}
                  </Pill>
                ) : (
                  "—"
                ),
            },
            {
              key: "assets",
              label: "Headlines / desc.",
              align: "right",
              render: (a) => (isRsa(a) ? `${a.headlines} / ${a.descriptions}${a.pinned ? ` · ${a.pinned} pinned` : ""}` : "—"),
            },
            {
              key: "url",
              label: "Landing page",
              render: (a) =>
                a.finalUrl ? (
                  <a href={a.finalUrl} target="_blank" rel="noreferrer" className="text-xs hover:underline">
                    {a.finalUrl.replace(/^https?:\/\/(www\.)?/, "")}
                  </a>
                ) : (
                  "—"
                ),
            },
            { key: "cost", label: "Spend", align: "right", render: (a) => formatUsd(a.metrics.cost) },
            { key: "clicks", label: "Clicks", align: "right", render: (a) => formatNumber(a.metrics.clicks) },
            {
              key: "fix",
              label: "What to fix",
              className: "min-w-64",
              render: (a) =>
                a.issues.length ? (
                  <ul className="flex flex-wrap gap-1">
                    {a.issues.map((i) => (
                      <li key={i.text}>
                        <Pill tone={i.tone}>{i.text}</Pill>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Pill tone="green">Looks good</Pill>
                ),
            },
          ]}
        />
      </Section>

      {assets && <AssetSection assets={assets.ok ? assets.data : []} />}
    </>
  )
}

function AssetSection({ assets }: { assets: AssetRow[] }) {
  const labels = new Map<string, number>()
  for (const a of assets) labels.set(a.label, (labels.get(a.label) ?? 0) + 1)
  const low = assets.filter((a) => a.label === "LOW")
  const rated = assets.filter((a) => ["BEST", "GOOD", "LOW"].includes(a.label)).length
  return (
    <Section
      title="Headline and description ratings (running campaigns)"
      description="Google rates each headline and description Best, Good, or Low once it has enough impressions. Replace the Low ones."
    >
      <p className="text-sm">
        {[...labels.entries()].map(([l, n]) => `${enumLabel(l)}: ${n}`).join(" · ") || "No headlines or descriptions in running campaigns."}
      </p>
      {!rated && assets.length > 0 && (
        <p className="text-xs text-muted-foreground">None are rated yet: Google needs more impressions first. With ads mostly off, that takes a while.</p>
      )}
      {low.length > 0 && (
        <DataTable<AssetRow>
          rows={low}
          rowKey={(a) => `${a.campaign}|${a.field}|${a.text}`}
          columns={[
            { key: "text", label: "Low-rated text", render: (a) => <span className="font-medium">{a.text}</span> },
            { key: "field", label: "Type", render: (a) => enumLabel(a.field) },
            { key: "campaign", label: "Campaign", render: (a) => <span className="text-muted-foreground">{a.campaign}</span> },
          ]}
        />
      )}
    </Section>
  )
}
