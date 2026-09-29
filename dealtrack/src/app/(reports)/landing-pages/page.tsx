import type { Metadata } from "next"

import { formatConversions, formatNumber, formatPercent, formatUsd } from "@/components/dashboard/format"
import { DataTable, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { parseRange } from "@/lib/date-range"
import { emptyMetrics, getAdDestinations, getLandingPages, type AdDestination, type LandingPageRow } from "@/lib/google-ads/reports"
import { load, type Loaded } from "@/lib/load"
import { checkPage, getPageSpeed, type PageCheck, type PageSpeed } from "@/lib/pagespeed"
import { getPageStats } from "@/lib/posthog"

export const metadata: Metadata = { title: "Landing pages · DealTrack" }

// PageSpeed runs take 10–30 seconds each, so only the pages with the most spend are tested.
const AUDITED = 8
const OTHERS_SHOWN = 25

type Audited = LandingPageRow & {
  live: boolean // an enabled ad in an enabled campaign points here right now
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
  const destinations = await load(() => getAdDestinations())
  // Visitor numbers are a bonus: the audit still works without PostHog.
  const stats = await load(() => getPageStats(range))

  return (
    <>
      <PageHeader
        title="Landing pages"
        description={`Where your ads send people and how those pages hold up on a phone. Pages your running ads point to right now come first, then the pages that got the most ad spend in this period. Up to ${AUDITED} get a PageSpeed Insights test (mobile) and a check for the basics: a short form, tap-to-call, and reviews.`}
        range={range}
      />
      {!result.ok ? (
        <ReportProblem problem={result} />
      ) : (
        <>
          {!stats.ok && (
            <p className="text-xs text-muted-foreground">
              Visitor numbers from PostHog aren&apos;t available right now
              {stats.kind === "missing" ? ` (add ${stats.keys.join(", ")})` : `: ${stats.message.replace(/\.$/, "")}`}.
            </p>
          )}
          <Body
            pages={result.data}
            live={destinations.ok ? destinations.data.filter((d) => d.campaigns.some((c) => c.status === "ENABLED")) : []}
            stats={stats.ok ? stats.data : undefined}
          />
        </>
      )}
    </>
  )
}

async function Body({
  pages,
  live,
  stats,
}: {
  pages: LandingPageRow[]
  live: AdDestination[]
  stats?: Map<string, { sessions: number; conversions: number }>
}) {
  if (!pages.length && !live.length) {
    return <p className="rounded-2xl border bg-card p-5 text-sm">No running ads and no ad clicks in this date range.</p>
  }
  const liveUrls = new Set(live.map((d) => d.url))
  const spent = new Map(pages.map((p) => [p.url, p]))
  // Running ads first (with this period's results, if any), then the most-spent other pages.
  const toAudit: (LandingPageRow & { live: boolean })[] = [
    ...live.map((d) => ({
      url: d.url,
      campaigns: d.campaigns.filter((c) => c.status === "ENABLED").map((c) => c.name),
      metrics: spent.get(d.url)?.metrics ?? emptyMetrics(),
      live: true,
    })),
    ...pages.filter((p) => !liveUrls.has(p.url)).map((p) => ({ ...p, live: false })),
  ].slice(0, AUDITED)

  const audited: Audited[] = await Promise.all(
    toAudit.map(async (p) => {
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
      <Section
        title="Landing pages to check"
        description={`${live.length ? `${live.length} ${live.length === 1 ? "page is" : "pages are"} behind ads running now (marked), then the most-spent pages in this period.` : "No campaign is running right now, so these are the most-spent pages in this period."} Speed is Google's mobile Lighthouse score (0–100; 90+ is good). Visits and submits come from PostHog.`}
      >
        <DataTable<Audited>
          rows={audited}
          rowKey={(a) => a.url}
          columns={[
            {
              key: "url",
              label: "Page",
              render: (a) => (
                <span className="flex flex-col gap-0.5">
                  <a href={a.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                    {path(a.url)}
                  </a>
                  {a.live && (
                    <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <Pill tone="green">Ads running</Pill>
                      {a.campaigns.join(", ")}
                    </span>
                  )}
                </span>
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

      {pages.filter((p) => !audited.some((a) => a.url === p.url)).length > 0 && (
        <Section
          title="Other landing pages"
          description={`Not speed-tested. The next ${OTHERS_SHOWN} by spend at most. Broken pages behind any ad show up on the Alerts page.`}
        >
          <DataTable<LandingPageRow>
            rows={pages.filter((p) => !audited.some((a) => a.url === p.url)).slice(0, OTHERS_SHOWN)}
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
