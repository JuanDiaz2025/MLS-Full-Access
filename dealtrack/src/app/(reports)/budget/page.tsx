import type { Metadata } from "next"

import { saveBudgetSettings } from "@/app/actions/settings"
import PausePanel from "@/components/changes/pause-panel"
import { formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import PacingChart from "@/components/dashboard/pacing-chart"
import { AdminLink, DataTable, KpiGrid, PageHeader, Pill, ReportProblem, Section, StatusPill, enumLabel } from "@/components/report"
import SettingsForm from "@/components/settings-form"
import { isAdmin } from "@/lib/auth"
import { getPacing, type CampaignPace, type Pacing } from "@/lib/budget"
import { formatDay } from "@/lib/date-range"
import { getPausableCampaigns } from "@/lib/google-ads/changes"
import { load } from "@/lib/load"
import { currentName } from "@/lib/people"
import { readData, type Data } from "@/lib/store"

export const metadata: Metadata = { title: "Budget & pacing · DealTrack" }

const statusTone = { "no-budget": "gray", under: "amber", on: "green", over: "red" } as const
const statusLabel = { "no-budget": "No budget set", under: "Under pace", on: "On pace", over: "Over pace" } as const

export default async function BudgetPage() {
  const result = await load(async () => {
    const data = await readData()
    return { data, pacing: await getPacing(data.budget) }
  })

  return (
    <>
      <PageHeader
        title="Budget & pacing"
        description="This month's Google Ads spend against the monthly budget: where the month is heading, the daily spend needed to land on budget, and the alert and pause lines from the budget decision (d3). Nothing here changes Google Ads on its own; pausing is always an admin's click."
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body {...result.data} />}
    </>
  )
}

