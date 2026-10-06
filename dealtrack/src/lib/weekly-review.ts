// The weekly review (Mission 8): every Monday, last week and the last 90 days of Google Ads in one
// page, with five kinds of proposals, each with the number that decides it and only where the
// rules below allow it:
//   1. searches to add as keywords   (from Keyword ideas: searches that converted)
//   2. searches to block             (from Weekly negatives: not-a-seller searches that cost money)
//   3. keywords to pause             (spent a set amount in 90 days without converting)
//   4. cities to drop or push        (California cities that cost too much, or convert cheaply;
//                                     anywhere outside California is dropped)
//   5. a budget change, if any       (ad spend per closed deal against the target)
// Then a check on itself: totals recomputed two ways, and any proposal that contradicts another
// taken out, with what was corrected listed.
//
// Juan approves (one line at a time or all at once). Approved blocks and keywords go into a
// Weekly negatives and a Keyword ideas batch, already reviewed and approved, for an admin to push
// there (the weekly brake applies). Pauses, cities and budget are applied by hand in Google Ads
// and ticked off here with a name. While the dry run is on, nothing goes anywhere: proposals only.
//
// Reviews and the rules are saved on this computer (.data/weekly-reviews.json). Making one uses
// about 15 Google Ads API operations.

import { addDays, today, type DateRange } from "@/lib/date-range"
import { getCalls } from "@/lib/google-ads/calls"
import { getCampaigns, getDaily, getKeywords, getLocationData, getMonthlySpend, sumMetrics, type Metrics } from "@/lib/google-ads/reports"
import { jsonFileStore } from "@/lib/json-file-store"
import { draftIdeas } from "@/lib/keyword-ideas"
import { listLeads } from "@/lib/leads/store"
import { blocks } from "@/lib/negatives"
import { completeWeeks, draftBatch } from "@/lib/negative-batches"
import { activeAccount } from "@/lib/conversions/google"
import { getLeadData } from "@/lib/sheets"
import { readCombined } from "@/lib/sheets/sync"
import { readData, type BatchItem, type KeywordIdea } from "@/lib/store"
import { getPacing } from "@/lib/budget"

// ---- Rules ------------------------------------------------------------------------------------

export type ReviewRules = {
  targetLow: number // ad spend per closed deal: below this there's room to spend more…
  targetHigh: number // …above this, spend less
  pauseKeywordSpend: number // a keyword that spent this much in 90 days with no conversion is proposed for pausing
  dropCitySpend: number // a California city that spent this much in 90 days with no conversion is proposed to drop
  cityCostTimes: number // …or whose cost per conversion is this many times the average
  pushCityConversions: number // a city with at least this many conversions in 90 days…
  pushCityCostShare: number // …at this share of the average cost per conversion or less is proposed to push
  outsideSpend: number // a city outside California that spent this much in 90 days is proposed to drop
  budgetStep: number // a budget change moves the monthly budget by this share (0.1 = 10%)
  maxPerSection: number
  dryRun: boolean // proposals only: nothing is sent to the negatives or keyword ideas batches
  updatedBy?: string
  updatedAt?: string
}

export const DEFAULT_RULES: ReviewRules = {
  targetLow: 13_000,
  targetHigh: 17_000,
  pauseKeywordSpend: 1_000,
  dropCitySpend: 1_000,
  cityCostTimes: 3,
  pushCityConversions: 2,
  pushCityCostShare: 0.6,
  outsideSpend: 50,
  budgetStep: 0.1,
  maxPerSection: 15,
  dryRun: true,
}

// Written into the AI summary's question and shown on the page: the rules every proposal follows.
export const STANDING_RULES = [
  "Batch changes once a week. No constant bid changes, no pausing and unpausing ads, no new landing pages mid-week: that resets Google's learning.",
  "Never block a search that converted in the last 12 months, or one that says “sell” (Weekly negatives' own safety check).",
  "The buy area is California: anywhere else is waste.",
]

// ---- Saved reviews ----------------------------------------------------------------------------

export type ProposalKind = "add" | "block" | "pause" | "city" | "budget"

