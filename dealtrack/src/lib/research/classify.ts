// What a keyword is about, worked out from its words (Competitors → Keyword explorer): a topic
// for the seller's situation or the kind of search, and the California place it names, if any.
// Worked out each time the page opens, so changing a rule here regroups every keyword.
import { CALIFORNIA_PLACES } from "@/lib/service-area"

export const TOPICS = [
  { id: "brand", label: "Twin Home Buyer (brand)", match: /twin ?(homes?|house)|twinhome/ },
  {
    id: "competitor",
    label: "Competitor names",
    match:
      /open ?door|offerpad|john buys|osborne homes|^webuyhouses$|homevestors?|we buy ugly|sundae|houzeo|catapult|redfin|zillow|express ?home ?buyers|kiavi|\bknock\b|orchard|flyhomes|homelight|ibuyer|webuyhouses\.com|www\./,
  },
  {
    id: "inherited",
    label: "Inherited & probate",
    match:
      /inherit|probate|executor|deceased|passed away|\btrust\b|(?<!real )estate (sale|buyers?|homes?|propert|attorney|lawyer|agents?)|parents.? (house|home)/,
  },
  {
    id: "distress",
    label: "Foreclosure & debt",
    match:
      /foreclos|behind on|short sale|bankrupt|\blien|default|back taxes|late payments?|owe more|can.?t (pay|afford)|late mortgage|mortgage payments?|mortgage sell|sell (my )?house mortgage/,
  },
  { id: "life", label: "Life changes", match: /divorce|relocat|moving|landlord|tenant|evict|rental|job loss|downsiz/ },
  {
    id: "condition",
    label: "As-is & condition",
    match: /as[- ]?is|fixer|repairs?|ugly|damage|condition|mold|fire|hoard|old house|needs work|distressed|rundown|run down/,
  },
  {
    id: "home-buyers",
    label: "Buying a home (not sellers)",
    match:
      /first time|1st time|(first|1st) home buyers?|(?<!my )homes? for sale|(?<!my )houses? for sale|mortgage (rates?|calculator|lenders?|pre)|down payment|pre-?approv|home loan|buy(ing)? a (house|home)|rent to own|open house|apartments?/,
  },
  { id: "land", label: "Land & lots", match: /\bland\b|\blots?\b|acre|vacant/ },
  { id: "near-me", label: "Near me", match: /near me|nearby|close to me|in my area/ },
  {
    id: "buyers",
    label: "We buy houses / cash buyers",
    match:
      /we buy|buys? (my |your )?(house|home)s?|buy (my|your)( [a-z]+)? (house|home|property)|compan(y|ies) (that|who)? ?buy|(home|house) buying (compan|service)|compan(y|ies) buying|buyers? for (homes|houses)|property buyers?|house buyers?|home buyers?|cash buyers?|investors? (that|who)? ?buy|investors? buying|flipping investors?|real estate investors?|buyers network/,
  },
  {
    id: "sell",
    label: "Sell my house",
    match:
      /sell(ing)? (my |a |your |the |our |parents |mom'?s |dad'?s )?(house|home|property|condo|townhouse)|sal(e|ing) (a |my |your )?(house|home)|(quick|fast) (home|house) (sale|sell)|sell fast|sell quick|how to sell|selling price|sell for|without a realtor|^sell$/,
  },
  { id: "cash", label: "Cash & offers", match: /cash|offer|quick sale|fast sale/ },
  { id: "other", label: "Other", match: /./ },
] as const

export type TopicId = (typeof TOPICS)[number]["id"]

export function topicOf(keyword: string): TopicId {
  return (TOPICS.find((t) => t.match.test(keyword)) ?? TOPICS[TOPICS.length - 1]).id
}

// Longest names first, so "south san francisco" wins over "san francisco".
const PLACES = [...new Set(CALIFORNIA_PLACES.map((p) => p.toLowerCase()))]
  .sort((a, b) => b.length - a.length)
  .map((name) => ({ name, re: new RegExp(`(^|[^a-z])${name.replace(/ /g, "\\s*")}([^a-z]|$)`) }))
const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase())

export function placeOf(keyword: string): string | undefined {
  const hit = PLACES.find((p) => p.re.test(keyword))
  return hit ? title(hit.name) : undefined
}
