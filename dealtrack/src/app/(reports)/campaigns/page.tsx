import type { Metadata } from "next"
import Link from "next/link"

import { formatConversions, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import { DataTable, PageHeader, ReportProblem, Section, StatusPill, enumLabel } from "@/components/report"
import { parseRange, rangeQuery, type DateRange } from "@/lib/date-range"
import { getAllCampaigns, rates, sumMetrics, type CampaignListRow } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Campaigns · DealTrack" }

// The same status views as Google Ads. "All but removed" is Google's default.
const VIEWS = [
  { id: "live", label: "All but removed", match: (s: string) => s !== "REMOVED" },
  { id: "enabled", label: "Enabled", match: (s: string) => s === "ENABLED" },
  { id: "paused", label: "Paused", match: (s: string) => s === "PAUSED" },
  { id: "removed", label: "Removed", match: (s: string) => s === "REMOVED" },
  { id: "all", label: "All", match: () => true },
] as const

type Params = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const range = parseRange(params)
  const view = VIEWS.find((v) => v.id === first(params.status)) ?? VIEWS[0]
  const result = await load(() => getAllCampaigns(range))

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Every campaign in the account, running or not, with its results for this period. Filter by status the same way Google Ads does."
        range={range}
      />
      {!result.ok ? (
        <ReportProblem problem={result} />
      ) : (
        <Body campaigns={result.data} view={view.id} range={range} />
      )}
    </>
  )
}

function Body({ campaigns, view, range }: { campaigns: CampaignListRow[]; view: (typeof VIEWS)[number]["id"]; range: DateRange }) {
  const current = VIEWS.find((v) => v.id === view)!
  const rows = campaigns.filter((c) => current.match(c.status))
  const count = (match: (s: string) => boolean) => campaigns.filter((c) => match(c.status)).length
  const enabledBudget = campaigns.filter((c) => c.status === "ENABLED").reduce((s, c) => s + (c.dailyBudget ?? 0), 0)
  // Keep the date range when switching status.
  const q = rangeQuery(range)
  const href = (id: string) => `/campaigns${q ? `${q}&` : "?"}status=${id}`

  return (
    <Section
      title={`${rows.length} ${rows.length === 1 ? "campaign" : "campaigns"}`}
      description={`${count((s) => s === "ENABLED")} enabled (${formatUsd(enabledBudget)}/day in budgets), ${count((s) => s === "PAUSED")} paused, ${count((s) => s === "REMOVED")} removed.`}
      actions={
        <nav aria-label="Campaign status" className="flex flex-wrap gap-1.5">
          {VIEWS.map((v) => (
            <Link
              key={v.id}
              href={href(v.id)}
              aria-current={v.id === view ? "true" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
                v.id === view && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
              )}
            >
              {v.label} ({count(v.match)})
            </Link>
          ))}
        </nav>
      }
    >
      <CampaignTable rows={rows} />
    </Section>
  )
}

function CampaignTable({ rows }: { rows: CampaignListRow[] }) {
  const totals = sumMetrics(rows)
  const t = rates(totals)
  return (
    <DataTable<CampaignListRow>
      rows={rows}
      rowKey={(c) => c.id}
      empty="No campaigns with this status."
      rowClassName={(c) => (c.metrics.impressions === 0 ? "text-muted-foreground" : undefined)}
      columns={[
        { key: "name", label: "Campaign", render: (c) => <span className="font-medium">{c.name}</span> },
        { key: "status", label: "Status", render: (c) => <StatusPill status={c.status} /> },
        { key: "type", label: "Type", render: (c) => <span className="text-muted-foreground">{enumLabel(c.channel)}</span> },
        { key: "bidding", label: "Bidding", render: (c) => <span className="text-muted-foreground">{enumLabel(c.bidding)}</span> },
        { key: "budget", label: "Budget / day", align: "right", render: (c) => (c.dailyBudget === null ? "—" : formatUsd(c.dailyBudget)) },
        { key: "cost", label: "Spend", align: "right", render: (c) => formatUsd(c.metrics.cost) },
        { key: "clicks", label: "Clicks", align: "right", render: (c) => formatNumber(c.metrics.clicks) },
        { key: "ctr", label: "CTR", align: "right", render: (c) => (c.metrics.impressions ? formatPercent(rates(c.metrics).ctr) : "—") },
        { key: "cpc", label: "Avg. CPC", align: "right", render: (c) => (c.metrics.clicks ? formatUsdCents(rates(c.metrics).cpc) : "—") },
        { key: "conv", label: "Conversions", align: "right", render: (c) => formatConversions(c.metrics.conversions) },
        {
          key: "cpa",
          label: "Cost / conv.",
          align: "right",
          render: (c) => {
            if (!c.metrics.cost) return "—"
            const cpa = rates(c.metrics).costPerConversion
            return cpa === null ? <span className="text-destructive">None</span> : formatUsd(cpa)
          },
        },
      ]}
      footer={
        <tfoot>
          <tr className="border-t font-medium">
            <td className="px-4 py-2 sm:pl-5" colSpan={5}>
              Total
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{formatUsd(totals.cost)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{formatNumber(totals.clicks)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{formatPercent(t.ctr)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{formatUsdCents(t.cpc)}</td>
            <td className="px-4 py-2 text-right tabular-nums">{formatConversions(totals.conversions)}</td>
            <td className="px-4 py-2 text-right tabular-nums sm:pr-5">
              {t.costPerConversion === null ? "—" : formatUsd(t.costPerConversion)}
            </td>
          </tr>
        </tfoot>
      }
    />
  )
}
