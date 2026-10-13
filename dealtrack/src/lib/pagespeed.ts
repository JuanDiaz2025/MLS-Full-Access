// Landing page checks: Google PageSpeed Insights (mobile Lighthouse, plus real-visitor Chrome
// data when Google has enough of it) and a quick read of the page HTML for the things a seller
// landing page needs. Results are cached for 12 hours; one PageSpeed run takes 10–30 seconds.

import { HOUR, ServiceError, cached, settings } from "@/lib/services"

const SERVICE = "PageSpeed Insights"

export type PageSpeed = {
  performance: number | null // 0–100
  lcpS: number | null // largest contentful paint, seconds
  tbtMs: number | null // total blocking time
  cls: number | null
  fieldLcp: "FAST" | "AVERAGE" | "SLOW" | null // real Chrome visitors, last 28 days
  slowestThirdParties: string[] // the names in heaviestScripts, for the pages that list only names
  screenshot?: string | null // how the page looked on a phone once loaded (a data: URL); missing in older cached results
  // Other companies' scripts that kept the phone busiest while the page loaded (Lighthouse's
  // JavaScript execution time, by company), e.g. a click-fraud check or a tag manager.
  heaviestScripts?: { name: string; ms: number }[]
}

type Audit = { numericValue?: number; details?: { data?: string; items?: { url?: string; total?: number }[] } }

// The site's ClickCease (CHEQ) click-fraud tag loads from a different made-up domain from one visit to
// the next (ob.brilliantlocco.com, obseu.nordivalen.com…), always as /i/<tag ID>.js.
const CLICKCEASE_TAG = /^https:\/\/ob[a-z]*\.[^/]+\/i\/[0-9a-f]{32}\.js(\?|$)/
const domainOf = (host: string) => host.split(".").slice(-2).join(".")

export function getPageSpeed(url: string): Promise<PageSpeed> {
  const { PAGESPEED_API_KEY } = settings(SERVICE, ["PAGESPEED_API_KEY"] as const)
  return cached(`psi3:${url}`, 12 * HOUR, async () => {
    const params = new URLSearchParams({ url, strategy: "mobile", category: "performance", key: PAGESPEED_API_KEY })
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, { cache: "no-store" })
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string }
      lighthouseResult?: {
        categories?: { performance?: { score?: number } }
        audits?: Record<string, Audit>
        entities?: { name?: string; isFirstParty?: boolean; origins?: string[] }[]
      }
      loadingExperience?: { metrics?: { LARGEST_CONTENTFUL_PAINT_MS?: { category?: PageSpeed["fieldLcp"] } } }
    }
    if (!res.ok) {
      throw new ServiceError(
        SERVICE,
        res.status === 429 ? "PageSpeed Insights' daily quota was reached." : "PageSpeed Insights couldn't test this page.",
        body.error?.message,
      )
    }
    const audits = body.lighthouseResult?.audits ?? {}
    const value = (id: string) => audits[id]?.numericValue ?? null
    const score = body.lighthouseResult?.categories?.performance?.score
    const lcp = value("largest-contentful-paint")
    const entities = new Map<string, { name?: string; isFirstParty?: boolean }>()
    for (const e of body.lighthouseResult?.entities ?? []) for (const origin of e.origins ?? []) entities.set(origin, e)
    const site = new URL(url).hostname.replace(/^www\./, "")
    const scripts = (audits["bootup-time"]?.details?.items ?? []).filter((i) => URL.canParse(i.url ?? "")) // "Unattributable" work isn't a script
    const clickCease = new Set(scripts.filter((i) => CLICKCEASE_TAG.test(i.url!)).map((i) => domainOf(new URL(i.url!).hostname)))
    const busy = new Map<string, number>()
    for (const item of scripts) {
      const { origin, hostname } = new URL(item.url!)
      const entity = entities.get(origin)
      if (entity?.isFirstParty || hostname.replace(/^www\./, "") === site) continue // the site's own code
      const name = clickCease.has(domainOf(hostname)) ? "ClickCease" : (entity?.name ?? hostname)
      busy.set(name, (busy.get(name) ?? 0) + (item.total ?? 0))
    }
    const heaviest = [...busy]
      .filter(([, ms]) => ms >= 150)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, ms]) => ({ name, ms: Math.round(ms) }))
    return {
      performance: score === undefined || score === null ? null : Math.round(score * 100),
      lcpS: lcp === null ? null : Math.round(lcp / 100) / 10,
      tbtMs: value("total-blocking-time") === null ? null : Math.round(value("total-blocking-time")!),
      cls: value("cumulative-layout-shift"),
      fieldLcp: body.loadingExperience?.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.category ?? null,
      // Lighthouse 13 dropped the third-party summary these names used to come from.
      slowestThirdParties: heaviest.map((s) => s.name),
      screenshot: audits["final-screenshot"]?.details?.data ?? null,
      heaviestScripts: heaviest,
    }
  }, { staleMs: 7 * 24 * HOUR })
}

