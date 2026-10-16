// The chat's tools. All of them only read: Google Ads through GAQL SELECT queries on DealTrack's
// connection (the search endpoint can't change an account), the website leads, DealTrack's own
// saved records (alerts, budget lines, weekly negatives), and PageSpeed tests of the landing pages.
import { PAGES, PAGE_GUIDE, pageData, type PageName } from "@/lib/assistant/pages"
import { addDays, dayOf, today } from "@/lib/date-range"
import { getClickPatterns } from "@/lib/fraud/clicks"
import { findJunkLeads } from "@/lib/fraud/leads"
import { classifyVisits, findClusters, getAdVisits } from "@/lib/fraud/visitors"
import { getCampaignAds, getCampaignAssets, getCampaignInfo, getCampaignKeywords } from "@/lib/google-ads/campaign"
import { adClickUrl, TEST_GCLID } from "@/lib/google-ads/click-url"
import { GoogleAdsError, gaql } from "@/lib/google-ads/client"
import { getOverview } from "@/lib/google-ads/overview"
import { getAllCampaigns, getLocationData, getSearchTerms, isWaste } from "@/lib/google-ads/reports"
import { activeAccount } from "@/lib/conversions/google"
import { leadSource } from "@/lib/leads/source"
import { listLeads, listQrCodes } from "@/lib/leads/store"
import { leadChannel } from "@/lib/leads/tracking"
import { getPageSpeed, type PageSpeed } from "@/lib/pagespeed"
import { readCombined } from "@/lib/sheets/sync"
import { readData } from "@/lib/store"

// Written once and handed to whichever AI provider is set up (see claude.ts and openai.ts).
export type ToolSpec = {
  name: string
  description: string
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
}

