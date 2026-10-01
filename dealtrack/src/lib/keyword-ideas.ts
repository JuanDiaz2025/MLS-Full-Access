// Keyword ideas: the opposite of the weekly negatives. Three kinds, most trusted first:
//   proven     searches that converted but aren't keywords yet (exact match, where they converted)
//   phrase     a phrase that several converting searches share (phrase match)
//   situation  seller situations (inherited, probate, divorce, foreclosure…), with how often they
//              already show up in the account's searches
// When the developer token has Basic access, Keyword Planner adds monthly volume and bids for
// California to every idea, plus related ideas ("planner"). With Explorer access it's skipped and
// the batch says so.
// Safety: nothing the negative rules would block (competitors only when asked), nothing a
// negative already blocks there, and nothing the campaign already has as a keyword.

import { addDays, today } from "@/lib/date-range"
import { GoogleAdsError, gaql, keywordIdeas } from "@/lib/google-ads/client"
import { cleanKeyword } from "@/lib/google-ads/changes"
import { getSearchTerms, type SearchTermRow } from "@/lib/google-ads/reports"
import { existingNegatives, type ExistingNegative } from "@/lib/negative-batches"
import { SELLER_INTENT, blocks, matchRule } from "@/lib/negatives"
import type { IdeaSource, IdeaTarget, KeywordBatch, KeywordIdea } from "@/lib/store"

export const IDEA_DAYS = 365 // default period: the last 12 months
const SHOWN = 5
const MAX_PHRASES = 25
const MAX_PLANNER = 25
const CALIFORNIA = "geoTargetConstants/21137"
const ENGLISH = "languageConstants/1000"

export const SOURCE_LABELS: Record<IdeaSource, string> = {
  proven: "Converted already",
  phrase: "Shared by converting searches",
  situation: "Seller situation",
  planner: "Keyword Planner idea",
}

// Seller situations: a keyword to suggest, and what counts as a search about it.
const SITUATIONS: { keyword: string; pattern: RegExp }[] = [
  { keyword: "sell inherited house", pattern: /\binherit\w*/i },
  { keyword: "sell house in probate", pattern: /\bprobate\b/i },
  { keyword: "sell house during divorce", pattern: /\bdivorc\w*/i },
  { keyword: "sell house before foreclosure", pattern: /\b(fore ?clos\w*|pre ?foreclos\w*)/i },
  { keyword: "behind on mortgage payments", pattern: /\bbehind on\b|\bmissed (mortgage )?payments?\b/i },
  { keyword: "sell house with tax lien", pattern: /\b(tax )?liens?\b|\bback taxes\b/i },
  { keyword: "sell fire damaged house", pattern: /\bfire\b/i },
  { keyword: "sell water damaged house", pattern: /\bwater damage\w*|\bflood\w*/i },
  { keyword: "sell house with mold", pattern: /\bmold\w*/i },
  { keyword: "sell hoarder house", pattern: /\bhoard\w*/i },
  { keyword: "sell house with foundation problems", pattern: /\bfoundation\b/i },
  { keyword: "sell house that needs repairs", pattern: /\b(needs? (work|repairs?)|repairs? needed|fixer|run ?down|distressed)\b/i },
  { keyword: "sell house as is", pattern: /\bas[- ]is\b/i },
  { keyword: "sell house with code violations", pattern: /\bcode violations?\b|\bcondemned\b/i },
  { keyword: "sell vacant house", pattern: /\bvacant\b|\bempty house\b/i },
  { keyword: "sell rental property with tenants", pattern: /\btenants?\b|\blandlord\b/i },
  { keyword: "sell house in bankruptcy", pattern: /\bbankrupt\w*/i },
  { keyword: "sell house after death", pattern: /\b(death|died|passed away|deceased|estate sale)\b/i },
  { keyword: "sell house to move to assisted living", pattern: /\b(assisted living|nursing home|senior)\b/i },
  { keyword: "sell house fast relocation", pattern: /\brelocat\w*|\bmoving out of state\b/i },
  { keyword: "sell house without realtor", pattern: /\bwithout (a |an )?(realtor|agent)\b|\bno realtor\b|\bfsbo\b/i },
]