export type Proposal = {
  id: string
  kind: ProposalKind
  title: string // what to do: "Block “for rent”", "Pause [cash for houses]", "Drop Reno, NV"
  number: string // the number that decides it
  detail?: string
  action?: "drop" | "push" | "raise" | "lower" | "hold"
  block?: BatchItem // kind "block": the Weekly negatives line
  idea?: KeywordIdea // kind "add": the Keyword ideas line
  keyword?: { text: string; matchType: string; campaign: string; adGroup: string }
  cost: number // spend behind it (the period it's judged on)
  decision: boolean | null // approved, rejected, or not decided yet
  decidedBy?: string
  applied?: { by: string; at: string } // pauses, cities and budget: done by hand in Google Ads
}

export type PeriodNumbers = {
  from: string
  to: string
  cost: number
  clicks: number
  conversions: number
  leads: number // leads saved in DealTrack (website forms, calls added as leads)
  qualified: number // of those: interested, appointment, offer or closed
  closed: number
  calls60: number // Google Ads calls of 60 seconds or more
}

export type CostPerDeal = { from: string; to: string; spend: number; deals: number; value: number | null; source: string }

export type WeeklyReview = {
  id: string // the reviewed week's Monday
  week: PeriodNumbers
  long: PeriodNumbers // the 90 days ending with that week
  costPerDeal: CostPerDeal | null
  monthlyBudget: number | null
  rules: ReviewRules // as they were when it was made
  proposals: Proposal[]
  checks: { ok: boolean; text: string }[]
  notes: string[] // what couldn't be read
  made: { by: string; at: string }
  dryRun: boolean
  sent?: { by: string; at: string; negatives?: string; ideas?: string }
  summary?: { text: string; by: string; at: string }
}

type File = { rules: ReviewRules; reviews: WeeklyReview[] }
const file = jsonFileStore<File>("weekly-reviews.json", () => ({ rules: { ...DEFAULT_RULES }, reviews: [] }))
const KEEP = 26 // half a year of reviews

export async function getReviews(): Promise<File> {
  const f = await file.read()
  return { rules: { ...DEFAULT_RULES, ...f.rules }, reviews: f.reviews ?? [] }
}

export const updateReviews = (change: (f: File) => void | boolean) =>
  file.update((f) => {
    f.rules = { ...DEFAULT_RULES, ...f.rules }
    f.reviews ??= []
    change(f)
    f.reviews.sort((a, b) => b.id.localeCompare(a.id))
    f.reviews = f.reviews.slice(0, KEEP)
    return f
  })

// The week a review made today is about: last Monday–Sunday.
export const reviewWeek = () => completeWeeks(1)[0]

// ---- Making one -------------------------------------------------------------------------------

