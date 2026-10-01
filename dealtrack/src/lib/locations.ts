// Location insights for the Locations page: California regions, California cities that cost a
// lot and brought nothing, and each campaign's location targeting with what looks wrong.

import { readFile } from "node:fs/promises"
import path from "node:path"

import { gaql } from "@/lib/google-ads/client"
import type { GeometryCollection, Topology } from "topojson-specification"
import { feature } from "topojson-client"

import { GEO_RESOURCE, geoNames, rates, sumMetrics, type CityCampaign, type LocationRow, type Metrics, type PlaceLevel } from "@/lib/google-ads/reports"
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
  // A county row ("San Mateo County") goes by its county; a city by its name, then its county.
  const asCounty = / County$/.test(row.city) ? row.city.replace(/ County$/, "").toLowerCase() : undefined
  if (asCounty) return byCounty.get(asCounty) ?? OTHER_CALIFORNIA
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

// Place centers, "city|ST" → [lat, lng]: US ZIP code data (the zipcodes package, BSD license),
// which follows where people live, filled in with the Census Gazetteer's places (public domain).
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
  // County outlines, for the map's area view (county level only).
  geometry?: GeoJSON.Geometry
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

// County outlines from us-atlas (US Census boundaries, ISC license), by "name|state FIPS".
const STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", DC: "11", FL: "12", GA: "13", HI: "15", ID: "16",
  IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25", MI: "26", MN: "27", MS: "28", MO: "29",
  MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42",
  RI: "44", SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55", WY: "56",
}
// California city and town outlines: Census cartographic boundaries (public domain), simplified.
let cityShapes: Map<string, GeoJSON.Geometry> | null = null
async function californiaCities() {
  if (cityShapes) return cityShapes
  const fc = JSON.parse(await readFile(path.join(process.cwd(), "src/lib/places/ca-places.json"), "utf8")) as GeoJSON.FeatureCollection<GeoJSON.Geometry, { NAME: string }>
  cityShapes = new Map(fc.features.map((f) => [f.properties.NAME.toLowerCase(), f.geometry]))
  return cityShapes
}

let countyShapes: Map<string, GeoJSON.Geometry> | null = null
async function counties() {
  if (countyShapes) return countyShapes
  const topology = JSON.parse(await readFile(path.join(process.cwd(), "node_modules/us-atlas/counties-10m.json"), "utf8")) as Topology
  const fc = feature(topology, topology.objects.counties as GeometryCollection<{ name: string }>) as GeoJSON.FeatureCollection<GeoJSON.Geometry, { name: string }>
  countyShapes = new Map(fc.features.map((f) => [`${f.properties.name.toLowerCase()}|${String(f.id).slice(0, 2)}`, roundCoords(f.geometry)]))
  return countyShapes
}

// Three decimals (about 100 m) is plenty for shading a county and keeps the page small.
function roundCoords(g: GeoJSON.Geometry): GeoJSON.Geometry {
  const r = (c: number[]) => [Math.round(c[0] * 1000) / 1000, Math.round(c[1] * 1000) / 1000]
  if (g.type === "Polygon") return { type: "Polygon", coordinates: g.coordinates.map((ring) => ring.map(r)) }
  if (g.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: g.coordinates.map((p) => p.map((ring) => ring.map(r))) }
  return g
}

// The middle of a shape's box: good enough to put a county's bubble.
function center(g: GeoJSON.Geometry): [number, number] {
  const pts = g.type === "Polygon" ? g.coordinates.flat() : g.type === "MultiPolygon" ? g.coordinates.flat(2) : []
  const lngs = pts.map((p) => p[0])
  const lats = pts.map((p) => p[1])
  return [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lngs) + Math.max(...lngs)) / 2]
}

const COUNTY_SUFFIX = / (County|Parish|Borough|Census Area|Municipality|City and Borough)$/

