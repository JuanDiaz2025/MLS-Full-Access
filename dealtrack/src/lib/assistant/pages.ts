// What each DealTrack page shows, as compact JSON for the chat: the same loaders the pages use,
// trimmed to the findings a person would read. Read-only, like the rest of the chat's tools.

import { runAudit } from "@/lib/audit"
import { getPacing } from "@/lib/budget"
import { checkCampaigns } from "@/lib/campaign-check"
import { addDays, today, type DateRange } from "@/lib/date-range"
import { getAds, getAssetRatings } from "@/lib/google-ads/ads"
import { getCalls } from "@/lib/google-ads/calls"
import { getOverview } from "@/lib/google-ads/overview"
import { getQualityKeywords } from "@/lib/google-ads/quality"
import {
  getAdDestinations,
  getLandingPages,
  getLocationData,
  getSchedule,
  getSearchTerms,
  rates,
  sumMetrics,
  weekdays,
  type Metrics,
} from "@/lib/google-ads/reports"
import { pagesToAudit } from "@/lib/landing-audit"
import { expensiveCities, regions } from "@/lib/locations"
import { getPageSpeed } from "@/lib/pagespeed"
import { getPageStats, getSessions } from "@/lib/posthog"
import { readData } from "@/lib/store"

export const PAGES = [
  "overview",
  "budget",
  "audit",
  "ads",
  "quality_score",
  "landing_pages",
  "search_terms",
  "negatives",
  "keyword_ideas",
  "locations",
  "schedule",
  "behavior",
  "calls",
  "fraud",
] as const
export type PageName = (typeof PAGES)[number]

export const PAGE_GUIDE =
  "overview: spend, clicks, leads, impression share vs the period before (Overview page). " +
  "budget: this month's spend, pace, projection, alert and pause lines (Monitor → Budget & pacing). " +
  "audit: the go-live audit score and every failing or warning check with its fix (Audit → Go-live audit). " +
  "ads: disapproved or limited ads, weak ad strength, and Low-rated headlines (Audit → Ads & creatives). " +
  "quality_score: keywords with low Quality Scores and which part is below average (Monitor → Quality Score). " +
  "landing_pages: where the ads send people, spend, visits and form submits per page, and phone speed for the top pages (Audit → Landing pages). " +
  "search_terms: costly searches with no conversions and the suggested negative, and the searches that converted (Optimize → Search terms). " +
  "negatives: the campaign check (campaigns missing standard negatives, unblocked waste) and the weekly negative batches (Optimize → Weekly negatives). " +
  "keyword_ideas: keyword idea batches, their review and whether they were added (Optimize → Keyword ideas). " +
  "locations: presence vs interest, regions of California, spend outside California, expensive cities (Optimize → Locations). " +
  "schedule: spend and conversions by day of week and hour (Optimize → Day & hour). " +
  "behavior: what Google Ads visitors did on the site from PostHog, by campaign, landing page and device (Insights → Behavior). " +
  "calls: calls from the ads, missed calls (Leads → Leads & calls). " +
  "fraud: suspicious IP addresses, bots, suspicious days and refund claims (Monitor → Fraud)."

