// Searches that just started wasting money: what Google Ads matched in the last two days (today
// and yesterday) that cost money, brought no lead, isn't blocked yet, and fits one of the
// not-a-seller rules in negatives.ts (agents, buyers, renters, loans, jobs, other states...).
// Seller searches never match those rules, so nothing here would block a seller.
//
// Shown on the Overview the day they appear (instead of waiting for the weekly negatives batch),
// and behind the "one bad search spent more than $X today" alert. Pushing the block still goes
// through the weekly batch, so Google's bidding isn't unsettled by daily changes.
import { addDays, today } from "@/lib/date-range"
import { jsonFileStore } from "@/lib/json-file-store"
import { getSearchTerms, isWaste, type SearchTermRow } from "@/lib/google-ads/reports"
import { shared } from "@/lib/shared-state"

export type WastedSearch = {
  term: string
  cost: number
  clicks: number
  reason: string
  negative: string
  campaigns: string[]
  isNew: boolean // first seen wasting money in the last day
}

// When each wasted search was first seen, so the list can mark the new ones.
const seenFile = jsonFileStore<{ firstSeen: Record<string, string> }>("wasted-searches-seen.json", () => ({ firstSeen: {} }))
const NEW_FOR_MS = 24 * 60 * 60_000
const KEEP_FOR_MS = 60 * 24 * 60 * 60_000

const isBlocked = (t: SearchTermRow) => t.status.includes("EXCLUDED")

// Words that also show up in seller searches ("sell my house behind on mortgage", "sell my rental
// property", "sell house without inspection"): blocking the word would block those sellers too,
// so for these the exact search is suggested instead.
const SELLER_WORDS =
  /^(mortgage|mortgages|rent|rental|rentals|lease|leasing|tenant|tenants|inspection|free|foreclosure|loan|loans|home equity|equity)$/i
const safeNegative = (term: string, negative: string) => (SELLER_WORDS.test(negative.trim()) ? `[${term.toLowerCase()}]` : negative)

export function junkSearches(terms: SearchTermRow[]) {
  return terms.filter((t) => t.rule && t.suggestion && isWaste(t.metrics) && !isBlocked(t))
}

// The list, asked of Google Ads again only when older than `maxAgeMs` (one for the whole app: the
// Overview and the background alert check share it).
const cache = shared("wasted-searches", () => ({ at: 0, list: null as Promise<WastedSearch[]> | null }))
export function recentWastedSearches(maxAgeMs: number): Promise<WastedSearch[]> {
  if (!cache.list || Date.now() - cache.at > maxAgeMs) {
    cache.at = Date.now()
    const list = (cache.list = newWastedSearches())
    list.catch(() => {
      if (cache.list === list) cache.list = null
    })
  }
  return cache.list
}

async function newWastedSearches(): Promise<WastedSearch[]> {
  const day = today()
  const terms = junkSearches(await getSearchTerms({ from: addDays(day, -1), to: day, label: "Today and yesterday" }))
  const now = Date.now()
  const seen = await seenFile.update((s) => {
    s.firstSeen ??= {}
    for (const t of terms) s.firstSeen[t.term.toLowerCase()] ??= new Date(now).toISOString()
    for (const [k, at] of Object.entries(s.firstSeen)) if (now - Date.parse(at) > KEEP_FOR_MS) delete s.firstSeen[k]
    return { ...s.firstSeen }
  })
  return terms.map((t) => ({
    term: t.term,
    cost: t.metrics.cost,
    clicks: t.metrics.clicks,
    reason: t.rule!.reason,
    negative: safeNegative(t.term, t.suggestion!),
    campaigns: t.campaigns,
    isNew: now - Date.parse(seen[t.term.toLowerCase()] ?? "") < NEW_FOR_MS,
  }))
}
