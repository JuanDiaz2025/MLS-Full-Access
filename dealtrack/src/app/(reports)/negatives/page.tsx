import type { Metadata } from "next"
import { Suspense } from "react"

import CampaignCheck from "@/components/negatives/campaign-check"
import { WorkspaceProvider } from "@/components/negatives/context"
import { TABS, type Tab } from "@/components/negatives/tabs"
import type { BatchView } from "@/components/negatives/parts"
import Workspace from "@/components/negatives/workspace"
import PageLoading from "@/components/page-loading"
import { AdminLink, PageHeader, ReportProblem } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { checkCampaigns } from "@/lib/campaign-check"
import { dayOf, formatDay, today } from "@/lib/date-range"
import { STANDARD_LIST, getEditableCampaigns } from "@/lib/google-ads/changes"
import { dryRun } from "@/lib/google-ads/client"
import { load } from "@/lib/load"
import { BRAKE_DAYS, LOOKBACK_DAYS, brake, checkDay, completeWeeks, stageOf } from "@/lib/negative-batches"
import { currentName } from "@/lib/people"
import { readData, type NegativeBatch } from "@/lib/store"

export const metadata: Metadata = { title: "Weekly negatives · DealTrack" }

const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : undefined
// The year shows only when the period isn't in this year.
const shortDay = (iso: string, year: boolean) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: year ? "numeric" : undefined, timeZone: "UTC" })
const periodLabel = (from: string, to: string) => {
  const year = from.slice(0, 4) !== today().slice(0, 4) || to.slice(0, 4) !== today().slice(0, 4)
  return `${shortDay(from, year)} – ${shortDay(to, year)}`
}

function view(b: NegativeBatch): BatchView {
  const day = checkDay(b)
  return {
    ...b,
    stage: stageOf(b),
    periodLabel: periodLabel(b.from, b.to),
    times: {
      drafted: when(b.drafted.at),
      proven: when(b.proven?.at),
      approved: when(b.approved?.at),
      pushed: when(b.pushed?.at),
      checked: when(b.checked?.at),
    },
    checkDayLabel: day ? formatDay(day) : null,
    checkReady: !!day && today() >= day,
  }
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function NegativesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const [data, campaigns, personName, admin] = await Promise.all([
    load(() => readData()),
    load(() => getEditableCampaigns()),
    currentName(),
    isAdmin(),
  ])
  const askedTab = first(params.tab)
  const tab: Tab = TABS.includes(askedTab as Tab) ? (askedTab as Tab) : "batches"

  return (
    <>
      <PageHeader
        title="Weekly negatives"
        description="Turn wasted searches into negative keywords: draft a batch, review and approve it, push it to Google Ads, and check the result a week later."
      />
      {!data.ok ? (
        <ReportProblem problem={data} />
      ) : (
        <WorkspaceProvider initial={{ name: personName, tab, batchId: first(params.batch) ?? null }}>
          {!campaigns.ok && <ReportProblem problem={campaigns} />}
          <Body batches={data.data.batches} campaigns={campaigns.ok ? campaigns.data : []} admin={admin} />
        </WorkspaceProvider>
      )}
    </>
  )
}

function Body({
  batches,
  campaigns,
  admin,
}: {
  batches: NegativeBatch[]
  campaigns: { id: string; name: string; status: string }[]
  admin: boolean
}) {
  const lastWeek = completeWeeks(1)[0]
  const held = brake(batches)
  return (
    <Workspace
      batches={[...batches].sort((a, b) => b.drafted.at.localeCompare(a.drafted.at)).map(view)}
      lastWeek={{ from: lastWeek.from, to: lastWeek.to }}
      today={today()}
      campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status }))}
      admin={admin}
      adminLink={<AdminLink />}
      listName={STANDARD_LIST}
      brakeNote={
        held
          ? `A batch already went out on ${formatDay(dayOf(held.last))}. One batch a week keeps Google's learning steady; the next can go on ${formatDay(held.nextDay)}.`
          : null
      }
      dryRun={dryRun()}
      brakeDays={BRAKE_DAYS}
      lookbackDays={LOOKBACK_DAYS}
      checkPanel={
        // The check reads a year of search terms and every campaign's negatives, so it streams in.
        <Suspense fallback={<PageLoading message="Checking each campaign's negative keywords…" />}>
          <Check />
        </Suspense>
      }
    />
  )
}

async function Check() {
  const check = await load(() => checkCampaigns())
  if (!check.ok) return <ReportProblem problem={check} />
  return <CampaignCheck check={check.data} listName={STANDARD_LIST} />
}
