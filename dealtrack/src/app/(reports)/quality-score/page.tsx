import type { Metadata } from "next"
import Link from "next/link"

import { formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import TrendChart from "@/components/dashboard/trend-chart"
import { DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section, enumLabel } from "@/components/report"
import { addDays, parseRange, rangeQuery, today, type DateRange } from "@/lib/date-range"
import { getQualityHistory, getQualityKeywords, isBrand, type QualityKeyword, type QualityWeek, type Rating } from "@/lib/google-ads/quality"
import { load } from "@/lib/load"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Quality Score · DealTrack" }

const SCOPES = [
  { id: "nonbrand", label: "Seller keywords (non-brand)", match: (c: string) => !isBrand(c) },
  { id: "brand", label: "Brand", match: (c: string) => isBrand(c) },
  { id: "all", label: "All", match: () => true },
] as const
type ScopeId = (typeof SCOPES)[number]["id"]

type Params = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

const ratingTone = { ABOVE_AVERAGE: "green", AVERAGE: "gray", BELOW_AVERAGE: "red", UNKNOWN: "gray" } as const
const ratingLabel = { ABOVE_AVERAGE: "Above avg", AVERAGE: "Average", BELOW_AVERAGE: "Below avg", UNKNOWN: "—" } as const
const RatingPill = ({ r }: { r: Rating }) => (r === "UNKNOWN" ? <span className="text-muted-foreground">—</span> : <Pill tone={ratingTone[r]}>{ratingLabel[r]}</Pill>)

export default async function QualityScorePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const range = parseRange(params)
  const scope = (SCOPES.find((s) => s.id === first(params.scope))?.id ?? "nonbrand") as ScopeId
  const match = SCOPES.find((s) => s.id === scope)!.match
  const year: DateRange = { from: addDays(today(), -364), to: today(), label: "Last 12 months" }
  const [keywords, history] = await Promise.all([load(() => getQualityKeywords(range)), load(() => getQualityHistory(year, match))])

  return (
    <>
      <PageHeader
        title="Quality Score"
        description="Google's 1–10 rating of each keyword, and its three parts: expected click-through rate, ad relevance, and landing page experience. Higher scores mean cheaper clicks and better positions. Brand keywords score high by nature, so seller keywords are shown on their own by default."
        range={range}
      />
      {!keywords.ok ? (
        <ReportProblem problem={keywords} />
      ) : (
        <Body keywords={keywords.data.filter((k) => match(k.campaign))} history={history.ok ? history.data : []} scope={scope} range={range} />
      )}
    </>
  )
}

