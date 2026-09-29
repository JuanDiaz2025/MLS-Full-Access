import type { Metadata } from "next"

import { formatConversions, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { DataTable, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { parseRange } from "@/lib/date-range"
import { getLandingPages, type LandingPageRow } from "@/lib/google-ads/reports"
import { load, type Loaded } from "@/lib/load"
import { checkPage, getPageSpeed, type PageCheck, type PageSpeed } from "@/lib/pagespeed"
import { getPageStats } from "@/lib/posthog"

export const metadata: Metadata = { title: "Landing pages · DealTrack" }

// PageSpeed runs take 10–30 seconds each, so only the pages with the most spend are tested.
const AUDITED = 8
const OTHERS_SHOWN = 25

type Audited = LandingPageRow & {
  check: PageCheck
  speed: Loaded<PageSpeed>
  visits?: { sessions: number; conversions: number }
  issues: { tone: "red" | "amber" | "gray"; text: string }[]
}

function issuesFor(check: PageCheck, speed: Loaded<PageSpeed>): Audited["issues"] {
  const out: Audited["issues"] = []
  if (!check.resolves) return [{ tone: "red", text: "Domain doesn't exist: every click lands on an error" }]
  if (check.status === null) return [{ tone: "red", text: "Page didn't respond" }]
  if (check.status >= 400) return [{ tone: "red", text: `Page is broken (HTTP ${check.status})` }]
  if (!speed.ok) out.push({ tone: "gray", text: "Speed not tested" })
  else {
    const s = speed.data
    if (s.performance !== null && s.performance < 50) out.push({ tone: "red", text: `Slow on phones (${s.performance}/100)` })
    if (s.lcpS !== null && s.lcpS > 4) out.push({ tone: "amber", text: `Main content appears after ${s.lcpS}s` })
    if (s.tbtMs !== null && s.tbtMs > 600) out.push({ tone: "amber", text: `Scripts freeze the page for ${(s.tbtMs / 1000).toFixed(1)}s` })
  }
  if (check.formFields === null) out.push({ tone: "amber", text: "No form on the page" })
  else if (check.formFields > 6) out.push({ tone: "amber", text: `${check.formFields} form fields` })
  if (!check.tapToCall) out.push({ tone: "amber", text: "No tap-to-call link" })
  if (!check.reviews) out.push({ tone: "amber", text: "No reviews or testimonials" })
  return out
}

const path = (url: string) => url.replace(/^https?:\/\/(www\.)?twinhomebuyer\.com/, "") || "/"

export default async function LandingPagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const range = parseRange(await searchParams)
  const result = await load(() => getLandingPages(range))
  // Visitor numbers are a bonus: the audit still works without PostHog.
  const stats = await load(() => getPageStats(range))

  return (
    <>
      <PageHeader
        title="Landing pages"
        description={`Where ads sent people and how those pages hold up on a phone. The ${AUDITED} pages with the most spend get a PageSpeed Insights test (mobile) and a check for the basics: a short form, tap-to-call, and reviews.`}
        range={range}
      />
      {!result.ok ? (
        <ReportProblem problem={result} />
      ) : (
        <>
          {!stats.ok && (
            <p className="text-xs text-muted-foreground">
              Visitor numbers from PostHog aren&apos;t available right now
              {stats.kind === "missing" ? ` (add ${stats.keys.join(", ")})` : `: ${stats.message}`}.
            </p>
          )}
          <Body pages={result.data} stats={stats.ok ? stats.data : undefined} />
        </>
      )}
    </>
  )
}

async function Body({ pages, stats }: { pages: LandingPageRow[]; stats?: Map<string, { sessions: number; conversions: number }> }) {
  if (!pages.length) return <p className="rounded-2xl border bg-card p-5 text-sm">No ad clicks in this date range.</p>

  const audited: Audited[] = await Promise.all(
    pages.slice(0, AUDITED).map(async (p) => {
      const check = await checkPage(p.url)
      const speed: Loaded<PageSpeed> =
        check.resolves && check.status !== null && check.status < 400
          ? await load(() => getPageSpeed(p.url))
          : { ok: false, kind: "error", message: "Not tested" }
      return { ...p, check, speed, visits: stats?.get(new URL(p.url).pathname), issues: issuesFor(check, speed) }
    }),
  )
  const speedProblem = audited.find((a) => !a.speed.ok && a.speed.kind === "missing")?.speed

  return (
    <>
      {speedProblem && !speedProblem.ok && <ReportProblem problem={speedProblem} />}
      <Section title="Most-spent landing pages" description="Speed is Google's mobile Lighthouse score (0–100; 90+ is good). Visits and submits come from PostHog.">
        <DataTable<Audited>
          rows={audited}
          rowKey={(a) => a.url}
          columns={[
            {
              key: "url",
              label: "Page",
              render: (a) => (
                <a href={a.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                  {path(a.url)}
                </a>
              ),
            },
            { key: "cost", label: "Spend", align: "right", render: (a) => formatUsd(a.metrics.cost) },
            { key: "clicks", label: "Clicks", align: "right", render: (a) => formatNumber(a.metrics.clicks) },
            { key: "conv", label: "Conversions", align: "right", render: (a) => formatConversions(a.metrics.conversions) },
            {
              key: "rate",
              label: "Visit → submit",
              align: "right",
              render: (a) => (a.visits?.sessions ? formatPercent(a.visits.conversions / a.visits.sessions) : "—"),
            },
            {
              key: "speed",
              label: "Speed",
              align: "right",
              render: (a) =>
                a.speed.ok && a.speed.data.performance !== null ? (
                  <Pill tone={a.speed.data.performance >= 90 ? "green" : a.speed.data.performance >= 50 ? "amber" : "red"}>
                    {a.speed.data.performance}
                  </Pill>
                ) : (
                  "—"
                ),
            },
            {
              key: "lcp",
              label: "Content shows",
              align: "right",
              render: (a) => (a.speed.ok && a.speed.data.lcpS !== null ? `${a.speed.data.lcpS}s` : "—"),
            },
            {
              key: "issues",
              label: "What to fix",
              className: "min-w-64",
              render: (a) =>
                a.issues.length ? (
                  <ul className="flex flex-wrap gap-1">
                    {a.issues.map((i) => (
                      <li key={i.text}>
                        <Pill tone={i.tone}>{i.text}</Pill>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Pill tone="green">Looks good</Pill>
                ),
            },
          ]}
        />
        {audited.some((a) => a.speed.ok && a.speed.data.slowestThirdParties.length) && (
          <p className="text-xs text-muted-foreground">
            Slowest outside scripts:{" "}
            {[...new Set(audited.flatMap((a) => (a.speed.ok ? a.speed.data.slowestThirdParties : [])))].slice(0, 6).join(", ")}.
            Removing or delaying these is usually the quickest speed win.
          </p>
        )}
      </Section>

      {pages.length > AUDITED && (
        <Section
          title="Other landing pages"
          description={`Not speed-tested. ${pages.length - AUDITED > OTHERS_SHOWN ? `The next ${OTHERS_SHOWN} of ${pages.length - AUDITED} by spend. ` : ""}Broken pages behind any ad show up on the Alerts page.`}
        >
          <DataTable<LandingPageRow>
            rows={pages.slice(AUDITED, AUDITED + OTHERS_SHOWN)}
            rowKey={(p) => p.url}
            columns={[
              { key: "url", label: "Page", render: (p) => <span className="font-medium">{path(p.url)}</span> },
              { key: "cost", label: "Spend", align: "right", render: (p) => formatUsd(p.metrics.cost) },
              { key: "clicks", label: "Clicks", align: "right", render: (p) => formatNumber(p.metrics.clicks) },
              { key: "conv", label: "Conversions", align: "right", render: (p) => formatConversions(p.metrics.conversions) },
              {
                key: "campaigns",
                label: "Campaigns",
                render: (p) => (
                  <span className="text-muted-foreground" title={p.campaigns.join(", ")}>
                    {p.campaigns.slice(0, 2).join(", ")}
                    {p.campaigns.length > 2 && ` and ${p.campaigns.length - 2} more`}
                  </span>
                ),
              },
            ]}
          />
        </Section>
      )}
    </>
  )
}
