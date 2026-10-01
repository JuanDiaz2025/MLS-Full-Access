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
import type { BatchItem, BatchResult, CampaignShare, HeldBack, NegativeBatch } from "@/lib/store"

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

type MatchType = "PHRASE" | "EXACT" | "BROAD"
// A negative already in Google Ads, and where it applies: one ad group, one campaign, or (with
// neither) the whole account.
export type ExistingNegative = { text: string; matchType: MatchType; campaignId?: string; adGroupId?: string }

const matchTypeOf = (m?: string): MatchType => (m === "EXACT" ? "EXACT" : m === "BROAD" ? "BROAD" : "PHRASE")
const idList = (ids: string[]) => [...new Set(ids)].filter((id) => /^\d+$/.test(id)).join(", ")

// Every negative keyword that applies to these campaigns, whatever their status: on the campaign,
// on its ad groups, in negative lists attached to it, and in account-wide lists.
export async function existingNegatives(campaignIds: string[]): Promise<ExistingNegative[]> {
  const ids = idList(campaignIds)
  if (!ids) return []
  type Kw = { text?: string; matchType?: string }
  const [direct, adGroups, lists, account] = await Promise.all([
    gaql<{ campaign: { id?: Num }; campaignCriterion: { keyword?: Kw } }>(
      `SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion
       WHERE campaign.id IN (${ids}) AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'
         AND campaign_criterion.status != 'REMOVED'`,
    ),
    gaql<{ campaign: { id?: Num }; adGroup: { id?: Num }; adGroupCriterion: { keyword?: Kw } }>(
      `SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion
       WHERE campaign.id IN (${ids}) AND ad_group_criterion.negative = TRUE AND ad_group_criterion.type = 'KEYWORD'
         AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'`,
    ),
    gaql<{ campaign: { id?: Num }; sharedSet: { id?: Num } }>(
      `SELECT campaign.id, shared_set.id FROM campaign_shared_set
       WHERE campaign.id IN (${ids}) AND campaign_shared_set.status = 'ENABLED' AND shared_set.type = 'NEGATIVE_KEYWORDS'`,
    ),
    // Account-wide negative lists (Tools > Shared library, applied at the account level).
    gaql<{ customerNegativeCriterion: { negativeKeywordList?: { sharedSet?: string } } }>(
      `SELECT customer_negative_criterion.negative_keyword_list.shared_set FROM customer_negative_criterion
       WHERE customer_negative_criterion.type = 'NEGATIVE_KEYWORD_LIST'`,
    ).catch(() => []),
  ])
  const accountLists = account.map((a) => a.customerNegativeCriterion.negativeKeywordList?.sharedSet?.split("/").pop() ?? "")
  const listIds = idList([...lists.map((l) => String(l.sharedSet.id ?? "")), ...accountLists])
  const shared = listIds
    ? await gaql<{ sharedSet: { id?: Num }; sharedCriterion: { keyword?: Kw } }>(
        `SELECT shared_set.id, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion
         WHERE shared_set.id IN (${listIds}) AND shared_criterion.type = 'KEYWORD'`,
      )
    : []
  const out: ExistingNegative[] = []
  const push = (kw: Kw | undefined, where: Omit<ExistingNegative, "text" | "matchType">) => {
    if (kw?.text) out.push({ text: kw.text.toLowerCase().trim(), matchType: matchTypeOf(kw.matchType), ...where })
  }
  for (const d of direct) push(d.campaignCriterion.keyword, { campaignId: String(d.campaign.id) })
  for (const a of adGroups) push(a.adGroupCriterion.keyword, { campaignId: String(a.campaign.id), adGroupId: String(a.adGroup.id) })
  const accountWide = new Set(accountLists)
  const listCampaigns = new Map<string, string[]>()
  for (const l of lists) {
    const id = String(l.sharedSet.id)
    listCampaigns.set(id, [...(listCampaigns.get(id) ?? []), String(l.campaign.id)])
  }
  for (const c of shared) {
    const id = String(c.sharedSet.id)
    if (accountWide.has(id)) push(c.sharedCriterion.keyword, {})
    for (const campaignId of listCampaigns.get(id) ?? []) push(c.sharedCriterion.keyword, { campaignId })
  }
  return out
}