export type PageCheck = {
  status: number | null // HTTP status; null when the domain doesn't resolve or the request failed
  resolves: boolean
  h1: string
  formFields: number | null // visible inputs across the page's forms; null when no <form>
  tapToCall: boolean
  reviews: boolean
  // What the page says about itself, for previews. Missing in results cached before they were added.
  title?: string
  description?: string
  image?: string // the page's share image (og:image)
  images?: string[] // the first few pictures on the page
}

// Asks public DNS rather than the server's resolver, which may sit behind a proxy.
export function domainResolves(host: string): Promise<boolean> {
  return cached(`dns:${host}`, HOUR, async () => {
    try {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, { cache: "no-store", signal: AbortSignal.timeout(5000) })
      const body = (await res.json()) as { Status?: number }
      return body.Status === 0
    } catch {
      return true // can't tell: don't raise a false alarm
    }
  }, { staleMs: 24 * HOUR })
}

// The site's firewall answers 403 to HEAD and bot-looking requests, so this is a normal GET
// with a phone browser's user agent.
export function checkPage(url: string): Promise<PageCheck> {
  return cached(`page2:${url}`, HOUR, async () => {
    const empty = { h1: "", formFields: null, tapToCall: false, reviews: false }
    const host = new URL(url).hostname
    if (!(await domainResolves(host))) return { status: null, resolves: false, ...empty }
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36",
          accept: "text/html",
        },
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(8000), // a hung server counts as unreachable instead of stalling the page
      })
      if (!res.ok) return { status: res.status, resolves: true, ...empty }
      const html = await res.text()
      const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ")
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>|\s+/g, " ").trim() ?? ""
      const hasForm = /<form\b/i.test(html)
      const base = res.url || url
      const abs = (src: string) => {
        try {
          return new URL(src.replace(/&amp;/g, "&"), base).toString()
        } catch {
          return ""
        }
      }
      const meta = (name: string) =>
        html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"))?.[1] ??
        html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i"))?.[1] ??
        ""
      const images = [...html.matchAll(/<img\b[^>]*?\s(?:data-src|src)=["']([^"']+)["']/gi)]
        .map((m) => abs(m[1]))
        .filter((u) => /^https?:/.test(u) && !/\.svg(\?|$)|pixel|spacer|gravatar|facebook\.com\/tr/i.test(u))
      const decode = (t: string) =>
        t.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#8211;/g, "–").replace(/&#8217;/g, "’").trim()
      const fields = html.match(/<(input|select|textarea)\b(?![^>]*type=["']?(hidden|submit|button|checkbox|radio))[^>]*>/gi) ?? []
      return {
        status: res.status,
        resolves: true,
        h1: h1.slice(0, 120),
        formFields: hasForm ? fields.length : null,
        tapToCall: /href=["']tel:/i.test(html),
        reviews: /review|testimonial|\bstars?\b|rating/i.test(text),
        title: decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 140),
        description: decode(meta("description") || meta("og:description")).slice(0, 300),
        image: meta("og:image") ? abs(meta("og:image")) : undefined,
        images: [...new Set(images)].slice(0, 6),
      }
    } catch {
      return { status: null, resolves: true, ...empty } // timed out or refused: shown as unreachable
    }
  }, { staleMs: 24 * HOUR })
}
