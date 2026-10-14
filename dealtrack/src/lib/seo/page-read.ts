// Competitors → SEO → Competitor watch: reading a competitor's public page the way the watch
// compares them. Its robots.txt rules (what a site allows automated visitors to read), its sitemap,
// and what a page says: title, description, headings, offers, seller situations, cities and phone
// numbers, plus a fingerprint of its main text. Things that change on every load without the page
// changing (Cloudflare's email-protection codes, timestamps, version tags) are cleaned out first, so
// they don't show as changes. No I/O.
import { offerTags, type OfferTag } from "@/lib/competitors/ad-analysis"
import { TOPICS } from "@/lib/research/classify"
import { CALIFORNIA_PLACES } from "@/lib/service-area"

export const USER_AGENT = "Mozilla/5.0 (compatible; DealTrackBot/1.0; +https://www.twinhomebuyer.com)"
const BOT = "dealtrackbot"

// ---- robots.txt ---------------------------------------------------------------------------------

type Rule = { allow: boolean; path: string }
export type Robots = { rules: Rule[]; delay: number | null; sitemaps: string[] }

// The rules for DealTrackBot if the file names it, else the ones for every robot ("*").
export function parseRobots(text: string): Robots {
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = []
  const sitemaps: string[] = []
  let current: (typeof groups)[number] | null = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim()
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === "sitemap") {
      if (value) sitemaps.push(value)
      continue
    }
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!current) continue
    if (field === "disallow" && value) current.rules.push({ allow: false, path: value })
    else if (field === "allow" && value) current.rules.push({ allow: true, path: value })
    else if (field === "crawl-delay" && Number(value) > 0) current.delay = Number(value)
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && BOT.includes(a))) ?? groups.find((g) => g.agents.includes("*"))
  return { rules: mine?.rules ?? [], delay: mine?.delay ?? null, sitemaps }
}

// "/private/*.pdf$" style patterns: * is anything, $ ends the path.
function ruleMatches(pattern: string, path: string) {
  const re = new RegExp(`^${pattern.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$")}`)
  return re.test(path)
}

// Whether the site allows reading this path: the longest matching rule wins, Allow on a tie.
export function allowed(robots: Robots, url: string) {
  let path: string
  try {
    const u = new URL(url)
    path = `${u.pathname}${u.search}`
  } catch {
    return false
  }
  let best: Rule | null = null
  for (const r of robots.rules) {
    if (!ruleMatches(r.path, path)) continue
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r
  }
  return !best || best.allow
}

// ---- Sitemaps -----------------------------------------------------------------------------------

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&[a-z]+;/gi, " ")

// The addresses in a sitemap with when each last changed (if it says), and whether it's an index of
// other sitemaps.
export function parseSitemap(xml: string): { entries: { url: string; lastmod?: string }[]; index: boolean } {
  const entries: { url: string; lastmod?: string }[] = []
  for (const m of xml.matchAll(/<(url|sitemap)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
    const loc = /<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(m[2])?.[1]
    if (!loc) continue
    const lastmod = /<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i.exec(m[2])?.[1]
    entries.push({ url: decode(loc).trim(), ...(lastmod ? { lastmod: decode(lastmod).trim().slice(0, 40) } : {}) })
  }
  return { entries, index: /<sitemapindex[\s>]/i.test(xml) }
}

// Pages worth watching: not files, feeds, tag or author lists, page 2 and on.
export function isPageUrl(url: string, host: string) {
  try {
    const u = new URL(url)
    if (u.host !== host && u.host.replace(/^www\./, "") !== host.replace(/^www\./, "")) return false
    const p = u.pathname.toLowerCase()
    if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js|xml|json|txt|ico)$/.test(p)) return false
    if (/\/(feed|tag|tags|category|author|wp-json|wp-admin|wp-content|cart|checkout|my-account)(\/|$)/.test(p)) return false
    if (/\/page\/\d+\/?$/.test(p)) return false
    return true
  } catch {
    return false
  }
}

// Which pages first, when a site has more than the cap: city, county and seller-situation pages,
// then anything about selling, then the rest; the home page always.
export function pagePriority(url: string) {
  const p = pathWords(url)
  if (!p) return 0
  if (/(^| )(blog|news|articles?|posts?)( |$)|(^| )20\d\d \d\d( |$)/.test(p)) return 4
  if (PLACE_NAMES.some((pl) => pl.path.test(p))) return 1
  if (/inherit|probate|foreclos|divorce|tenant|landlord|as is|repair|fire|mold|behind|relocat|downsiz|estate/.test(p)) return 1
  if (/sell|cash|buy|offer|how it works|compar|faq|review|about|contact/.test(p)) return 2
  return 3
}

// ---- A page -------------------------------------------------------------------------------------

// Cities and counties, not regions ("Bay Area", "Central Valley"). Matched with their capitals in a
// page's text, so "orange" or "concord grapes" aren't places; lowercase in an address.
const REGIONS = new Set(["California", "Bay Area", "Northern California", "Southern California", "Central Valley", "Central Coast", "Inland Empire", "Peninsula", "East Bay", "South Bay", "North Bay", "Silicon Valley", "NorCal", "SoCal"])
const PLACE_NAMES = [...new Set(CALIFORNIA_PLACES.filter((p) => !REGIONS.has(p)))]
  .sort((a, b) => b.length - a.length)
  .map((name) => ({
    name,
    text: new RegExp(`(^|[^A-Za-z])${name.replace(/ /g, "\\s+")}([^A-Za-z]|$)`),
    path: new RegExp(`(^| )${name.toLowerCase()}( |$)`),
  }))

