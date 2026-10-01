// The campaign check: for each campaign, which of the standard negatives (every rule's negatives
// in negatives.ts: competitors, places outside California, agents, renters…) it doesn't block
// yet, and how much it spent in the last 12 months on rule-matched searches nothing blocks. The
// missing ones can become a normal weekly-negatives batch (review, approve, admin push).

import { addDays, today } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"
import { STANDARD_LIST, getEditableCampaigns } from "@/lib/google-ads/changes"
import { getSearchTerms, type SearchTermRow } from "@/lib/google-ads/reports"
import { TERMS_SHOWN, existingNegatives, keywordsInUse, stillOpen, type ExistingNegative } from "@/lib/negative-batches"
import { SELLER_INTENT, blocks, negativeRules } from "@/lib/negatives"
import type { BatchItem, HeldBack } from "@/lib/store"

export const CHECK_DAYS = 365
const MAX_CAMPAIGNS = 30 // running ones, then the paused ones with the most search spend

export const GROUP_LABELS: Record<string, string> = {
  competitor: "Competitors",
  "out-of-area": "Places outside California",
  agent: "Agents & listing services",
  buyer: "Home buyers",
  renter: "Renters",
  financing: "Loans",
  jobs: "Jobs",
  portal: "Listing sites",
  value: "Price checks",
}

export type Gap = { rule: string; label: string; missing: string[] }

export type CampaignCheck = {
  id: string
  name: string
  status: string
  spend: number // search spend in the period
  negatives: number // negative keywords that apply to it (campaign, ad groups, lists, account)
  lists: string[] // negative lists attached
  hasStandardList: boolean
  waste: number // rule-matched searches that didn't convert and nothing blocks
  wasteSearches: string[]
  gaps: Gap[]
  missing: number
}

export type CheckResult = { from: string; to: string; campaigns: CampaignCheck[]; standard: number; heldBack: HeldBack[] }

type Standard = { negative: string; rule: string; why: string }

const appliesTo = (e: ExistingNegative, campaignId: string) => !e.campaignId || e.campaignId === campaignId

// An existing phrase or broad negative that blocks the standard one's words blocks every search
// it would. An exact one only blocks that exact search, so it doesn't count. Ad group negatives
// only cover their ad group, so they don't count either.
const covered = (negative: string, existing: ExistingNegative[]) =>
  existing.some((e) => !e.adGroupId && e.matchType !== "EXACT" && blocks(e.text, e.matchType, negative))

async function gather() {
  const to = today()
  const from = addDays(to, -(CHECK_DAYS - 1))
  const [terms, editable, keywords] = await Promise.all([
    getSearchTerms({ from, to, label: "" }),
    getEditableCampaigns(),
    keywordsInUse(),
  ])

  const spend = new Map<string, number>()
  for (const p of terms.flatMap((t) => t.placements)) spend.set(p.campaignId, (spend.get(p.campaignId) ?? 0) + p.cost)
  const campaigns = [
    ...editable.filter((c) => c.status === "ENABLED"),
    ...editable.filter((c) => c.status !== "ENABLED" && (spend.get(c.id) ?? 0) > 0).sort((a, b) => (spend.get(b.id) ?? 0) - (spend.get(a.id) ?? 0)),
  ].slice(0, MAX_CAMPAIGNS)
  const ids = campaigns.map((c) => c.id)

  const [existing, lists] = await Promise.all([
    existingNegatives(ids),
    ids.length
      ? gaql<{ campaign: { id?: string | number }; sharedSet: { name?: string } }>(
          `SELECT campaign.id, shared_set.name FROM campaign_shared_set
           WHERE campaign.id IN (${ids.join(", ")}) AND campaign_shared_set.status = 'ENABLED' AND shared_set.type = 'NEGATIVE_KEYWORDS'`,
        )
      : Promise.resolve([]),
  ])

  // Standard negatives that are never safe here: they'd block a search that converted in the
  // period, or (except competitors and cities) a seller saying "sell".
  const heldBack: HeldBack[] = []
  const standard: Standard[] = []
  for (const rule of negativeRules) {
    for (const negative of rule.negatives) {
      const risky = terms.filter(
        (t) => blocks(negative, "PHRASE", t.term) && (t.metrics.conversions > 0 || (!rule.evenForSellers && SELLER_INTENT.test(t.term))),
      )
      if (risky.length) heldBack.push({ negative, why: rule.reason, converting: risky.slice(0, TERMS_SHOWN).map((t) => t.term) })
      else standard.push({ negative, rule: rule.id, why: rule.reason })
    }
  }

  const { open } = stillOpen(terms, existing)
  const wants = (campaignId: string, negative: string) => (keywords.byCampaign.get(campaignId) ?? []).some((k) => blocks(negative, "PHRASE", k))
  return { from, to, campaigns, spend, existing, lists, standard, heldBack, open, wants }
}

