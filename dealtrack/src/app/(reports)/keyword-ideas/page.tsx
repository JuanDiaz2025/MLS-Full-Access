import type { Metadata } from "next"

import type { IdeaBatchView } from "@/components/keyword-ideas/idea-batch"
import KeywordIdeas from "@/components/keyword-ideas/workspace"
import { AdminLink, PageHeader, ReportProblem } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { today } from "@/lib/date-range"
import { getEditableCampaigns } from "@/lib/google-ads/changes"
import { dryRun } from "@/lib/google-ads/client"
import { adGroupsWithKeywords, ideaStage } from "@/lib/keyword-ideas"
import { load } from "@/lib/load"
import { currentName } from "@/lib/people"
import { readData, type KeywordBatch } from "@/lib/store"

export const metadata: Metadata = { title: "Keyword ideas · DealTrack" }

const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : undefined
const shortDay = (iso: string, year: boolean) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: year ? "numeric" : undefined, timeZone: "UTC" })
function periodLabel(from: string, to: string) {
  const year = from.slice(0, 4) !== to.slice(0, 4) || to.slice(0, 4) !== today().slice(0, 4)
  return `${shortDay(from, year)} – ${shortDay(to, year)}`
}

function view(b: KeywordBatch): IdeaBatchView {
  return {
    ...b,
    stage: ideaStage(b),
    periodLabel: periodLabel(b.from, b.to),
    times: { drafted: when(b.drafted.at), proven: when(b.proven?.at), approved: when(b.approved?.at), pushed: when(b.pushed?.at) },
  }
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function KeywordIdeasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const [data, campaigns, groups, personName, admin] = await Promise.all([
    load(() => readData()),
    load(() => getEditableCampaigns()),
    load(() => adGroupsWithKeywords()),
    currentName(),
    isAdmin(),
  ])

  const running = new Set(campaigns.ok ? campaigns.data.filter((c) => c.status === "ENABLED").map((c) => c.id) : [])
  return (
    <>
      <PageHeader
        title="Keyword ideas"
        description="The opposite of negatives: searches and phrases worth bidding on, from your own search terms. Review, approve, and an admin adds them to Google Ads, paused by default."
      />
      {!data.ok ? (
        <ReportProblem problem={data} />
      ) : (
        <>
          {!campaigns.ok && <ReportProblem problem={campaigns} />}
          {!groups.ok && <ReportProblem problem={groups} />}
          <KeywordIdeas
            batches={data.data.keywordBatches.map(view)}
            campaigns={campaigns.ok ? campaigns.data.map((c) => ({ id: c.id, name: c.name, status: c.status })) : []}
            adGroups={
              groups.ok
                ? groups.data.map((g) => ({ id: g.id, name: g.name, campaignId: g.campaignId, campaignName: g.campaignName, running: running.has(g.campaignId) }))
                : []
            }
            admin={admin}
            adminLink={<AdminLink />}
            dryRun={dryRun()}
            personName={personName}
            today={today()}
            initial={{ tab: first(params.tab) ?? null, batchId: first(params.batch) ?? null }}
          />
        </>
      )}
    </>
  )
}