export const toolSpecs: ToolSpec[] = [
  {
    name: "deal_history",
    description:
      "The company's closed and pending deals from its Google Sheet (the Deal History tab: every deal from the 2024, 2025 and 2026 tabs in one list), " +
      "with each deal's lead name, dates (lead received, contract signed, acquired), address, Google Ads campaign, keyword, ad group, lead source (PPC = Google Ads, " +
      "Direct Mail, Realtor...), marketing fee (the deal's profit to the company) and status, plus summary tables by year and by Google Ads campaign " +
      "(deals, marketing fees, Google Ads spend, ad spend per deal, return on ad spend). Use it for questions about deals, profit, which campaigns or keywords " +
      "brought deals, and return on ad spend. Pass a year to see only that year's deals, or 0 for all.",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "A year like 2025 for only that year's deals, or 0 for all years." },
      },
      required: ["year"],
      additionalProperties: false,
    },
  },
  {
    name: "dealtrack_page",
    description:
      "Read what one of DealTrack's own pages shows, already worked out: the same findings the team sees on that page. " +
      "Prefer it over raw queries when the question matches a page. Pages: " +
      PAGE_GUIDE,
    parameters: {
      type: "object",
      properties: {
        page: { type: "string", enum: [...PAGES], description: "Which page." },
        days: { type: "integer", description: "How many days back, from 1 to 365 (ignored by budget, audit, negatives and keyword_ideas). Default 30." },
      },
      required: ["page", "days"],
      additionalProperties: false,
    },
  },
  {
    name: "google_ads_query",
    description:
      "Run a read-only Google Ads Query Language (GAQL) SELECT query against Twin Home Buyer's Google Ads account and get the rows back as JSON. " +
      "Use it for any question about spend, clicks, impressions, conversions, campaigns, ad groups, keywords, search terms, locations or devices. " +
      "Useful resources: campaign, ad_group, ad_group_criterion (keywords), keyword_view, search_term_view, geographic_view, customer. " +
      "For locations: user_location_view with segments.geo_target_city and user_location_view.targeting_location (false = outside the target area), " +
      "campaign_criterion WHERE campaign_criterion.type = 'LOCATION' for targeting, campaign.geo_target_type_setting.positive_geo_target_type for Presence vs Presence or interest, " +
      "and geo_target_constant (resource_name IN (...)) to turn geoTargetConstants/123 into place names. " +
      "For phone calls: call_view (start_call_date_time, call_duration_seconds, call_status MISSED or RECEIVED, caller_area_code, campaign.name); filter with call_view.start_call_date_time >= 'YYYY-MM-DD 00:00:00' instead of segments.date. " +
      "Money fields end in _micros: divide by 1,000,000 to get dollars. " +
      "Always filter by date with segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' (or DURING LAST_7_DAYS / LAST_30_DAYS / THIS_MONTH / LAST_MONTH), " +
      "and add ORDER BY and a LIMIT (at most 200). JSON field names come back in camelCase, e.g. metrics.costMicros.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A complete GAQL SELECT statement." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_leads",
    description:
      "List the leads collected in the last N days, newest first, from the WordPress website's forms. " +
      "Each lead has a date, name, phone, email, property address, notes, the form, its channel (Google Ads, Facebook, organic search...), tracking (UTM tags, Google click ID, landing page), " +
      "its score (0-100, graded hot/warm/cold/junk, with the reasons), the team's status (new, unresponsive, interested, appointment, offer, closed, not_interested), and what was sent back to Google Ads as an offline conversion, " +
      "and roughly where the person was (not the property): the city/ZIP of their Google Ads click, the place their search was about, and their internet connection's city from the website visit. " +
      "These are separate from Google Ads conversions.",
    parameters: {
      type: "object",
      properties: { days: { type: "integer", description: "How many days back to look, from 1 to 365." } },
      required: ["days"],
      additionalProperties: false,
    },
  },
  {
    name: "dealtrack_status",
    description:
      "DealTrack's own records: the open alerts (and the last 20 that cleared), the monthly budget with its alert and pause lines, the alert limits, " +
      "and the weekly negative keyword batches with each line's review and approval. Use it for questions about alerts, the budget, or negatives.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "fraud_check",
    description:
      "DealTrack's Fraud page data for the last N days: the IP addresses that came from the ads (from PostHog, grouped by connection: an IPv4 address or an IPv6 /64), " +
      "each sorted into looks real / suspicious / bot / team with the reasons (repeat ad clicks from one connection, arriving in lockstep with other connections, outside the US, " +
      "automated browser, Google's own landing page checks), bursts of ad clicks from different connections at the same moment, suspicious days in Google Ads " +
      "(click spikes, invalid-click bursts, night clicks, one-hour bursts) with how many days are left to file a refund claim, and junk form leads. " +
      "Use it for any question about suspicious IP addresses, click fraud, bots, invalid clicks or refund claims.",
    parameters: {
      type: "object",
      properties: { days: { type: "integer", description: "How many days back to look, from 1 to 365." } },
      required: ["days"],
      additionalProperties: false,
    },
  },
  {
    name: "campaign_detail",
    description:
      "Everything DealTrack's single-campaign page shows (Optimize → Campaigns → click a campaign) for one campaign: its settings and Google's status, " +
      "spend, leads, cost per lead, clicks and impression share against the period before, every ad with all headlines and descriptions (with Google's " +
      "Best/Good/Low ratings and pins), ad strength and approval, sitelinks, callouts and images, keywords with Quality Score, the searches that brought " +
      "leads and the costliest ones with none, and the top cities. Use it when the question is about one campaign or its ads.",
    parameters: {
      type: "object",
      properties: {
        campaign: { type: "string", description: "The campaign's name (or part of it) or its ID." },
        days: { type: "integer", description: "How many days back, from 1 to 365." },
      },
      required: ["campaign", "days"],
      additionalProperties: false,
    },
  },
  {
    name: "page_speed",
    description:
      "Test how fast pages load on a phone with Google PageSpeed Insights (the mobile test on pagespeed.web.dev). Give a campaign to test the pages its " +
      "running ads and its sitelinks send people to, or a url to test one page. Each page is tested twice: as an ad click (the address a real click lands on, " +
      "with the tracking Google adds, so click-fraud checks and tracking tags run as they do for ad visitors) and as a plain visit. Each result has the " +
      "score (0-100), when the main content showed (seconds), how long the page was frozen and couldn't respond to taps (total blocking time), layout " +
      "shift, real Chrome visitors' rating when Google has enough data, and the outside scripts that kept the phone busiest. Tests take 10-30 seconds " +
      "and are kept for 12 hours. Pass an empty string for whichever of campaign and url isn't used.",
    parameters: {
      type: "object",
      properties: {
        campaign: { type: "string", description: "The campaign's name (or part of it) or its ID, or an empty string." },
        url: { type: "string", description: "One page's full address (https://...), or an empty string." },
      },
      required: ["campaign", "url"],
      additionalProperties: false,
    },
  },
]

