// Flags search terms that almost never come from a homeowner ready to sell for cash, and turns
// them into suggested negative keywords. These are suggestions for a person to review, never
// applied automatically. Edit the rules to match what the team learns from call outcomes.

export type NegativeRule = {
  id: string
  reason: string
  // Words or phrases to add as negative keywords when a term matches.
  negatives: string[]
  pattern: RegExp
  // Applies even when the search says "sell" (a competitor's name or a city we don't buy in).
  evenForSellers?: boolean
}

// Places outside California: other states' big cities and the states themselves. Anywhere in
// California is in the buy area (lib/service-area.ts), so no California place belongs here.
const OUT_OF_STATE = [
  "las vegas", "reno", "nevada", "phoenix", "scottsdale", "tucson", "arizona", "portland", "oregon",
  "seattle", "tacoma", "spokane", "boise", "idaho", "salt lake city", "utah", "denver", "colorado springs", "colorado",
  "albuquerque", "new mexico", "texas", "houston", "dallas", "fort worth", "austin", "san antonio", "el paso",
  "oklahoma city", "oklahoma", "kansas city", "st louis", "missouri", "chicago", "illinois", "indianapolis", "indiana",
  "des moines", "iowa", "minneapolis", "minnesota", "milwaukee", "wisconsin", "detroit", "michigan", "columbus",
  "cleveland", "cincinnati", "ohio", "nashville", "memphis", "tennessee", "atlanta", "georgia", "charlotte", "raleigh",
  "north carolina", "south carolina", "jacksonville", "orlando", "tampa", "miami", "florida", "new orleans", "louisiana",
  "birmingham", "alabama", "louisville", "kentucky", "virginia", "baltimore", "maryland", "philadelphia", "pittsburgh",
  "pennsylvania", "new jersey", "new york", "brooklyn", "boston", "massachusetts", "connecticut", "honolulu", "hawaii",
  "alaska", "vancouver", "canada", "mexico", "tijuana",
]

export const negativeRules: NegativeRule[] = [
  {
    id: "agent",
    reason: "Looking for an agent, not a cash buyer",
    negatives: ["realtor", "real estate agent", "listing agent", "mls", "flat fee", "homes for heroes"],
    pattern: /\b(realtors?|real estate agents?|listing agents?|broker|mls|flat fee|homes for heroes)\b/i,
  },
  {
    id: "buyer",
    reason: "Wants to buy a home, not sell one",
    negatives: ["homes for sale", "houses for sale", "first time home buyer", "down payment"],
    pattern:
      /\b(homes? for sale|houses? for sale|first[- ]time (home ?)?buyers?|down payment|buy a (house|home)|pre-?approv\w*)\b/i,
  },
  {
    id: "renter",
    reason: "Renting, not selling",
    negatives: ["rent", "rental", "apartment", "section 8"],
    pattern: /\b(rent|rentals?|apartments?|lease|leasing|section 8)\b/i,
  },
  {
    id: "financing",
    reason: "Looking for a loan or refinance",
    negatives: ["mortgage", "refinance", "heloc", "loan"],
    pattern: /\b(mortgages?|refinanc\w*|heloc|loans?|lenders?)\b/i,
  },
  {
    id: "jobs",
    reason: "Job or training search",
    negatives: ["jobs", "hiring", "salary", "course", "license"],
    pattern: /\b(jobs?|hiring|careers?|salary|employment|course|class(es)?|license|licensing|training)\b/i,
  },
  {
    id: "portal",
    reason: "Browsing listing sites",
    negatives: ["zillow", "redfin", "trulia", "craigslist"],
    pattern: /\b(zillow|redfin|trulia|craigslist|marketplace)\b/i,
  },
  {
    id: "value",
    reason: "Checking a price, often a price shopper (review before adding)",
    negatives: ["zestimate", "home value", "house value"],
    pattern: /\b(zestimate|home value|house value|what('?s| is) my (house|home) worth|appraisal)\b/i,
  },
  {
    // From the account's "Competitors" negative list, plus the iBuyers seen in search terms.
    id: "competitor",
    reason: "Looking for a competitor by name",
    evenForSellers: true,
    negatives: [
      "opendoor", "open door", "offerpad", "orchard", "sellfast", "homevestors", "we buy ugly houses", "we buy ugly homes",
      "john buys", "laurel buys houses", "capital home buyers", "fair home buyers", "local home buyers inc", "24 home buyer",
      "just home buyers", "turtle home buyer", "naca", "clever offers", "clever real estate", "liz buys", "homelight",
      "redfinnow", "redfin now", "flyhomes", "jeff buys", "bobby buys", "sunomi",
    ],
    pattern:
      /\b(open ?door|offerpad|orchard(?! (ave|avenue|st|street|rd|road|dr|drive|ln|lane|way|blvd|ct|court|pl|place)\b)|sellfast(\.?com)?|sell fast ?\.?com|homevestors|we buy ugly (houses|homes)|john buys|laurel buys houses|capital home buyers|fair home buyers|local home buyers inc|24 home buyers?|just home buyers|turtle home buyers?|naca|clever (cash )?offers?|clever real estate|clever home buying|liz buys|homelight|redfin ?now|flyhomes|jeff buys|bobby buys|sunomi)\b/i,
  },
  {
    id: "out-of-area",
    reason: "A place outside California",
    evenForSellers: true,
    negatives: OUT_OF_STATE,
    pattern: new RegExp(
      `\\b(${OUT_OF_STATE.map((p) => p.replace(/ /g, "\\s+")).join("|")})\\b`,
      "i",
    ),
  },
]

// Searches that say the person wants to sell are never flagged, whatever else they mention:
// "sell my house without a realtor" and "selling a rental with tenants" are the sellers we want.
// Only the competitor and out-of-area rules still apply to them.
export const SELLER_INTENT =
  /\b(sell|sells|selling|sold|we buy|buys? (my|your|houses|homes)|buying (houses|homes)|cash (for|offer)|cash (home |house )?buyers?|foreclos\w*|behind on)\b/i

export function matchRule(term: string): NegativeRule | undefined {
  const seller = SELLER_INTENT.test(term)
  return negativeRules.find((rule) => (!seller || rule.evenForSellers) && rule.pattern.test(term))
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Whether a negative keyword blocks a search, the way Google matches negatives: phrase means the
// search contains those whole words in that order; exact means the search is exactly it. Negatives
// don't match plurals or other variants, so "rent" doesn't block "rentals".
export function blocks(negative: string, matchType: "PHRASE" | "EXACT" | "BROAD", term: string): boolean {
  const search = term.toLowerCase().replace(/\s+/g, " ").trim()
  const neg = negative.toLowerCase().replace(/\s+/g, " ").trim()
  if (!neg) return false
  if (matchType === "EXACT") return search === neg
  if (matchType === "BROAD") return neg.split(" ").every((w) => search.split(" ").includes(w))
  return new RegExp(`(^| )${escapeRegExp(neg)}( |$)`).test(search)
}

// The specific negative to suggest for a term: the rule's phrase when the term contains it as
// whole words, otherwise the words the rule matched (e.g. "realtors" suggests "realtors", since
// the negative "realtor" wouldn't block it).
export function suggestedNegative(term: string, rule: NegativeRule): string {
  const whole = rule.negatives.find((n) => blocks(n, "PHRASE", term))
  if (whole) return whole
  return term.toLowerCase().match(rule.pattern)?.[0]?.replace(/\s+/g, " ").trim() || rule.negatives[0]
}
