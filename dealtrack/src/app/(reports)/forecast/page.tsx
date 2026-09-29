import type { Metadata } from "next"

import { formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { DataTable, KpiGrid, PageHeader, ReportProblem, Section } from "@/components/report"
import { formatDay, today } from "@/lib/date-range"
import {
  FIT_START,
  buildMonthly,
  fit,
  fitAds,
  median,
  simulate,
  simulateAds,
  type AdsMonth,
  type AdsScenario,
  type Scenario,
} from "@/lib/forecast"
import type { Deal, Lead } from "@/lib/leads"
import { getMonthlyAds } from "@/lib/google-ads/reports"
import { load, type Loaded } from "@/lib/load"
import { getLeadData } from "@/lib/sheets"

export const metadata: Metadata = { title: "Forecast · DealTrack" }

const BUDGETS = [5_000, 10_000, 15_000, 20_000, 30_000, 45_000]
const MONTH_CHOICES = [3, 6, 12]

type Params = Record<string, string | string[] | undefined>
type Sheet = { leads: Lead[]; deals: Deal[] }
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
const range = ([lo, mid, hi]: [number, number, number], f: (n: number) => string) => `${f(mid)} (${f(lo)}–${f(hi)})`

export default async function ForecastPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams
  const months = MONTH_CHOICES.includes(Number(first(params.months))) ? Number(first(params.months)) : 3

  // Google Ads alone drives the forecast; the lead sheet adds deals and profit when it's connected.
  const [ads, sheet] = await Promise.all([load(() => getMonthlyAds("2023-01-01", today())), load(() => getLeadData())])

  return (
    <>
      <PageHeader
        title="Forecast"
        description="What a monthly Google Ads budget is likely to bring in, with honest ranges. Leads come from the account's own history; deals and profit are added from the PPC LEAD sheet when it's connected. Costs are Google Ads spend only."
      />
      {!ads.ok ? <ReportProblem problem={ads} /> : <Body ads={ads.data} sheet={sheet} months={months} />}
    </>
  )
}

function Body({ ads, sheet, months }: { ads: AdsMonth[]; sheet: Loaded<Sheet>; months: number }) {
  const model = fitAds(ads)
  if (!model) {
    return (
      <p className="rounded-2xl border bg-card p-5 text-sm">
        Not enough history to forecast yet: it needs at least 4 months since {FIT_START} with $1,000+ spend and leads.
      </p>
    )
  }
  const scenarios = simulateAds(model, BUDGETS, { months })
  const tenPercent = 1.1 ** model.leads.elasticity - 1
  const spend = new Map(ads.map((m) => [m.month, m.cost]))
  const deals = sheet.ok ? buildMonthly(spend, sheet.data.leads, sheet.data.deals) : null
  const dealsByMonth = new Map(deals?.map((d) => [d.month, d]) ?? [])
  const history = ads.filter((m) => m.month >= "2024-01" && (m.cost > 0 || m.leads > 0)).reverse()

  return (
    <>
      <KpiGrid
        items={[
          { label: "Cost per lead", value: formatUsd(model.costPerLead), note: `Google Ads, since ${FIT_START.slice(0, 4)}` },
          {
            label: "+10% budget",
            value: `+${formatPercent(tenPercent, 0)} leads`,
            note: model.leads.elasticity >= 0.999 ? "At most one-for-one" : "Diminishing returns",
          },
          {
            label: "How well spend explains leads",
            value: formatPercent(Math.max(0, model.leads.r2), 0),
            note: `${model.months} months of history`,
            tone: model.leads.r2 < 0.4 ? "bad" : "default",
          },
        ]}
      />

      <Section
        title={`Next ${months} months by monthly budget`}
        description={`From Google Ads alone. Each row is ${formatNumber(5000)} simulated ${months}-month periods; the middle result is shown with the range that covers 8 in 10 outcomes. Leads are Google's lead conversions (forms and calls); page views and other soft actions don't count. More budget is assumed to bring leads at the same cost or worse, never cheaper.`}
        actions={<MonthsForm months={months} />}
      >
        <DataTable<AdsScenario>
          rows={scenarios}
          rowKey={(s) => String(s.budget)}
          columns={[
            { key: "budget", label: "Budget / month", render: (s) => <span className="font-medium">{formatUsd(s.budget)}</span> },
            { key: "daily", label: "Per day", align: "right", render: (s) => formatUsd(s.budget / 30.4) },
            { key: "cost", label: `Ad spend (${months} mo)`, align: "right", render: (s) => formatUsd(s.totalCost) },
            { key: "leads", label: "Leads", align: "right", render: (s) => range(s.leads, formatNumber) },
            // The cheapest outcome goes with the most leads, so the range reads high to low.
            { key: "cpl", label: "Cost per lead", align: "right", render: (s) => range(s.costPerLead, formatUsd) },
          ]}
        />
        {model.leads.r2 < 0.4 && (
          <p className="text-xs text-muted-foreground">
            Spend explains only part of the swings in leads: some months got far fewer leads per dollar than others (tracking
            and campaign changes). Treat the ranges as the honest answer, not the middle number.
          </p>
        )}
      </Section>

      <DealsSection sheet={sheet} spend={spend} months={months} />

      <Section
        title="Month by month"
        description={
          deals
            ? "Spend, clicks, and Google leads from Google Ads; sheet leads, appointments, and deals from the PPC LEAD sheet."
            : "Spend, clicks, and leads from Google Ads."
        }
      >
        <DataTable<AdsMonth>
          rows={history}
          rowKey={(m) => m.month}
          columns={[
            { key: "month", label: "Month", render: (m) => <span className="font-medium">{monthLabel(m.month)}</span> },
            { key: "cost", label: "Spend", align: "right", render: (m) => formatUsd(m.cost) },
            { key: "clicks", label: "Clicks", align: "right", render: (m) => formatNumber(m.clicks) },
            { key: "leads", label: "Google leads", align: "right", render: (m) => formatNumber(m.leads) },
            { key: "cpl", label: "Cost per lead", align: "right", render: (m) => (m.leads ? formatUsd(m.cost / m.leads) : "—") },
            ...(deals
              ? [
                  {
                    key: "sheet",
                    label: "Sheet leads",
                    align: "right" as const,
                    render: (m: AdsMonth) => {
                      const d = dealsByMonth.get(m.month)
                      return d?.hasLeadData ? formatNumber(d.leads) : "—"
                    },
                  },
                  { key: "qual", label: "Appointment+", align: "right" as const, render: (m: AdsMonth) => formatNumber(dealsByMonth.get(m.month)?.qualified ?? 0) },
                  { key: "deals", label: "Deals", align: "right" as const, render: (m: AdsMonth) => formatNumber(dealsByMonth.get(m.month)?.deals ?? 0) },
                  {
                    key: "rev",
                    label: "Net revenue",
                    align: "right" as const,
                    render: (m: AdsMonth) => {
                      const d = dealsByMonth.get(m.month)
                      return d?.deals ? <span className={d.netRevenue < 0 ? "text-destructive" : undefined}>{formatUsd(d.netRevenue)}</span> : "—"
                    },
                  },
                ]
              : []),
          ]}
        />
      </Section>
    </>
  )
}

