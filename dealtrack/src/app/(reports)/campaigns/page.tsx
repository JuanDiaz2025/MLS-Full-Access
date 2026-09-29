import type { Metadata } from "next"

import CampaignControls from "@/components/changes/campaign-controls"
import { formatConversions, formatNumber, formatPercent, formatUsd, formatUsdCents } from "@/components/dashboard/format"
import { AdminLink, DataTable, PageHeader, ReportProblem, Section, StatusPill, enumLabel } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { parseRange } from "@/lib/date-range"
import { getCampaignControls, maxDailyBudget } from "@/lib/google-ads/controls"
import { getCampaigns, rates, sumMetrics, type CampaignRow } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Campaigns · DealTrack" }

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const range = parseRange(await searchParams)
  const admin = await isAdmin()
  const [result, controls] = await Promise.all([
    load(() => getCampaigns(range)),
    admin ? load(getCampaignControls) : null,
  ])

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Every campaign that showed ads in this period, including paused and removed ones."
        range={range}
      />
      <Section
        title="Pause, turn on, and budgets"
        description="Running campaigns are listed. Find a paused one to turn it back on. Every change asks first and can be undone."
        actions={!admin && <AdminLink />}
      >
        {!controls ? (
          <p className="text-sm text-muted-foreground">Admins can pause campaigns, turn them on, and change daily budgets here.</p>
        ) : !controls.ok ? (
          <ReportProblem problem={controls} />
        ) : (
          <CampaignControls campaigns={controls.data} maxBudget={maxDailyBudget()} />
        )}
      </Section>
      {!result.ok ? (
        <ReportProblem problem={result} />
      ) : (
        <Section title={`${result.data.length} campaigns`}>
          <CampaignTable rows={result.data} />
        </Section>
      )}
    </>
  )
}

function CampaignTable({ rows }: { rows: CampaignRow[] }) {
  const totals = sumMetrics(rows)
  const t = rates(totals)
  return (
    <DataTable<CampaignRow>
      rows={rows}
      rowKey={(c) => c.id}
      columns={[
        { key: "name", label: "Campaign", render: (c) => <span className="font-medium">{c.name}</span> },
        { key: "status", label: "Status", render: (c) => <StatusPill status={c.status} /> },
        { key: "bidding", label: "Bidding", render: (c) => <span className="text-muted-foreground">{enumLabel(c.bidding)}</span> },
        { key: "cost", label: "Spend", align: "right", render: (c) => formatUsd(c.metrics.cost) },
        { key: "clicks", label: "Clicks", align: "right", render: (c) => formatNumber(c.metrics.clicks) },
        { key: "ctr", label: "CTR", align: "right", render: (c) => formatPercent(rates(c.metrics).ctr) },
        { key: "cpc", label: "Avg. CPC", align: "right", render: (c) => formatUsdCents(rates(c.metrics).cpc) },
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
      footer={
        <tfoot>
          <tr className="border-t font-medium">
            <td className="px-4 py-2 sm:pl-5" colSpan={3}>
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
