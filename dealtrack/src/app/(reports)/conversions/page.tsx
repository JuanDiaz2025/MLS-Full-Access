import type { Metadata } from "next"

import { formatConversions } from "@/components/dashboard/format"
import { DataTable, PageHeader, Pill, ReportProblem, Section, enumLabel } from "@/components/report"
import { parseRange } from "@/lib/date-range"
import { getConversionActions, isLeadConversion, type ConversionActionRow } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Conversions · DealTrack" }

// If a soft action counts as a primary conversion, "cost per conversion" can look much better
// than the real cost per lead.
const isSoft = (a: ConversionActionRow) => !isLeadConversion(a.name, a.category)

export default async function ConversionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const range = parseRange(await searchParams)
  const result = await load(() => getConversionActions(range))

  return (
    <>
      <PageHeader
        title="Conversions"
        description="What Google counts as a conversion. Only primary actions count toward the Conversions column and train Smart Bidding, so they should be real leads: form submissions and calls."
        range={range}
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body actions={result.data} />}
    </>
  )
}

function Body({ actions }: { actions: ConversionActionRow[] }) {
  const active = actions.filter((a) => a.status !== "REMOVED")
  const softPrimary = active.filter((a) => a.primary && isSoft(a))

  return (
    <>
      {softPrimary.length > 0 && (
        <p role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <span className="font-medium">Check your primary conversions.</span>{" "}
          {softPrimary.map((a) => a.name).join(", ")} {softPrimary.length === 1 ? "counts" : "count"} as a conversion but
          {softPrimary.length === 1 ? " isn't" : " aren't"} usually a lead. This can make cost per conversion look better than
          your real cost per lead, and teaches Google to find the wrong people.
        </p>
      )}
      <Section title={`${active.length} conversion actions`} description="Removed actions are hidden.">
        <DataTable<ConversionActionRow>
          rows={active}
          rowKey={(a) => a.id}
          empty="No conversion actions are set up. Google can't learn which clicks become leads until one is."
          columns={[
            { key: "name", label: "Action", render: (a) => <span className="font-medium">{a.name}</span> },
            {
              key: "primary",
              label: "Counts as conversion",
              render: (a) => (a.primary ? <Pill tone="green">Primary</Pill> : <Pill>Secondary</Pill>),
            },
            {
              key: "category",
              label: "Category",
              render: (a) => (
                <span className={isSoft(a) && a.primary ? "font-medium text-amber-700" : "text-muted-foreground"}>
                  {enumLabel(a.category)}
                </span>
              ),
            },
            { key: "type", label: "Source", render: (a) => <span className="text-muted-foreground">{enumLabel(a.type)}</span> },
            {
              key: "counting",
              label: "Counts",
              render: (a) => (
                <span className="text-muted-foreground">
                  {a.counting === "ONE_PER_CLICK" ? "One per click" : a.counting === "MANY_PER_CLICK" ? "Every" : enumLabel(a.counting)}
                </span>
              ),
            },
            { key: "status", label: "Status", render: (a) => <span className="text-muted-foreground">{enumLabel(a.status)}</span> },
            { key: "conv", label: "Conversions", align: "right", render: (a) => formatConversions(a.conversions) },
            { key: "all", label: "All conversions", align: "right", render: (a) => formatConversions(a.allConversions) },
          ]}
        />
      </Section>
    </>
  )
}
