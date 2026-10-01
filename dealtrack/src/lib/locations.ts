// Location insights for the Locations page: California regions, California cities that cost a
// lot and brought nothing, and each campaign's location targeting with what looks wrong.

import { readFile } from "node:fs/promises"
import path from "node:path"

import { gaql } from "@/lib/google-ads/client"
import { GEO_RESOURCE, geoNames, rates, sumMetrics, type CityCampaign, type LocationRow, type Metrics } from "@/lib/google-ads/reports"
import { serviceAreaStatus } from "@/lib/service-area"

// California regions, by city. Edit to regroup. Cities not listed fall under their county's
// region when Google names the county, otherwise "Other California".
export const REGIONS: { name: string; cities: string[]; counties: string[] }[] = [
  {
    name: "San Francisco & Peninsula",
    counties: ["San Francisco", "San Mateo"],
    cities: [
      "San Francisco", "Daly City", "Colma", "Brisbane", "South San Francisco", "San Bruno", "Pacifica", "Millbrae", "Burlingame",
      "Hillsborough", "San Mateo", "Foster City", "Belmont", "San Carlos", "Redwood City", "Atherton", "Menlo Park", "East Palo Alto",
      "Woodside", "Half Moon Bay", "Portola Valley",
    ],
  },
  {
    name: "South Bay",
    counties: ["Santa Clara"],
    cities: ["San Jose", "Palo Alto", "Los Altos", "Mountain View", "Sunnyvale", "Santa Clara", "Cupertino", "Campbell", "Saratoga", "Los Gatos", "Milpitas", "Morgan Hill", "Gilroy", "Los Altos Hills", "Monte Sereno"],
  },
  {
    name: "East Bay",
    counties: ["Alameda", "Contra Costa"],
    cities: [
      "Oakland", "San Leandro", "Hayward", "San Lorenzo", "Castro Valley", "Berkeley", "Alameda", "Emeryville", "Albany", "Fremont",
      "Newark", "Union City", "Pleasanton", "Livermore", "Dublin", "San Ramon", "Danville", "Walnut Creek", "Concord", "Pleasant Hill",
      "Martinez", "Antioch", "Pittsburg", "Brentwood", "Oakley", "Richmond", "El Cerrito", "San Pablo", "Hercules", "Pinole", "Lafayette",
      "Orinda", "Moraga",
    ],
  },
  {
    name: "North Bay",
    counties: ["Marin", "Sonoma", "Napa", "Solano"],
    cities: [
      "Vallejo", "Benicia", "Fairfield", "Vacaville", "Dixon", "Suisun City", "American Canyon", "Napa", "Sonoma", "Santa Rosa", "Petaluma",
      "Rohnert Park", "Windsor", "Novato", "San Rafael", "Mill Valley", "Sausalito",
    ],
  },
  {
    name: "Sacramento area",
    counties: ["Sacramento", "Placer", "Yolo", "El Dorado"],
    cities: ["Sacramento", "Elk Grove", "Roseville", "Rocklin", "Folsom", "Citrus Heights", "Rancho Cordova", "Davis", "Woodland", "West Sacramento", "Lincoln", "Carmichael", "Antelope"],
  },
  {
    name: "Central Valley",
    counties: ["San Joaquin", "Stanislaus", "Merced", "Fresno", "Tulare", "Kings", "Kern", "Madera"],
    cities: ["Stockton", "Lodi", "Manteca", "Tracy", "Lathrop", "Modesto", "Turlock", "Ceres", "Merced", "Fresno", "Clovis", "Visalia", "Tulare", "Hanford", "Bakersfield", "Madera"],
  },
  {
    name: "Central Coast",
    counties: ["Santa Cruz", "Monterey", "San Benito", "San Luis Obispo", "Santa Barbara"],
    cities: ["Santa Cruz", "Watsonville", "Scotts Valley", "Salinas", "Monterey", "Hollister", "San Luis Obispo", "Santa Barbara", "Santa Maria"],
  },
  {
    name: "Southern California",
    counties: ["Los Angeles", "Orange", "San Diego", "Riverside", "San Bernardino", "Ventura", "Imperial"],
    cities: [
      "Los Angeles", "Long Beach", "Pasadena", "Glendale", "Burbank", "Santa Clarita", "Lancaster", "Palmdale", "Torrance", "Inglewood",
      "Pomona", "Anaheim", "Santa Ana", "Irvine", "Huntington Beach", "Riverside", "San Bernardino", "Ontario", "Fontana",
      "Rancho Cucamonga", "Moreno Valley", "Corona", "Temecula", "Murrieta", "Palm Springs", "Indio", "San Diego", "Chula Vista",
      "Oceanside", "Escondido", "Carlsbad", "El Cajon", "Ventura", "Oxnard", "Thousand Oaks",
    ],
  },
]
export const OTHER_CALIFORNIA = "Other California"

const byCity = new Map(REGIONS.flatMap((r) => r.cities.map((c) => [c.toLowerCase(), r.name] as const)))
const byCounty = new Map(REGIONS.flatMap((r) => r.counties.map((c) => [c.toLowerCase(), r.name] as const)))

