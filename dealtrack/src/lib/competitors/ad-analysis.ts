// Competitors → Competitor ads: from the samples (ad-samples.ts) to who advertises where. Every
// search is one chance for an advertiser to show, so an advertiser's share is the searches they
// showed in ÷ the searches made, with a 95% range (Wilson score interval) that stays honest with
// few searches: 5 of 10 is "somewhere from 24% to 76%". Never seen in n searches means they likely
// show in fewer than 3/n of them ("rule of three").
import type { AdSample } from "@/lib/competitors/ad-samples"

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1]
  const p = k / n
  const den = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

// What an ad offers, from its headline, text and sitelinks.
export const OFFER_TAGS = [
  { id: "cash", label: "Cash offer", match: /\bcash\b/i },
  { id: "fast", label: "Close fast", match: /\b(fast|quick(ly)?|same[- ]day|24 ?(hours?|hrs?)|\d+ days?|seven days|days not months)\b/i },
  { id: "asis", label: "As-is, no repairs", match: /\bas[- ]is\b|\bno repairs?\b|\bany condition\b|\bno clean(ing|[- ]?up)\b|\bdon'?t (fix|repair|clean)\b/i },
  { id: "nofees", label: "No fees or commissions", match: /\bno (fees?|commissions?|closing costs?|realtors?|agents?)\b|\bzero (fees?|commissions?)\b|\bcommission[- ]free\b|\bfee[- ]free\b/i },
  { id: "inherited", label: "Inherited, probate", match: /\binherit|\bprobate\b|\bestate sale\b/i },
  { id: "foreclosure", label: "Foreclosure", match: /\bforeclos|\bbehind on (your )?(payments|mortgage)\b/i },
  { id: "divorce", label: "Divorce", match: /\bdivorc/i },
  { id: "tenants", label: "Tenants, rentals", match: /\btenants?\b|\brental\b|\blandlords?\b/i },
  { id: "fair", label: "Fair or top price", match: /\b(fair|top|best|highest|competitive|great)( cash)? (offer|price)s?\b|\btop dollar\b/i },
  { id: "noob", label: "No obligation", match: /\bno[- ]obligation\b|\bno pressure\b|\bfree (quote|offer|valuation)\b/i },
  { id: "local", label: "Local", match: /\blocal(ly)?\b|\bfamily[- ]owned\b|\bbay area\b|\bnear you\b/i },
  { id: "trust", label: "Reviews, BBB", match: /\bbbb\b|\breviews?\b|\b5[- ]star\b|\btop[- ]rated\b|\btrusted\b|\ba\+ rat/i },
] as const
export type OfferTag = (typeof OFFER_TAGS)[number]["id"]
export const offerTags = (text: string): OfferTag[] => OFFER_TAGS.filter((t) => t.match.test(text)).map((t) => t.id)

// Pacific time of day, in four blocks plus the night.
export const DAYPARTS = ["6–10 AM", "10 AM–2 PM", "2–6 PM", "6–10 PM", "Night"] as const
const pacific = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23", weekday: "short" })
function whenPacific(iso: string) {
  const parts = pacific.formatToParts(new Date(iso))
  const h = Number(parts.find((p) => p.type === "hour")?.value)
  const day = parts.find((p) => p.type === "weekday")?.value ?? ""
  const block = h >= 6 && h < 10 ? 0 : h >= 10 && h < 14 ? 1 : h >= 14 && h < 18 ? 2 : h >= 18 && h < 22 ? 3 : 4
  return { block, weekend: day === "Sat" || day === "Sun" }
}

export type Range = { seen: number; n: number; share: number; lo: number; hi: number }
const range = (seen: number, n: number): Range => {
  const [lo, hi] = wilson(seen, n)
  return { seen, n, share: n ? seen / n : 0, lo, hi }
}

export type AdvertiserRow = Range & {
  d: string
  ours: boolean
  top: number // searches where they showed above the results
  first: number // searches where theirs was the very first ad
  pos: number // average place among the ads (1 = first)
  desktop: Range
  mobile: Range
  keywords: { k: string; seen: number; n: number }[] // where they show most
  placesSeen: number
  keywordsSeen: number
  creatives: number
  firstSeen: string
  lastSeen: string
  phone?: string
}
export type Creative = {
  d: string
  t: string
  desc: string
  dl?: string
  links: string[]
  seen: number
  first: string
  last: string
  tags: OfferTag[]
  keywords: string[]
  places: number
}
export type AdAnalysis = {
  samples: number
  withAds: number
  ads: number
  from: string
  to: string
  ai: number // searches with an AI Overview (they rarely have ads)
  devices: Record<"desktop" | "mobile", { n: number; withAds: number }>
  advertisers: AdvertiserRow[]
  keywords: { k: string; n: number; withAds: number; top: { d: string; seen: number }[] }[]
  places: { loc: string; n: number; withAds: number; top: { d: string; seen: number }[] }[]
  creatives: Creative[]
  dayparts: { n: number[]; weekend: number; weekday: number; rows: { d: string; seen: number[]; weekend: number; weekday: number }[] }
  // Keyword × place: searches made, searches with ads, and per advertiser (the top 15) searches seen.
  grid: { keywords: string[]; places: string[]; n: Record<string, number>; withAds: Record<string, number>; seen: Record<string, Record<string, number>> }
}

export const cellKey = (k: string, loc: string) => `${k}|${loc}`

export function analyzeAds(samples: AdSample[], ourSites: string[]): AdAnalysis {
  type Acc = {
    seen: number
    top: number
    first: number
    posSum: number
    posN: number
    dev: Record<string, number>
    kw: Map<string, number>
    places: Set<string>
    creatives: Set<string>
    firstSeen: string
    lastSeen: string
    phone?: string
    blocks: number[]
    weekend: number
    weekday: number
    cells: Map<string, number>
  }
  const acc = new Map<string, Acc>()
  const kwN = new Map<string, { n: number; withAds: number; by: Map<string, number> }>()
  const placeN = new Map<string, { n: number; withAds: number; by: Map<string, number> }>()
  const creatives = new Map<string, Creative & { kw: Map<string, number>; locs: Set<string> }>()
  const devices = { desktop: { n: 0, withAds: 0 }, mobile: { n: 0, withAds: 0 } }
  const blockN = [0, 0, 0, 0, 0]
  let weekendN = 0
  let weekdayN = 0
  const gridN: Record<string, number> = {}
  const gridAds: Record<string, number> = {}
  let withAds = 0
  let ads = 0
  let ai = 0

  for (const s of samples) {
    const when = whenPacific(s.at)
    const cell = cellKey(s.k, s.loc)
    const dev = s.dev === "mobile" ? "mobile" : "desktop"
    devices[dev].n++
    blockN[when.block]++
    if (when.weekend) weekendN++
    else weekdayN++
    gridN[cell] = (gridN[cell] ?? 0) + 1
    if (s.ai) ai++
    const kwRow = kwN.get(s.k) ?? { n: 0, withAds: 0, by: new Map() }
    const placeRow = placeN.get(s.loc) ?? { n: 0, withAds: 0, by: new Map() }
    kwRow.n++
    placeRow.n++
    kwN.set(s.k, kwRow)
    placeN.set(s.loc, placeRow)
    if (!s.ads.length) continue
    withAds++
    ads += s.ads.length
    devices[dev].withAds++
    kwRow.withAds++
    placeRow.withAds++
    gridAds[cell] = (gridAds[cell] ?? 0) + 1

    // Each advertiser counts once per search, at its best place.
    const best = new Map<string, { top: boolean; order: number; first: boolean }>()
    s.ads.forEach((ad, i) => {
      const order = i + 1
      const had = best.get(ad.d)
      if (!had || order < had.order) best.set(ad.d, { top: ad.block === "top", order, first: ad.block === "top" && ad.r === 1 })
      const ck = `${ad.d}|${ad.t}|${ad.desc ?? ""}`
      const c = creatives.get(ck) ?? {
        d: ad.d,
        t: ad.t,
        desc: ad.desc ?? "",
        dl: ad.dl,
        links: ad.links ?? [],
        seen: 0,
        first: s.at,
        last: s.at,
        tags: offerTags([ad.t, ad.desc ?? "", ...(ad.links ?? [])].join(" · ")),
        keywords: [],
        places: 0,
        kw: new Map(),
        locs: new Set(),
      }
      c.seen++
      c.last = s.at
      c.kw.set(s.k, (c.kw.get(s.k) ?? 0) + 1)
      c.locs.add(s.loc)
      creatives.set(ck, c)
    })
    for (const [d, b] of best) {
      const a: Acc = acc.get(d) ?? {
        seen: 0,
        top: 0,
        first: 0,
        posSum: 0,
        posN: 0,
        dev: {},
        kw: new Map(),
        places: new Set(),
        creatives: new Set(),
        firstSeen: s.at,
        lastSeen: s.at,
        blocks: [0, 0, 0, 0, 0],
        weekend: 0,
        weekday: 0,
        cells: new Map(),
      }
      a.seen++
      if (b.top) a.top++
      if (b.first) a.first++
      a.posSum += b.order
      a.posN++
      a.dev[dev] = (a.dev[dev] ?? 0) + 1
      a.kw.set(s.k, (a.kw.get(s.k) ?? 0) + 1)
      a.places.add(s.loc)
      a.lastSeen = s.at
      a.blocks[when.block]++
      if (when.weekend) a.weekend++
      else a.weekday++
      a.cells.set(cell, (a.cells.get(cell) ?? 0) + 1)
      for (const ad of s.ads) {
        if (ad.d !== d) continue
        a.creatives.add(`${ad.t}|${ad.desc ?? ""}`)
        if (ad.phone) a.phone = ad.phone
      }
      acc.set(d, a)
      kwRow.by.set(d, (kwRow.by.get(d) ?? 0) + 1)
      placeRow.by.set(d, (placeRow.by.get(d) ?? 0) + 1)
    }
  }

  const n = samples.length
  const ours = new Set(ourSites)
  const advertisers: AdvertiserRow[] = [...acc.entries()]
    .map(([d, a]) => ({
      d,
      ours: ours.has(d),
      ...range(a.seen, n),
      top: a.top,
      first: a.first,
      pos: a.posN ? a.posSum / a.posN : 0,
      desktop: range(a.dev.desktop ?? 0, devices.desktop.n),
      mobile: range(a.dev.mobile ?? 0, devices.mobile.n),
      keywords: [...a.kw.entries()]
        .map(([k, seen]) => ({ k, seen, n: kwN.get(k)?.n ?? 0 }))
        .sort((x, y) => y.seen - x.seen || y.seen / Math.max(1, y.n) - x.seen / Math.max(1, x.n))
        .slice(0, 6),
      placesSeen: a.places.size,
      keywordsSeen: a.kw.size,
      creatives: a.creatives.size,
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
      ...(a.phone ? { phone: a.phone } : {}),
    }))
    .sort((x, y) => y.seen - x.seen || x.d.localeCompare(y.d))

  const topOf = (by: Map<string, number>) =>
    [...by.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([d, seen]) => ({ d, seen }))
  const gridAdvertisers = advertisers.slice(0, 15).map((a) => a.d)
  if (!gridAdvertisers.some((d) => ours.has(d))) gridAdvertisers.push(...advertisers.filter((a) => a.ours).map((a) => a.d))

  return {
    samples: n,
    withAds,
    ads,
    from: samples[0]?.at ?? "",
    to: samples.at(-1)?.at ?? "",
    ai,
    devices,
    advertisers,
    keywords: [...kwN.entries()].map(([k, r]) => ({ k, n: r.n, withAds: r.withAds, top: topOf(r.by) })).sort((x, y) => y.n - x.n || x.k.localeCompare(y.k)),
    places: [...placeN.entries()].map(([loc, r]) => ({ loc, n: r.n, withAds: r.withAds, top: topOf(r.by) })).sort((x, y) => y.n - x.n || x.loc.localeCompare(y.loc)),
    creatives: [...creatives.values()]
      .map(({ kw, locs, ...c }) => ({
        ...c,
        keywords: [...kw.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 4)
          .map(([k]) => k),
        places: locs.size,
      }))
      .sort((x, y) => y.seen - x.seen || y.last.localeCompare(x.last)),
    dayparts: {
      n: blockN,
      weekend: weekendN,
      weekday: weekdayN,
      rows: advertisers.slice(0, 8).map((a) => {
        const x = acc.get(a.d)!
        return { d: a.d, seen: x.blocks, weekend: x.weekend, weekday: x.weekday }
      }),
    },
    grid: {
      keywords: [...kwN.keys()].sort(),
      places: [...placeN.keys()].sort(),
      n: gridN,
      withAds: gridAds,
      seen: Object.fromEntries(gridAdvertisers.map((d) => [d, Object.fromEntries(acc.get(d)?.cells ?? [])])),
    },
  }
}
