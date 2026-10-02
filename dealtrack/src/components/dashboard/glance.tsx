// The "at a glance" pieces shared by the Overview and a single campaign's page: the to-do list
// built from the period's numbers, the A–F grade, the one-line summary, and the glossary.

import Link from "next/link"
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, CircleCheck } from "lucide-react"

import { formatConversions, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { Section } from "@/components/report"
import { formatDay, type DateRange } from "@/lib/date-range"
import type { CampaignRow } from "@/lib/google-ads/reports"
import type { AlertRecord, GradeSettings } from "@/lib/store"
import { cn } from "@/lib/utils"

// ---- At a glance ----------------------------------------------------------------------------

export type Todo = { key: string; severity: "critical" | "high" | "medium" | "low"; title: string; detail: string; href: string; cost: number }

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const

// Everything worth doing, worst first: broken tracking, open alerts, money spent on searches,
// places, and campaigns that brought nothing back, missed calls, and changes waiting for approval.
export function doToday(input: {
  q: string
  grade: GradeSettings
  totalsCost: number
  leads: number
  attention: {
    wastedTermCost: number
    wastedTerms: number
    suggested: number
    outsideCost: number
    outsideTop: string[]
    deadCampaigns: CampaignRow[]
  }
  alerts: AlertRecord[]
  missedCalls: number
  waitingRequests: number
}): Todo[] {
  const { q, totalsCost, leads, attention: a } = input
  const { leadCost } = input.grade
  const share = (n: number) => (totalsCost ? n / totalsCost : 0)
  const out: Todo[] = []
  // Spending less than a lead usually costs, with no lead yet, is normal; it only counts as a
  // problem past that line, and as urgent past twice it.
  if (totalsCost >= leadCost && leads === 0) {
    out.push({
      key: "no-leads",
      severity: totalsCost >= 2 * leadCost ? "critical" : "high",
      title: `${formatUsd(totalsCost)} spent and Google recorded no leads`,
      detail: "Either the ads aren't bringing sellers or conversion tracking is broken. Check tracking first.",
      href: "/conversions",
      cost: totalsCost,
    })
  }
  for (const r of input.alerts.filter((r) => r.severity !== "info")) {
    out.push({
      key: `alert:${r.key}`,
      severity: r.severity === "info" ? "low" : r.severity,
      title: r.title,
      detail: r.detail,
      href: r.href ?? "/alerts",
      cost: 0,
    })
  }
  if (a.wastedTermCost > 0) {
    out.push({
      key: "wasted-terms",
      severity: a.wastedTermCost < leadCost ? "low" : share(a.wastedTermCost) >= 0.2 ? "high" : "medium",
      title: `Block wasted searches: ${formatUsd(a.wastedTermCost)} on ${formatNumber(a.wastedTerms)} search terms with no leads`,
      detail: `${formatPercent(share(a.wastedTermCost), 0)} of spend.${a.suggested ? ` ${a.suggested} negative keyword${a.suggested === 1 ? "" : "s"} suggested.` : ""}`,
      href: `/search-terms${q}`,
      cost: a.wastedTermCost,
    })
  }
  if (a.outsideCost > 0) {
    out.push({
      key: "outside",
      severity: share(a.outsideCost) >= 0.1 ? "high" : "medium",
      title: `Stop spend outside California: ${formatUsd(a.outsideCost)} (${formatPercent(share(a.outsideCost), 0)} of spend)`,
      detail: a.outsideTop.length ? `Top: ${a.outsideTop.join(", ")}.` : "",
      href: `/locations${q}`,
      cost: a.outsideCost,
    })
  }
  // Only campaigns that spent more than a lead usually costs; below that it's too early to tell.
  const dead = a.deadCampaigns.filter((c) => c.metrics.cost >= leadCost)
  if (dead.length) {
    const cost = dead.reduce((s, c) => s + c.metrics.cost, 0)
    out.push({
      key: "dead-campaigns",
      severity: share(cost) >= 0.25 ? "high" : "medium",
      title: `${dead.length} campaign${dead.length === 1 ? "" : "s"} spent ${formatUsd(cost)} with no leads`,
      detail: dead
        .slice(0, 3)
        .map((c) => c.name)
        .join(", "),
      href: `/campaigns${q}`,
      cost,
    })
  }
  if (input.missedCalls) {
    out.push({
      key: "missed-calls",
      severity: input.missedCalls >= 3 ? "high" : "medium",
      title: `Call back ${input.missedCalls} missed call${input.missedCalls === 1 ? "" : "s"} from the ads`,
      detail: "Each one may be a seller who didn't get through.",
      href: "/leads#calls",
      cost: 0,
    })
  }
  if (input.waitingRequests) {
    out.push({
      key: "compliance",
      severity: "low",
      title: `${input.waitingRequests} change${input.waitingRequests === 1 ? "" : "s"} waiting for a check or approval`,
      detail: "Turning ads on or off, or changes held while Google is learning.",
      href: "/compliance",
      cost: 0,
    })
  }
  // The same problem can come in as an alert and from this period's numbers; keep one.
  const seen = new Set<string>()
  return out
    .filter((t) => {
      const k = t.title.toLowerCase().slice(0, 40)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || y.cost - x.cost)
}

// A grade for the account, like One Marketing Command Center's: every problem costs points,
// more for worse ones.
const STRICTNESS = { relaxed: 0.5, normal: 1, strict: 1.5 } as const

export function gradeOf(todos: Todo[], settings: GradeSettings) {
  const cost = { critical: 25, high: 15, medium: 5, low: 0 } as const
  const off = todos.reduce((s, t) => s + cost[t.severity], 0) * STRICTNESS[settings.strictness]
  const score = Math.max(0, Math.round(100 - off))
  const letter = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F"
  const words = { A: "Healthy", B: "Mostly fine", C: "Needs work", D: "Losing money", F: "Urgent fixes needed" }[letter]
  const tone = letter === "A" || letter === "B" ? "good" : letter === "C" ? "warn" : "bad"
  return { score, letter, words, tone }
}

type Totals = { cost: number; leads: number; clicks: number }
const change = (now: number, before: number) => (before ? (now - before) / before : null)

export function AtAGlance({
  grade,
  totals,
  before,
  range,
  leadCost,
  title = "Your ads at a glance",
}: {
  grade: ReturnType<typeof gradeOf>
  totals: Totals
  before: Totals
  range: DateRange
  leadCost: number
  title?: string
}) {
  const period = range.preset ? range.label.toLowerCase().replace(/^last/, "in the last") : `from ${formatDay(range.from)} to ${formatDay(range.to)}`
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  const cpl = totals.leads ? totals.cost / totals.leads : null
  const beforeCpl = before.leads ? before.cost / before.leads : null
  const story = !totals.cost
    ? `Your ads didn't spend anything ${period}.`
    : totals.leads
      ? `${cap(period)} you spent ${formatUsd(totals.cost)} and got ${formatConversions(totals.leads)} lead${totals.leads === 1 ? "" : "s"} from Google Ads, at ${formatUsd(cpl!)} each.`
      : `${cap(period)} you spent ${formatUsd(totals.cost)} but Google Ads recorded no leads.${
          totals.cost < leadCost ? ` That's still under what a lead usually costs (${formatUsd(leadCost)}), so it's too early to judge.` : ""
        }`
  const leadsChange = change(totals.leads, before.leads)
  const cplChange = cpl !== null && beforeCpl ? (cpl - beforeCpl) / beforeCpl : null
  const trend =
    leadsChange === null || !totals.leads
      ? null
      : Math.abs(leadsChange) < 0.02
        ? { text: "About the same number of leads as the period before.", good: null }
        : {
            text: `${formatPercent(Math.abs(leadsChange), 0)} ${leadsChange > 0 ? "more" : "fewer"} leads than the period before${
              cplChange !== null && Math.abs(cplChange) >= 0.02
                ? `, each ${formatPercent(Math.abs(cplChange), 0)} ${cplChange < 0 ? "cheaper" : "dearer"}`
                : ""
            }.`,
            good: leadsChange > 0,
          }
  const Icon = trend?.good === null || !trend ? ArrowRight : trend.good ? ArrowUp : ArrowDown
  return (
    <section aria-label="At a glance" className="flex items-center gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <div
        className={cn(
          "flex size-20 shrink-0 flex-col items-center justify-center rounded-2xl border-2",
          grade.tone === "good" && "border-emerald-300 bg-emerald-50 text-emerald-800",
          grade.tone === "warn" && "border-amber-300 bg-amber-50 text-amber-800",
          grade.tone === "bad" && "border-red-300 bg-red-50 text-red-800",
        )}
        title={`${grade.score} out of 100`}
      >
        <span className="text-4xl leading-none font-bold">{grade.letter}</span>
        <span className="mt-1 text-[10px] font-semibold tracking-wide uppercase">Grade</span>
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          {title}:{" "}
          <span className={cn(grade.tone === "good" ? "text-emerald-700" : grade.tone === "warn" ? "text-amber-700" : "text-destructive")}>
            {grade.words}
          </span>
        </h2>
        <p className="text-sm">{story}</p>
        <a href="#grade" className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {grade.score} out of 100 · How the grade works
        </a>
        {trend && (
          <p
            className={cn(
              "flex items-center gap-1 text-sm font-medium",
              trend.good === null ? "text-muted-foreground" : trend.good ? "text-emerald-700" : "text-destructive",
            )}
          >
            <Icon className="size-4" aria-hidden /> {trend.text}
          </p>
        )}
      </div>
    </section>
  )
}

const TODO_SHOWN = 3

function TodoList({ todos, start }: { todos: Todo[]; start: number }) {
  return (
    <ol className="flex flex-col divide-y">
      {todos.map((t, i) => (
        <li key={t.key}>
          <Link href={t.href} className="group flex items-start gap-3 py-3">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white",
                t.severity === "critical" || t.severity === "high" ? "bg-red-500" : t.severity === "medium" ? "bg-amber-500" : "bg-slate-400",
              )}
            >
              {start + i + 1}
            </span>
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="font-medium">{t.title}</span>
              {t.detail && <span className="text-sm text-muted-foreground">{t.detail}</span>}
            </span>
            <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ol>
  )
}

export function DoToday({ todos }: { todos: Todo[] }) {
  const rest = todos.slice(TODO_SHOWN)
  return (
    <Section title="Do these today" description={todos.length ? "The worst first. Each one opens the page that fixes it." : undefined}>
      {todos.length ? (
        <TodoList todos={todos.slice(0, TODO_SHOWN)} start={0} />
      ) : (
        <p className="flex items-center gap-2 py-1 text-sm text-emerald-700">
          <CircleCheck className="size-4" aria-hidden /> Nothing to fix right now.
        </p>
      )}
      {rest.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-sm font-medium text-primary hover:underline">
            <span className="group-open:hidden">Show {rest.length} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <TodoList todos={rest} start={TODO_SHOWN} />
        </details>
      )}
    </Section>
  )
}

const WORDS: [string, string][] = [
  ["Spend", "What Google charged for clicks in the period."],
  [
    "Leads",
    "Form fills, calls and lead stages Google counted as conversions. Soft conversions (page views, clicks to call that didn't connect) are left out.",
  ],
  ["Cost per lead (CPL)", "Spend divided by leads: what one seller lead cost. Lower is better."],
  ["Clicks", "People who clicked an ad. Google already takes out the clicks it decides are invalid."],
  ["Click-through rate (CTR)", "Clicks divided by impressions: how often people who saw an ad clicked it."],
  ["Impressions", "How many times the ads were shown."],
  [
    "Search impression share",
    "Of all the times the ads could have shown, how often they did. Lost to budget means the money ran out; lost to rank means bids or ad quality were too low.",
  ],
  ["Conversion", "Something Google counts as a result: a form sent, a call, or a lead stage sent back from the CRM."],
  ["Negative keyword", 'A word or phrase that stops ads showing for searches that contain it, e.g. "rent" or "jobs".'],
  ["Search term", "What someone actually typed into Google before seeing the ad."],
  ["Quality Score", "Google's 1–10 rating of a keyword's ad and landing page. Higher means cheaper clicks."],
  ["Learning period", "The week or two after a big change while Google's bidding adjusts. Results swing, so changes are held then."],
]

export function Glossary() {
  return (
    <details className="group rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
        What do these words mean?
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {WORDS.map(([word, meaning]) => (
          <div key={word}>
            <dt className="font-medium">{word}</dt>
            <dd className="text-muted-foreground">{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