// The seller situations (a page about inherited houses, foreclosure...), not the generic topics.
export const SITUATIONS = TOPICS.filter((t) => ["inherited", "distress", "life", "condition"].includes(t.id))

export type PageSnap = {
  title: string
  desc: string
  h1: string
  h2: string[]
  offers: OfferTag[]
  situations: string[] // what the page is about (its title, headline and address)
  places: string[] // cities the page is about (its title, headline and address)
  mentions: string[] // cities named anywhere on it
  phones: string[]
  words: number
  hash: string // fingerprint of the main text, after cleaning
}

// "/sell-my-house-fast-san-jose/" → "sell my house fast san jose"
export function pathWords(url: string) {
  try {
    return decodeURIComponent(new URL(url).pathname)
      .toLowerCase()
      .replace(/\.(html?|php|aspx?)$/, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  } catch {
    return ""
  }
}

// What an address alone says a page is about: for a new page not read yet.
export function urlFacts(url: string) {
  const words = pathWords(url)
  return {
    places: PLACE_NAMES.filter((p) => p.path.test(words)).map((p) => p.name),
    situations: SITUATIONS.filter((s) => s.match.test(words)).map((s) => s.id),
  }
}

const strip = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()

// Things that change on every load without the page changing.
export function cleanHtml(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/\/cdn-cgi\/l\/email-protection#?[0-9a-f]*/gi, "")
    .replace(/data-cfemail="[0-9a-f]*"/gi, "")
    .replace(/\[email(&#160;|&nbsp;|\s)*protected\]/gi, "")
    .replace(/([?&])(ver|v|nonce|_wpnonce|timestamp|ts)=[\w.-]+/gi, "$1")
    .replace(/\b\d{10,13}\b/g, "")
}

// The main part of the page: <main> or <article> when there is one, else the body without its
// header, menus, footer and sidebars (which change with every new blog post).
function mainHtml(html: string) {
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0]
  if (main) return main
  const body = /<body[\s\S]*?<\/body>/i.exec(html)?.[0] ?? html
  return body.replace(/<(header|nav|footer|aside)[\s>][\s\S]*?<\/\1>/gi, " ")
}

const placesIn = (text: string) => PLACE_NAMES.filter((p) => p.text.test(text)).map((p) => p.name)

// The links on a page that stay on the same site, as full addresses.
export function linksIn(rawHtml: string, base: string) {
  const out = new Set<string>()
  for (const m of cleanHtml(rawHtml).matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)/gi)) {
    try {
      const u = new URL(decode(m[1]), base)
      if (!/^https?:$/.test(u.protocol)) continue
      u.hash = ""
      out.add(u.href)
    } catch {
      // not an address
    }
  }
  return [...out]
}

export function readPage(rawHtml: string, url = ""): PageSnap {
  const html = cleanHtml(rawHtml)
  const title = strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").slice(0, 200)
  const desc = strip(
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ??
      "",
  ).slice(0, 300)
  // Headings from the main part, so a sidebar's latest posts aren't a change on every page.
  const main = mainHtml(html)
  const heads = (tag: string, from: string) => [...from.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => strip(m[1])).filter(Boolean)
  const h1 = (heads("h1", main)[0] ?? heads("h1", html)[0] ?? "").slice(0, 200)
  const h2 = [...new Set(heads("h2", main).map((h) => h.slice(0, 160)))].slice(0, 20)
  const text = strip(main)
  const focus = [title, desc, h1, ...h2].join(" · ")
  const fromUrl = urlFacts(url)
  const phones = [...new Set([...`${text} ${focus}`.matchAll(/\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g)].map((m) => `(${m[1]}) ${m[2]}-${m[3]}`))].slice(0, 5)
  return {
    title,
    desc,
    h1,
    h2,
    offers: offerTags(`${focus} · ${text.slice(0, 3000)}`),
    situations: [...new Set([...SITUATIONS.filter((s) => s.match.test(`${title} · ${h1}`.toLowerCase())).map((s) => s.id), ...fromUrl.situations])],
    places: [...new Set([...placesIn(`${title} · ${h1}`), ...fromUrl.places])],
    mentions: placesIn(`${focus} · ${text}`).slice(0, 40),
    phones,
    words: text ? text.split(" ").length : 0,
    hash: fingerprint(`${title}|${h1}|${text.toLowerCase()}`),
  }
}

// A short fingerprint (FNV-1a, twice): equal texts, equal fingerprints.
function fingerprint(s: string) {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x811c9dc5)
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`
}

// A site turning us away (blocked: stop there until the next check, never get around it) or having
// trouble (a problem: try again soon). A robot check (Cloudflare's "Just a moment...") is a block.
export function refusalOf(status: number, html: string): { blocked?: string; problem?: string } | null {
  if (/cf-browser-verification|challenge-platform|cf-chl-|<title>\s*(just a moment|attention required|access denied|are you a (robot|human))/i.test(html.slice(0, 8000)))
    return { blocked: "It shows a robot check instead of its pages" }
  if (status === 401 || status === 403) return { blocked: `It turns automated visits away (${status})` }
  if (status === 429) return { blocked: "It asked us to slow down (429)" }
  if (status === 503) return { problem: "It said it's busy (503)" }
  return null
}