// Places with a known spot, for the map: the ones with impressions, most impressions first.
// Cities get a point; counties get their outline (and its middle, for bubbles).
export async function mapCities(
  rows: LocationRow[],
  cityCampaigns: Map<string, CityCampaign[]>,
  level: PlaceLevel = "city",
): Promise<{ cities: MapCity[]; missing: number; abroad: { places: number; impressions: number; cost: number } }> {
  const c = level === "city" ? await cityCoords() : {}
  const shapes = level === "county" ? await counties() : await californiaCities()
  const out: MapCity[] = []
  let missing = 0
  const abroad = { places: 0, impressions: 0, cost: 0 }
  for (const r of [...rows].filter((x) => x.metrics.impressions > 0 && x.status !== "unknown").sort((a, b) => b.metrics.impressions - a.metrics.impressions)) {
    if (out.length >= MAP_CITIES) break
    const state = STATES[r.region.split(", ").at(-1) ?? ""]
    let at: [number, number] | undefined
    let geometry: GeoJSON.Geometry | undefined
    if (level === "county") {
      geometry = state ? shapes.get(`${r.city.replace(COUNTY_SUFFIX, "").toLowerCase()}|${STATE_FIPS[state]}`) : undefined
      at = geometry ? center(geometry) : undefined
    } else {
      geometry = state === "CA" ? shapes.get(r.city.toLowerCase()) : undefined
      at = (state ? c[`${r.city.toLowerCase()}|${state}`] : undefined) ?? (geometry ? center(geometry) : undefined)
    }
    if (!at) {
      // Outside the US there's no spot to put it; say how much went there instead.
      if (!state && !r.region.endsWith("United States")) {
        abroad.places++
        abroad.impressions += r.metrics.impressions
        abroad.cost += r.metrics.cost
      } else missing++
      continue
    }
    out.push({
      key: r.key,
      geometry,
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
  return { cities: out, missing, abroad }
}

// ---- Targeted locations ----------------------------------------------------------------------

// Performance by each campaign's targeted location: what Google Ads shows on its Locations tab.
// It answers "how did this target do", not "where were the people" (that's the rest of the page).
export type TargetedRow = {
  key: string
  place: string // "San Francisco County, California" or "8 mi around 37.95, -121.29"
  campaign: string
  running: boolean
  metrics: Metrics
}

export async function getTargetedLocations(range: { from: string; to: string }, campaignId?: string): Promise<TargetedRow[]> {
  const oneCampaign = campaignId && /^\d+$/.test(campaignId) ? ` AND campaign.id = ${campaignId}` : ""
  const rows = await gaql<{
    campaign: { id?: string | number; name?: string; status?: string }
    campaignCriterion: {
      criterionId?: string | number
      type?: string
      location?: { geoTargetConstant?: string }
      proximity?: { radius?: number; radiusUnits?: string; geoPoint?: { latitudeInMicroDegrees?: number; longitudeInMicroDegrees?: number }; address?: { cityName?: string } }
    }
    metrics?: { costMicros?: string | number; clicks?: string | number; impressions?: string | number; conversions?: string | number }
  }>(
    `SELECT campaign.id, campaign.name, campaign.status, campaign_criterion.criterion_id, campaign_criterion.type,
       campaign_criterion.location.geo_target_constant, campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units,
       campaign_criterion.proximity.geo_point.latitude_in_micro_degrees, campaign_criterion.proximity.geo_point.longitude_in_micro_degrees,
       campaign_criterion.proximity.address.city_name,
       metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
     FROM location_view WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'${oneCampaign}`,
  )
  const names = await geoNames(rows.map((r) => r.campaignCriterion.location?.geoTargetConstant ?? "").filter(Boolean))
  const by = new Map<string, TargetedRow>()
  for (const r of rows) {
    const key = `${r.campaign.id}|${r.campaignCriterion.criterionId}`
    const geo = r.campaignCriterion.location?.geoTargetConstant
    const p = r.campaignCriterion.proximity
    const place = geo
      ? (names.get(geo)?.canonical ?? geo).replace(/,United States$/, "").replace(/,/g, ", ")
      : `${p?.radius ?? "?"} ${UNITS[p?.radiusUnits ?? ""] ?? ""} around ${
          p?.address?.cityName ||
          (p?.geoPoint ? `${((p.geoPoint.latitudeInMicroDegrees ?? 0) / 1e6).toFixed(2)}, ${((p.geoPoint.longitudeInMicroDegrees ?? 0) / 1e6).toFixed(2)}` : "a point")
        }`
    const row = by.get(key) ?? { key, place, campaign: r.campaign.name ?? "", running: r.campaign.status === "ENABLED", metrics: { cost: 0, clicks: 0, impressions: 0, conversions: 0 } }
    row.metrics.cost += Number(r.metrics?.costMicros ?? 0) / 1e6
    row.metrics.clicks += Number(r.metrics?.clicks ?? 0)
    row.metrics.impressions += Number(r.metrics?.impressions ?? 0)
    row.metrics.conversions += Number(r.metrics?.conversions ?? 0)
    by.set(key, row)
  }
  return [...by.values()].sort((a, b) => b.metrics.conversions - a.metrics.conversions || b.metrics.cost - a.metrics.cost)
}
