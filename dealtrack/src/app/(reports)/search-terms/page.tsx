import type { Metadata } from "next"
import Link from "next/link"

import NegativeKeywordPanel from "@/components/changes/negative-keyword-panel"
import NegativesList from "@/components/changes/negatives-list"
import CopyButton from "@/components/copy-button"
import { formatConversions, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { AdminLink, DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { parseRange, rangeQuery, type DateRange } from "@/lib/date-range"
import {
  getCampaignNegatives,
  getEditableCampaigns,
  type CampaignNegative,
  type EditableCampaign,
} from "@/lib/google-ads/changes"
import { getSearchTerms, isWaste, rates, sumMetrics, type Metrics, type SearchTermRow } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Search terms · DealTrack" }

const views = [
  { id: "waste", label: "No conversions" },
  { id: "flagged", label: "Flagged" },
  { id: "converting", label: "Converting" },
  { id: "all", label: "All" },
] as const
type View = (typeof views)[number]["id"]

const MAX_ROWS = 500

export default async function SearchTermsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const range = parseRange(params)
  const view: View = views.some((v) => v.id === params.view) ? (params.view as View) : "waste"
  const admin = await isAdmin()
  const result = await load(async () => {
    const [terms, campaigns] = await Promise.all([getSearchTerms(range), getEditableCampaigns()])
    // Old paused campaigns hold thousands of negatives; show the ones on running campaigns.
    const running = campaigns.filter((c) => c.status === "ENABLED").map((c) => c.id)
    const negatives = await getCampaignNegatives({ campaignIds: running })
    return { terms, negatives, campaigns }
  })

  return (
    <>
      <PageHeader
        title="Search terms"
        description="What people actually typed before clicking your ads. Terms that cost money without converting are the first place to add negative keywords."
        range={range}
      />
      {!result.ok ? (
        <ReportProblem problem={result} />
      ) : (
        <Body {...result.data} range={range} view={view} admin={admin} />
      )}
    </>
  )
}

type Suggestion = { negative: string; reason: string; terms: number; metrics: Metrics }

function Body({
  terms,
  negatives,
  campaigns,
  range,
  view,
  admin,
}: {
  terms: SearchTermRow[]
  negatives: CampaignNegative[]
  campaigns: EditableCampaign[]
  range: DateRange
  view: View
  admin: boolean
}) {
  const keywordNegatives = negatives.filter((n) => n.kind === "keyword")
  const totals = sumMetrics(terms)
  const waste = terms.filter((t) => isWaste(t.metrics))
  const wasteCost = waste.reduce((s, t) => s + t.metrics.cost, 0)

  // Group flagged terms (not already excluded) by the negative keyword that would block them.
  const byNegative = new Map<string, Suggestion>()
  for (const t of terms) {
    if (!t.rule || !t.suggestion || t.status.includes("EXCLUDED")) continue
    const s = byNegative.get(t.suggestion) ?? {
      negative: t.suggestion,
      reason: t.rule.reason,
      terms: 0,
      metrics: { cost: 0, clicks: 0, impressions: 0, conversions: 0 },
    }
    s.terms += 1
    s.metrics.cost += t.metrics.cost
    s.metrics.clicks += t.metrics.clicks
    s.metrics.conversions += t.metrics.conversions
    byNegative.set(t.suggestion, s)
  }
  const suggestions = [...byNegative.values()].sort((a, b) => b.metrics.cost - a.metrics.cost)
  // Phrase match, one per line: the format Google Ads accepts when pasting negatives.
  const pasteList = suggestions.map((s) => `"${s.negative}"`).join("\n")

  const shown = terms.filter((t) =>
    view === "waste" ? isWaste(t.metrics) : view === "flagged" ? !!t.rule : view === "converting" ? t.metrics.conversions > 0 : true,
  )
  const q = rangeQuery(range)
  const join = q ? `${q}&` : "?"

  return (
    <>
      <KpiGrid
        items={[
          { label: "Search terms", value: formatNumber(terms.length) },
          { label: "Search-term spend", value: formatUsd(totals.cost), note: "Google hides rare terms, so this is less than total spend" },
          { label: "Terms with no conversions", value: formatNumber(waste.length) },
          {
            label: "Spend with no conversions",
            value: formatUsd(wasteCost),
            note: `${formatPercent(totals.cost ? wasteCost / totals.cost : 0, 0)} of search-term spend`,
            tone: wasteCost > 0 ? "bad" : "default",
          },
          { label: "Suggested negatives", value: formatNumber(suggestions.length) },
          {
            label: "Spend they'd have blocked",
            value: formatUsd(suggestions.reduce((s, x) => s + x.metrics.cost, 0)),
          },
        ]}
      />

      <Section
        title="Suggested negative keywords"
        description="Based on terms that usually aren't cash sellers: agents, buyers, renters, loans, jobs, listing sites, and places outside California. Review each one before adding it. Some flagged terms may still have converted."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!admin && <AdminLink />}
            {suggestions.length > 0 && <CopyButton text={pasteList} label="Copy as phrase match" />}
          </div>
        }
      >
        {admin ? (
          <NegativeKeywordPanel
            suggestions={suggestions.map((s) => ({
              negative: s.negative,
              reason: s.reason,
              terms: s.terms,
              cost: s.metrics.cost,
              conversions: s.metrics.conversions,
            }))}
            campaigns={campaigns}
            existing={keywordNegatives.map((n) => `${n.campaignId}|${n.text}|${n.matchType}`)}
          />
        ) : (
          <DataTable<Suggestion>
            rows={suggestions}
            rowKey={(s) => s.negative}
            empty="No flagged search terms in this period."
            columns={[
              { key: "negative", label: "Negative keyword", render: (s) => <code className="font-mono text-xs">&quot;{s.negative}&quot;</code> },
              { key: "reason", label: "Why", render: (s) => <span className="text-muted-foreground">{s.reason}</span> },
              { key: "terms", label: "Terms", align: "right", render: (s) => formatNumber(s.terms) },
              { key: "cost", label: "Spend", align: "right", render: (s) => formatUsd(s.metrics.cost) },
              {
                key: "conv",
                label: "Conversions",
                align: "right",
                render: (s) => (
                  <span className={cn(s.metrics.conversions > 0 && "font-medium text-amber-700")}>
                    {formatConversions(s.metrics.conversions)}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Section>

      <Section
        title={`Negative keywords on running campaigns (${keywordNegatives.length})`}
        description="Set directly on campaigns that are currently enabled. Paused campaigns and shared negative keyword lists aren't shown."
      >
        <NegativesList
          canEdit={admin}
          noun="negative keyword"
          empty="No campaign-level negative keywords yet."
          items={keywordNegatives
            .sort((a, b) => (a.text ?? "").localeCompare(b.text ?? ""))
            .map((n) => ({
              resourceName: n.resourceName,
              label: n.matchType === "EXACT" ? `[${n.text}]` : n.matchType === "PHRASE" ? `"${n.text}"` : (n.text ?? ""),
              campaignName: n.campaignName,
            }))}
        />
      </Section>

      <Section
        title="Search terms"
        description={
          shown.length > MAX_ROWS ? `Showing the ${MAX_ROWS} highest-spend of ${formatNumber(shown.length)} terms.` : undefined
        }
        actions={
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter search terms">
            {views.map((v) => (
              <Link
                key={v.id}
                href={`/search-terms${join}view=${v.id}`}
                aria-current={view === v.id ? "true" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground",
                  view === v.id && "border-foreground bg-foreground text-background hover:text-background",
                )}
              >
                {v.label}
              </Link>
            ))}
          </div>
        }
      >
        <DataTable<SearchTermRow>
          rows={shown.slice(0, MAX_ROWS)}
          rowKey={(t) => t.term.toLowerCase()}
          empty="No search terms match this filter."
          columns={[
            {
              key: "term",
              label: "Search term",
              render: (t) => (
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{t.term}</span>
                  <span className="text-xs text-muted-foreground">{t.adGroups.join(", ")}</span>
                </div>
              ),
            },
            {
              key: "flag",
              label: "Flag",
              render: (t) => (
                <div className="flex flex-wrap gap-1">
                  {t.status.includes("EXCLUDED") && <Pill tone="gray">Already excluded</Pill>}
                  {t.status === "ADDED" && <Pill tone="violet">Is a keyword</Pill>}
                  {t.rule && !t.status.includes("EXCLUDED") && <Pill tone="red">{t.rule.reason}</Pill>}
                </div>
              ),
            },
            { key: "cost", label: "Spend", align: "right", render: (t) => formatUsd(t.metrics.cost) },
            { key: "clicks", label: "Clicks", align: "right", render: (t) => formatNumber(t.metrics.clicks) },
            { key: "conv", label: "Conversions", align: "right", render: (t) => formatConversions(t.metrics.conversions) },
            {
              key: "cpa",
              label: "Cost / conv.",
              align: "right",
              render: (t) => {
                const cpa = rates(t.metrics).costPerConversion
                return cpa === null ? <span className="text-muted-foreground">—</span> : formatUsd(cpa)
              },
            },
          ]}
        />
      </Section>
    </>
  )
}
