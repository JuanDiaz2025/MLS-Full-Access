// Where Twin Home Buyer buys houses: anywhere in California. Anywhere outside California is
// outside the buy area, and spend on searches from there is flagged. Edit this to change the
// buy box.

export const BUY_AREA_LABEL = "the buy area"
export const BUY_AREA_STATE = "California"

// California places that show up in searches. Word-level waste analysis never suggests blocking
// one of their words, and the out-of-area negative rule never lists them. Not every city in the
// state, so the location reports use Google's own names (serviceAreaStatus) instead.
export const CALIFORNIA_PLACES = [
  "California", "Bay Area", "Northern California", "Southern California", "Central Valley", "Central Coast", "Inland Empire",
  "Peninsula", "East Bay", "South Bay", "North Bay", "Silicon Valley", "NorCal", "SoCal",
  // Bay Area
  "San Francisco", "Daly City", "Colma", "Brisbane", "South San Francisco", "San Bruno", "Pacifica", "Millbrae", "Burlingame",
  "Hillsborough", "San Mateo", "Foster City", "Belmont", "San Carlos", "Redwood City", "Atherton", "Menlo Park", "East Palo Alto",
  "Woodside", "Palo Alto", "Los Altos", "Mountain View", "Sunnyvale", "Santa Clara", "San Jose", "Cupertino", "Campbell",
  "Saratoga", "Los Gatos", "Milpitas", "Morgan Hill", "Gilroy", "Oakland", "San Leandro", "Hayward", "San Lorenzo",
  "Castro Valley", "Berkeley", "Alameda", "Fremont", "Newark", "Union City", "Pleasanton", "Livermore", "Dublin",
  "San Ramon", "Danville", "Walnut Creek", "Concord", "Pleasant Hill", "Martinez", "Antioch", "Pittsburg", "Brentwood",
  "Richmond", "El Cerrito", "San Pablo", "Vallejo", "Benicia", "Fairfield", "Vacaville", "Dixon", "Suisun City",
  "Napa", "Sonoma", "Santa Rosa", "Petaluma", "Rohnert Park", "Novato", "San Rafael", "Marin", "Contra Costa", "Solano",
  // Central Valley and north
  "Sacramento", "Elk Grove", "Roseville", "Rocklin", "Folsom", "Citrus Heights", "Rancho Cordova", "Davis", "Woodland",
  "Stockton", "Lodi", "Manteca", "Tracy", "Modesto", "Turlock", "Ceres", "Merced", "Fresno", "Clovis", "Visalia",
  "Tulare", "Hanford", "Bakersfield", "Redding", "Chico", "Yuba City", "Eureka",
  // Central Coast and south
  "Santa Cruz", "Watsonville", "Salinas", "Monterey", "San Luis Obispo", "Santa Barbara", "Santa Maria", "Ventura",
  "Oxnard", "Thousand Oaks", "Los Angeles", "Long Beach", "Pasadena", "Glendale", "Burbank", "Santa Clarita", "Lancaster",
  "Palmdale", "Torrance", "Inglewood", "Pomona", "Anaheim", "Santa Ana", "Irvine", "Huntington Beach", "Orange County",
  "Riverside", "San Bernardino", "Ontario", "Fontana", "Rancho Cucamonga", "Moreno Valley", "Corona", "Temecula",
  "Murrieta", "Palm Springs", "Indio", "San Diego", "Chula Vista", "Oceanside", "Escondido", "Carlsbad", "El Cajon",
]

export const BUY_AREA_WORDS = new Set([...CALIFORNIA_PLACES.flatMap((name) => name.toLowerCase().split(" ")), "ca", "calif", "cali"])

export type AreaStatus = "inside" | "outside" | "unknown"

// Google's canonical names look like "San Jose,California,United States", and sometimes include
// the county: "San Carlos,San Mateo County,California,United States". A target for the whole
// state is "California,United States".
export function serviceAreaStatus(canonicalName: string | undefined): { status: AreaStatus; county?: string } {
  if (!canonicalName) return { status: "unknown" }
  const parts = canonicalName.split(",").map((part) => part.trim())
  if (parts.at(-1) !== "United States" || parts.at(-2) !== BUY_AREA_STATE) return { status: "outside" }
  const county = parts.find((p) => p.endsWith(" County"))?.replace(/ County$/, "")
  return { status: "inside", county }
}