// Words that can't start or end a suggested phrase, so phrases read like keywords.
const EDGE = new Set("a an the to for in of on at by my me i we you your our it is are be do how what where who why with from and or near as that which best".split(" "))
// A phrase has to say something a seller says: sell, cash, an offer, a buyer.
const SELLER_WORDS = /\b(sell\w*|sold|cash|offers?|buy\w*|buyers?)\b/i
const BRAND = /\btwin\b/i

export type Ideas = { items: KeywordIdea[]; skipped: { text: string; why: string }[]; notes: string[] }
// addTo: put every idea into this campaign (its closest ad group) instead of where it converted.
export type IdeaScope = { from: string; to: string; campaignId?: string; addTo?: string; sources: IdeaSource[]; competitors: boolean }

export type AdGroup = { id: string; name: string; campaignId: string; campaignName: string; keywords: string[] }

export const toTarget = (g: AdGroup): IdeaTarget => ({ adGroupId: g.id, adGroupName: g.name, campaignId: g.campaignId, campaignName: g.campaignName })

// Every ad group that can take keywords, with its keywords (any status but removed).
export async function adGroupsWithKeywords(): Promise<AdGroup[]> {
  const [groups, kws] = await Promise.all([
    gaql<{ adGroup: { id?: string | number; name?: string }; campaign: { id?: string | number; name?: string } }>(
      `SELECT ad_group.id, ad_group.name, campaign.id, campaign.name FROM ad_group
       WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED' AND campaign.advertising_channel_type = 'SEARCH'`,
    ),
    gaql<{ adGroup: { id?: string | number }; adGroupCriterion: { keyword?: { text?: string } } }>(
      `SELECT ad_group.id, ad_group_criterion.keyword.text FROM ad_group_criterion
       WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'
         AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`,
    ),
  ])
  const byGroup = new Map<string, string[]>()
  for (const k of kws) {
    const id = String(k.adGroup.id)
    const text = k.adGroupCriterion.keyword?.text?.toLowerCase().trim()
    if (text) byGroup.set(id, [...(byGroup.get(id) ?? []), text])
  }
  return groups.map((g) => ({
    id: String(g.adGroup.id),
    name: g.adGroup.name ?? "",
    campaignId: String(g.campaign.id),
    campaignName: g.campaign.name ?? "",
    keywords: byGroup.get(String(g.adGroup.id)) ?? [],
  }))
}

const words = (t: string) => t.toLowerCase().split(/\s+/).filter(Boolean)

// The ad group whose keywords share the most words with the idea, within the given campaigns.
export function closestGroup(text: string, groups: AdGroup[]): AdGroup | undefined {
  const mine = new Set(words(text))
  let best: { g: AdGroup; score: number } | undefined
  for (const g of groups) {
    const theirs = new Set(g.keywords.flatMap(words))
    if (!theirs.size) continue
    const shared = [...mine].filter((w) => theirs.has(w)).length
    const score = shared / mine.size
    if (shared && (!best || score > best.score)) best = { g, score }
  }
  return best?.g
}

// The ad group in a campaign that fits a keyword best: most shared words, or the campaign's ad
// group with the most keywords when none share a word.
export function groupInCampaign(text: string, campaignGroups: AdGroup[]): AdGroup | undefined {
  return closestGroup(text, campaignGroups) ?? [...campaignGroups].sort((a, b) => b.keywords.length - a.keywords.length)[0]
}

