// Go-live audit: grades the account against Juan's go-live checklist (decision d6) and PPC basics,
// in areas scored A–F like Optmyzr's PPC audit. Every check reads the live account; the few that
// Google Ads can't show are manual checks a person ticks (saved locally).

import { getAds } from "@/lib/google-ads/ads"
import { gaql } from "@/lib/google-ads/client"
import { geoNames, getMonthlyAds, isLeadConversion } from "@/lib/google-ads/reports"
import { load } from "@/lib/load"
import { checkPage, getPageSpeed, type PageCheck } from "@/lib/pagespeed"
import { serviceAreaStatus } from "@/lib/service-area"
import { addDays, formatDay, today } from "@/lib/date-range"
import type { BudgetSettings, ManualCheck } from "@/lib/store"
import { isBrand } from "@/lib/google-ads/quality"

export type CheckStatus = "pass" | "warn" | "fail" | "info" | "manual"

export type Check = {
  id: string
  title: string
  status: CheckStatus
  detail: string
  fix?: string
  plan?: string // action plan item or decision it maps to
  manual?: ManualCheck // for manual checks: who ticked it
}

export type Area = { title: string; checks: Check[]; score: number | null; grade: string; manual: boolean }

export type Audit = { areas: Area[]; score: number | null; grade: string }

// Things only a person can confirm, with the action plan item and owner behind each.
export const MANUAL_CHECKS = [
  { id: "click-id", title: "Click ID captured on every form and call", plan: "a5, a13 · Jonathan" },
  { id: "test-lead", title: "A test lead ran from click to Google and showed up", plan: "a13 · Jonathan" },
  { id: "after-hours", title: "After-hours calls and forms get answered", plan: "a10 · Cherry" },
  { id: "call-form", title: "Acquisitions fills the call outcome form after every call", plan: "a7 · Cherry" },
  { id: "retargeting", title: "Facebook retargeting is running", plan: "b5 · Cherry" },
  { id: "baseline", title: "Baseline numbers saved before launch", plan: "d6" },
] as const

const points: Record<CheckStatus, number | null> = { pass: 1, warn: 0.5, fail: 0, manual: 0, info: null }

export function grade(score: number | null) {
  if (score === null) return "—"
  return score >= 0.9 ? "A" : score >= 0.8 ? "B" : score >= 0.7 ? "C" : score >= 0.6 ? "D" : "F"
}

function scoreOf(checks: Check[]) {
  const scored = checks.map((c) => points[c.status]).filter((p): p is number => p !== null)
  return scored.length ? scored.reduce((s, p) => s + p, 0) / scored.length : null
}