// Searches in one campaign that a negative would block and nothing blocks yet, with what they
// cost there.
function openIn(open: SearchTermRow[], campaignId: string, negative?: string) {
  return open.flatMap((t) => {
    if (t.metrics.conversions > 0) return []
    if (negative ? !blocks(negative, "PHRASE", t.term) : !t.rule || !t.suggestion) return []
    const here = t.placements.filter((p) => p.campaignId === campaignId)
    const cost = here.reduce((s, p) => s + p.cost, 0)
    const clicks = here.reduce((s, p) => s + p.clicks, 0)
    return here.length ? [{ term: t.term, suggestion: t.suggestion, cost, clicks }] : []
  })
}

export async function checkCampaigns(): Promise<CheckResult> {
  const g = await gather()
  const campaigns = g.campaigns.map((c): CampaignCheck => {
    const mine = g.existing.filter((e) => appliesTo(e, c.id))
    const missing = g.standard.filter((s) => !covered(s.negative, mine) && !g.wants(c.id, s.negative))
    const gaps = Object.keys(GROUP_LABELS)
      .map((rule) => ({ rule, label: GROUP_LABELS[rule], missing: missing.filter((m) => m.rule === rule).map((m) => m.negative) }))
      .filter((gap) => gap.missing.length)
    const waste = openIn(g.open, c.id).filter((w) => !g.wants(c.id, w.suggestion!)).sort((a, b) => b.cost - a.cost)
    const lists = g.lists.filter((l) => String(l.campaign.id) === c.id).map((l) => l.sharedSet.name ?? "")
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      spend: g.spend.get(c.id) ?? 0,
      negatives: mine.length,
      lists,
      hasStandardList: lists.includes(STANDARD_LIST),
      waste: waste.reduce((s, w) => s + w.cost, 0),
      wasteSearches: waste.filter((w) => w.cost > 0).slice(0, TERMS_SHOWN).map((w) => w.term),
      gaps,
      missing: missing.length,
    }
  })
  return { from: g.from, to: g.to, campaigns, standard: g.standard.length, heldBack: g.heldBack }
}

// The missing standard negatives of the chosen campaigns as batch lines: one line per negative,
// with the campaigns that miss it and the searches it would have blocked there.
export async function draftStandard(campaignIds: string[]): Promise<{ items: BatchItem[]; heldBack: HeldBack[]; from: string; to: string }> {
  const g = await gather()
  const chosen = g.campaigns.filter((c) => campaignIds.includes(c.id))
  const order = Object.keys(GROUP_LABELS)
  const items: BatchItem[] = []
  for (const s of g.standard) {
    const missingIn = chosen.filter((c) => !covered(s.negative, g.existing.filter((e) => appliesTo(e, c.id))) && !g.wants(c.id, s.negative))
    if (!missingIn.length) continue
    const hits = missingIn.flatMap((c) => openIn(g.open, c.id, s.negative).map((h) => ({ ...h, campaign: c })))
    const byCampaign = missingIn
      .map((c) => ({ id: c.id, name: c.name, cost: hits.filter((h) => h.campaign.id === c.id).reduce((t, h) => t + h.cost, 0) }))
      .sort((a, b) => b.cost - a.cost)
    const terms = [...new Map(hits.sort((a, b) => b.cost - a.cost).map((h) => [h.term, h])).keys()]
    items.push({
      negative: s.negative,
      matchType: "PHRASE",
      why: s.why,
      terms: terms.slice(0, TERMS_SHOWN),
      termCount: terms.length,
      campaigns: byCampaign,
      clicks: hits.reduce((t, h) => t + h.clicks, 0),
      cost: hits.reduce((t, h) => t + h.cost, 0),
      conversions: 0,
      proven: null,
      approved: null,
    })
  }
  items.sort((a, b) => b.cost - a.cost || order.indexOf(ruleOf(a, g.standard)) - order.indexOf(ruleOf(b, g.standard)))
  return { items, heldBack: g.heldBack, from: g.from, to: g.to }
}

const ruleOf = (item: BatchItem, standard: Standard[]) => standard.find((s) => s.negative === item.negative)?.rule ?? ""