// Where the searches an idea covers converted (or cost) the most.
function bestPlacement(rows: SearchTermRow[]) {
  const by = new Map<string, { campaignId: string; campaign: string; adGroupId: string; adGroup: string; conversions: number; cost: number }>()
  for (const p of rows.flatMap((r) => r.placements)) {
    const key = p.adGroupId
    const g = by.get(key) ?? { campaignId: p.campaignId, campaign: p.campaign, adGroupId: p.adGroupId, adGroup: p.adGroup, conversions: 0, cost: 0 }
    g.conversions += p.conversions
    g.cost += p.cost
    by.set(key, g)
  }
  return [...by.values()].sort((a, b) => b.conversions - a.conversions || b.cost - a.cost)[0]
}

function evidence(rows: SearchTermRow[]) {
  const sorted = [...rows].sort((a, b) => b.metrics.conversions - a.metrics.conversions || b.metrics.cost - a.metrics.cost)
  return {
    searches: sorted.slice(0, SHOWN).map((r) => r.term),
    searchCount: rows.length,
    impressions: rows.reduce((s, r) => s + r.metrics.impressions, 0),
    clicks: rows.reduce((s, r) => s + r.metrics.clicks, 0),
    cost: rows.reduce((s, r) => s + r.metrics.cost, 0),
    conversions: rows.reduce((s, r) => s + r.metrics.conversions, 0),
  }
}

