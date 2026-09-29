import type { Metadata } from "next"

import { formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { DataTable, KpiGrid, PageHeader, ReportProblem, Section } from "@/components/report"
import { formatDay, today } from "@/lib/date-range"
import { FIT_START, buildMonthly, fit, median, simulate, type MonthRow, type Scenario } from "@/lib/forecast"
import { getMonthlySpend } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"
import { getLeadData } from "@/lib/sheets"

export const metadata: Metadata = { title: "Forecast · DealTrack" }

const BUDGETS = [5_000, 10_000, 15_000, 20_000, 30_000]
const MONTH_CHOICES = [3, 6, 12]
const DEFAULT_FEE = Number(process.env.FORECAST_MONTHLY_FEE ?? 2000) || 0

type Params = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function ForecastPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const months = MONTH_CHOICES.includes(Number(first(params.months))) ? Number(first(params.months)) : 3
  const feeParam = Number(first(params.fee))
  const fee = first(params.fee) !== undefined && Number.isFinite(feeParam) && feeParam >= 0 ? Math.min(feeParam, 50_000) : DEFAULT_FEE

  const result = await load(async () => {
    const [sheet, spend] = await Promise.all([getLeadData(), getMonthlySpend("2023-01-01", today())])
    return { ...sheet, monthly: buildMonthly(spend, sheet.leads, sheet.deals) }
  })

  return (
    <>
      <PageHeader
        title="Forecast"
        description="What a monthly Google Ads budget is likely to bring in: leads, deals, and net revenue, with honest ranges. Built from the account's spend and the PPC LEAD sheet's lead stages and acquired deals."
      />
      {!result.ok ? (
        <ReportProblem problem={result} />
      ) : (
        <Body {...result.data} months={months} fee={fee} />
      )}
    </>
  )
}

function Body({
  leads,
  deals,
  monthly,
  months,
  fee,
}: {
  leads: { date: string }[]
  deals: Parameters<typeof fit>[1]
  monthly: MonthRow[]
  months: number
  fee: number
}) {
  const model = fit(monthly, deals)
  const lastLead = leads.map((l) => l.date).sort().at(-1)!
  if (!model) {
    return (
      <p className="rounded-2xl border bg-card p-5 text-sm">
        Not enough history to forecast yet: it needs at least 4 months since {FIT_START} with $1,000+ spend and leads in the
        sheet, and at least one acquired deal with a net revenue.
      </p>
    )
  }
  const scenarios = simulate(model, BUDGETS, { months, monthlyFee: fee })
  const medianProfit = median(model.profits)!
  const tenPercent = 1.1 ** model.elasticity - 1
  const history = monthly.filter((m) => m.month >= "2024-05" && (m.cost > 0 || m.leads > 0)).reverse()

  return (
    <>
      <KpiGrid
        items={[
          { label: "Cost per lead", value: formatUsd(model.costPerLead), note: `Since ${FIT_START.slice(0, 4)}` },
          { label: "Leads that become deals", value: formatPercent(model.dealRate), note: `${model.deals} of ${formatNumber(model.leads)} leads` },
          { label: "Booked appointment or better", value: formatPercent(model.qualifiedRate), note: "Share of PPC leads" },
          { label: "Median deal profit", value: formatUsd(medianProfit), note: `${model.profits.length} acquired deals` },
          { label: "+10% budget", value: `+${formatPercent(tenPercent, 0)} leads`, note: "Diminishing returns" },
          { label: "Model fit", value: formatPercent(model.r2, 0), note: `${model.months} months; sheet through ${formatDay(lastLead)}` },
        ]}
      />

      <Section
        title={`Next ${months} months by monthly budget`}
        description={`Each row is ${formatNumber(5000)} simulated ${months}-month periods. "Likely" is the middle result; the range covers 8 in 10 outcomes. Cost includes a ${formatUsd(fee)}/month agency fee.`}
        actions={
          <form className="flex flex-wrap items-end gap-2 text-sm" method="get">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Months</span>
              <select name="months" defaultValue={months} className="h-8 rounded-md border bg-background px-2">
                {MONTH_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Agency fee / month</span>
              <input name="fee" type="number" min={0} step={100} defaultValue={fee} className="h-8 w-28 rounded-md border bg-background px-2" />
            </label>
            <button type="submit" className="h-8 rounded-md bg-primary px-3 font-medium text-primary-foreground">
              Update
            </button>
          </form>
        }
      >
        <DataTable<Scenario>
          rows={scenarios}
          rowKey={(s) => String(s.budget)}
          columns={[
            { key: "budget", label: "Ad budget / month", render: (s) => <span className="font-medium">{formatUsd(s.budget)}</span> },
            { key: "cost", label: `Total cost (${months} mo)`, align: "right", render: (s) => formatUsd(s.totalCost) },
            { key: "leads", label: "Leads", align: "right", render: (s) => `${formatNumber(s.leads[1])} (${formatNumber(s.leads[0])}–${formatNumber(s.leads[2])})` },
            { key: "deals", label: "Deals", align: "right", render: (s) => `${s.deals[1]} (${s.deals[0]}–${s.deals[2]})` },
            { key: "rev", label: "Net revenue, likely", align: "right", render: (s) => formatUsd(s.netRevenue[1]) },
            {
              key: "none",
              label: "Chance of 0 deals",
              align: "right",
              render: (s) => <span className={s.chanceNoDeals > 0.3 ? "text-destructive" : undefined}>{formatPercent(s.chanceNoDeals, 0)}</span>,
            },
            {
              key: "profit",
              label: "Chance revenue beats cost",
              align: "right",
              render: (s) => <span className={s.chanceProfit >= 0.6 ? "text-emerald-600" : undefined}>{formatPercent(s.chanceProfit, 0)}</span>,
            },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          Deals are rare and profits vary a lot (some deals lost money), so a single quarter can come up empty even at a good
          budget. Judge a budget over 6+ months. Deals are counted in the month the lead came in; closing takes 1–3 months more.
        </p>
      </Section>

      <Section title="Month by month" description="Spend from Google Ads; leads, appointments, and deals from the PPC LEAD sheet. Months the sheet doesn't fully cover are marked.">
        <DataTable<MonthRow>
          rows={history}
          rowKey={(m) => m.month}
          columns={[
            {
              key: "month",
              label: "Month",
              render: (m) => (
                <span className={m.hasLeadData ? "font-medium" : "text-muted-foreground"}>
                  {new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}
                  {!m.hasLeadData && " (partial)"}
                </span>
              ),
            },
            { key: "cost", label: "Spend", align: "right", render: (m) => formatUsd(m.cost) },
            { key: "leads", label: "Leads", align: "right", render: (m) => formatNumber(m.leads) },
            { key: "cpl", label: "Cost per lead", align: "right", render: (m) => (m.leads ? formatUsd(m.cost / m.leads) : "—") },
            { key: "qual", label: "Appointment+", align: "right", render: (m) => formatNumber(m.qualified) },
            { key: "deals", label: "Deals", align: "right", render: (m) => formatNumber(m.deals) },
            {
              key: "rev",
              label: "Net revenue",
              align: "right",
              render: (m) => (m.deals ? <span className={m.netRevenue < 0 ? "text-destructive" : undefined}>{formatUsd(m.netRevenue)}</span> : "—"),
            },
          ]}
        />
      </Section>
    </>
  )
}
