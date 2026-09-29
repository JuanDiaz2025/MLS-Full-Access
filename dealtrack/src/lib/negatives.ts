// Flags search terms that almost never come from a homeowner ready to sell for cash, and turns
// them into suggested negative keywords. These are suggestions for a person to review, never
// applied automatically. Edit the rules to match what the team learns from call outcomes.

export type NegativeRule = {
  id: string
  reason: string
  // Words or phrases to add as negative keywords when a term matches.
  negatives: string[]
  pattern: RegExp
}

export const negativeRules: NegativeRule[] = [
  {
    id: "agent",
    reason: "Looking for an agent, not a cash buyer",
    negatives: ["realtor", "real estate agent", "listing agent"],
    pattern: /\b(realtors?|real estate agents?|listing agents?|broker)\b/i,
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
    id: "out-of-area",
    reason: "A city outside the Bay Area",
    negatives: [
      "stockton", "fresno", "sacramento", "modesto", "merced", "visalia", "bakersfield", "tracy",
      "manteca", "lodi", "turlock", "los angeles", "san diego", "reno",
    ],
    pattern:
      /\b(stockton|fresno|sacramento|modesto|merced|visalia|bakersfield|tracy|manteca|lodi|turlock|los angeles|san diego|reno)\b/i,
  },
]

export function matchRule(term: string): NegativeRule | undefined {
  return negativeRules.find((rule) => rule.pattern.test(term))
}

// The specific negative to suggest for a term: the rule's phrase that appears in it, or the
// rule's first phrase when the match came from a variant (e.g. "realtors" suggests "realtor").
export function suggestedNegative(term: string, rule: NegativeRule): string {
  const lower = term.toLowerCase()
  return rule.negatives.find((n) => lower.includes(n)) ?? rule.negatives[0]
}