export async function draftIdeas(scope: IdeaScope): Promise<Ideas> {
  const [terms, groups] = await Promise.all([getSearchTerms({ from: scope.from, to: scope.to, label: "" }, scope.campaignId), adGroupsWithKeywords()])
  const notes: string[] = []
  const skipped: { text: string; why: string }[] = []
  const candidates: { text: string; matchType: "EXACT" | "PHRASE"; source: IdeaSource; why: string; rows: SearchTermRow[]; group?: AdGroup }[] = []
  const groupById = new Map(groups.map((g) => [g.id, g]))
  // Ideas without evidence go to the campaigns in scope: the chosen one, or the ones searches came from.
  const scopeCampaigns = new Set(scope.campaignId ? [scope.campaignId] : terms.flatMap((t) => t.placements.map((p) => p.campaignId)))
  const scopeGroups = groups.filter((g) => scopeCampaigns.has(g.campaignId))

  if (scope.sources.includes("proven")) {
    for (const t of terms) {
      if (t.metrics.conversions <= 0 || t.status.includes("ADDED") || BRAND.test(t.term)) continue
      candidates.push({
        text: t.term.toLowerCase(),
        matchType: "EXACT",
        source: "proven",
        why: `${fmt(t.metrics.conversions)} conversion${t.metrics.conversions === 1 ? "" : "s"} from this exact search`,
        rows: [t],
      })
    }
  }

  if (scope.sources.includes("phrase")) {
    const converting = terms.filter((t) => t.metrics.conversions > 0)
    const grams = new Map<string, SearchTermRow[]>()
    for (const t of converting) {
      const w = words(t.term)
      const seen = new Set<string>()
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= w.length; i++) {
          const gram = w.slice(i, i + n)
          if (EDGE.has(gram[0]) || EDGE.has(gram[gram.length - 1])) continue
          const key = gram.join(" ")
          if (seen.has(key)) continue
          seen.add(key)
          grams.set(key, [...(grams.get(key) ?? []), t])
        }
      }
    }
    // Not a fragment of the brand or a competitor: most of the searches it comes from aren't those.
    const ownSearch = (t: SearchTermRow) => !BRAND.test(t.term) && matchRule(t.term)?.id !== "competitor"
    const shared = [...grams.entries()]
      .filter(([gram, rows]) => rows.length >= 2 && SELLER_WORDS.test(gram) && !BRAND.test(gram) && rows.filter(ownSearch).length / rows.length > 0.5)
      .map(([gram]) => ({ gram, rows: terms.filter((t) => blocks(gram, "PHRASE", t.term)) }))
      .sort((a, b) => conversionsOf(b.rows) - conversionsOf(a.rows))
    // As phrase match, "buy homes" already covers "buy homes for cash", so a longer phrase that
    // contains one already kept adds nothing.
    const kept: typeof shared = []
    for (const s of shared) {
      if (kept.some((k) => blocks(k.gram, "PHRASE", s.gram))) continue
      kept.push(s)
      if (kept.length >= MAX_PHRASES) break
    }
    for (const { gram, rows } of kept) {
      const c = conversionsOf(rows)
      candidates.push({
        text: gram,
        matchType: "PHRASE",
        source: "phrase",
        why: `In ${rows.filter((r) => r.metrics.conversions > 0).length} searches that converted (${fmt(c)} conversions in all)`,
        rows,
      })
    }
  }

  if (scope.sources.includes("situation")) {
    for (const s of SITUATIONS) {
      const rows = terms.filter((t) => s.pattern.test(t.term))
      const c = conversionsOf(rows)
      candidates.push({
        text: s.keyword,
        matchType: "PHRASE",
        source: "situation",
        why: rows.length
          ? `${rows.length} search${rows.length === 1 ? "" : "es"} about this in the period${c ? `, ${fmt(c)} conversions` : ", no conversion yet"}`
          : "Not searched in this period yet: an untested idea",
        rows,
      })
    }
  }

  // Keyword Planner: volume and bids for every idea, plus related ideas. Needs Basic access.
  let planner = new Map<string, { volume?: number; lowBid?: number; highBid?: number; competition?: string }>()
  if (scope.sources.includes("planner") || candidates.length) {
    const seeds = [...new Set([...candidates.filter((c) => c.source !== "situation" || c.rows.length).map((c) => c.text), ...SITUATIONS.map((s) => s.keyword)])].slice(0, 20)
    try {
      const ideas = await plannerIdeas(seeds)
      planner = new Map(ideas.map((i) => [i.text, i]))
      if (scope.sources.includes("planner")) {
        for (const i of ideas.filter((i) => SELLER_INTENT.test(i.text) && (i.volume ?? 0) >= 10).slice(0, MAX_PLANNER)) {
          candidates.push({ text: i.text, matchType: "PHRASE", source: "planner", why: "Related search from Keyword Planner", rows: terms.filter((t) => blocks(i.text, "PHRASE", t.term)) })
        }
      }
    } catch (e) {
      const explorer = e instanceof GoogleAdsError && /explorer access|basic or standard access/i.test(`${e.message} ${e.detail ?? ""}`)
      notes.push(
        explorer
          ? "Keyword Planner isn't available yet: the Google Ads developer token has Explorer access. Apply for Basic access (Google Ads > Tools > API Center) to add monthly searches, bids, and related ideas."
          : `Keyword Planner didn't answer, so there are no monthly searches or bids this time${e instanceof Error ? ` (${e.message})` : ""}.`,
      )
    }
  }

  // Where each idea goes: the chosen campaign's closest ad group, or where its searches converted,
  // or the closest ad group in scope.
  const addGroups = scope.addTo ? groups.filter((g) => g.campaignId === scope.addTo) : []
  if (scope.addTo && !addGroups.length) notes.push("That campaign has no ad groups yet, so choose where each keyword goes in its line.")
  const targetCampaigns = new Set<string>()
  for (const c of candidates) {
    if (scope.addTo) c.group = groupInCampaign(c.text, addGroups)
    else {
      const best = c.rows.length ? bestPlacement(c.rows) : undefined
      c.group = (best && groupById.get(best.adGroupId)) || closestGroup(c.text, scopeGroups)
    }
    if (c.group) targetCampaigns.add(c.group.campaignId)
  }
  const negatives = await existingNegatives([...targetCampaigns])

  const items: KeywordIdea[] = []
  const taken = new Set<string>()
  for (const c of candidates) {
    const text = cleanKeyword(c.text)
    if (!text) {
      skipped.push({ text: c.text, why: "Can't be a keyword (symbols Google doesn't take)" })
      continue
    }
    if (taken.has(`${text}|${c.matchType}`)) continue
    const rule = matchRule(text)
    if (rule && !(rule.id === "competitor" && scope.competitors)) {
      skipped.push({ text, why: rule.id === "competitor" ? "Competitor name (turn on competitors to include)" : `The negative rules block it: ${rule.reason.toLowerCase()}` })
      continue
    }
    const g = c.group
    const campaignKeywords = g ? groups.filter((x) => x.campaignId === g.campaignId).flatMap((x) => x.keywords) : []
    if (campaignKeywords.includes(text)) {
      skipped.push({ text, why: `Already a keyword in ${g!.campaignName}` })
      continue
    }
    const blockedBy = g && negatives.find((n: ExistingNegative) => (!n.campaignId || n.campaignId === g.campaignId) && (!n.adGroupId || n.adGroupId === g.id) && blocks(n.text, n.matchType, text))
    if (blockedBy) {
      skipped.push({ text, why: `A negative in ${g!.campaignName} blocks it ("${blockedBy.text}")` })
      continue
    }
    taken.add(`${text}|${c.matchType}`)
    const p = planner.get(text)
    items.push({
      text,
      matchType: c.matchType,
      source: c.source,
      why: c.why,
      targets: g ? [toTarget(g)] : [],
      ...evidence(c.rows),
      ...(p ?? {}),
      proven: null,
      approved: null,
    })
  }

  const uniqueSkipped = [...new Map(skipped.map((x) => [x.text, x])).values()]
  const rank: Record<IdeaSource, number> = { proven: 0, phrase: 1, situation: 2, planner: 3 }
  items.sort((a, b) => rank[a.source] - rank[b.source] || b.conversions - a.conversions || (b.volume ?? 0) - (a.volume ?? 0) || b.impressions - a.impressions)
  return { items, skipped: uniqueSkipped, notes }
}