// The campaign a name, part of a name or an ID points to: the exact ID or name, else the one with
// every word in its name (running campaigns first).
function matchCampaign<T extends { id: string; name: string; status: string }>(all: T[], campaign: string) {
  const wanted = campaign.trim().toLowerCase()
  return (
    all.find((c) => c.id === wanted) ??
    all.find((c) => c.name.toLowerCase() === wanted) ??
    all.filter((c) => wanted.split(/\s+/).every((w) => c.name.toLowerCase().includes(w))).sort((a, b) => (a.status === "ENABLED" ? 0 : 1) - (b.status === "ENABLED" ? 0 : 1))[0]
  )
}

// One campaign, as its DealTrack page shows it.
export async function campaignDetail(campaign: string, days: number) {
  const range = { from: addDays(today(), -(days - 1)), to: today(), label: `Last ${days} days` }
  const all = await getAllCampaigns(range)
  const match = matchCampaign(all, campaign)
  if (!match) return { error: `No campaign matches "${campaign}".`, campaigns: all.filter((c) => c.status === "ENABLED").map((c) => c.name) }
  const id = match.id
  const [info, overview, ads, assets, keywords, terms, places] = await Promise.all([
    getCampaignInfo(id),
    getOverview(range, id),
    getCampaignAds(id, range),
    getCampaignAssets(id),
    getCampaignKeywords(id, range),
    getSearchTerms(range, id),
    getLocationData(range, id),
  ])
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    page: `/campaigns/${id}`,
    range,
    campaign: info,
    totals: overview.totals,
    previousPeriod: overview.previous,
    ads: ads.map((a) => ({
      adGroup: a.adGroup,
      status: a.status,
      strength: a.strength,
      approval: a.approval,
      policyTopics: a.topics,
      finalUrl: a.finalUrl,
      displayUrl: a.displayUrl,
      headlines: a.headlines,
      descriptions: a.descriptions,
      metrics: a.metrics,
    })),
    assets,
    keywords: keywords.slice(0, 25).map((k) => ({ text: k.text, match: k.matchType, status: k.status, qualityScore: k.quality, cost: round(k.metrics.cost), clicks: k.metrics.clicks, conversions: k.metrics.conversions })),
    searchesWithLeads: terms.filter((t) => t.metrics.conversions > 0).slice(0, 10).map((t) => ({ term: t.term, cost: round(t.metrics.cost), conversions: t.metrics.conversions })),
    costliestWithNoLeads: terms.filter((t) => isWaste(t.metrics)).slice(0, 10).map((t) => ({ term: t.term, cost: round(t.metrics.cost), clicks: t.metrics.clicks, blocked: t.status.includes("EXCLUDED") })),
    topCities: places.rows.slice(0, 10).map((p) => ({ city: p.city, inBuyArea: p.status !== "outside", cost: round(p.metrics.cost), conversions: p.metrics.conversions })),
  }
}

// How long the chat waits for PageSpeed (tests usually take 10–40 seconds, a few at once can take
// longer). The campaign's Landing page tab runs the same tests.
const SPEED_WAIT_MS = 90_000