export function regionOf(row: LocationRow): string | null {
  if (row.status !== "inside") return null
  return byCity.get(row.city.toLowerCase()) ?? (row.county ? byCounty.get(row.county.toLowerCase()) : undefined) ?? OTHER_CALIFORNIA
}

export type Region = { name: string; metrics: Metrics; cities: LocationRow[] }

export function regions(rows: LocationRow[]): Region[] {
  const map = new Map<string, LocationRow[]>()
  for (const r of rows) {
    const name = regionOf(r)
    if (name) map.set(name, [...(map.get(name) ?? []), r])
  }
  const order = [...REGIONS.map((r) => r.name), OTHER_CALIFORNIA]
  return [...map.entries()]
    .map(([name, cities]) => ({ name, metrics: sumMetrics(cities), cities: cities.sort((a, b) => b.metrics.cost - a.metrics.cost) }))
    .sort((a, b) => b.metrics.cost - a.metrics.cost || order.indexOf(a.name) - order.indexOf(b.name))
}

// California cities worth a look: at least this much spend with no conversion, or a cost per
// conversion this many times the average.
export const EXPENSIVE_MIN_SPEND = 300
export const EXPENSIVE_CPA_TIMES = 2

export type ExpensiveCity = LocationRow & { reason: string }

export function expensiveCities(rows: LocationRow[], averageCpa: number | null): ExpensiveCity[] {
  return rows
    .filter((r) => r.status === "inside" && r.metrics.cost >= EXPENSIVE_MIN_SPEND && GEO_RESOURCE.test(r.key))
    .flatMap((r): ExpensiveCity[] => {
      if (r.metrics.conversions <= 0) return [{ ...r, reason: "No conversions" }]
      const cpa = r.metrics.cost / r.metrics.conversions
      if (averageCpa && cpa >= averageCpa * EXPENSIVE_CPA_TIMES) return [{ ...r, reason: `${(cpa / averageCpa).toFixed(1)}× your average cost per conversion` }]
      return []
    })
    .sort((a, b) => b.metrics.cost - a.metrics.cost)
}

// ---- Targeting check -------------------------------------------------------------------------

export type Place = { geo?: string; name: string; outside: boolean }

export type CampaignTargeting = {
  id: string
  name: string
  status: string
  option: string // PRESENCE or PRESENCE_OR_INTEREST
  targets: Place[]
  radius: string[] // "10 mi around Oakland, CA"
  excluded: Place[]
  warnings: { tone: "red" | "amber"; text: string }[]
}

const UNITS: Record<string, string> = { MILES: "mi", KILOMETERS: "km" }
const EXCLUDED_NAMED = 12

export async function getTargeting(campaigns: { id: string; name: string; status: string }[], convertingGeos: Map<string, number>): Promise<CampaignTargeting[]> {
  const ids = campaigns.map((c) => c.id).filter((id) => /^\d+$/.test(id))
  if (!ids.length) return []
  const [settings, criteria] = await Promise.all([
    gaql<{ campaign: { id?: string | number; geoTargetTypeSetting?: { positiveGeoTargetType?: string } } }>(
      `SELECT campaign.id, campaign.geo_target_type_setting.positive_geo_target_type FROM campaign WHERE campaign.id IN (${ids.join(", ")})`,
    ),
    gaql<{
      campaign: { id?: string | number }
      campaignCriterion: {
        negative?: boolean
        type?: string
        location?: { geoTargetConstant?: string }
        proximity?: { radius?: number; radiusUnits?: string; address?: { cityName?: string; provinceCode?: string } }
      }
    }>(
      `SELECT campaign.id, campaign_criterion.negative, campaign_criterion.type, campaign_criterion.location.geo_target_constant,
         campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units, campaign_criterion.proximity.address.city_name,
         campaign_criterion.proximity.address.province_code
       FROM campaign_criterion
       WHERE campaign.id IN (${ids.join(", ")}) AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY') AND campaign_criterion.status != 'REMOVED'`,
    ),
  ])
  // Old campaigns can exclude thousands of places: name only the ones shown (every target, the
  // first few exclusions, and any exclusion that brought conversions).
  const shownGeos = new Set<string>()
  const excludedSeen = new Map<string, number>()
  for (const c of criteria) {
    const geo = c.campaignCriterion.location?.geoTargetConstant
    if (!geo) continue
    if (!c.campaignCriterion.negative) shownGeos.add(geo)
    else {
      const id = String(c.campaign.id)
      const n = excludedSeen.get(id) ?? 0
      if (n < EXCLUDED_NAMED || (convertingGeos.get(geo) ?? 0) > 0) shownGeos.add(geo)
      excludedSeen.set(id, n + 1)
    }
  }
  const names = await geoNames([...shownGeos])
  const place = (geo: string): Place => {
    const n = names.get(geo)
    return { geo, name: n ? n.canonical.replace(/,United States$/, "").replace(/,/g, ", ") : "", outside: n ? serviceAreaStatus(n.canonical).status !== "inside" : false }
  }
  const option = new Map(settings.map((s) => [String(s.campaign.id), s.campaign.geoTargetTypeSetting?.positiveGeoTargetType ?? ""]))

  return campaigns.map((c) => {
    const mine = criteria.filter((x) => String(x.campaign.id) === c.id)
    const targets = mine.filter((x) => !x.campaignCriterion.negative && x.campaignCriterion.location?.geoTargetConstant).map((x) => place(x.campaignCriterion.location!.geoTargetConstant!))
    const excluded = mine.filter((x) => x.campaignCriterion.negative && x.campaignCriterion.location?.geoTargetConstant).map((x) => place(x.campaignCriterion.location!.geoTargetConstant!))
    const radius = mine
      .filter((x) => !x.campaignCriterion.negative && x.campaignCriterion.type === "PROXIMITY")
      .map((x) => {
        const p = x.campaignCriterion.proximity
        return `${p?.radius ?? "?"} ${UNITS[p?.radiusUnits ?? ""] ?? ""} around ${[p?.address?.cityName, p?.address?.provinceCode].filter(Boolean).join(", ") || "an address"}`
      })
    const warnings: CampaignTargeting["warnings"] = []
    const opt = option.get(c.id) ?? ""
    if (!targets.length && !radius.length) warnings.push({ tone: "red", text: "No location targeting: ads can show anywhere" })
    const outside = targets.filter((t) => t.outside)
    if (outside.length) warnings.push({ tone: "red", text: `Targets places outside California: ${outside.map((t) => t.name).join("; ")}` })
    if (opt === "PRESENCE") warnings.push({ tone: "amber", text: "Only people in the area: misses sellers elsewhere searching about California (see the Overview tab)" })
    const lost = excluded.filter((e) => e.geo && (convertingGeos.get(e.geo) ?? 0) > 0)
    if (lost.length) warnings.push({ tone: "amber", text: `Excludes places that brought conversions: ${lost.map((e) => `${e.name} (${convertingGeos.get(e.geo!)!.toFixed(0)})`).join("; ")}` })
    return { ...c, option: opt, targets, radius, excluded, warnings }
  })
}