function Body({ keywords, history, scope, range }: { keywords: QualityKeyword[]; history: QualityWeek[]; scope: ScopeId; range: DateRange }) {
  const q = rangeQuery(range)
  const href = (s: ScopeId) => `/quality-score${q ? `${q}&` : "?"}scope=${s}`
  const withImps = keywords.filter((k) => k.metrics.impressions > 0)
  const weight = withImps.reduce((s, k) => s + k.metrics.impressions, 0)
  const weighted = weight ? withImps.reduce((s, k) => s + k.score * k.metrics.impressions, 0) / weight : null
  const share = (part: (k: QualityKeyword) => Rating) => (keywords.length ? keywords.filter((k) => part(k) === "BELOW_AVERAGE").length / keywords.length : 0)
  const low = keywords.filter((k) => k.score <= 3).length
  const dist = Array.from({ length: 10 }, (_, i) => keywords.filter((k) => k.score === i + 1).length)
  const maxDist = Math.max(...dist, 1)
  const rows = [...keywords].sort((a, b) => b.metrics.cost - a.metrics.cost || a.score - b.score)
  const chart = history.filter((w) => w.score !== null).map((w) => ({ date: w.week, value: w.score! }))
  const lastWeeks = history.filter((w) => w.score !== null).slice(-8)
  const recent = lastWeeks.length ? lastWeeks : history

  return (
    <>
      <nav aria-label="Keywords" className="flex flex-wrap gap-1.5">
        {SCOPES.map((s) => (
          <Link
            key={s.id}
            href={href(s.id)}
            aria-current={s.id === scope ? "true" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
              s.id === scope && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
            )}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      <KpiGrid
        items={[
          { label: "Keywords with a score", value: formatNumber(keywords.length), note: "Google scores keywords once they get searches" },
          {
            label: "Average score",
            value: weighted === null ? "—" : weighted.toFixed(1),
            note: weighted === null ? "No impressions in this range" : "Weighted by impressions",
            tone: weighted !== null && weighted < 5 ? "bad" : "default",
          },
          { label: "Score 3 or lower", value: formatNumber(low), tone: low ? "bad" : "default" },
          { label: "Expected CTR below avg", value: formatPercent(share((k) => k.expectedCtr), 0), note: "Of scored keywords" },
          { label: "Ad relevance below avg", value: formatPercent(share((k) => k.adRelevance), 0), note: "Of scored keywords" },
          {
            label: "Landing page below avg",
            value: formatPercent(share((k) => k.landingPage), 0),
            note: "Of scored keywords",
            tone: share((k) => k.landingPage) > 0.25 ? "bad" : "default",
          },
        ]}
      />

      <Section title="Score over the last 12 months" description="Weekly, weighted by impressions. Weeks with no searches are left out.">
        {chart.length > 1 ? (
          <TrendChart data={chart} color="var(--primary)" label="Quality Score" unit="score" />
        ) : (
          <p className="text-sm text-muted-foreground">Not enough weeks with scored keywords to draw a trend.</p>
        )}
        {recent.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Recent weeks, share of impressions rated below average: expected CTR{" "}
            {formatPercent(recent.reduce((s, w) => s + w.belowCtr, 0) / recent.length, 0)}, ad relevance{" "}
            {formatPercent(recent.reduce((s, w) => s + w.belowRelevance, 0) / recent.length, 0)}, landing page{" "}
            {formatPercent(recent.reduce((s, w) => s + w.belowLandingPage, 0) / recent.length, 0)}.
          </p>
        )}
      </Section>

      <Section title="How scores are spread" description="Keywords by today's score. 7+ is good; 3 or lower costs more per click.">
        <div className="flex h-32 items-end gap-1.5" role="img" aria-label="Keywords by Quality Score from 1 to 10">
          {dist.map((n, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1 text-[11px] tabular-nums">
              <span className="text-muted-foreground">{n || ""}</span>
              <div
                className={cn("w-full rounded-t", i < 3 ? "bg-destructive/70" : i < 6 ? "bg-amber-400" : "bg-emerald-500")}
                style={{ height: `${(n / maxDist) * 88}px` }}
              />
              <span className="font-medium">{i + 1}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title={`${keywords.length} scored keywords`} description="Most spend first. The part rated below average is what to fix.">
        <DataTable<QualityKeyword>
          rows={rows}
          rowKey={(k) => k.id}
          empty="No keywords have a Quality Score in this view."
          columns={[
            {
              key: "kw",
              label: "Keyword",
              className: "min-w-48",
              render: (k) => (
                <span className="flex flex-col">
                  <span className="font-medium">{k.text}</span>
                  <span className="text-xs text-muted-foreground">
                    {enumLabel(k.matchType)} · {k.campaign} · {k.adGroup}
                  </span>
                </span>
              ),
            },
            {
              key: "qs",
              label: "Score",
              align: "right",
              render: (k) => <Pill tone={k.score >= 7 ? "green" : k.score >= 4 ? "amber" : "red"}>{k.score}/10</Pill>,
            },
            { key: "ctr", label: "Expected CTR", render: (k) => <RatingPill r={k.expectedCtr} /> },
            { key: "rel", label: "Ad relevance", render: (k) => <RatingPill r={k.adRelevance} /> },
            { key: "lp", label: "Landing page", render: (k) => <RatingPill r={k.landingPage} /> },
            { key: "imps", label: "Impressions", align: "right", render: (k) => formatNumber(k.metrics.impressions) },
            { key: "cost", label: "Spend", align: "right", render: (k) => formatUsd(k.metrics.cost) },
            {
              key: "fix",
              label: "What to fix",
              className: "min-w-48",
              render: (k) => {
                const fixes = [
                  k.landingPage === "BELOW_AVERAGE" && "Landing page: faster, and about this search",
                  k.expectedCtr === "BELOW_AVERAGE" && "Headlines that match the search",
                  k.adRelevance === "BELOW_AVERAGE" && "Put the keyword in the ad; tighter ad group",
                ].filter(Boolean) as string[]
                return fixes.length ? <span className="text-xs">{fixes.join(" · ")}</span> : <span className="text-xs text-muted-foreground">—</span>
              },
            },
          ]}
        />
      </Section>
    </>
  )
}