// A campaign's ad landing pages and sitelink pages (at most 8), or one address, each tested on a
// phone as an ad click and as a plain visit.
export async function pageSpeedCheck(campaign: string, url: string) {
  if (!process.env.PAGESPEED_API_KEY?.trim()) return { error: "PageSpeed isn't set up: PAGESPEED_API_KEY is missing from .env.local." }
  let pages: { what: string; url: string; clickUrl: string }[]
  let about: Record<string, string> = {}
  if (url.trim()) {
    const address = url.trim()
    if (!/^https?:\/\//i.test(address) || !URL.canParse(address)) return { error: `"${address}" isn't a full web address (https://...).` }
    // Any address: a typical Google Ads click's tracking. A campaign's pages get their own.
    pages = [{ what: "Page", url: address, clickUrl: adClickUrl(address, "utm_source=google&utm_medium=cpc") }]
  } else {
    const range = { from: addDays(today(), -29), to: today(), label: "Last 30 days" }
    const all = await getAllCampaigns(range)
    const match = matchCampaign(all, campaign)
    if (!match) return { error: `No campaign matches "${campaign}".`, campaigns: all.filter((c) => c.status === "ENABLED").map((c) => c.name) }
    const [ads, assets] = await Promise.all([getCampaignAds(match.id, range), getCampaignAssets(match.id)])
    const landing = new Map<string, { what: string; url: string; clickUrl: string }>()
    for (const a of ads) {
      if (a.status === "ENABLED" && a.finalUrl && !landing.has(a.finalUrl)) landing.set(a.finalUrl, { what: `Ad landing page (as a click on the ${a.adGroup} ad)`, url: a.finalUrl, clickUrl: a.clickUrl })
    }
    const sitelinks = assets.sitelinks.filter((s) => s.url).map((s) => ({ what: `Sitelink: ${s.text}`, url: s.url, clickUrl: s.clickUrl }))
    pages = [...[...landing.values()].slice(0, 2), ...sitelinks].slice(0, 8)
    about = { campaign: match.name, dealtrackPage: `/campaigns/${match.id}?tab=landing` }
    if (!pages.length) return { ...about, error: "This campaign has no running ads or sitelinks with a landing page." }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ stillTesting: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ stillTesting: "PageSpeed took over 90 seconds on this test. Ask again in a minute, or see it on the campaign's Landing page tab." }),
      SPEED_WAIT_MS,
    )
  })
  const summary = (s: PageSpeed) => ({
    score: s.performance,
    mainContentSeconds: s.lcpS,
    frozenSeconds: s.tbtMs === null ? null : Math.round(s.tbtMs / 100) / 10,
    layoutShift: s.cls === null ? null : Math.round(s.cls * 1000) / 1000,
    realChromeVisitors: s.fieldLcp ?? "not enough data",
    slowestOutsideScripts: (s.heaviestScripts ?? []).map((x) => `${x.name} ${Math.round(x.ms / 100) / 10}s`),
  })
  const test = (address: string) =>
    Promise.race([
      (async () => summary(await getPageSpeed(address)))().catch((e: unknown) => ({ error: e instanceof Error ? e.message : "The test failed." })),
      late,
    ])
  const results = await Promise.all(
    pages.map(async (p) => {
      const [adClick, plainVisit] = await Promise.all([test(p.clickUrl), test(p.url)])
      return { ...p, adClick, plainVisit }
    }),
  )
  clearTimeout(timer)
  return {
    ...about,
    testedOn: "a phone (Google PageSpeed Insights, mobile)",
    note: `The ad-click test opens the address a real click lands on, with ${TEST_GCLID} as the click ID. A big gap between the two tests means something on the page works much harder for ad visitors.`,
    pages: results.map(({ what, url: address, adClick, plainVisit }) => ({ what, url: address, adClick, plainVisit })),
  }
}

const MAX_ROWS = 200
const MAX_CHARS = 60_000

