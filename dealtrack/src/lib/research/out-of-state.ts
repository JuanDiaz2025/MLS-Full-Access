// Spots results from outside California: Google answers general searches ("sell house before
// foreclosure") from all over the US even when asked for California, so a Florida county clerk or
// a Minnesota sheriff can rank. A page counts as out of state when its address or title names
// another state, one of its cities or counties, or a non-California county; a site is out of state
// when most of its pages are and none mention California. A guess from words, so it can miss some.
import { CALIFORNIA_PLACES } from "@/lib/service-area"

const STATES = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington state",
  "west virginia",
  "wisconsin",
  "wyoming",
]
const CODES =
  "AL|AK|AZ|AR|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC"
const CITIES = [
  "houston",
  "dallas",
  "austin",
  "san antonio",
  "fort worth",
  "el paso",
  "atlanta",
  "chicago",
  "miami",
  "orlando",
  "tampa",
  "jacksonville",
  "palm beach",
  "broward",
  "phoenix",
  "tucson",
  "scottsdale",
  "mesa",
  "las vegas",
  "reno",
  "henderson",
  "denver",
  "colorado springs",
  "seattle",
  "tacoma",
  "spokane",
  "portland",
  "boise",
  "salt lake",
  "omaha",
  "kansas city",
  "st louis",
  "st. louis",
  "minneapolis",
  "st paul",
  "hennepin",
  "milwaukee",
  "detroit",
  "cleveland",
  "columbus",
  "cincinnati",
  "indianapolis",
  "louisville",
  "nashville",
  "memphis",
  "knoxville",
  "charlotte",
  "raleigh",
  "durham",
  "richmond va",
  "virginia beach",
  "baltimore",
  "philadelphia",
  "pittsburgh",
  "boston",
  "brooklyn",
  "manhattan",
  "queens",
  "bronx",
  "long island",
  "newark nj",
  "birmingham al",
  "new orleans",
  "baton rouge",
  "oklahoma city",
  "tulsa",
  "albuquerque",
  "little rock",
  "des moines",
  "honolulu",
  "anchorage",
  "charleston",
  "savannah",
  "jersey city",
]
const CA_COUNTIES = [
  "alameda",
  "alpine",
  "amador",
  "butte",
  "calaveras",
  "colusa",
  "contra costa",
  "del norte",
  "el dorado",
  "fresno",
  "glenn",
  "humboldt",
  "imperial",
  "inyo",
  "kern",
  "kings",
  "lake",
  "lassen",
  "los angeles",
  "madera",
  "marin",
  "mariposa",
  "mendocino",
  "merced",
  "modoc",
  "mono",
  "monterey",
  "napa",
  "nevada",
  "orange",
  "placer",
  "plumas",
  "riverside",
  "sacramento",
  "san benito",
  "san bernardino",
  "san diego",
  "san francisco",
  "san joaquin",
  "san luis obispo",
  "san mateo",
  "santa barbara",
  "santa clara",
  "santa cruz",
  "shasta",
  "sierra",
  "siskiyou",
  "solano",
  "sonoma",
  "stanislaus",
  "sutter",
  "tehama",
  "trinity",
  "tulare",
  "tuolumne",
  "ventura",
  "yolo",
  "yuba",
]

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "")
const words = (list: string[]) => new RegExp(`\\b(${list.map((w) => w.replace(/[.]/g, "\\.").replace(/ /g, "\\s+")).join("|")})\\b`, "i")
const OTHER_PLACE = words([...STATES, ...CITIES])
// In a site's name, words run together: "mypalmbeachclerk", "hennepinsheriff", "floridahomebuyers".
const OTHER_IN_NAME = [...STATES, ...CITIES].map(squash).filter((w) => w.length >= 5 && w !== "maine")
const STATE_CODE = new RegExp(`(,\\s*|\\b)(${CODES})\\s+\\d{5}\\b|,\\s*(${CODES})\\b(?!\\s*\\w*[a-z])`)
const STATE_GOV = new RegExp(`\\.(${CODES.toLowerCase()})\\.us$|^(${CODES.toLowerCase()})\\.gov$`)
const COUNTY = /\b([a-z][a-z.' -]{1,20}?)\s+county\b/gi
const CA_COUNTY = new Set(CA_COUNTIES)
const CALIFORNIA = new RegExp(`\\bcalifornia\\b|,\\s*CA\\b|\\bCA\\s+9\\d{4}\\b|${words(CALIFORNIA_PLACES.filter((p) => p.length > 4)).source}`, "i")

// Does this page (its site, title or street address) point outside California?
// "Nevada County" and "Orange County" are in California.
const CA_COUNTY_NAME = new RegExp(`\\b(${CA_COUNTIES.join("|")})\\s+county\\b`, "gi")

const CA_COUNTY_SQUASHED = new RegExp(`(${CA_COUNTIES.map(squash).join("|")})county`, "g")

export function pointsOutOfState(site: string, title: string): boolean {
  if (CALIFORNIA.test(title)) return false
  title = title.replace(CA_COUNTY_NAME, " ")
  if (STATE_GOV.test(site) || OTHER_IN_NAME.some((w) => squash(site).replace(CA_COUNTY_SQUASHED, "").includes(w))) return true
  if (OTHER_PLACE.test(title) || STATE_CODE.test(title)) return true
  for (const m of title.matchAll(COUNTY)) {
    const name = m[1].toLowerCase().trim().split(/\s+/).slice(-2).join(" ")
    if (!CA_COUNTY.has(name) && !CA_COUNTY.has(name.split(" ").at(-1)!)) return true
  }
  return false
}

export const mentionsCalifornia = (text: string) => CALIFORNIA.test(text)

// A site is out of state when most of its pages point outside California and none mention it.
export function siteOutOfState(pages: { d: string; t: string }[]): boolean {
  if (!pages.length) return false
  if (pages.some((p) => mentionsCalifornia(p.t))) return false
  return pages.filter((p) => pointsOutOfState(p.d, p.t)).length > pages.length / 2
}