function MonthsForm({ months }: { months: number }) {
  return (
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
      <button type="submit" className="h-8 rounded-md bg-primary px-3 font-medium text-primary-foreground">
        Update
      </button>
    </form>
  )
}

// Deals and profit need to know which leads closed, which only the PPC LEAD sheet has.
function DealsSection({ sheet, spend, months }: { sheet: Loaded<Sheet>; spend: Map<string, number>; months: number }) {
  if (!sheet.ok) {
    return (
      <Section
        title="Deals and profit"
        description="Google Ads doesn't know which leads became deals. Connect the PPC LEAD sheet to forecast deals, net revenue, and ad spend per deal too."
      >
        <p className="text-sm text-muted-foreground">
          {sheet.kind === "missing" ? `Add ${sheet.keys.join(", ")} to the settings (see README).` : sheet.message}
        </p>
      </Section>
    )
  }
  const monthly = buildMonthly(spend, sheet.data.leads, sheet.data.deals)
  const model = fit(monthly, sheet.data.deals)
  if (!model) {
    return (
      <Section title="Deals and profit">
        <p className="text-sm text-muted-foreground">
          The sheet doesn&apos;t have enough history yet: it needs 4+ months since {FIT_START} with leads, and at least one acquired
          deal with a net revenue.
        </p>
      </Section>
    )
  }
  const scenarios = simulate(model, BUDGETS, { months })
  const lastLead = sheet.data.leads.map((l) => l.date).sort().at(-1)!
  return (
    <Section
      title={`Deals and profit, next ${months} months`}
      description={`From the PPC LEAD sheet (through ${formatDay(lastLead)}): ${formatPercent(model.dealRate)} of sheet leads became deals (${model.deals} of ${formatNumber(model.leads)}), median deal profit ${formatUsd(median(model.profits)!)}, ${formatPercent(model.qualifiedRate)} booked an appointment or better.`}
    >
      <DataTable<Scenario>
        rows={scenarios}
        rowKey={(s) => String(s.budget)}
        columns={[
          { key: "budget", label: "Budget / month", render: (s) => <span className="font-medium">{formatUsd(s.budget)}</span> },
          { key: "deals", label: "Deals", align: "right", render: (s) => `${s.deals[1]} (${s.deals[0]}–${s.deals[2]})` },
          { key: "rev", label: "Net revenue, likely", align: "right", render: (s) => formatUsd(s.netRevenue[1]) },
          { key: "cpd", label: "Ad spend per deal", align: "right", render: (s) => (s.deals[1] ? formatUsd(s.totalCost / s.deals[1]) : "—") },
          {
            key: "none",
            label: "Chance of 0 deals",
            align: "right",
            render: (s) => <span className={s.chanceNoDeals > 0.3 ? "text-destructive" : undefined}>{formatPercent(s.chanceNoDeals, 0)}</span>,
          },
          {
            key: "profit",
            label: "Chance revenue beats ad spend",
            align: "right",
            render: (s) => <span className={s.chanceProfit >= 0.6 ? "text-emerald-600" : undefined}>{formatPercent(s.chanceProfit, 0)}</span>,
          },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        Deals are rare and profits vary a lot (some deals lost money), so a single quarter can come up empty even at a good budget.
        Judge a budget over 6+ months. Deals are counted in the month the lead came in; closing takes 1–3 months more.
      </p>
    </Section>
  )
}
