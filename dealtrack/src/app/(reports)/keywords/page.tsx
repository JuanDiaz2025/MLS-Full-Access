import type { Metadata } from "next"
import Link from "next/link"

import { formatConversions, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import { DataTable, PageHeader, Pill, ReportProblem, Section, StatusPill, enumLabel } from "@/components/report"
import { parseRange } from "@/lib/date-range"
import { getKeywords, rates, sumMetrics, type KeywordRow } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Keywords · DealTrack" }

// A keyword that spent at least this much without converting is worth a look.
const REVIEW_SPEND = 100

export default async function KeywordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const range = parseRange(await searchParams)
  const result = await load(() => getKeywords(range))

  return (
    <>
      <PageHeader
        title="Keywords"
        description="The keywords you bid on. Stop: spent without converting. Scale: converting cheaper than your average."
        range={range}
      />
      <Link href="/keyword-ideas" className="self-start text-sm font-medium text-primary hover:underline">
        Find new keywords worth adding →
      </Link>
      {!result.ok ? <ReportProblem problem={result} /> : <Body keywords={result.data} />}
    </>
  )
}

function Body({ keywords }: { keywords: KeywordRow[] }) {
  const avgCpa = rates(sumMetrics(keywords)).costPerConversion

  function verdict(k: KeywordRow) {
    const cpa = rates(k.metrics).costPerConversion
    if (k.metrics.conversions === 0 && k.metrics.cost >= REVIEW_SPEND) return <Pill tone="red">Stop or fix</Pill>
    if (cpa !== null && avgCpa !== null && k.metrics.conversions >= 2 && cpa <= avgCpa) return <Pill tone="green">Scale</Pill>
    return null
  }

  return (
    <Section
      title={`${keywords.length} keywords`}
      description={
        avgCpa === null
          ? "No conversions in this period, so nothing can be marked Scale yet."
          : `Average cost per conversion across all keywords: ${formatUsd(avgCpa)}.`
      }
    >
      <DataTable<KeywordRow>
        rows={keywords}
        rowKey={(k) => k.id}
        columns={[
          {
            key: "keyword",
            label: "Keyword",
            render: (k) => (
              <div className="flex flex-col gap-1">
                <span className="font-medium">{k.text}</span>
                <span className="text-xs text-muted-foreground">
                  {k.campaign} › {k.adGroup}
                </span>
              </div>
            ),
          },
          { key: "match", label: "Match", render: (k) => <span className="text-muted-foreground">{enumLabel(k.matchType)}</span> },
          { key: "status", label: "Status", render: (k) => <StatusPill status={k.status} /> },
          { key: "verdict", label: "Verdict", render: verdict },
          { key: "cost", label: "Spend", align: "right", render: (k) => formatUsd(k.metrics.cost) },
          { key: "clicks", label: "Clicks", align: "right", render: (k) => formatNumber(k.metrics.clicks) },
          { key: "ctr", label: "CTR", align: "right", render: (k) => formatPercent(rates(k.metrics).ctr) },
          { key: "cpc", label: "Avg. CPC", align: "right", render: (k) => formatUsdCents(rates(k.metrics).cpc) },
          { key: "conv", label: "Conversions", align: "right", render: (k) => formatConversions(k.metrics.conversions) },
          {
            key: "cpa",
            label: "Cost / conv.",
            align: "right",
            render: (k) => {
              const cpa = rates(k.metrics).costPerConversion
              return cpa === null ? <span className="text-muted-foreground">—</span> : formatUsd(cpa)
            },
          },
        ]}
      />
    </Section>
  )
}