const r2 = (n: number) => Math.round(n * 100) / 100
const brief = (m: Metrics) => {
  const r = rates(m)
  return {
    cost: r2(m.cost),
    clicks: m.clicks,
    impressions: m.impressions,
    conversions: r2(m.conversions),
    costPerConversion: r.costPerConversion === null ? null : r2(r.costPerConversion),
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

export async function pageData(page: PageName, days: number): Promise<unknown> {
  const end = today()
  const range: DateRange = { from: addDays(end, -(days - 1)), to: end, label: `Last ${days} days` }
  const period = { from: range.from, to: range.to }

  switch (page) {
    case "overview": {
      const o = await getOverview(range)
      return { period, totals: o.totals, previousPeriod: { ...o.previous.range, totals: o.previous.totals } }
    }

    case "budget": {
      // Everything but the day-by-day line for the chart.
      const { cumulative, ...rest } = await getPacing((await readData()).budget)
      return { ...rest, daysSoFar: cumulative.length }
    }

    case "audit": {
      const data = await readData()
      const a = await runAudit(data.budget, data.audit)
      return {
        score: a.score,
        grade: a.grade,
        areas: a.areas.map((area) => ({
          area: area.title,
          score: area.score,
          grade: area.grade,
          problems: area.checks
            .filter((c) => c.status === "fail" || c.status === "warn" || (c.status === "manual" && !c.manual?.done))
            .map((c) => ({ check: c.title, problem: c.problem, status: c.status, detail: c.detail, fix: c.fix })),
        })),
      }
    }

    case "ads": {
      const [ads, assets] = await Promise.all([getAds(range), getAssetRatings().catch(() => [])])
      const live = ads.filter((a) => a.campaignStatus === "ENABLED")
      return {
        period,
        ads: live.length,
        problems: live
          .filter((a) => a.approval !== "APPROVED" || ["POOR", "AVERAGE"].includes(a.strength) || a.headlines < 10)
          .slice(0, 40)
          .map((a) => ({
            campaign: a.campaign,
            adGroup: a.adGroup,
            approval: a.approval,
            policyTopics: a.topics,
            adStrength: a.strength,
            headlines: a.headlines,
            descriptions: a.descriptions,
            pinnedHeadlines: a.pinned,
            finalUrl: a.finalUrl,
            ...brief(a.metrics),
          })),
        lowRatedText: assets.filter((x) => x.label === "LOW").slice(0, 30),
      }
    }

    case "quality_score": {
      const kws = await getQualityKeywords(range)
      const avg = kws.length ? kws.reduce((s, k) => s + k.score, 0) / kws.length : null
      return {
        period,
        keywordsWithScore: kws.length,
        averageScore: avg === null ? null : r2(avg),
        low: kws
          .filter((k) => k.score <= 5)
          .sort((a, b) => b.metrics.cost - a.metrics.cost)
          .slice(0, 40)
          .map((k) => ({
            keyword: k.text,
            matchType: k.matchType,
            campaign: k.campaign,
            adGroup: k.adGroup,
            score: k.score,
            expectedCtr: k.expectedCtr,
            adRelevance: k.adRelevance,
            landingPage: k.landingPage,
            ...brief(k.metrics),
          })),
      }
    }

    case "landing_pages": {
      const [pages, live, stats] = await Promise.all([getLandingPages(range), getAdDestinations(), getPageStats(range).catch(() => new Map())])
      const audited = pagesToAudit(pages, live)
      // PageSpeed takes 10–30 seconds a page; the top three get a test, cached for 12 hours.
      const speeds = await Promise.all(
        audited.slice(0, 3).map((p) =>
          withTimeout(
            Promise.resolve()
              .then(() => getPageSpeed(p.url))
              .catch(() => null),
            40_000,
          ),
        ),
      )
      const pathOf = (url: string) => {
        try {
          return new URL(url).pathname
        } catch {
          return url
        }
      }
      return {
        period,
        pages: audited.slice(0, 15).map((p, i) => {
          const s = stats.get(pathOf(p.url))
          return {
            url: p.url,
            adsRunningNow: p.live,
            campaigns: p.campaigns.slice(0, 3),
            ...brief(p.metrics),
            visits: s?.sessions ?? null,
            formSubmits: s?.conversions ?? null,
            phoneSpeed: speeds[i]
              ? {
                  score: speeds[i]!.performance,
                  mainContentSeconds: speeds[i]!.lcpS,
                  blockingMs: speeds[i]!.tbtMs,
                  realVisitors: speeds[i]!.fieldLcp,
                  slowScripts: speeds[i]!.slowestThirdParties,
                }
              : i < 3
                ? "speed test unavailable (no PageSpeed key or it timed out)"
                : "not tested",
          }
        }),
      }
    }

    case "search_terms": {
      const terms = await getSearchTerms(range)
      const open = terms.filter((t) => t.status !== "EXCLUDED" && t.status !== "ADDED_EXCLUDED")
      return {
        period,
        searches: terms.length,
        wastedNoConversions: open
          .filter((t) => t.metrics.conversions === 0 && t.metrics.cost > 0)
          .sort((a, b) => b.metrics.cost - a.metrics.cost)
          .slice(0, 40)
          .map((t) => ({
            term: t.term,
            campaigns: t.campaigns.slice(0, 2),
            ...brief(t.metrics),
            why: t.rule?.reason ?? null,
            suggestedNegative: t.suggestion ?? null,
          })),
        converting: terms
          .filter((t) => t.metrics.conversions > 0)
          .sort((a, b) => b.metrics.conversions - a.metrics.conversions)
          .slice(0, 25)
          .map((t) => ({ term: t.term, status: t.status, campaigns: t.campaigns.slice(0, 2), ...brief(t.metrics) })),
      }
    }

    case "negatives": {
      const [check, data] = await Promise.all([checkCampaigns(), readData()])
      return {
        campaignCheck: {
          period: { from: check.from, to: check.to },
          standardNegatives: check.standard,
          campaigns: check.campaigns.map((c) => ({
            campaign: c.name,
            status: c.status,
            spend: r2(c.spend),
            negativesApplying: c.negatives,
            lists: c.lists,
            hasStandardList: c.hasStandardList,
            unblockedWasteSearches: c.waste,
            examples: c.wasteSearches.slice(0, 5),
            missingStandardNegatives: c.missing,
            gaps: c.gaps.map((g) => ({ group: g.label, missing: g.missing.slice(0, 8) })),
          })),
        },
        weeklyBatches: data.batches.slice(0, 8).map((b) => ({
          period: `${b.from} to ${b.to}`,
          campaign: b.campaignName ?? "All campaigns",
          lines: b.items.length,
          approved: b.items.filter((i) => i.approved).length,
          rejected: b.items.filter((i) => i.approved === false).length,
          heldBackBecauseTheyConverted: b.heldBack.length,
          kind: b.kind === "standard" ? "standard negatives from the campaign check" : "weekly search terms",
          pushed: b.pushed
            ? { by: b.pushed.by, at: b.pushed.at, added: b.pushed.added, list: b.pushed.list ?? null, dryRun: !!b.pushed.dryRun }
            : null,
          resultAWeekLater: b.checked
            ? {
                blockedSpendBefore: r2(b.checked.blockedSpendBefore),
                blockedSpendAfter: r2(b.checked.blockedSpendAfter),
                leadsBefore: b.checked.leadsBefore,
                leadsAfter: b.checked.leadsAfter,
              }
            : null,
          topLines: b.items
            .slice(0, 15)
            .map((i) => ({ negative: i.negative, matchType: i.matchType, why: i.why, cost: r2(i.cost), approved: i.approved })),
        })),
      }
    }

    case "keyword_ideas": {
      const data = await readData()
      return {
        batches: data.keywordBatches.slice(0, 8).map((b) => ({
          period: `${b.from} to ${b.to}`,
          fromCampaign: b.campaignName ?? "All campaigns",
          addTo: b.addTo?.campaignName ?? "Where each search converted",
          ideas: b.items.length,
          approved: b.items.filter((i) => i.approved).length,
          added: b.pushed ? { by: b.pushed.by, at: b.pushed.at, added: b.pushed.added, paused: b.pushed.paused, dryRun: !!b.pushed.dryRun } : null,
          notes: b.notes,
          ideasList: b.items.slice(0, 25).map((i) => ({
            keyword: i.text,
            matchType: i.matchType,
            source: i.source,
            why: i.why,
            adGroups: i.targets.map((t) => `${t.campaignName} › ${t.adGroupName}`),
            conversions: r2(i.conversions),
            cost: r2(i.cost),
            approved: i.approved,
          })),
        })),
      }
    }

    case "locations": {
      const loc = await getLocationData(range)
      const total = sumMetrics(loc.rows)
      const avgCpa = rates(total).costPerConversion
      const outside = loc.rows.filter((r) => r.status === "outside")
      return {
        period,
        buyArea: "California",
        total: brief(total),
        presenceVsInterest: { inTheArea: brief(loc.byKind.presence), searchingAboutTheArea: brief(loc.byKind.interest) },
        regions: regions(loc.rows).map((r) => ({ region: r.name, ...brief(r.metrics) })),
        outsideCalifornia: {
          ...brief(sumMetrics(outside)),
          places: outside
            .sort((a, b) => b.metrics.cost - a.metrics.cost)
            .slice(0, 15)
            .map((r) => ({ place: `${r.city}, ${r.region}`, ...brief(r.metrics) })),
        },
        expensiveCities: expensiveCities(loc.rows, avgCpa)
          .slice(0, 15)
          .map((r) => ({ city: r.city, county: r.county, reason: r.reason, ...brief(r.metrics) })),
        topCities: [...loc.rows]
          .sort((a, b) => b.metrics.conversions - a.metrics.conversions || b.metrics.cost - a.metrics.cost)
          .slice(0, 20)
          .map((r) => ({ place: `${r.city}, ${r.region}`, ...brief(r.metrics) })),
      }
    }

    case "schedule": {
      const grid = await getSchedule(range)
      const byDay = grid.map((hours, i) => ({ day: weekdays[i], ...brief(sumMetrics(hours.map((m) => ({ metrics: m })))) }))
      const byHour = Array.from({ length: 24 }, (_, h) => ({ hourPacific: h, ...brief(sumMetrics(grid.map((hours) => ({ metrics: hours[h] })))) }))
      return { period, byDay, byHour }
    }

    case "behavior": {
      const all = await getSessions(range)
      const ads = all.filter((s) => s.source === "Google Ads")
      const group = (key: (s: (typeof ads)[number]) => string) => {
        const m = new Map<string, typeof ads>()
        for (const s of ads) m.set(key(s), [...(m.get(key(s)) ?? []), s])
        return [...m]
          .map(([k, list]) => ({
            key: k,
            visits: list.length,
            formSubmits: list.filter((s) => s.converted).length,
            leftRightAway: list.filter((s) => s.pageviews === 1 && s.durationS < 10).length,
          }))
          .sort((a, b) => b.visits - a.visits)
          .slice(0, 15)
      }
      return {
        period,
        source: "PostHog; Google Ads visits only, team and staging site left out",
        allVisits: all.length,
        adVisits: ads.length,
        adFormSubmits: ads.filter((s) => s.converted).length,
        rageClicks: ads.filter((s) => s.rageClicked).length,
        byCampaignId: group((s) => s.campaignId || "not tagged"),
        byLandingPage: group((s) => s.entryPage),
        byDevice: group((s) => s.device),
        byKeyword: group((s) => s.keyword || "not tagged"),
      }
    }

    case "calls": {
      const calls = await getCalls(days)
      return {
        period,
        calls: calls.length,
        missed: calls.filter((c) => c.missed).length,
        recent: calls.slice(0, 40),
      }
    }

    case "fraud": {
      // tools.ts lists this module's pages in its tool specs, so it's loaded only when needed.
      const { fraudCheck } = await import("@/lib/assistant/tools")
      return fraudCheck(days)
    }
  }
}
