import type { Metadata } from "next"
import Link from "next/link"
import { ArrowRight, CircleCheck } from "lucide-react"

import { PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import type { PillTone } from "@/components/pill"
import { checkAlerts, googleAdsRules } from "@/lib/alert-rules"
import { runAudit } from "@/lib/audit"
import { isOpen } from "@/lib/compliance-rules"
import { load } from "@/lib/load"
import { readData } from "@/lib/store"

export const metadata: Metadata = { title: "Problems · DealTrack" }

// Everything wrong in one list, worst first: the open alerts (spend, budget, ads, calls, fraud,
// wasted searches...), what the go-live audit says to fix, and change requests waiting on someone.
// Each links to the page that fixes it. Like One Marketing Command Center's Problems tab.

type Level = "critical" | "high" | "medium" | "low"
type Item = { level: Level; title: string; detail: string; fix?: string; href: string; from: string }

const LEVELS: Record<Level, { tone: PillTone; label: string; rank: number }> = {
  critical: { tone: "red", label: "Critical", rank: 0 },
  high: { tone: "red", label: "High", rank: 1 },
  medium: { tone: "amber", label: "Medium", rank: 2 },
  low: { tone: "gray", label: "Low", rank: 3 },
}

// Where each audit area's problems get fixed.
const AREA_LINK: Record<string, string> = {
  "Conversion tracking": "/conversions",
  "Location targeting": "/locations",
  "Keywords and negatives": "/search-terms",
  "Ads and landing pages": "/ads",
  "Budget and alerts": "/budget",
  "Campaign setup": "/campaigns",
}

// Audit checks that an alert already reports: shown once, as the alert.
const SAME_AS_ALERT: Record<string, string> = { "conv-soft": "health:soft-conversions" }

export default async function ProblemsPage() {
  const data = await readData()
  const [alerts, audit] = await Promise.all([load(() => checkAlerts(googleAdsRules(data))), load(() => runAudit(data.budget, data.audit))])

  const items: Item[] = []
  const openKeys = new Set(alerts.ok ? alerts.data.log.filter((r) => !r.resolvedAt).map((r) => r.key) : [])
  if (alerts.ok) {
    for (const r of alerts.data.log.filter((r) => !r.resolvedAt)) {
      items.push({ level: r.severity === "info" ? "low" : r.severity, title: r.title, detail: r.detail, href: r.href ?? "/alerts", from: "Alert" })
    }
  }
  if (audit.ok) {
    for (const area of audit.data.areas.filter((a) => !a.manual)) {
      for (const c of area.checks.filter(
        (c) => (c.status === "fail" || c.status === "warn") && !(c.id in SAME_AS_ALERT && openKeys.has(SAME_AS_ALERT[c.id])),
      )) {
        items.push({
          level: c.status === "fail" ? "high" : "medium",
          title: c.problem ?? c.title,
          detail: c.detail,
          fix: c.fix,
          href: AREA_LINK[area.title] ?? "/audit",
          from: `Audit · ${area.title}`,
        })
      }
    }
  }
  const waiting = data.changeRequests.filter(isOpen)
  if (waiting.length) {
    items.push({
      level: "medium",
      title: `${waiting.length} change ${waiting.length === 1 ? "request is" : "requests are"} waiting`,
      detail: waiting.map((r) => r.campaigns.map((c) => c.name).join(", ")).join("; "),
      href: "/compliance",
      from: "Compliance",
    })
  }
  items.sort((a, b) => LEVELS[a.level].rank - LEVELS[b.level].rank)
  const counts = (["critical", "high", "medium", "low"] as const)
    .map((l) => [l, items.filter((i) => i.level === l).length] as const)
    .filter(([, n]) => n)

  return (
    <>
      <PageHeader
        title="Problems"
        description="Everything that needs fixing, in one list and worst first: the open alerts (spend, budget, ads, calls, fraud, wasted searches), what the go-live audit says to fix, and change requests waiting on someone. Each one links to the page where it gets fixed. Read fresh from Google Ads each time this page opens."
      />
      {!alerts.ok && <ReportProblem problem={alerts} />}
      {!audit.ok && <ReportProblem problem={audit} />}
      <Section
        title={items.length ? `${items.length} ${items.length === 1 ? "problem" : "problems"}` : "No problems"}
        description={
          items.length
            ? counts.map(([l, n]) => `${n} ${LEVELS[l].label.toLowerCase()}`).join(" · ")
            : "No open alerts, nothing to fix in the audit, and no requests waiting."
        }
      >
        {items.length ? (
          <ul className="flex flex-col divide-y rounded-xl border">
            {items.map((i, n) => (
              <li key={n}>
                <Link href={i.href} className="group flex items-start gap-3 p-3 hover:bg-muted/40 sm:p-4">
                  <span className="mt-0.5 w-16 shrink-0">
                    <Pill tone={LEVELS[i.level].tone}>{LEVELS[i.level].label}</Pill>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="font-medium">{i.title}</span>
                    <span className="text-sm text-muted-foreground">{i.detail}</span>
                    {i.fix && <span className="text-sm">Fix: {i.fix}</span>}
                    <span className="text-xs text-muted-foreground">{i.from}</span>
                  </span>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-emerald-700">
            <CircleCheck className="size-4" aria-hidden /> All clear.
          </p>
        )}
      </Section>
    </>
  )
}