const range = (from: string, to: string): DateRange => ({ from, to, label: `${from} – ${to}` })
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`
const conv = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US")
const QUALIFIED = new Set(["interested", "appointment", "offer", "closed"])
const settle = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  )
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200)

export async function makeReview(by: string): Promise<WeeklyReview> {
  const { rules } = await getReviews()
  const week = reviewWeek()
  const longFrom = addDays(week.to, -89)
  const notes: string[] = []
  // The 12 complete months before this one.
  const thisMonth = `${today().slice(0, 7)}-01`
  const twelveFrom = `${Number(thisMonth.slice(0, 4)) - 1}${thisMonth.slice(4)}`
  const twelveTo = addDays(thisMonth, -1)

  const [dailyWeek, dailyLong, campaignsWeek, keywords, places, calls, leads, history, sheet, spend12, negatives, ideas, data] = await Promise.all([
    getDaily(range(week.from, week.to)),
    getDaily(range(longFrom, week.to)),
    settle(getCampaigns(range(week.from, week.to))),
    settle(getKeywords(range(longFrom, week.to))),
    settle(getLocationData(range(longFrom, week.to))),
    settle(getCalls(Math.max(1, Math.round((Date.parse(today()) - Date.parse(longFrom)) / 86_400_000)))),
    settle(listLeads()),
    settle(activeAccount().then((a) => (a ? readCombined(a.connection) : null))),
    // getLeadData throws at once when the Sheet isn't set up: through a promise, so it's a note, not a failed review.
    settle(Promise.resolve().then(getLeadData)),
    settle(getMonthlySpend(twelveFrom, twelveTo)),
    settle(draftBatch({ from: week.from, to: week.to })),
    settle(draftIdeas({ from: longFrom, to: week.to, sources: ["proven", "phrase"], competitors: false })),
    readData(),
  ])
  const pacing = await settle(getPacing(data.budget))

  // Headline numbers for both periods.
  const numbers = (from: string, to: string, daily: { date: string; metrics: Metrics }[]): PeriodNumbers => {
    const m = sumMetrics(daily)
    const inRange = (iso: string) => iso.slice(0, 10) >= from && iso.slice(0, 10) <= to
    const mine = leads.ok ? leads.v.filter((l) => inRange(l.createdAt)) : []
    return {
      from,
      to,
      cost: m.cost,
      clicks: m.clicks,
      conversions: m.conversions,
      leads: mine.length,
      qualified: mine.filter((l) => l.status && QUALIFIED.has(l.status)).length,
      closed: mine.filter((l) => l.status === "closed").length,
      calls60: calls.ok ? calls.v.filter((c) => c.seconds >= 60 && inRange(c.start)).length : 0,
    }
  }
  const weekN = numbers(week.from, week.to, dailyWeek)
  const longN = numbers(longFrom, week.to, dailyLong)
  if (!calls.ok) notes.push(`Calls couldn't be read: ${why(calls.e)}`)
  if (!leads.ok) notes.push(`Leads couldn't be read: ${why(leads.e)}`)

  // Ad spend per closed deal: the last 12 complete months (deals take weeks to close, so 90 days
  // would undercount them). Deals come from Deal History (PPC deals acquired, or under contract, in
  // those months); without it, the lead sheet; without that, leads marked "Closed deal".
  let costPerDeal: CostPerDeal | null = null
  if (spend12.ok) {
    const total = [...spend12.v.values()].reduce((s, n) => s + n, 0)
    const months = new Set(spend12.v.keys())
    const inWindow = (iso: string | null) => !!iso && iso >= twelveFrom && iso <= twelveTo
    let deals: number | null = null
    let source = ""
    if (history.ok && history.v) {
      const col = (re: RegExp) => history.v!.header.findIndex((h) => re.test(h.trim().toLowerCase()))
      const [src, acquired, contract] = [col(/^lead source/), col(/^acquisition date/), col(/^contract signed/)]
      const day = (v?: string) => {
        const t = v ? Date.parse(v) : NaN
        return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
      }
      if (src >= 0) {
        deals = history.v.deals.filter((d) => /^ppc/i.test(d[src] ?? "") && inWindow(day(d[acquired]) ?? day(d[contract]))).length
        source = "PPC deals in Deal History, by acquisition date (or contract date)"
      }
    }
    if (deals === null && sheet.ok) {
      deals = sheet.v.deals.filter((d) => d.acquired && months.has(d.leadDate.slice(0, 7))).length
      source = "Acquired deals in the lead sheet, by the month the lead came in"
    }
    if (deals === null && leads.ok) {
      deals = leads.v.filter((l) => l.status === "closed" && inWindow(l.createdAt.slice(0, 10))).length
      source = "Leads marked “Closed deal” in DealTrack (Deal History and the lead sheet couldn't be read)"
    }
    if (deals !== null) costPerDeal = { from: twelveFrom, to: twelveTo, spend: total, deals, value: deals ? total / deals : null, source }
  } else notes.push(`Monthly spend couldn't be read: ${why(spend12.e)}`)

  const proposals: Proposal[] = []
  const cap = <T>(list: T[]) => list.slice(0, rules.maxPerSection)

  // 1. Searches to add as keywords.
  if (ideas.ok) {
    for (const [i, idea] of cap(ideas.v.items).entries()) {
      proposals.push({
        id: `add-${i}`,
        kind: "add",
        title: `Add ${idea.matchType === "EXACT" ? `[${idea.text}]` : `“${idea.text}”`}`,
        number: idea.conversions
          ? `${conv(idea.conversions)} conversion${idea.conversions === 1 ? "" : "s"} from ${usd(idea.cost)} in 90 days (${usd(idea.cost / idea.conversions)} each)`
          : `${idea.clicks} clicks, ${usd(idea.cost)} in 90 days`,
        detail: [idea.why, idea.targets[0] && `into ${idea.targets[0].campaignName} › ${idea.targets[0].adGroupName}`].filter(Boolean).join(" · "),
        idea,
        cost: idea.cost,
        decision: null,
      })
    }
  } else notes.push(`Keyword ideas couldn't be drafted: ${why(ideas.e)}`)

  // 2. Searches to block.
  if (negatives.ok) {
    for (const [i, item] of cap(negatives.v.items).entries()) {
      proposals.push({
        id: `block-${i}`,
        kind: "block",
        title: `Block “${item.negative}”`,
        number: `${usd(item.cost)}, ${item.clicks} click${item.clicks === 1 ? "" : "s"}, 0 conversions last week (${item.termCount} search${item.termCount === 1 ? "" : "es"})`,
        detail: `${item.why}. e.g. ${item.terms.slice(0, 3).join(", ")}`,
        block: item,
        cost: item.cost,
        decision: null,
      })
    }
  } else notes.push(`Search terms to block couldn't be drafted: ${why(negatives.e)}`)

  // 3. Keywords to pause: running ones that spent the set amount in 90 days without converting.
  if (keywords.ok) {
    const stale = keywords.v
      .filter((k) => k.status === "ENABLED" && k.metrics.conversions === 0 && k.metrics.cost >= rules.pauseKeywordSpend)
      .sort((a, b) => b.metrics.cost - a.metrics.cost)
    for (const [i, k] of cap(stale).entries()) {
      const shown = k.matchType === "EXACT" ? `[${k.text}]` : k.matchType === "PHRASE" ? `“${k.text}”` : k.text
      proposals.push({
        id: `pause-${i}`,
        kind: "pause",
        title: `Pause ${shown}`,
        number: `${usd(k.metrics.cost)}, ${k.metrics.clicks} clicks, 0 conversions in 90 days (rule: ${usd(rules.pauseKeywordSpend)})`,
        detail: `${k.campaign} › ${k.adGroup}`,
        keyword: { text: k.text, matchType: k.matchType, campaign: k.campaign, adGroup: k.adGroup },
        cost: k.metrics.cost,
        decision: null,
      })
    }
  } else notes.push(`Keywords couldn't be read: ${why(keywords.e)}`)

  // 4. Cities to drop or push.
  if (places.ok) {
    const rows = places.v.rows.filter((r) => r.status !== "unknown")
    const inside = rows.filter((r) => r.status === "inside")
    const avg = (() => {
      const m = sumMetrics(inside)
      return m.conversions ? m.cost / m.conversions : null
    })()
    const name = (r: (typeof rows)[number]) => `${r.city}${r.region ? `, ${r.region.replace(", United States", "")}` : ""}`
    const outside = rows.filter((r) => r.status === "outside" && r.metrics.cost >= rules.outsideSpend).sort((a, b) => b.metrics.cost - a.metrics.cost)
    const expensive = inside
      .filter((r) => {
        const cpa = r.metrics.conversions ? r.metrics.cost / r.metrics.conversions : null
        return (
          (r.metrics.conversions === 0 && r.metrics.cost >= rules.dropCitySpend) ||
          (cpa !== null && avg !== null && cpa >= avg * rules.cityCostTimes && r.metrics.cost >= rules.dropCitySpend)
        )
      })
      .sort((a, b) => b.metrics.cost - a.metrics.cost)
    const cheap = inside
      .filter(
        (r) =>
          avg !== null &&
          r.metrics.conversions >= rules.pushCityConversions &&
          r.metrics.cost / r.metrics.conversions <= avg * rules.pushCityCostShare,
      )
      .sort((a, b) => b.metrics.conversions - a.metrics.conversions)
    let n = 0
    for (const r of cap(outside)) {
      proposals.push({
        id: `city-${n++}`,
        kind: "city",
        action: "drop",
        title: `Drop ${name(r)}`,
        number: `${usd(r.metrics.cost)}, ${conv(r.metrics.conversions)} conversions in 90 days, outside California`,
        detail: "Exclude it in the campaign's locations (Locations page → Outside the buy area).",
        cost: r.metrics.cost,
        decision: null,
      })
    }
    for (const r of cap(expensive)) {
      proposals.push({
        id: `city-${n++}`,
        kind: "city",
        action: "drop",
        title: `Drop or bid down ${name(r)}`,
        number: r.metrics.conversions
          ? `${usd(r.metrics.cost / r.metrics.conversions)} per conversion in 90 days, ${(r.metrics.cost / r.metrics.conversions / avg!).toFixed(1)}× the ${usd(avg!)} average`
          : `${usd(r.metrics.cost)}, ${r.metrics.clicks} clicks, 0 conversions in 90 days (rule: ${usd(rules.dropCitySpend)})`,
        detail: "In the buy area, so excluding it is a choice: a lower bid adjustment keeps it on.",
        cost: r.metrics.cost,
        decision: null,
      })
    }
    for (const r of cap(cheap)) {
      proposals.push({
        id: `city-${n++}`,
        kind: "city",
        action: "push",
        title: `Push ${name(r)}`,
        number: `${conv(r.metrics.conversions)} conversions at ${usd(r.metrics.cost / r.metrics.conversions)} each in 90 days, against a ${usd(avg!)} average`,
        detail: "Raise its bid adjustment, or give it its own campaign or budget.",
        cost: r.metrics.cost,
        decision: null,
      })
    }
  } else notes.push(`Locations couldn't be read: ${why(places.e)}`)

  // 5. Budget.
  const monthly = data.budget.monthly
  const cpd = costPerDeal?.value ?? null
  if (cpd !== null) {
    const step = Math.round(rules.budgetStep * 100)
    const pace = pacing.ok ? pacing.v : null
    const lost = pace ? Math.max(0, ...pace.campaigns.filter((c) => c.status === "ENABLED").map((c) => c.lostToBudget ?? 0)) : 0
    const base = `${usd(cpd)} ad spend per closed deal over 12 months (${costPerDeal!.deals} deals), target ${usd(rules.targetLow)}–${usd(rules.targetHigh)}`
    const p = (action: Proposal["action"], title: string, detail: string): Proposal => ({
      id: "budget",
      kind: "budget",
      action,
      title,
      number: base,
      detail,
      cost: 0,
      decision: null,
    })
    if (cpd < rules.targetLow)
      proposals.push(
        p(
          "raise",
          monthly ? `Raise the monthly budget ${step}%: ${usd(monthly)} → ${usd(monthly * (1 + rules.budgetStep))}` : `Raise the budget ${step}%`,
          `Deals cost less than the target, so there's room to buy more.${lost > 0.1 ? ` Campaigns lost up to ${Math.round(lost * 100)}% of searches to budget this month.` : ""} Change daily budgets once, not day by day.`,
        ),
      )
    else if (cpd > rules.targetHigh)
      proposals.push(
        p(
          "lower",
          monthly ? `Lower the monthly budget ${step}%: ${usd(monthly)} → ${usd(monthly * (1 - rules.budgetStep))}` : `Lower the budget ${step}%`,
          "Deals cost more than the target. Block the waste above first; lower the budget if it's still over next week.",
        ),
      )
    else proposals.push(p("hold", "No budget change", "Ad spend per deal is inside the target."))
  } else
    notes.push(
      costPerDeal
        ? "No budget proposal: no closed deals in the last 12 months to judge it by."
        : "No budget proposal: there's no closed-deal count to judge it by (link the spreadsheet on Deal History).",
    )

  // The check on itself.
  const checks: { ok: boolean; text: string }[] = []
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(a) * 0.01)
  if (campaignsWeek.ok) {
    const byCampaign = sumMetrics(campaignsWeek.v).cost
    checks.push(
      close(byCampaign, weekN.cost)
        ? { ok: true, text: `Last week's spend adds up both ways: ${usd(weekN.cost)} by day, ${usd(byCampaign)} by campaign.` }
        : {
            ok: false,
            text: `Last week's spend doesn't add up: ${usd(weekN.cost)} by day but ${usd(byCampaign)} by campaign. The by-day total is used; Google may still be updating the last day.`,
          },
    )
  }
  const longFromWeeks = dailyLong.filter((d) => d.date >= week.from).reduce((s, d) => s + d.metrics.cost, 0)
  checks.push(
    close(longFromWeeks, weekN.cost)
      ? { ok: true, text: `The 90-day numbers include last week's ${usd(weekN.cost)} exactly.` }
      : { ok: false, text: `The 90-day report has ${usd(longFromWeeks)} for last week against ${usd(weekN.cost)}: Google updated in between.` },
  )
  const blockCost = proposals.filter((p) => p.kind === "block").reduce((s, p) => s + p.cost, 0)
  checks.push(
    blockCost <= weekN.cost + 1
      ? {
          ok: true,
          text: `Searches to block cost ${usd(blockCost)}, ${weekN.cost ? Math.round((blockCost / weekN.cost) * 100) : 0}% of last week's spend.`,
        }
      : {
          ok: false,
          text: `Searches to block add up to ${usd(blockCost)}, more than last week's ${usd(weekN.cost)}: some searches count under two negatives.`,
        },
  )
  // Corrections: a block that would stop a keyword we're about to add, or a city both dropped and pushed.
  const adds = proposals.filter((p) => p.kind === "add" && p.idea)
  for (const b of proposals.filter((p) => p.kind === "block" && p.block)) {
    const clash = adds.find((a) => blocks(b.block!.negative, b.block!.matchType, a.idea!.text))
    if (clash) {
      proposals.splice(proposals.indexOf(b), 1)
      checks.push({ ok: false, text: `Corrected: took out ${b.title}, it would block ${clash.title.replace(/^Add /, "")}, which converted.` })
    }
  }
  const pausing = new Set(proposals.filter((p) => p.kind === "pause").map((p) => p.keyword!.text.toLowerCase()))
  for (const a of proposals.filter((p) => p.kind === "add" && pausing.has(p.idea!.text.toLowerCase()))) {
    proposals.splice(proposals.indexOf(a), 1)
    checks.push({ ok: false, text: `Corrected: took out ${a.title}, the same keyword is proposed for pausing.` })
  }
  if (!checks.some((c) => c.text.startsWith("Corrected")))
    checks.push({ ok: true, text: "No proposal contradicts another (no block stops a keyword to add, no keyword both added and paused)." })

  return {
    id: week.id,
    week: weekN,
    long: longN,
    costPerDeal,
    monthlyBudget: monthly,
    rules,
    proposals,
    checks,
    notes,
    made: { by, at: new Date().toISOString() },
    dryRun: rules.dryRun,
  }
}