const shown = (n: ExistingNegative) => (n.matchType === "EXACT" ? `[${n.text}]` : n.matchType === "BROAD" ? n.text : `"${n.text}"`)

// Takes out what existing negatives already block, using Google's matching rules: a search is
// dropped from each campaign and ad group where a negative there (or account-wide) blocks it, so
// "john" covers "john buys", but [opendoor] only covers the search "opendoor". Returns the
// searches still getting through (with only the spend that's still open) and the negatives that
// cover the rest.
export function stillOpen(terms: SearchTermRow[], existing: ExistingNegative[]) {
  // Only negatives whose first word is in the search can block it.
  const byFirstWord = new Map<string, ExistingNegative[]>()
  for (const e of existing) {
    const first = e.text.split(/\s+/)[0]
    byFirstWord.set(first, [...(byFirstWord.get(first) ?? []), e])
  }
  const covering = new Set<string>()
  const open: SearchTermRow[] = []
  for (const t of terms) {
    const candidates = [...new Set(t.term.toLowerCase().split(/\s+/))].flatMap((w) => byFirstWord.get(w) ?? [])
    const placements = t.placements.filter((p) => {
      const by = candidates.find(
        (e) => (!e.campaignId || e.campaignId === p.campaignId) && (!e.adGroupId || e.adGroupId === p.adGroupId) && blocks(e.text, e.matchType, t.term),
      )
      if (by && (t.metrics.cost > 0 || t.metrics.clicks > 0)) covering.add(shown(by))
      return !by
    })
    if (!placements.length) continue
    const cost = placements.reduce((s, p) => s + p.cost, 0)
    const clicks = placements.reduce((s, p) => s + p.clicks, 0)
    open.push(placements.length === t.placements.length ? t : { ...t, placements, metrics: { ...t.metrics, cost, clicks } })
  }
  return { open, covering: [...covering].sort() }
}

// The campaigns a line's searches came from, costliest first.
export function campaignsOf(rows: SearchTermRow[]): CampaignShare[] {
  const by = new Map<string, CampaignShare>()
  for (const p of rows.flatMap((r) => r.placements)) {
    const c = by.get(p.campaignId) ?? { id: p.campaignId, name: p.campaign, cost: 0 }
    c.cost += p.cost
    by.set(p.campaignId, c)
  }
  const all = [...by.values()].sort((a, b) => b.cost - a.cost)
  const paid = all.filter((c) => c.cost >= 0.5)
  return paid.length ? paid : all
}

