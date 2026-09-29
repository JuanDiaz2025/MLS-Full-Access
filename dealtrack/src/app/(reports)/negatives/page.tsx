import type { Metadata } from "next"

import { AdminLink, PageHeader, ReportProblem } from "@/components/report"
import WeeklyNegatives, { type BatchView } from "@/components/weekly-negatives"
import { isAdmin } from "@/lib/auth"
import { dayOf, formatDay, today } from "@/lib/date-range"
import { getEditableCampaigns } from "@/lib/google-ads/changes"
import { dryRun } from "@/lib/google-ads/client"
import { load } from "@/lib/load"
import { BRAKE_DAYS, LOOKBACK_DAYS, brake, checkDay, completeWeeks, stageOf } from "@/lib/negative-batches"
import { currentName } from "@/lib/people"
import { readData, type NegativeBatch } from "@/lib/store"

export const metadata: Metadata = { title: "Weekly negatives · DealTrack" }

const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : undefined
const shortDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const weekLabel = (from: string, to: string) => `${shortDay(from)} – ${shortDay(to)}`

function view(b: NegativeBatch): BatchView {
  const day = checkDay(b)
  return {
    ...b,
    stage: stageOf(b),
    weekLabel: weekLabel(b.from, b.to),
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
  const [data, campaigns] = await Promise.all([load(() => readData()), load(() => getEditableCampaigns())])

  return (
    <>
      <PageHeader
        title="Weekly negatives"
        description={`Once a week, last week's wasted searches become one batch of negative keywords: DealTrack drafts it from the rules (and words that never converted), Seth proves each line, the PPC owner approves, an admin pushes the approved lines to Google Ads in one change, and a week later the result is checked. Anything that would block a search that converted in the last ${LOOKBACK_DAYS} days, or a seller saying "sell", is held back. At most one push every ${BRAKE_DAYS} days. Saved on this computer.`}
      />
      {!data.ok ? (
        <ReportProblem problem={data} />
      ) : (
        <>
          {!campaigns.ok && <ReportProblem problem={campaigns} />}
          <Body batches={data.data.batches} campaigns={campaigns.ok ? campaigns.data : []} />
        </>
      )}
    </>
  )
}

async function Body({ batches, campaigns }: { batches: NegativeBatch[]; campaigns: { id: string; name: string; status: string }[] }) {
  const taken = new Set(batches.map((b) => b.id))
  const weeks = completeWeeks(8)
    .map((w, i) => ({ id: w.id, label: `${weekLabel(w.from, w.to)}${i === 0 ? " (last week)" : ""}` }))
    .filter((w) => !taken.has(w.id))
  const held = brake(batches)
  return (
    <WeeklyNegatives
      batches={[...batches].sort((a, b) => b.id.localeCompare(a.id)).map(view)}
      weeks={weeks}
      campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status }))}
      admin={await isAdmin()}
      adminLink={<AdminLink />}
      personName={await currentName()}
      brakeNote={
        held
          ? `A batch already went out on ${formatDay(dayOf(held.last))}. One batch a week keeps Google's learning steady; the next can go on ${formatDay(held.nextDay)}.`
          : null
      }
      dryRun={dryRun()}
    />
  )
}