const conversionsOf = (rows: SearchTermRow[]) => rows.reduce((s, r) => s + r.metrics.conversions, 0)
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

type PlannerIdea = { text: string; volume?: number; lowBid?: number; highBid?: number; competition?: string }

async function plannerIdeas(seeds: string[]): Promise<PlannerIdea[]> {
  if (!seeds.length) return []
  const body = (await keywordIdeas({
    language: ENGLISH,
    geoTargetConstants: [CALIFORNIA],
    keywordPlanNetwork: "GOOGLE_SEARCH",
    includeAdultKeywords: false,
    keywordSeed: { keywords: seeds },
    pageSize: 500,
  })) as {
    results?: {
      text?: string
      keywordIdeaMetrics?: { avgMonthlySearches?: string | number; competition?: string; lowTopOfPageBidMicros?: string | number; highTopOfPageBidMicros?: string | number }
    }[]
  }
  const micros = (v?: string | number) => (v === undefined ? undefined : Number(v) / 1_000_000)
  return (body.results ?? [])
    .filter((r) => r.text)
    .map((r) => ({
      text: r.text!.toLowerCase(),
      volume: r.keywordIdeaMetrics?.avgMonthlySearches === undefined ? undefined : Number(r.keywordIdeaMetrics.avgMonthlySearches),
      lowBid: micros(r.keywordIdeaMetrics?.lowTopOfPageBidMicros),
      highBid: micros(r.keywordIdeaMetrics?.highTopOfPageBidMicros),
      competition: r.keywordIdeaMetrics?.competition,
    }))
}

export const defaultIdeaPeriod = () => ({ from: addDays(today(), -(IDEA_DAYS - 1)), to: today() })

// Steps, as for a negatives batch: review, approve, admin push.
export type IdeaStage = "empty" | "proving" | "approving" | "ready" | "nothing-approved" | "pushed"

export const pushedIdeas = (b: KeywordBatch) => b.items.filter((i) => i.proven && i.approved)

export function ideaStage(b: KeywordBatch): IdeaStage {
  if (b.pushed) return "pushed"
  if (!b.items.length) return "empty"
  if (!b.proven) return "proving"
  if (!b.approved) return b.items.some((i) => i.proven) ? "approving" : "nothing-approved"
  return pushedIdeas(b).length ? "ready" : "nothing-approved"
}