// Words the word-level analysis never suggests: filler, and what every seller search says.
const COMMON = new Set(
  ("a an the to for in of on at by near me my i we you your our it is are be do does can how what where who why when which with without from and or vs " +
    "house houses home homes property properties ca california usa best top cheap fast quick quickly now today get online local area " +
    "sell sells selling sold sale buy buys buying buyer buyers cash offer offers company companies investor investors estate real " +
    "someone people anyone condition work works process looking own year years").split(" "),
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
    if (t.rule || t.metrics.conversions > 0 || !t.metrics.cost) continue
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

// The keywords each campaign bids on (paused ones too), and every word in them.
export async function keywordsInUse(): Promise<{ byCampaign: Map<string, string[]>; words: Set<string> }> {
  const rows = await gaql<{ campaign: { id?: Num }; adGroupCriterion: { keyword?: { text?: string } } }>(
    `SELECT campaign.id, ad_group_criterion.keyword.text FROM ad_group_criterion
     WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'
       AND ad_group.status != 'REMOVED' AND campaign.status IN ('ENABLED', 'PAUSED')`,
  )
  const byCampaign = new Map<string, string[]>()
  for (const r of rows) {
    const text = (r.adGroupCriterion.keyword?.text ?? "").toLowerCase().trim()
    if (!text) continue
    const id = String(r.campaign.id)
    byCampaign.set(id, [...(byCampaign.get(id) ?? []), text])
  }
  return { byCampaign, words: new Set([...byCampaign.values()].flat().flatMap((t) => t.split(/\s+/))) }
}

// A campaign that bids on what a negative blocks wants those searches (a competitor campaign
// bidding on "john buys", a Santa Rosa campaign on "santa rosa"), so the line leaves it out.
function outsideOwnKeywords(negative: string, rows: SearchTermRow[], byCampaign: Map<string, string[]>) {
  const wants = (campaignId: string) => (byCampaign.get(campaignId) ?? []).some((k) => blocks(negative, "PHRASE", k))
  return rows.flatMap((t) => {
    const placements = t.placements.filter((p) => !wants(p.campaignId))
    if (!placements.length) return []
    if (placements.length === t.placements.length) return [t]
    const cost = placements.reduce((s, p) => s + p.cost, 0)
    const clicks = placements.reduce((s, p) => s + p.clicks, 0)
    return [{ ...t, placements, metrics: { ...t.metrics, cost, clicks } }]
  })
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
  const [allTerms, history, keywords] = await Promise.all([
    getSearchTerms(range(scope.from, scope.to), scope.campaignId),
    lookback(scope.to),
    keywordsInUse(),
  ])
  // Checked against the negatives of the campaigns these searches actually came from.
  const existing = await existingNegatives(allTerms.flatMap((t) => t.placements.map((p) => p.campaignId)))
  const { open: terms, covering } = stillOpen(allTerms, existing)

  // One line per suggested negative, from searches that cost money and brought nothing.
  const groups = new Map<string, { why: string; evenForSellers: boolean; rows: SearchTermRow[] }>()
  for (const t of terms) {
    // No status check: "excluded" can mean excluded in just one campaign. stillOpen() already took
    // out the campaigns and ad groups where a negative blocks it.
    if (!t.rule || !t.suggestion || t.metrics.conversions > 0) continue
    if (!(t.metrics.clicks > 0 || t.metrics.cost > 0)) continue
    const g = groups.get(t.suggestion) ?? { why: t.rule.reason, evenForSellers: !!t.rule.evenForSellers, rows: [] }
    g.rows.push(t)
    groups.set(t.suggestion, g)
  }

  const items: BatchItem[] = []
  const heldBack: HeldBack[] = []
  for (const [negative, g] of groups) {
    // Never block a search that converted, or (except for competitors and cities) one that says "sell".
    const risky = history.filter(
      (t) => blocks(negative, "PHRASE", t.term) && (t.metrics.conversions > 0 || (!g.evenForSellers && SELLER_INTENT.test(t.term))),
    )
    if (risky.length) {
      heldBack.push({ negative, why: g.why, converting: risky.sort((a, b) => b.metrics.conversions - a.metrics.conversions).slice(0, TERMS_SHOWN).map((t) => t.term) })
      continue
    }
    const rows = outsideOwnKeywords(negative, g.rows, keywords.byCampaign).sort((a, b) => b.metrics.cost - a.metrics.cost)
    if (!rows.some((r) => r.metrics.cost > 0 || r.metrics.clicks > 0)) continue
    items.push({
      negative,
      matchType: "PHRASE",
      why: g.why,
      terms: rows.slice(0, TERMS_SHOWN).map((r) => r.term),
      termCount: rows.length,
      campaigns: campaignsOf(rows),
      clicks: rows.reduce((s, r) => s + r.metrics.clicks, 0),
      cost: rows.reduce((s, r) => s + r.metrics.cost, 0),
      conversions: 0,
      proven: null,
      approved: null,
    })
  }
  for (const [word, g] of wasteWords(terms, history, keywords.words)) {
    if (items.some((i) => i.negative === word)) continue
    const rows = [...g.terms].sort((a, b) => b.metrics.cost - a.metrics.cost)
    items.push({
      negative: word,
      matchType: "PHRASE",
      why: "Word in searches that never converted in 90 days (check it's not something sellers say)",
      terms: rows.slice(0, TERMS_SHOWN).map((r) => r.term),
      termCount: rows.length,
      campaigns: campaignsOf(rows),
      clicks: g.clicks,
      cost: g.cost,
      conversions: 0,
      proven: null,
      approved: null,
    })
  }
  items.sort((a, b) => b.cost - a.cost || b.clicks - a.clicks)
  return { items, heldBack, alreadyNegative: covering }
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