export const cpa = (m: Metrics) => rates(m).costPerConversion

// Each campaign's location option (presence, or presence or interest), for the Overview tab.
export async function getLocationOptions(ids: string[]): Promise<Map<string, string>> {
  const valid = ids.filter((id) => /^\d+$/.test(id))
  if (!valid.length) return new Map()
  const rows = await gaql<{ campaign: { id?: string | number; geoTargetTypeSetting?: { positiveGeoTargetType?: string } } }>(
    `SELECT campaign.id, campaign.geo_target_type_setting.positive_geo_target_type FROM campaign WHERE campaign.id IN (${valid.join(", ")})`,
  )
  return new Map(rows.map((r) => [String(r.campaign.id), r.campaign.geoTargetTypeSetting?.positiveGeoTargetType ?? ""]))
}

// ---- Map -------------------------------------------------------------------------------------

// City centers from US ZIP code data (the zipcodes package, BSD license): "city|ST" → [lat, lng].
const STATES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
  Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
}

// Read from disk once, when the map is first opened (1 MB, so it isn't bundled or type-checked).
let coords: Record<string, [number, number]> | null = null
async function cityCoords() {
  coords ??= JSON.parse(await readFile(path.join(process.cwd(), "src/lib/places/us-cities.json"), "utf8")) as Record<string, [number, number]>
  return coords
}

export type MapCity = {
  key: string
  city: string
  region: string
  inside: boolean
  lat: number
  lng: number
  cost: number
  impressions: number
  clicks: number
  conversions: number
  campaigns: { name: string; running: boolean; cost: number; impressions: number; conversions: number }[]
}

const MAP_CITIES = 2500

// Cities with a known center, for the map: the ones with impressions, most impressions first.
export async function mapCities(rows: LocationRow[], cityCampaigns: Map<string, CityCampaign[]>): Promise<{ cities: MapCity[]; missing: number }> {
  const c = await cityCoords()
  const out: MapCity[] = []
  let missing = 0
  for (const r of [...rows].filter((x) => x.metrics.impressions > 0 && x.status !== "unknown").sort((a, b) => b.metrics.impressions - a.metrics.impressions)) {
    if (out.length >= MAP_CITIES) break
    const state = STATES[r.region.split(", ").at(-1) ?? ""]
    const at = state ? c[`${r.city.toLowerCase()}|${state}`] : undefined
    if (!at) {
      missing++
      continue
    }
    out.push({
      key: r.key,
      city: r.city,
      region: r.county ? `${r.county} County` : r.region,
      inside: r.status === "inside",
      lat: at[0],
      lng: at[1],
      cost: r.metrics.cost,
      impressions: r.metrics.impressions,
      clicks: r.metrics.clicks,
      conversions: r.metrics.conversions,
      campaigns: (cityCampaigns.get(r.key) ?? []).slice(0, 6).map((x) => ({
        name: x.name,
        running: x.status === "ENABLED",
        cost: x.metrics.cost,
        impressions: x.metrics.impressions,
        conversions: x.metrics.conversions,
      })),
    })
  }
  return { cities: out, missing }
}
