// The weekly negative keyword routine, in five steps:
//   1. Draft: a period's search terms (last week by default; any dates, one campaign or all) that match a rule in negatives.ts and brought no
//      conversions, grouped into one line per negative keyword, with the evidence.
//   2. Review: each line's evidence holds up, or it's dropped.
//   3. Approve: each reviewed line is approved or rejected.
//   4. Push (admin): the approved lines go to Google Ads in one change. One batch a week, so
//      Google's learning isn't shaken up by constant changes (the brake check).
//   5. Check (a week later): did spend on the blocked searches stop, and did leads hold up?
// Batches and every step's name and time are saved on this computer (lib/store.ts).

import { addDays, dayOf, today, type DateRange } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { getSeries } from "@/lib/google-ads/overview"
import { getSearchTerms, type SearchTermRow } from "@/lib/google-ads/reports"
import { SELLER_INTENT, blocks } from "@/lib/negatives"
import { BUY_AREA_WORDS } from "@/lib/service-area"
import type { BatchItem, BatchResult, HeldBack, NegativeBatch } from "@/lib/store"

export const LOOKBACK_DAYS = 90 // searches a new negative must not block: ones that converted, or sellers
export const BRAKE_DAYS = 7 // at most one push per week
export const TERMS_SHOWN = 5
export const MAX_DRAFT_DAYS = 366

type Num = string | number | undefined

export type Week = { id: string; from: string; to: string }

export function mondayOf(iso: string) {
  return addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7))
}

// The last `n` complete Monday–Sunday weeks, newest first.
export function completeWeeks(n: number): Week[] {
  const thisMonday = mondayOf(today())
  return Array.from({ length: n }, (_, i) => {
    const from = addDays(thisMonday, -7 * (i + 1))
    return { id: from, from, to: addDays(from, 6) }
  })
}

const range = (from: string, to: string): DateRange => ({ from, to, label: `${from} – ${to}` })

// What a batch drafts from: search terms between two dates, from one campaign or all of them.
export type Scope = { from: string; to: string; campaignId?: string }

// A plain all-campaigns Monday–Sunday week keeps the Monday as its id (what the Overview looks
// for); any other period or a single campaign gets its own id, so each can have one batch.
export function batchId({ from, to, campaignId }: Scope) {
  const plainWeek = !campaignId && mondayOf(from) === from && addDays(from, 6) === to
  return plainWeek ? from : `${from}_${to}${campaignId ? `_c${campaignId}` : ""}`
}

// Negatives already on the campaign (any status), or on running campaigns when drafting from all,
// directly or through their shared lists.
async function existingNegatives(campaignId?: string): Promise<Set<string>> {
  const which = campaignId ? `campaign.id = ${campaignId}` : "campaign.status = 'ENABLED'"
  const [direct, lists] = await Promise.all([
    gaql<{ campaignCriterion: { keyword?: { text?: string } } }>(
      `SELECT campaign_criterion.keyword.text FROM campaign_criterion
       WHERE ${which} AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`,
    ),
    gaql<{ sharedSet: { id?: Num } }>(
      `SELECT shared_set.id FROM campaign_shared_set
       WHERE ${which} AND campaign_shared_set.status = 'ENABLED' AND shared_set.type = 'NEGATIVE_KEYWORDS'`,
    ),
  ])
  const ids = [...new Set(lists.map((l) => String(l.sharedSet.id ?? "")).filter((id) => /^\d+$/.test(id)))]
  const shared = ids.length
    ? await gaql<{ sharedCriterion: { keyword?: { text?: string } } }>(
        `SELECT shared_criterion.keyword.text FROM shared_criterion WHERE shared_set.id IN (${ids.join(", ")})`,
      )
    : []
  return new Set(
    [...direct.map((d) => d.campaignCriterion.keyword?.text), ...shared.map((s) => s.sharedCriterion.keyword?.text)]
      .filter((t): t is string => !!t)
      .map((t) => t.toLowerCase().trim()),
  )
}

// Words the word-level analysis never suggests: filler, and what every seller search says.
const COMMON = new Set(
  ("a an the to for in of on at by near me my i we you your our it is are be do does can how what where who why when which with without from and or vs " +
    "house houses home homes property properties ca california usa best top cheap fast quick quickly now today get online local area " +
    "sell sells selling sold sale buy buys buying buyer buyers cash offer offers company companies investor investors estate real " +
    "someone people anyone condition").split(" "),
)
const MIN_WORD_SPEND = 50 // a word needs this much spend in the period, across 2+ searches…
const MAX_WORD_LINES = 10

