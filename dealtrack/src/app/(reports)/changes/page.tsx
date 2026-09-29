import type { Metadata } from "next"
import { connection } from "next/server"

import { DataTable, Pill, ReportProblem, Section, enumLabel } from "@/components/report"
import { addDays, formatDay, today } from "@/lib/date-range"
import { getChangeHistory, type ChangeEvent } from "@/lib/google-ads/changes"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Changes · DealTrack" }

const clientLabels: Record<string, string> = {
  GOOGLE_ADS_API: "DealTrack / API",
  GOOGLE_ADS_WEB_CLIENT: "Google Ads website",
  GOOGLE_ADS_EDITOR: "Google Ads Editor",
  GOOGLE_ADS_SCRIPTS: "Script",
  GOOGLE_ADS_AUTOMATED_RULE: "Automated rule",
  GOOGLE_ADS_RECOMMENDATIONS: "Google recommendation",
  INTERNAL_TOOL: "Google",
  OTHER: "Other",
}

export default async function ChangesPage() {
  // Always fetch fresh; this page has no URL parameters that would tell Next.js it's dynamic.
  await connection()
  // Google keeps change history for 30 days.
  const to = today()
  const from = addDays(to, -29)
  const result = await load(() => getChangeHistory(from, to))

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Changes</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every change made to the Google Ads account, from Google&apos;s own change history: by DealTrack, on the Google
          Ads website, in Google Ads Editor, or by scripts and agencies.
        </p>
        <p className="text-xs text-muted-foreground">
          Last 30 days: <span className="font-medium text-foreground">{formatDay(from)} – {formatDay(to)}</span>. Google
          doesn&apos;t keep older history here.
        </p>
      </div>
      {!result.ok ? (
        <ReportProblem problem={result} />
      ) : (
        <Section title={`${result.data.length} changes`} description={result.data.length === 500 ? "Showing the latest 500." : undefined}>
          <DataTable<ChangeEvent>
            rows={result.data}
            rowKey={(e) => `${e.at}|${e.resourceType}|${e.detail}|${e.campaign}`}
            empty="No changes in the last 30 days."
            columns={[
              {
                key: "at",
                label: "When (Pacific)",
                render: (e) => <span className="whitespace-nowrap tabular-nums">{e.at.slice(0, 16)}</span>,
              },
              {
                key: "who",
                label: "Who",
                render: (e) => (
                  <div className="flex flex-col gap-1">
                    <span>{e.user || "—"}</span>
                    <span>
                      <Pill tone={e.client === "GOOGLE_ADS_API" ? "violet" : "gray"}>{clientLabels[e.client] ?? enumLabel(e.client)}</Pill>
                    </span>
                  </div>
                ),
              },
              {
                key: "what",
                label: "What",
                render: (e) => (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {enumLabel(e.operation)} · {enumLabel(e.resourceType)}
                    </span>
                    {e.detail && <span className="text-xs text-muted-foreground">{e.detail}</span>}
                  </div>
                ),
              },
              { key: "campaign", label: "Campaign", render: (e) => <span className="text-muted-foreground">{e.campaign || "—"}</span> },
            ]}
          />
        </Section>
      )}
    </>
  )
}
