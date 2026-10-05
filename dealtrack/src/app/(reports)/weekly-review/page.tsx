import type { Metadata } from "next"
import Link from "next/link"

import { formatConversions, formatNumber, formatUsd } from "@/components/dashboard/format"
import { KpiGrid, PageHeader, Pill, Section } from "@/components/report"
import Disclosure from "@/components/ui/disclosure"
import { MakeReview, NameProvider, ReviewBody, RulesForm } from "@/components/weekly-review/review"
import { assistantProvider } from "@/lib/assistant/shared"
import { isAdmin } from "@/lib/auth"
import { formatDay } from "@/lib/date-range"
import { currentName } from "@/lib/people"
import { STANDING_RULES, getReviews, reviewWeek, type PeriodNumbers } from "@/lib/weekly-review"

export const metadata: Metadata = { title: "Weekly review · DealTrack" }

// Mission 8's weekly loop in one page: last week and the last 90 days, five kinds of proposals
// with the number behind each, a check on itself, Juan's approvals, and the rules (lib/weekly-review.ts).
export default async function WeeklyReviewPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const { week: picked } = await searchParams
  const [{ rules, reviews }, admin, name] = await Promise.all([getReviews(), isAdmin(), currentName()])
  const due = reviewWeek()
  const review = reviews.find((r) => r.id === picked) ?? reviews[0]
  const hasDue = reviews.some((r) => r.id === due.id)
  const dueLabel = `${formatDay(due.from)} – ${formatDay(due.to)}`

  const cpd = review?.costPerDeal
  const cpdTone = !cpd?.value ? "default" : cpd.value > review.rules.targetHigh ? "bad" : cpd.value < review.rules.targetLow ? "good" : "default"
  const tiles = (n: PeriodNumbers, label: string) => [
    { label: `Spend · ${label}`, value: formatUsd(n.cost), note: `${formatNumber(n.clicks)} clicks` },
    { label: `Google conversions · ${label}`, value: formatConversions(n.conversions) },
    {
      label: `Leads · ${label}`,
      value: formatNumber(n.leads),
      note: `${n.qualified} qualified · ${n.closed} closed`,
      href: "/leads",
      linkLabel: "Leads",
    },
    { label: `Calls 60s+ · ${label}`, value: formatNumber(n.calls60) },
  ]

  return (
    <NameProvider initialName={name}>
      <PageHeader
        title="Weekly review"
        description="Every Monday: last week and the last 90 days, with proposals for new keywords, searches to block, keywords to pause, cities to drop or push, and the budget, each with the number that decides it and only what the rules allow. Juan approves; blocks and keywords go on to their batches for an admin to push, and the rest is applied by hand in Google Ads and ticked off here."
      />

      <Section
        title={review ? `Week of ${formatDay(review.week.from)} – ${formatDay(review.week.to)}` : "No review yet"}
        description={
          review ? (
            <>
              Made by {review.made.by}, {new Date(review.made.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.{" "}
              {review.dryRun && <Pill tone="amber">Dry run</Pill>}
            </>
          ) : (
            `DealTrack makes it on its own every Monday from 7 AM while it's running, or make it now. It reads about 15 Google Ads reports.`
          )
        }
        actions={
          !hasDue ? (
            <MakeReview label={`Make the review of ${dueLabel}`} showName={!review} />
          ) : review?.id === due.id && !review.sent ? (
            <MakeReview label="Make it again with fresh numbers" />
          ) : undefined
        }
      >
        {reviews.length > 1 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {reviews.map((r) => (
              <Link
                key={r.id}
                href={`/weekly-review?week=${r.id}`}
                className={
                  r.id === review?.id ? "rounded-lg bg-primary px-2 py-1 text-primary-foreground" : "rounded-lg border px-2 py-1 hover:bg-muted"
                }
              >
                {formatDay(r.week.from)}
              </Link>
            ))}
          </div>
        )}
      </Section>

      {review && (
        <>
          <KpiGrid
            items={[
              ...tiles(review.week, "last week"),
              {
                label: "Ad spend per closed deal",
                value: cpd?.value ? formatUsd(cpd.value) : "—",
                tone: cpdTone,
                note: `Target ${formatUsd(review.rules.targetLow)}–${formatUsd(review.rules.targetHigh)}${cpd ? ` · ${cpd.deals} deals in 12 months` : ""}`,
                href: "/deals",
                linkLabel: "Deal History",
              },
              {
                label: "Monthly budget",
                value: review.monthlyBudget ? formatUsd(review.monthlyBudget) : "Not set",
                href: "/budget",
                linkLabel: "Budget",
              },
            ]}
          />
          <KpiGrid items={tiles(review.long, "90 days")} />
          {cpd && (
            <p className="-mt-2 text-xs text-muted-foreground">
              Ad spend per deal: {formatUsd(cpd.spend)} spent from {formatDay(cpd.from)} to {formatDay(cpd.to)}, {cpd.deals} deal
              {cpd.deals === 1 ? "" : "s"}. Deals: {cpd.source}.
            </p>
          )}
          <ReviewBody review={review} dryRun={rules.dryRun} canAsk={!!assistantProvider()} />
        </>
      )}

      <Disclosure className="group rounded-2xl border bg-card shadow-xs" initialOpen={false}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:px-5">
          <span className="flex flex-col">
            <span className="font-semibold">Rules</span>
            <span className="text-sm text-muted-foreground">What each proposal has to meet (Mission 7). Changes apply to the next review made.</span>
          </span>
          <span className="text-sm text-primary group-open:hidden">Open</span>
        </summary>
        <div className="flex flex-col gap-4 border-t p-4 sm:px-5">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {STANDING_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
            <li>Searches to block come from last week; everything else is judged on the last 90 days.</li>
          </ul>
          <RulesForm rules={rules} admin={admin} initialName={name} />
          {rules.updatedBy && (
            <p className="text-xs text-muted-foreground">
              Last changed by {rules.updatedBy}
              {rules.updatedAt ? `, ${new Date(rules.updatedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}` : ""}.
            </p>
          )}
        </div>
      </Disclosure>
    </NameProvider>
  )
}