// Words (and two-word phrases) in last week's searches that cost money and never converted in the
// last 90 days, and aren't a buy-area place, a keyword we bid on, or seller language: Optmyzr's
// n-gram waste analysis. "sell my timeshare" makes "timeshare" a candidate. These need a
// review like every other line.
function wasteWords(week: SearchTermRow[], history: SearchTermRow[], keywordWords: Set<string>) {
  const grams = new Map<string, { cost: number; clicks: number; terms: SearchTermRow[] }>()
  for (const t of week) {
    if (t.rule || t.metrics.conversions > 0 || t.status.includes("EXCLUDED") || !t.metrics.cost) continue
    const words = t.term.toLowerCase().split(/\s+/).filter(Boolean)
    const seen = new Set<string>()
    for (let n = 1; n <= 2; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n)
        if (gram.some((w) => !/^[a-z][a-z'&.-]{2,}$/.test(w) || COMMON.has(w) || BUY_AREA_WORDS.has(w) || keywordWords.has(w))) continue
        const key = gram.join(" ")
        if (seen.has(key)) continue
        seen.add(key)
        const g = grams.get(key) ?? { cost: 0, clicks: 0, terms: [] }
        g.cost += t.metrics.cost
        g.clicks += t.metrics.clicks
        g.terms.push(t)
        grams.set(key, g)
      }
    }
  }
  const safe = [...grams.entries()]
    .filter(([, g]) => g.cost >= MIN_WORD_SPEND && g.terms.length >= 2)
    .filter(([gram]) => !history.some((t) => blocks(gram, "PHRASE", t.term) && t.metrics.conversions > 0))
    .sort((a, b) => b[1].cost - a[1].cost)
  // A single word covers the two-word phrases that contain it.
  const singles = new Set(safe.filter(([gram]) => !gram.includes(" ")).map(([gram]) => gram))
  return safe.filter(([gram]) => !gram.includes(" ") || !gram.split(" ").some((w) => singles.has(w))).slice(0, MAX_WORD_LINES)
}

async function keywordWordsInUse(): Promise<Set<string>> {
  const rows = await gaql<{ adGroupCriterion: { keyword?: { text?: string } } }>(
    `SELECT ad_group_criterion.keyword.text FROM ad_group_criterion
     WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status = 'ENABLED'
       AND ad_group.status = 'ENABLED' AND campaign.status IN ('ENABLED', 'PAUSED')`,
  )
  return new Set(rows.flatMap((r) => (r.adGroupCriterion.keyword?.text ?? "").toLowerCase().split(/\s+/)).filter(Boolean))
}

export type Draft = Pick<NegativeBatch, "items" | "heldBack" | "alreadyNegative">

// The searches a new negative must not block, from every campaign: the 90 days up to the end of
// the period, and the last 90 days (the same window when the period is recent).
async function lookback(to: string): Promise<SearchTermRow[]> {
  const recent = addDays(today(), -(LOOKBACK_DAYS - 1))
  const before = addDays(to, -(LOOKBACK_DAYS - 1))
  if (to >= recent) return getSearchTerms(range(before < recent ? before : recent, today()))
  const [then, now] = await Promise.all([getSearchTerms(range(before, to)), getSearchTerms(range(recent, today()))])
  return [...then, ...now]
}

export async function draftBatch(scope: Scope): Promise<Draft> {
  const [terms, history, existing, keywordWords] = await Promise.all([
    getSearchTerms(range(scope.from, scope.to), scope.campaignId),
    lookback(scope.to),
    existingNegatives(scope.campaignId),
    keywordWordsInUse(),
  ])

  // One line per suggested negative, from searches that cost money and brought nothing.
  const groups = new Map<string, { why: string; evenForSellers: boolean; rows: SearchTermRow[] }>()
  for (const t of terms) {
    if (!t.rule || !t.suggestion || t.metrics.conversions > 0 || t.status.includes("EXCLUDED")) continue
    if (!(t.metrics.clicks > 0 || t.metrics.cost > 0)) continue
    const g = groups.get(t.suggestion) ?? { why: t.rule.reason, evenForSellers: !!t.rule.evenForSellers, rows: [] }
    g.rows.push(t)
    groups.set(t.suggestion, g)
  }

  const items: BatchItem[] = []
  const heldBack: HeldBack[] = []
  const alreadyNegative: string[] = []
  for (const [negative, g] of groups) {
    if (existing.has(negative)) {
      alreadyNegative.push(negative)
      continue
    }
    // Never block a search that converted, or (except for competitors and cities) one that says "sell".
    const risky = history.filter(
      (t) => blocks(negative, "PHRASE", t.term) && (t.metrics.conversions > 0 || (!g.evenForSellers && SELLER_INTENT.test(t.term))),
    )
    if (risky.length) {
      heldBack.push({ negative, why: g.why, converting: risky.sort((a, b) => b.metrics.conversions - a.metrics.conversions).slice(0, TERMS_SHOWN).map((t) => t.term) })
      continue
    }
    const rows = [...g.rows].sort((a, b) => b.metrics.cost - a.metrics.cost)
    items.push({
      negative,
      matchType: "PHRASE",
      why: g.why,
      terms: rows.slice(0, TERMS_SHOWN).map((r) => r.term),
      termCount: rows.length,
      clicks: rows.reduce((s, r) => s + r.metrics.clicks, 0),
      cost: rows.reduce((s, r) => s + r.metrics.cost, 0),
      conversions: 0,
      proven: null,
      approved: null,
    })
  }
  for (const [word, g] of wasteWords(terms, history, keywordWords)) {
    if (existing.has(word) || items.some((i) => i.negative === word)) continue
    const rows = [...g.terms].sort((a, b) => b.metrics.cost - a.metrics.cost)
    items.push({
      negative: word,
      matchType: "PHRASE",
      why: "Word in searches that never converted in 90 days (check it's not something sellers say)",
      terms: rows.slice(0, TERMS_SHOWN).map((r) => r.term),
      termCount: rows.length,
      clicks: g.clicks,
      cost: g.cost,
      conversions: 0,
      proven: null,
      approved: null,
    })
  }
  items.sort((a, b) => b.cost - a.cost || b.clicks - a.clicks)
  return { items, heldBack, alreadyNegative: alreadyNegative.sort() }
}

export const pushedLines = (b: NegativeBatch) => b.items.filter((i) => i.proven && i.approved)

export type Stage = "empty" | "proving" | "approving" | "ready" | "nothing-approved" | "pushed" | "checked"

export function stageOf(b: NegativeBatch): Stage {
  if (b.checked) return "checked"
  if (b.pushed) return "pushed"
  if (!b.items.length) return "empty"
  if (!b.proven) return "proving"
  if (!b.approved) return b.items.some((i) => i.proven) ? "approving" : "nothing-approved"
  return pushedLines(b).length ? "ready" : "nothing-approved"
}

// The brake: when the last push was, and when the next one is allowed.
export function brake(batches: NegativeBatch[], except?: string): { last: string; nextDay: string } | null {
  const last = batches
    .filter((b) => b.pushed && !b.pushed.dryRun && b.id !== except)
    .map((b) => b.pushed!.at)
    .sort()
    .at(-1)
  if (!last) return null
  const nextDay = addDays(dayOf(last), BRAKE_DAYS)
  return today() < nextDay ? { last, nextDay } : null
}

// A week after the push: the week before it against the week after it (push day left out).
export function checkDay(b: NegativeBatch) {
  return b.pushed ? addDays(dayOf(b.pushed.at), BRAKE_DAYS + 1) : null
}

export async function measure(b: NegativeBatch): Promise<BatchResult> {
  const day = dayOf(b.pushed!.at)
  const before = range(addDays(day, -7), addDays(day, -1))
  const after = range(addDays(day, 1), addDays(day, 7))
  const lines = pushedLines(b)
  const [termsBefore, termsAfter, daysBefore, daysAfter] = await Promise.all([
    getSearchTerms(before),
    getSearchTerms(after),
    getSeries(before, "day"),
    getSeries(after, "day"),
  ])
  const blockedCost = (terms: SearchTermRow[]) =>
    terms.filter((t) => lines.some((l) => blocks(l.negative, l.matchType, t.term))).reduce((s, t) => s + t.metrics.cost, 0)
  const total = (days: { cost: number; leads: number }[], f: "cost" | "leads") => days.reduce((s, d) => s + d[f], 0)
  return {
    blockedSpendBefore: blockedCost(termsBefore),
    blockedSpendAfter: blockedCost(termsAfter),
    spendBefore: total(daysBefore, "cost"),
    spendAfter: total(daysAfter, "cost"),
    leadsBefore: total(daysBefore, "leads"),
    leadsAfter: total(daysAfter, "leads"),
  }
}