// Keeps tool results a sensible size for the model, and says when rows were left out.
function asResult(rows: unknown[]) {
  const kept = rows.slice(0, MAX_ROWS)
  let text = JSON.stringify({ rowCount: rows.length, rows: kept })
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}… (truncated, narrow the query)`
  else if (rows.length > kept.length) text += `\n(Only the first ${MAX_ROWS} of ${rows.length} rows are shown.)`
  return text
}

export async function recentLeads(days: number) {
  const since = Date.now() - days * 86_400_000
  const [leads, qrCodes] = await Promise.all([listLeads(), listQrCodes()])
  const placements = new Map(qrCodes.map((c) => [c.id, c.placement]))
  return leads
    .filter((l) => Date.parse(l.createdAt) >= since)
    .map((l) => ({
      date: l.createdAt,
      name: l.name,
      phone: l.phone,
      email: l.email,
      propertyAddress: l.propertyAddress,
      notes: l.notes,
      source: leadSource(l, placements),
      channel: leadChannel(l),
      score: l.score && { value: l.score.value, grade: l.score.grade, reasons: l.score.reasons },
      status: l.status ?? "new",
      sentToGoogleAds: l.conversions
        ? Object.fromEntries(
            Object.entries(l.conversions).map(([kind, c]) => [
              kind,
              c?.retraction ? (c.retraction.state === "none" ? "nothing to take back (Google never counted it)" : `taken back (${c.retraction.state})`) : c?.test ? "test lead, not sent" : (c?.google?.status ?? c?.state),
            ]),
          )
        : undefined,
      tracking: l.tracking,
      roughLocation: l.place && (l.place.google || l.place.posthog) ? { googleAdsClick: l.place.google, searchedAbout: l.place.googleInterest, websiteVisit: l.place.posthog } : undefined,
    }))
}

export async function dealtrackStatus() {
  const data = await readData()
  return {
    budget: data.budget,
    alertLimits: data.alerts,
    openAlerts: data.alertLog.filter((r) => !r.resolvedAt).map(({ severity, title, detail, firstSeen }) => ({ severity, title, detail, firstSeen })),
    recentlyCleared: data.alertLog
      .filter((r) => r.resolvedAt)
      .slice(0, 20)
      .map(({ title, firstSeen, resolvedAt }) => ({ title, firstSeen, resolvedAt })),
    weeklyNegatives: data.batches.slice(0, 8).map((b) => ({
      week: `${b.from} to ${b.to}`,
      lines: b.items.map((i) => ({ negative: i.negative, why: i.why, cost: Math.round(i.cost), reviewed: i.proven, approved: i.approved })),
      pushed: b.pushed ? { by: b.pushed.by, at: b.pushed.at, dryRun: !!b.pushed.dryRun } : null,
    })),
  }
}

// The Fraud page's findings in one block, for the chat. PostHog or Google Ads failing leaves its
// part out with the reason, so the rest still answers.
export async function fraudCheck(days: number) {
  const end = today()
  const range = { from: addDays(end, -(days - 1)), to: end, label: `Last ${days} days` }
  const data = await readData()
  const settle = <T>(p: Promise<T>) => p.catch((e: unknown) => ({ error: e instanceof Error ? e.message : "unavailable" }))
  const [patterns, visits, leads] = await Promise.all([settle(getClickPatterns(range)), settle(getAdVisits(range)), settle(listLeads())])
  const place = (v: { city: string; region: string; country: string }) => [v.city, v.region, v.country].filter(Boolean).join(", ") || "Unknown"

  let adVisitors: unknown = visits
  if (Array.isArray(visits)) {
    const classified = classifyVisits(visits, data.knownNetworks)
    const by = new Map<string, typeof classified>()
    for (const v of classified) if (v.network) by.set(v.network, [...(by.get(v.network) ?? []), v])
    const rank = { suspicious: 0, bot: 1, team: 2, real: 3 } as const
    const connections = [...by].map(([network, list]) => {
      const worst = [...list].sort((a, b) => rank[a.kind] - rank[b.kind])[0]
      return {
        connection: network,
        ips: [...new Set(list.map((v) => v.ip))].slice(0, 5),
        place: place(list[0]),
        adVisits: list.length,
        adClickIds: new Set(list.map((v) => v.gclid).filter(Boolean)).size,
        looksLike: worst.kind,
        why: worst.why,
        first: list[0].startedAt,
        last: list[list.length - 1].startedAt,
        formsSent: list.filter((v) => v.submitted).length,
        devices: [...new Set(list.map((v) => [v.browser, v.os].filter(Boolean).join(" on ")))].slice(0, 3),
      }
    })
    connections.sort((a, b) => rank[a.looksLike] - rank[b.looksLike] || b.adVisits - a.adVisits)
    adVisitors = {
      source: "PostHog, Google Ads visits only (Google click ID, campaign ID or Google Ads UTM tag on the landing address)",
      totals: {
        visits: classified.length,
        connections: by.size,
        real: classified.filter((v) => v.kind === "real").length,
        suspicious: classified.filter((v) => v.kind === "suspicious").length,
        bots: classified.filter((v) => v.kind === "bot").length,
        team: classified.filter((v) => v.kind === "team").length,
      },
      teamConnections: data.knownNetworks.map((k) => ({ connection: k.network, label: k.label })),
      connections: connections.filter((c) => c.looksLike !== "real" || c.adVisits >= 2).slice(0, 40),
      sameMomentBursts: findClusters(visits, data.knownNetworks)
        .slice(0, 10)
        .map((c) => ({ start: c.start, adClicks: c.visits.length, places: c.places, ips: c.visits.map((v) => v.ip) })),
    }
  }

  return {
    period: { from: range.from, to: range.to },
    suspiciousDays:
      "error" in patterns
        ? patterns
        : patterns.flagged.slice(0, 20).map((d) => ({
            date: d.date,
            flags: d.flags,
            reasons: d.reasons,
            billedClicks: d.clicks,
            normalClicks: Math.round(d.normalClicks),
            invalidClicksFiltered: d.invalid,
            cost: Math.round(d.cost * 100) / 100,
            conversions: Math.round(d.conversions * 10) / 10,
            mainCampaign: d.campaigns[0]?.name ?? null,
            refundClaimDaysLeft: Math.max(0, 60 - Math.round((Date.parse(end) - Date.parse(d.date)) / 86_400_000)),
          })),
    adVisitors,
    junkLeads: Array.isArray(leads)
      ? findJunkLeads(leads, (l) => dayOf(l.createdAt) >= range.from)
          .slice(0, 20)
          .map((j) => ({ date: j.lead.createdAt, name: j.lead.name, reasons: j.reasons, googleAds: j.google }))
      : leads,
    note: "Server access logs (exact IP, time and browser of every click) can be added on the Fraud page's Refund claim tab; Google Ads itself never shows click IP addresses.",
  }
}

export async function runTool(name: string, input: unknown): Promise<{ content: string; isError?: boolean }> {
  try {
    if (name === "google_ads_query") {
      const { query } = input as { query?: unknown }
      if (typeof query !== "string" || !/^\s*select\b/i.test(query)) return { content: "Send one GAQL SELECT statement.", isError: true }
      return { content: asResult(await gaql(query)) }
    }
    if (name === "list_leads") {
      const days = Math.min(Math.max(Math.round(Number((input as { days?: unknown }).days) || 30), 1), 365)
      return { content: asResult(await recentLeads(days)) }
    }
    if (name === "dealtrack_page") {
      const { page, days } = input as { page?: unknown; days?: unknown }
      if (typeof page !== "string" || !(PAGES as readonly string[]).includes(page)) return { content: `page must be one of: ${PAGES.join(", ")}.`, isError: true }
      const d = Math.min(Math.max(Math.round(Number(days) || 30), 1), 365)
      return { content: asResult([await pageData(page as PageName, d)]).slice(0, MAX_CHARS) }
    }
    if (name === "fraud_check") {
      const days = Math.min(Math.max(Math.round(Number((input as { days?: unknown }).days) || 30), 1), 365)
      return { content: JSON.stringify(await fraudCheck(days)).slice(0, MAX_CHARS) }
    }
    if (name === "campaign_detail") {
      const { campaign, days } = input as { campaign?: unknown; days?: unknown }
      if (typeof campaign !== "string" || !campaign.trim()) return { content: "Say which campaign (name or ID).", isError: true }
      const d = Math.min(Math.max(Math.round(Number(days) || 30), 1), 365)
      return { content: JSON.stringify(await campaignDetail(campaign, d)).slice(0, MAX_CHARS) }
    }
    if (name === "page_speed") {
      const { campaign, url } = input as { campaign?: unknown; url?: unknown }
      const c = typeof campaign === "string" ? campaign : ""
      const u = typeof url === "string" ? url : ""
      if (!c.trim() && !u.trim()) return { content: "Say which campaign (name or ID) or which page (its full address) to test.", isError: true }
      return { content: JSON.stringify(await pageSpeedCheck(c, u)).slice(0, MAX_CHARS) }
    }
    if (name === "dealtrack_status") return { content: JSON.stringify(await dealtrackStatus()).slice(0, MAX_CHARS) }
    if (name === "deal_history") {
      const active = await activeAccount()
      if (!active) return { content: "Google isn't connected, so the spreadsheet can't be read.", isError: true }
      const view = await readCombined(active.connection)
      if (!view) return { content: "No spreadsheet is linked yet: link it on Reports → Deal History.", isError: true }
      const year = Math.round(Number((input as { year?: unknown }).year) || 0)
      const deals = view.deals
        .filter((d) => !year || d[0] === String(year))
        .map((d) => Object.fromEntries(view.header.map((h, i) => [h, d[i] ?? ""]).filter(([, v]) => v !== "")))
      const summaries = view.tables.map((t) => ({
        table: t.header[0],
        rows: t.rows.map((r) => Object.fromEntries(t.header.map((h, i) => [i === 0 ? t.header[0] : h, r[i] ?? ""]).filter(([h, v]) => h && v !== ""))),
      }))
      return { content: `${JSON.stringify({ summaries, notes: view.notes })}\n${asResult(deals)}` }
    }
    return { content: `Unknown tool ${name}.`, isError: true }
  } catch (error) {
    // Google's error text (e.g. a GAQL typo) helps the model fix its own query.
    if (error instanceof GoogleAdsError) return { content: `${error.message}${error.detail ? ` ${error.detail}` : ""}`, isError: true }
    return { content: error instanceof Error ? error.message : "The request failed.", isError: true }
  }
}