// Made once a week by the server on its own (instrumentation.ts), from Monday 7 AM Pacific: if
// last week has no review yet, it makes one.
export async function makeReviewIfDue(): Promise<void> {
  const week = reviewWeek()
  if ((await getReviews()).reviews.some((r) => r.id === week.id)) return
  const review = await makeReview("DealTrack (automatic)")
  await updateReviews((f) => {
    if (f.reviews.some((r) => r.id === review.id)) return false
    f.reviews.push(review)
  })
}

// Plain text of a review, for the AI summary and for copying.
export function reviewText(r: WeeklyReview): string {
  const p = (n: PeriodNumbers) =>
    `spend ${usd(n.cost)}, ${n.clicks} clicks, ${conv(n.conversions)} Google conversions, ${n.leads} leads (${n.qualified} qualified, ${n.closed} closed), ${n.calls60} calls of 60s+`
  const kinds: [ProposalKind, string][] = [
    ["add", "1. New search terms to add as keywords"],
    ["block", "2. Search terms to block"],
    ["pause", "3. Keywords to pause"],
    ["city", "4. Cities to drop or push"],
    ["budget", "5. Budget change"],
  ]
  return [
    `Week ${r.week.from} to ${r.week.to}: ${p(r.week)}.`,
    `Last 90 days (${r.long.from} to ${r.long.to}): ${p(r.long)}.`,
    r.costPerDeal
      ? `Ad spend per closed deal, ${r.costPerDeal.from} to ${r.costPerDeal.to}: ${r.costPerDeal.value === null ? "no deals" : usd(r.costPerDeal.value)} (${usd(r.costPerDeal.spend)} / ${r.costPerDeal.deals} deals). Target ${usd(r.rules.targetLow)}–${usd(r.rules.targetHigh)}.`
      : "Ad spend per closed deal: unknown.",
    ...kinds.flatMap(([k, label]) => {
      const list = r.proposals.filter((x) => x.kind === k)
      return [
        label,
        ...(list.length
          ? list.map((x) => `- ${x.title}: ${x.number}${x.decision === false ? " (rejected)" : x.decision ? " (approved)" : ""}`)
          : ["- None"]),
      ]
    }),
    "Self-check:",
    ...r.checks.map((c) => `- ${c.text}`),
    ...(r.notes.length ? ["Not available:", ...r.notes.map((n) => `- ${n}`)] : []),
  ].join("\n")
}
