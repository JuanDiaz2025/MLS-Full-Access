import type { Metadata } from "next"

import { formatConversions, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { parseRange } from "@/lib/date-range"
import { getLocations, rates, sumMetrics, type LocationRow } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Locations · DealTrack" }

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const range = parseRange(await searchParams)
  const result = await load(() => getLocations(range))

  return (
    <>
      <PageHeader
        title="Locations"
        description="Where the people who saw and clicked your ads were, by city. Anything outside the nine Bay Area counties is flagged, since that's not where you buy."
        range={range}
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body rows={result.data} />}
    </>
  )
}

function Body({ rows: allRows }: { rows: LocationRow[] }) {
  // Cities that only had impressions add noise; keep the ones with spend, clicks, or conversions.
  const rows = allRows.filter((r) => r.metrics.cost > 0 || r.metrics.clicks > 0 || r.metrics.conversions > 0)
  const hidden = allRows.length - rows.length
  const total = sumMetrics(rows)
  const inside = sumMetrics(rows.filter((r) => r.status === "inside"))
  const outside = sumMetrics(rows.filter((r) => r.status === "outside"))
  const unknown = sumMetrics(rows.filter((r) => r.status === "unknown"))
  const share = (cost: number) => formatPercent(total.cost ? cost / total.cost : 0, 0)

  return (
    <>
      <KpiGrid
        items={[
          { label: "Spend in the Bay Area", value: formatUsd(inside.cost), note: `${share(inside.cost)} of spend` },
          { label: "Conversions in the Bay Area", value: formatConversions(inside.conversions) },
          {
            label: "Spend outside the Bay Area",
            value: formatUsd(outside.cost),
            note: `${share(outside.cost)} of spend`,
            tone: outside.cost > 0 ? "bad" : "default",
          },
          { label: "Conversions outside", value: formatConversions(outside.conversions) },
          { label: "Unknown location", value: formatUsd(unknown.cost), note: "Google couldn't tell the city" },
          { label: "Cities with spend or clicks", value: formatNumber(rows.length), note: hidden ? `${hidden} with only impressions hidden` : undefined },
        ]}
      />
      <Section
        title="By city"
        description="To stop showing ads outside the Bay Area, set the campaign's location option to people in or regularly in your targeted locations, and exclude the flagged cities."
      >
        <DataTable<LocationRow>
          rows={rows}
          rowKey={(r) => r.key}
          rowClassName={(r) => (r.status === "outside" ? "bg-red-50/60" : undefined)}
          columns={[
            {
              key: "city",
              label: "City",
              render: (r) => (
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">{r.city}</span>
                  <span className="text-xs text-muted-foreground">{r.county ? `${r.county} County` : r.region}</span>
                </div>
              ),
            },
            {
              key: "area",
              label: "Service area",
              render: (r) =>
                r.status === "inside" ? (
                  <Pill tone="green">Bay Area</Pill>
                ) : r.status === "outside" ? (
                  <Pill tone="red">Outside</Pill>
                ) : (
                  <Pill>Unknown</Pill>
                ),
            },
            { key: "cost", label: "Spend", align: "right", render: (r) => formatUsd(r.metrics.cost) },
            { key: "clicks", label: "Clicks", align: "right", render: (r) => formatNumber(r.metrics.clicks) },
            { key: "conv", label: "Conversions", align: "right", render: (r) => formatConversions(r.metrics.conversions) },
            {
              key: "cpa",
              label: "Cost / conv.",
              align: "right",
              render: (r) => {
                const cpa = rates(r.metrics).costPerConversion
                return cpa === null ? <span className="text-muted-foreground">—</span> : formatUsd(cpa)
              },
            },
          ]}
        />
      </Section>
    </>
  )
}
