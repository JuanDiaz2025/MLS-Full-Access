import type { Metadata } from "next"
import { Suspense } from "react"

import CampaignCheck from "@/components/campaign-check"
import { NameProvider } from "@/components/negatives-name"
import PageLoading from "@/components/page-loading"

import { AdminLink, PageHeader, ReportProblem } from "@/components/report"
import WeeklyNegatives, { type BatchView } from "@/components/weekly-negatives"
import { isAdmin } from "@/lib/auth"
import { dayOf, formatDay, today } from "@/lib/date-range"
import { checkCampaigns } from "@/lib/campaign-check"
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

export default async function NegativesPage() {
  const [data, campaigns, personName] = await Promise.all([load(() => readData()), load(() => getEditableCampaigns()), currentName()])

  return (
    <>
      <PageHeader
        title="Weekly negatives"
        description={`Once a week, last week's wasted searches become one batch of negative keywords (or pick any dates and one campaign, paused ones too, to try it on older campaigns): DealTrack drafts it from the rules (and words that never converted), someone reviews each line, someone approves, an admin pushes the approved lines to Google Ads in one change, and a week later the result is checked. The campaign check below shows which standard negatives each campaign is missing. Anything that would block a search that converted in the last ${LOOKBACK_DAYS} days, or a seller saying "sell", is held back. At most one push every ${BRAKE_DAYS} days. Saved on this computer.`}
      />
      {!data.ok ? (
        <ReportProblem problem={data} />
      ) : (
        <NameProvider initial={personName}>
          {!campaigns.ok && <ReportProblem problem={campaigns} />}
          <Body batches={data.data.batches} campaigns={campaigns.ok ? campaigns.data : []} />
          {/* The check reads a year of search terms and every campaign's negatives, so it streams in. */}
          <Suspense fallback={<PageLoading message="Checking each campaign's negative keywords…" />}>
            <Check />
          </Suspense>
        </NameProvider>
      )}
    </>
  )
}

async function Body({ batches, campaigns }: { batches: NegativeBatch[]; campaigns: { id: string; name: string; status: string }[] }) {
  const lastWeek = completeWeeks(1)[0]
  const held = brake(batches)
  return (
    <WeeklyNegatives
      batches={[...batches].sort((a, b) => b.drafted.at.localeCompare(a.drafted.at)).map(view)}
      lastWeek={{ from: lastWeek.from, to: lastWeek.to }}
      today={today()}
      campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status }))}
      admin={await isAdmin()}
      adminLink={<AdminLink />}
      listName={STANDARD_LIST}
      brakeNote={
        held
          ? `A batch already went out on ${formatDay(dayOf(held.last))}. One batch a week keeps Google's learning steady; the next can go on ${formatDay(held.nextDay)}.`
          : null
      }
      dryRun={dryRun()}
    />
  )
}

async function Check() {
  const check = await load(() => checkCampaigns())
  if (!check.ok) return <ReportProblem problem={check} />
  return <CampaignCheck check={check.data} listName={STANDARD_LIST} />
}
