// Where Twin Home Buyer buys houses: Juan's final buy area (decision d2, Sep 29, 2026).
// San Francisco through San Jose on the Peninsula, every city in between, plus Oakland,
// San Leandro, and Hayward. Everything else is outside, including Sonoma (Santa Rosa, Petaluma),
// San Lorenzo, Castro Valley, Berkeley, Stockton, Fresno, and Sacramento.
// Spend on searches from outside is flagged. Edit this list to change the buy box.

export const BUY_AREA_LABEL = "the buy area"

const BUY_AREA: Record<string, string[]> = {
  "San Francisco": ["San Francisco"],
  "San Mateo": [
    "Daly City", "Colma", "Brisbane", "South San Francisco", "San Bruno", "Pacifica", "Millbrae", "Burlingame",
    "Hillsborough", "San Mateo", "Foster City", "Belmont", "San Carlos", "Redwood City", "Atherton", "Menlo Park",
    "East Palo Alto",
  ],
  "Santa Clara": ["Palo Alto", "Los Altos", "Mountain View", "Sunnyvale", "Santa Clara", "San Jose"],
  Alameda: ["Oakland", "San Leandro", "Hayward"],
}

const cityToCounty = new Map<string, string>(
  Object.entries(BUY_AREA).flatMap(([county, cities]) => cities.map((city) => [city.toLowerCase(), county] as [string, string])),
)

// Every word in a buy-area place name ("san", "mateo", "oakland", …), plus the county names, so
// word-level waste analysis never suggests blocking a city we buy in.
export const BUY_AREA_WORDS = new Set(
  [...Object.keys(BUY_AREA), ...Object.values(BUY_AREA).flat(), "bay area", "peninsula", "east bay", "south bay", "silicon valley"]
    .flatMap((name) => name.toLowerCase().split(" ")),
)

export type AreaStatus = "inside" | "outside" | "unknown"

// Google's canonical names look like "San Jose,California,United States", and sometimes include
// the county: "San Carlos,San Mateo County,California,United States". Only the listed cities
// count: unincorporated places nearby (e.g. Emerald Hills, Castro Valley) are outside.
export function serviceAreaStatus(canonicalName: string | undefined): { status: AreaStatus; county?: string } {
  if (!canonicalName) return { status: "unknown" }
  const parts = canonicalName.split(",").map((part) => part.trim())
  const [city] = parts
  const state = parts.at(-2)
  if (parts.at(-1) !== "United States" || state !== "California") return { status: "outside" }
  const county = cityToCounty.get(city.toLowerCase())
  return county ? { status: "inside", county } : { status: "outside" }
}