async function Body({ data, pacing: p }: { data: Data; pacing: Pacing }) {
  const admin = await isAdmin()
  const name = await currentName()
  const b = p.budget
  const atPause = !!b.pauseLine && p.spent >= b.pauseLine
  const atAlert = !!b.alertLine && p.spent >= b.alertLine
  const nothingBack = data.alerts.monthNoLeadSpend > 0 && p.spent >= data.alerts.monthNoLeadSpend && p.leads === 0
  const pausable = atPause && admin ? await load(() => getPausableCampaigns()) : null

  return (
    <>
      <KpiGrid
        items={[
          {
            label: `Spent in ${p.monthLabel.split(" ")[0]}`,
            value: formatUsd(p.spent),
            note: b.monthly ? `${formatPercent(p.spent / b.monthly, 0)} of ${formatUsd(b.monthly)}` : `Day ${p.dayOfMonth} of ${p.daysInMonth}`,
          },
          {
            label: "Expected by today",
            value: p.expectedSoFar === null ? "—" : formatUsd(p.expectedSoFar),
            note: b.monthly ? `Budget spread over ${p.daysInMonth} days` : "Set a monthly budget",
          },
          {
            label: "Month-end at recent pace",
            value: formatUsd(p.projectedByPace),
            note: `${formatUsd(p.avgDaily7)}/day over the last 7 days`,
            tone: b.monthly && p.projectedByPace > b.monthly * 1.1 ? "bad" : "default",
          },
          {
            label: "Month-end at full budgets",
            value: formatUsd(p.projectedByBudgets),
            note: `Enabled campaigns: ${formatUsd(p.runningDaily)}/day`,
          },
          {
            label: "Needed per day",
            value: p.neededDaily === null ? "—" : formatUsd(p.neededDaily),
            note: p.neededDaily === null ? "Set a monthly budget" : `For the last ${p.daysLeft} days`,
          },
          {
            label: "Leads this month",
            value: formatNumber(p.leads),
            note: p.leads ? `${formatUsd(p.spent / p.leads)} each` : "Google lead conversions",
            tone: nothingBack ? "bad" : "default",
          },
        ]}
      />

      <div className="flex flex-col gap-2">
        {nothingBack && (
          <Banner tone="red" title={`${formatUsd(p.spent)} spent this month with no leads`}>
            Juan&apos;s rule (d1): putting {formatUsd(data.alerts.monthNoLeadSpend)}+ into a month and getting nothing back isn&apos;t acceptable.
            Check tracking and search terms before spending more.
          </Banner>
        )}
        {atPause && (
          <Banner tone="red" title={`Spend reached the pause line (${formatUsd(b.pauseLine!)})`}>
            An admin decides whether to pause. Nothing pauses on its own.
          </Banner>
        )}
        {!atPause && atAlert && (
          <Banner tone="amber" title={`Spend passed the alert line (${formatUsd(b.alertLine!)})`}>
            {b.pauseLine ? `The pause line is ${formatUsd(b.pauseLine)}. ` : ""}Check that the leads are worth the spend.
          </Banner>
        )}
        {p.pauseLineDate && (
          <Banner tone="amber" title={`At the recent pace, spend reaches the pause line around ${formatDay(p.pauseLineDate)}`}>
            That&apos;s before the month ends. Lower daily budgets, or raise the pause line if the spend is planned.
          </Banner>
        )}
        {p.status === "under" && b.monthly && (
          <Banner tone="gray" title="Spending below budget">
            At the recent pace the month ends at {formatUsd(p.projectedByPace)} of {formatUsd(b.monthly)}. If the budget is meant to be spent,
            daily budgets need to total about {formatUsd(p.neededDaily ?? 0)}/day.
          </Banner>
        )}
      </div>

      <Section
        title={p.monthLabel}
        description={`Day ${p.dayOfMonth} of ${p.daysInMonth}.`}
        actions={<Pill tone={statusTone[p.status]}>{statusLabel[p.status]}</Pill>}
      >
        <PacingChart
          cumulative={p.cumulative}
          daysInMonth={p.daysInMonth}
          projected={p.projectedByPace}
          monthly={b.monthly}
          alertLine={b.alertLine}
          pauseLine={b.pauseLine}
        />
      </Section>

      {atPause && (
        <Section title="Pause at the pause line" description="Choose which running campaigns to pause. Local Services campaigns can't be paused from here.">
          {!admin ? (
            <AdminLink />
          ) : pausable && pausable.ok ? (
            <PausePanel campaigns={pausable.data.map((c) => ({ id: c.id, name: c.name, status: c.status }))} />
          ) : (
            pausable && !pausable.ok && <ReportProblem problem={pausable} />
          )}
        </Section>
      )}

      <Section title="Campaigns this month" description="Each campaign's spend so far against its daily budget, and how much of the time its ads didn't show because the budget ran out.">
        <DataTable<CampaignPace>
          rows={p.campaigns}
          rowKey={(c) => c.id}
          empty="No campaign is running or has spent this month."
          columns={[
            { key: "name", label: "Campaign", render: (c) => <span className="font-medium">{c.name}</span> },
            { key: "status", label: "Status", render: (c) => <StatusPill status={c.status} /> },
            { key: "type", label: "Type", render: (c) => <span className="text-muted-foreground">{enumLabel(c.channel)}</span> },
            { key: "budget", label: "Budget / day", align: "right", render: (c) => (c.dailyBudget === null ? "—" : formatUsd(c.dailyBudget)) },
            { key: "spent", label: "Spent", align: "right", render: (c) => formatUsd(c.spent) },
            { key: "expected", label: "Full budget so far", align: "right", render: (c) => (c.expected === null ? "—" : formatUsd(c.expected)) },
            {
              key: "pace",
              label: "Budget used",
              align: "right",
              render: (c) => (c.expected ? formatPercent(c.spent / c.expected, 0) : "—"),
            },
            {
              key: "lost",
              label: "Lost to budget",
              align: "right",
              render: (c) =>
                c.lostToBudget === null ? (
                  "—"
                ) : (
                  <span className={c.lostToBudget > 0.2 ? "font-medium text-amber-700" : undefined}>{formatPercent(c.lostToBudget, 0)}</span>
                ),
            },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          &ldquo;Lost to budget&rdquo; is the share of eligible searches where the ad didn&apos;t show because the daily budget was used up (search
          campaigns only). Above 20% with a good cost per lead means more budget would buy more leads.
        </p>
      </Section>

      <Section
        title="Budget settings"
        description={
          b.updatedAt
            ? `Set by ${b.updatedBy ?? "someone"} on ${new Date(b.updatedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}. Saved on this computer.`
            : "Not set yet. Juan's floor from decision d3: at least $1,500 a day. Kristine's budget proposal sets the monthly total and the two lines. Saved on this computer."
        }
      >
        {admin ? (
          <SettingsForm
            action={saveBudgetSettings}
            personName={name}
            fields={[
              { name: "monthly", label: "Monthly budget", prefix: "$", value: b.monthly?.toString() ?? "", placeholder: "e.g. 45600", hint: "Target Google Ads spend for a month." },
              { name: "alertLine", label: "Alert line", prefix: "$", value: b.alertLine?.toString() ?? "", placeholder: "e.g. 40000", hint: "Month-to-date spend that raises an alert." },
              { name: "pauseLine", label: "Pause line", prefix: "$", value: b.pauseLine?.toString() ?? "", placeholder: "e.g. 50000", hint: "Month-to-date spend at which admins are asked to pause." },
            ]}
          />
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Monthly budget: <span className="font-medium">{b.monthly ? formatUsd(b.monthly) : "not set"}</span> · Alert line:{" "}
              <span className="font-medium">{b.alertLine ? formatUsd(b.alertLine) : "not set"}</span> · Pause line:{" "}
              <span className="font-medium">{b.pauseLine ? formatUsd(b.pauseLine) : "not set"}</span>
            </p>
            <AdminLink />
          </div>
        )}
      </Section>
    </>
  )
}

const bannerTone = {
  red: "border-destructive/30 bg-destructive/5",
  amber: "border-amber-300 bg-amber-50 text-amber-950",
  gray: "border-border bg-muted/40",
} as const

function Banner({ tone, title, children }: { tone: keyof typeof bannerTone; title: string; children: React.ReactNode }) {
  return (
    <div role={tone === "red" ? "alert" : "status"} className={`rounded-2xl border p-4 text-sm ${bannerTone[tone]}`}>
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 text-muted-foreground">{children}</p>
    </div>
  )
}
