import type { Metadata } from "next"

import CityExclusionPanel from "@/components/changes/city-exclusion-panel"
import NegativesList from "@/components/changes/negatives-list"
import { formatConversions, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { AdminLink, DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { parseRange } from "@/lib/date-range"
import {
  getCampaignNegatives,
  getEditableCampaigns,
  type CampaignNegative,
  type EditableCampaign,
} from "@/lib/google-ads/changes"
import { getLocations, rates, sumMetrics, type LocationRow } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Locations · DealTrack" }

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const range = parseRange(await searchParams)
  const admin = await isAdmin()
  const result = await load(async () => {
    const [rows, campaigns] = await Promise.all([getLocations(range), getEditableCampaigns()])
    // Old paused campaigns hold thousands of exclusions; show the ones on running campaigns.
    const running = campaigns.filter((c) => c.status === "ENABLED").map((c) => c.id)
    const negatives = await getCampaignNegatives({ campaignIds: running })
    return { rows, negatives, campaigns }
  })

  return (
    <>
      <PageHeader
        title="Locations"
        description="Where the people who saw and clicked your ads were, by city. Anything outside the buy area (anywhere outside California) is flagged, since that's not where you buy."
        range={range}
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body {...result.data} admin={admin} />}
    </>
  )
}

function Body({
  rows: allRows,
  negatives,
  campaigns,
  admin,
}: {
  rows: LocationRow[]
  negatives: CampaignNegative[]
  campaigns: EditableCampaign[]
  admin: boolean
}) {
  const exclusions = negatives.filter((n) => n.kind === "location")
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
          { label: "Spend in the buy area", value: formatUsd(inside.cost), note: `${share(inside.cost)} of spend` },
          { label: "Conversions in the buy area", value: formatConversions(inside.conversions) },
          {
            label: "Spend outside the buy area",
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
        title="Exclude cities outside the buy area"
        description="Stops ads from showing to people in these cities. Cities with spend are pre-selected; ones that converted are highlighted so you can decide."
        actions={!admin && <AdminLink />}
      >
        {admin ? (
          <CityExclusionPanel
            cities={rows
              .filter((r) => r.status === "outside" && r.key.startsWith("geoTargetConstants/"))
              .map((r) => ({ geo: r.key, city: r.city, region: r.region, cost: r.metrics.cost, conversions: r.metrics.conversions }))}
            campaigns={campaigns}
            existing={exclusions.map((n) => `${n.campaignId}|${n.geo}`)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {rows.filter((r) => r.status === "outside").length} cities outside the buy area had clicks or spend in this period.
            They&apos;re highlighted in red below.
          </p>
        )}
      </Section>

      <Section
        title={`Excluded locations on running campaigns (${exclusions.length})`}
        description="Places your enabled campaigns are set not to show ads in. Paused campaigns aren't shown."
      >
        <NegativesList
          canEdit={admin}
          noun="location exclusion"
          empty="No excluded locations yet."
          items={exclusions
            .sort((a, b) => (a.place ?? "").localeCompare(b.place ?? ""))
            .map((n) => ({ resourceName: n.resourceName, label: n.place ?? n.geo ?? "", campaignName: n.campaignName }))}
        />
      </Section>

      <Section
        title="By city"
        description="To stop showing ads outside the buy area, set the campaign's location option to people in or regularly in your targeted locations, and exclude the flagged cities."
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
                  <Pill tone="green">Buy area</Pill>
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
