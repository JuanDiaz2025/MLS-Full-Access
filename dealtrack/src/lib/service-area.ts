// Where Twin Home Buyer buys houses: the nine Bay Area counties. Spend on searches from anywhere
// else is flagged as outside the service area. Edit this list to change the buy box.

const BAY_AREA_CITIES: Record<string, string[]> = {
  Alameda: [
    "Alameda", "Albany", "Ashland", "Berkeley", "Castro Valley", "Cherryland", "Dublin", "Emeryville",
    "Fairview", "Fremont", "Hayward", "Livermore", "Newark", "Oakland", "Piedmont", "Pleasanton",
    "San Leandro", "San Lorenzo", "Sunol", "Union City",
  ],
  "Contra Costa": [
    "Alamo", "Antioch", "Bay Point", "Bethel Island", "Brentwood", "Byron", "Clayton", "Concord",
    "Crockett", "Danville", "Discovery Bay", "El Cerrito", "El Sobrante", "Hercules", "Kensington",
    "Knightsen", "Lafayette", "Martinez", "Moraga", "Oakley", "Orinda", "Pinole", "Pittsburg",
    "Pleasant Hill", "Richmond", "Rodeo", "San Pablo", "San Ramon", "Walnut Creek",
  ],
  Marin: [
    "Belvedere", "Corte Madera", "Fairfax", "Greenbrae", "Kentfield", "Larkspur", "Mill Valley",
    "Novato", "Point Reyes Station", "Ross", "San Anselmo", "San Rafael", "Sausalito", "Stinson Beach",
    "Tiburon",
  ],
  Napa: ["American Canyon", "Angwin", "Calistoga", "Napa", "St. Helena", "Yountville"],
  "San Francisco": ["San Francisco"],
  "San Mateo": [
    "Atherton", "Belmont", "Brisbane", "Burlingame", "Colma", "Daly City", "East Palo Alto",
    "El Granada", "Foster City", "Half Moon Bay", "Hillsborough", "La Honda", "Menlo Park", "Millbrae",
    "Montara", "Moss Beach", "Pacifica", "Pescadero", "Portola Valley", "Redwood City", "San Bruno",
    "San Carlos", "San Mateo", "South San Francisco", "Woodside",
  ],
  "Santa Clara": [
    "Campbell", "Cupertino", "Gilroy", "Los Altos", "Los Altos Hills", "Los Gatos", "Milpitas",
    "Monte Sereno", "Morgan Hill", "Mountain View", "Palo Alto", "San Jose", "San Martin", "Santa Clara",
    "Saratoga", "Stanford", "Sunnyvale",
  ],
  Solano: ["Benicia", "Dixon", "Fairfield", "Rio Vista", "Suisun City", "Vacaville", "Vallejo"],
  Sonoma: [
    "Bodega Bay", "Cloverdale", "Cotati", "Forestville", "Glen Ellen", "Guerneville", "Healdsburg",
    "Kenwood", "Petaluma", "Rohnert Park", "Santa Rosa", "Sebastopol", "Sonoma", "Windsor",
  ],
}

const cityToCounty = new Map<string, string>(
  Object.entries(BAY_AREA_CITIES).flatMap(([county, cities]) =>
    cities.map((city) => [city.toLowerCase(), county] as [string, string]),
  ),
)

export type AreaStatus = "inside" | "outside" | "unknown"

// Google's canonical names look like "San Jose,California,United States".
export function serviceAreaStatus(canonicalName: string | undefined): { status: AreaStatus; county?: string } {
  if (!canonicalName) return { status: "unknown" }
  const [city, state] = canonicalName.split(",").map((part) => part.trim())
  if (state !== "California") return { status: "outside" }
  const county = cityToCounty.get(city.toLowerCase())
  return county ? { status: "inside", county } : { status: "outside" }
}