type Num = string | number | undefined
const num = (v: Num) => Number(v ?? 0) || 0
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export async function runAudit(budget: BudgetSettings, manual: Record<string, ManualCheck>): Promise<Audit> {
  const end = today()
  const [campaigns, conversionActions, conversionsByAction, locations, sharedSets, campaignNegatives, keywords, schedule, ads, year] =
    await Promise.all([
      gaql<{
        campaign: { id?: Num; name?: string; advertisingChannelType?: string; geoTargetTypeSetting?: { positiveGeoTargetType?: string } }
        campaignBudget?: { amountMicros?: Num }
      }>(
        `SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
           campaign.geo_target_type_setting.positive_geo_target_type, campaign_budget.amount_micros
         FROM campaign WHERE campaign.status = 'ENABLED'`,
      ),
      gaql<{
        conversionAction: { resourceName: string; name?: string; type?: string; category?: string; primaryForGoal?: boolean; phoneCallDurationSeconds?: Num }
      }>(
        `SELECT conversion_action.resource_name, conversion_action.name, conversion_action.type, conversion_action.category,
           conversion_action.primary_for_goal, conversion_action.phone_call_duration_seconds
         FROM conversion_action WHERE conversion_action.status = 'ENABLED'`,
      ),
      // By conversion date: when each stage happened, not when the ad was clicked.
      gaql<{ segments: { conversionAction?: string; date?: string }; metrics?: { allConversionsByConversionDate?: Num } }>(
        `SELECT segments.conversion_action, segments.date, metrics.all_conversions_by_conversion_date FROM customer
         WHERE segments.date BETWEEN '${addDays(end, -180)}' AND '${end}' AND metrics.all_conversions_by_conversion_date > 0`,
      ),
      gaql<{ campaign: { advertisingChannelType?: string }; campaignCriterion: { location?: { geoTargetConstant?: string }; negative?: boolean } }>(
        `SELECT campaign.advertising_channel_type, campaign_criterion.location.geo_target_constant, campaign_criterion.negative
         FROM campaign_criterion WHERE campaign.status = 'ENABLED' AND campaign_criterion.type = 'LOCATION'`,
      ),
      gaql<{ campaign: { name?: string }; sharedSet: { name?: string; type?: string; memberCount?: Num } }>(
        `SELECT campaign.name, shared_set.name, shared_set.type, shared_set.member_count FROM campaign_shared_set
         WHERE campaign.status = 'ENABLED' AND campaign_shared_set.status = 'ENABLED'`,
      ),
      gaql<{ campaign: { name?: string } }>(
        `SELECT campaign.name FROM campaign_criterion WHERE campaign.status = 'ENABLED'
           AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`,
      ),
      gaql<{ campaign: { name?: string }; adGroupCriterion: { keyword?: { matchType?: string } } }>(
        `SELECT campaign.name, ad_group_criterion.keyword.match_type FROM ad_group_criterion
         WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status = 'ENABLED'
           AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
      ),
      gaql<{ campaign: { name?: string } }>(
        `SELECT campaign.name FROM campaign_criterion WHERE campaign.status = 'ENABLED' AND campaign_criterion.type = 'AD_SCHEDULE'`,
      ),
      getAds({ from: addDays(end, -29), to: end, label: "Last 30 days" }),
      getMonthlyAds(addDays(end, -364), end),
    ])

  const search = campaigns.filter((c) => c.campaign.advertisingChannelType === "SEARCH")
  const sellerSearch = search.filter((c) => !isBrand(c.campaign.name ?? ""))

  // ---- Conversion tracking
  const typeOf = new Map(conversionActions.map((a) => [a.conversionAction.resourceName, a.conversionAction.type ?? ""]))
  const soft = conversionActions.filter(
    (a) => a.conversionAction.primaryForGoal && !isLeadConversion(a.conversionAction.name ?? "", a.conversionAction.category ?? ""),
  )
  const uploads = conversionsByAction.filter((r) => typeOf.get(r.segments.conversionAction ?? "") === "UPLOAD_CLICKS")
  const uploaded = uploads.reduce((s, r) => s + num(r.metrics?.allConversionsByConversionDate), 0)
  const lastUpload = uploads.map((r) => r.segments.date ?? "").sort().at(-1)
  const uploadFresh = !!lastUpload && lastUpload >= addDays(end, -30)
  const callActions = conversionActions.filter((a) => ["AD_CALL", "WEBSITE_CALL"].includes(a.conversionAction.type ?? ""))
  const shortCalls = callActions.filter((a) => num(a.conversionAction.phoneCallDurationSeconds) < 60)
  const tracking: Check[] = [
    {
      id: "conv-soft",
      title: "Only real leads count as conversions",
      status: soft.length ? "fail" : "pass",
      detail: soft.length
        ? `${soft.map((a) => a.conversionAction.name).join(", ")} ${soft.length === 1 ? "counts as a conversion but isn't a lead" : "count as conversions but aren't leads"}. Google bids toward whatever counts.`
        : "Every primary conversion is a form, call, or lead stage.",
      fix: soft.length ? "In Google Ads → Goals, make these secondary so bidding ignores them." : undefined,
      plan: "Conversions page",
    },
    {
      id: "conv-offline",
      title: "Lead outcomes flow back to Google",
      status: uploadFresh ? "pass" : lastUpload ? "warn" : "fail",
      detail: uploadFresh
        ? `${Math.round(uploaded)} lead stages uploaded in the last 6 months (qualified, appointment, and so on), the latest on ${formatDay(lastUpload!)}.`
        : lastUpload
          ? `The latest lead stage uploaded is from ${formatDay(lastUpload)}. With ads mostly off there are few new leads, so confirm the upload still runs before launch.`
          : "No lead stages were uploaded in the last 6 months, so Google can't learn which clicks become deals.",
      fix: uploadFresh ? undefined : "Upload each lead's stage by click ID (Bryan's Apps Script, a8). Run one test lead through it (a13).",
      plan: "d6 #1, a8",
    },
    {
      id: "conv-calls",
      title: "Calls only count after a real conversation (60s+)",
      status: !callActions.length ? "warn" : shortCalls.length ? "warn" : "pass",
      detail: !callActions.length
        ? "No call conversion is set up, so calls from ads aren't counted."
        : shortCalls.length
          ? `${shortCalls.map((a) => `${a.conversionAction.name} (${num(a.conversionAction.phoneCallDurationSeconds)}s)`).join(", ")} count shorter calls.`
          : `Call conversions count after ${Math.min(...callActions.map((a) => num(a.conversionAction.phoneCallDurationSeconds)))} seconds.`,
      fix: shortCalls.length || !callActions.length ? "Set the call length to 60 seconds in the call conversion's settings." : undefined,
      plan: "d6, a16",
    },
  ]

  // ---- Location targeting
  const notPresence = search.filter((c) => c.campaign.geoTargetTypeSetting?.positiveGeoTargetType !== "PRESENCE")
  const targetIds = [
    ...new Set(
      locations
        .filter((l) => l.campaign.advertisingChannelType === "SEARCH" && !l.campaignCriterion.negative)
        .map((l) => l.campaignCriterion.location?.geoTargetConstant ?? "")
        .filter(Boolean),
    ),
  ]
  const places = await geoNames(targetIds)
  const outsideTargets = targetIds
    .map((id) => places.get(id))
    .filter((p): p is { name: string; canonical: string } => !!p && serviceAreaStatus(p.canonical).status !== "inside")
  const targeting: Check[] = [
    {
      id: "geo-presence",
      title: "Ads only show to people located in the area",
      status: !search.length ? "info" : notPresence.length ? "fail" : "pass",
      detail: !search.length
        ? "No search campaign is running."
        : notPresence.length
          ? `${notPresence.map((c) => c.campaign.name).join(", ")} also ${notPresence.length === 1 ? "shows" : "show"} ads to people outside who search about the area.`
          : "Running search campaigns target people located in their locations.",
      fix: notPresence.length ? "Campaign settings → Locations → Location options → Presence: people in or regularly in your locations." : undefined,
      plan: "a3",
    },
    {
      id: "geo-inside",
      title: "Targeted locations are inside the buy area",
      status: !targetIds.length ? (search.length ? "warn" : "info") : outsideTargets.length ? "warn" : "pass",
      detail: !targetIds.length
        ? search.length
          ? "Running search campaigns have no location targets, so they show everywhere."
          : "No search campaign is running."
        : outsideTargets.length
          ? `${plural(outsideTargets.length, "target")} reach past Juan's buy area: ${outsideTargets.slice(0, 8).map((p) => p.name).join(", ")}${outsideTargets.length > 8 ? "…" : ""}.`
          : `All ${plural(targetIds.length, "location target")} are in the buy area.`,
      fix: outsideTargets.length ? "Target only the buy-area cities (SF through San Jose, plus Oakland, San Leandro, Hayward)." : undefined,
      plan: "d2, a3",
    },
  ]

  // ---- Keywords & negatives
  const sharedNegatives = sharedSets.filter((s) => s.sharedSet.type === "NEGATIVE_KEYWORDS").reduce((s, r) => s + num(r.sharedSet.memberCount), 0)
  const negativeCount = campaignNegatives.length + sharedNegatives
  const broad = keywords.filter((k) => k.adGroupCriterion.keyword?.matchType === "BROAD")
  const keywordChecks: Check[] = [
    {
      id: "neg-loaded",
      title: "Negative keywords are loaded",
      status: !search.length ? "info" : negativeCount ? "pass" : "fail",
      detail: !search.length
        ? "No search campaign is running."
        : negativeCount
          ? `${negativeCount.toLocaleString("en-US")} negatives on running campaigns (${campaignNegatives.length} on the campaigns, ${sharedNegatives} in shared lists).`
          : "Running search campaigns have no negative keywords.",
      fix: negativeCount ? undefined : "Load the starting negative list (a9) from the Search terms page.",
      plan: "d6 #2, a9",
    },
    {
      id: "kw-match",
      title: "Phrase and exact match only at launch",
      status: !keywords.length ? "info" : broad.length ? "warn" : "pass",
      detail: !keywords.length
        ? "No keywords in running campaigns."
        : broad.length
          ? `${plural(broad.length, "broad match keyword")} in running campaigns. Broad match needs lots of conversion data to stay on target.`
          : `All ${plural(keywords.length, "keyword")} in running campaigns are phrase or exact match.`,
      fix: broad.length ? "Switch to phrase or exact until Google has conversion history." : undefined,
      plan: "d6",
    },
  ]

  // ---- Ads & landing pages
  const running = ads.filter((a) => a.campaignStatus === "ENABLED")
  const disapproved = running.filter((a) => a.approval === "DISAPPROVED")
  const weak = running.filter((a) => a.type === "RESPONSIVE_SEARCH_AD" && (a.strength === "POOR" || a.strength === "AVERAGE"))
  // Landing pages behind running ads, most spend first. Speed is tested on the top 5 only: each
  // PageSpeed run takes 10–30 seconds (results are cached for 12 hours).
  const spendByUrl = new Map<string, number>()
  for (const a of running) if (a.finalUrl) spendByUrl.set(a.finalUrl, (spendByUrl.get(a.finalUrl) ?? 0) + a.metrics.cost)
  const urls = [...spendByUrl.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u)
  const pages: { u: string; page: PageCheck }[] = []
  for (let i = 0; i < urls.length; i += 8) {
    const batch = urls.slice(i, i + 8)
    const checked = await Promise.all(batch.map((u) => load(() => checkPage(u))))
    checked.forEach((c, j) => c.ok && pages.push({ u: batch[j], page: c.data }))
  }
  const broken = pages.filter((p) => !p.page.resolves || (p.page.status ?? 0) >= 400)
  const speeds = await Promise.all(
    pages
      .filter((p) => !broken.includes(p))
      .slice(0, 5)
      .map(async (p) => ({ u: p.u, speed: await load(() => getPageSpeed(p.u)) })),
  )
  const speedKnown = speeds.filter((s) => s.speed.ok && s.speed.data.performance !== null)
  const slow = speedKnown.filter((s) => s.speed.ok && (s.speed.data.performance ?? 100) < 50)
  const adChecks: Check[] = [
    {
      id: "ads-approved",
      title: "No disapproved ads in running campaigns",
      status: !running.length ? "info" : disapproved.length ? "fail" : "pass",
      detail: !running.length ? "No ads are running." : disapproved.length ? `${plural(disapproved.length, "ad")} disapproved.` : `All ${plural(running.length, "running ad")} are approved.`,
      fix: disapproved.length ? "See the reasons on the Ads & creatives page." : undefined,
      plan: "ag4",
    },
    {
      id: "ads-strength",
      title: "Running ads have Good or Excellent strength",
      status: !running.length ? "info" : weak.length ? "warn" : "pass",
      detail: !running.length
        ? "No ads are running."
        : weak.length
          ? `${plural(weak.length, "ad")} rated Average or Poor${weak.some((a) => a.pinned >= 3) ? "; heavy pinning is part of it" : ""}.`
          : "All running responsive ads are rated Good or better.",
      fix: weak.length ? "Add distinct headlines, unpin most of them, and use all 4 descriptions." : undefined,
      plan: "ag4",
    },
    {
      id: "lp-loads",
      title: "Landing pages behind running ads load",
      status: !urls.length ? "info" : broken.length ? "fail" : "pass",
      detail: !urls.length ? "No ads are running." : broken.length ? `${broken.map((b) => b.u).join(", ")} ${broken.length === 1 ? "doesn't" : "don't"} load.` : `${plural(urls.length, "page")} checked; all load.`,
      plan: "a12, ag4",
    },
    {
      id: "lp-speed",
      title: "Landing pages are fast on phones (speed 50+)",
      status: !urls.length ? "info" : !speedKnown.length ? "manual" : slow.length ? "fail" : "pass",
      detail: !urls.length
        ? "No ads are running."
        : !speedKnown.length
          ? "Couldn't test speed (PageSpeed key missing or the test failed). Check the Landing pages page."
          : slow.length
            ? slow.map((s) => `${s.u.replace(/^https?:\/\/(www\.)?/, "")} scores ${s.speed.ok ? s.speed.data.performance : "?"}`).join(", ") + " on mobile."
            : "Every landing page scores 50+ on mobile.",
      fix: slow.length ? "Remove or delay heavy third-party scripts, compress images, and cut form fields." : undefined,
      plan: "a12 · Seth",
    },
  ]

  // ---- Budget & alerts
  const leads = year.reduce((s, m) => s + m.leads, 0)
  const cost = year.reduce((s, m) => s + m.cost, 0)
  const cpl = leads ? cost / leads : null
  const sellerDaily = sellerSearch.reduce((s, c) => s + num(c.campaignBudget?.amountMicros) / 1_000_000, 0)
  const budgetChecks: Check[] = [
    {
      id: "budget-set",
      title: "Monthly budget, alert line, and pause line are set",
      status: budget.monthly && budget.alertLine && budget.pauseLine ? "pass" : budget.monthly ? "warn" : "fail",
      detail:
        budget.monthly && budget.alertLine && budget.pauseLine
          ? `$${budget.monthly.toLocaleString("en-US")} a month, alert at $${budget.alertLine.toLocaleString("en-US")}, pause at $${budget.pauseLine.toLocaleString("en-US")}.`
          : "Set them on the Budget & pacing page, so spend is watched from day one.",
      plan: "d3, xjuan1",
    },
    {
      id: "budget-learn",
      title: "The daily budget can buy about a lead a day",
      status: !sellerSearch.length ? "info" : cpl === null ? "warn" : sellerDaily >= cpl ? "pass" : "warn",
      detail: !sellerSearch.length
        ? "No seller (non-brand) search campaign is running yet."
        : cpl === null
          ? "No lead history to compare with."
          : `Seller campaigns budget $${Math.round(sellerDaily).toLocaleString("en-US")}/day against about $${Math.round(cpl).toLocaleString("en-US")} per lead over the last 12 months.`,
      fix: sellerSearch.length && cpl !== null && sellerDaily < cpl ? "Google learns slowly with less than about one lead a day." : undefined,
      plan: "d3",
    },
  ]

  // ---- Campaign setup
  const setup: Check[] = [
    {
      id: "one-campaign",
      title: "One seller campaign, several ad groups",
      status: sellerSearch.length === 1 ? "pass" : sellerSearch.length === 0 ? "info" : "warn",
      detail:
        sellerSearch.length === 0
          ? "The relaunch campaign isn't running yet (a4)."
          : sellerSearch.length === 1
            ? `${sellerSearch[0].campaign.name} is the one seller campaign.`
            : `${sellerSearch.length} seller campaigns are running: ${sellerSearch.map((c) => c.campaign.name).join(", ")}.`,
      fix: sellerSearch.length > 1 ? "Juan's decision d4: one campaign with ad groups; pause the others." : undefined,
      plan: "d4, a4",
    },
    {
      id: "ad-schedule",
      title: "Ads run when calls get answered",
      status: !search.length ? "info" : schedule.length ? "pass" : "warn",
      detail: !search.length
        ? "No search campaign is running."
        : schedule.length
          ? `An ad schedule is set (${plural(schedule.length, "time slot")}). Confirm it matches the hours Acquisitions answers.`
          : "No ad schedule: ads run around the clock, so night and weekend leads need after-hours coverage.",
      plan: "d6, b4, a10",
    },
  ]

  const manualChecks: Check[] = MANUAL_CHECKS.map((m) => {
    const tick = manual[m.id]
    return {
      id: m.id,
      title: m.title,
      status: tick?.done ? "pass" : "manual",
      detail: tick?.done ? `Confirmed by ${tick.by}.` : "Google Ads can't see this. Tick it once someone has checked.",
      plan: m.plan,
      manual: tick,
    }
  })

  const areas = [
    { title: "Conversion tracking", checks: tracking },
    { title: "Location targeting", checks: targeting },
    { title: "Keywords and negatives", checks: keywordChecks },
    { title: "Ads and landing pages", checks: adChecks },
    { title: "Budget and alerts", checks: budgetChecks },
    { title: "Campaign setup", checks: setup },
    { title: "Checked by the team", checks: manualChecks, manual: true },
  ].map((a) => {
    const score = scoreOf(a.checks)
    return { manual: false, ...a, score, grade: grade(score) }
  })
  const all = areas.flatMap((a) => a.checks)
  const score = scoreOf(all)
  return { areas, score, grade: grade(score) }
}
