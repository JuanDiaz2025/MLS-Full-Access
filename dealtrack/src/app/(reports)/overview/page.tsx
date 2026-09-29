import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { formatConversions, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import TrendChart from "@/components/dashboard/trend-chart"
import { DataTable, KpiGrid, PageHeader, ReportProblem, Section, StatusPill } from "@/components/report"
import { parseRange, rangeQuery } from "@/lib/date-range"
import {
  getAccount,
  getCampaigns,
  getDaily,
  getLocations,
  getSearchTerms,
  isWaste,
  rates,
  sumMetrics,
  type CampaignRow,
} from "@/lib/google-ads/reports"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Overview · DealTrack" }

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const range = parseRange(await searchParams)
  const q = rangeQuery(range)
  const result = await load(async () => {
    const [account, daily, campaigns, terms, locations] = await Promise.all([
      getAccount(),
      getDaily(range),
      getCampaigns(range),
      getSearchTerms(range),
      getLocations(range),
    ])
    return { account, daily, campaigns, terms, locations }
  })

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Overview" description="Spend, leads, and what needs attention." range={range} />
        <ReportProblem problem={result} />
      </>
    )
  }

  const { account, daily, campaigns, terms, locations } = result.data
  const totals = sumMetrics(daily)
  const r = rates(totals)

  const wastedTerms = terms.filter((t) => isWaste(t.metrics))
  const wastedTermCost = wastedTerms.reduce((s, t) => s + t.metrics.cost, 0)
  const suggested = new Set(terms.filter((t) => t.suggestion && t.status === "NONE").map((t) => t.suggestion))
  const outside = locations.filter((l) => l.status === "outside")
  const outsideCost = outside.reduce((s, l) => s + l.metrics.cost, 0)
  const deadCampaigns = campaigns.filter((c) => isWaste(c.metrics))

  const attention = [
    {
      href: `/search-terms${q}`,
      title: `${formatUsd(wastedTermCost)} on ${formatNumber(wastedTerms.length)} search terms with no conversions`,
      detail: `${formatPercent(totals.cost ? wastedTermCost / totals.cost : 0, 0)} of all spend. ${suggested.size} negative keywords suggested.`,
      show: wastedTermCost > 0,
    },
    {
      href: `/locations${q}`,
      title: `${formatUsd(outsideCost)} spent outside the Bay Area (${formatPercent(totals.cost ? outsideCost / totals.cost : 0, 0)} of spend)`,
      detail: outside.length
        ? `Top: ${outside.slice(0, 3).map((l) => l.city).join(", ")}.`
        : "",
      show: outsideCost > 0,
    },
    {
      href: `/campaigns${q}`,
      title: `${deadCampaigns.length} campaign${deadCampaigns.length === 1 ? "" : "s"} spent money with no conversions`,
      detail: deadCampaigns.length
        ? `${formatUsd(deadCampaigns.reduce((s, c) => s + c.metrics.cost, 0))} in total.`
        : "",
      show: deadCampaigns.length > 0,
    },
  ].filter((a) => a.show)

  return (
    <>
      <PageHeader
        title={account.name}
        description={`Google Ads account ${account.id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}. Read-only: nothing here changes your ads.`}
        range={range}
      />

      <KpiGrid
        items={[
          { label: "Spend", value: formatUsd(totals.cost) },
          { label: "Clicks", value: formatNumber(totals.clicks), note: `${formatNumber(totals.impressions)} impressions` },
          { label: "Conversions", value: formatConversions(totals.conversions), note: `${formatPercent(r.conversionRate)} of clicks` },
          {
            label: "Cost per conversion",
            value: r.costPerConversion === null ? "—" : formatUsd(r.costPerConversion),
            tone: r.costPerConversion === null && totals.cost > 0 ? "bad" : "default",
          },
          { label: "Click-through rate", value: formatPercent(r.ctr) },
          { label: "Avg. cost per click", value: formatUsdCents(r.cpc) },
        ]}
      />

      {attention.length > 0 && (
        <Section title="Needs attention" description="Money that didn't bring in leads during this period.">
          <ul className="flex flex-col divide-y">
            {attention.map((a) => (
              <li key={a.href}>
                <Link href={a.href} className="group flex items-center justify-between gap-4 py-3">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{a.title}</span>
                    {a.detail && <span className="text-sm text-muted-foreground">{a.detail}</span>}
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Spend per day">
          <TrendChart
            label="Spend"
            unit="usd"
            color="var(--primary)"
            data={daily.map((d) => ({ date: d.date, value: Math.round(d.metrics.cost) }))}
          />
        </Section>
        <Section title="Conversions per day">
          <TrendChart
            label="Conversions"
            color="var(--chart-2)"
            data={daily.map((d) => ({ date: d.date, value: d.metrics.conversions }))}
          />
        </Section>
      </div>

      <Section
        title="Campaigns"
        description="Campaigns with impressions in this period, highest spend first."
        actions={
          <Link href={`/campaigns${q}`} className="text-sm font-medium text-primary hover:underline">
            All campaigns
          </Link>
        }
      >
        <DataTable<CampaignRow>
          rows={campaigns.slice(0, 8)}
          rowKey={(c) => c.id}
          columns={[
            { key: "name", label: "Campaign", render: (c) => <span className="font-medium">{c.name}</span> },
            { key: "status", label: "Status", render: (c) => <StatusPill status={c.status} /> },
            { key: "cost", label: "Spend", align: "right", render: (c) => formatUsd(c.metrics.cost) },
            { key: "clicks", label: "Clicks", align: "right", render: (c) => formatNumber(c.metrics.clicks) },
            { key: "conv", label: "Conversions", align: "right", render: (c) => formatConversions(c.metrics.conversions) },
            {
              key: "cpa",
              label: "Cost / conv.",
              align: "right",
              render: (c) => {
                const cpa = rates(c.metrics).costPerConversion
                return cpa === null ? <span className="text-destructive">None</span> : formatUsd(cpa)
              },
            },
          ]}
        />
      </Section>
    </>
  )
}
