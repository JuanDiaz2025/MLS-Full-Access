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
  slowestThirdParties: string[]
}

type Audit = { numericValue?: number; details?: { items?: { entity?: string | { text?: string }; blockingTime?: number }[] } }

export function getPageSpeed(url: string): Promise<PageSpeed> {
  const { PAGESPEED_API_KEY } = settings(SERVICE, ["PAGESPEED_API_KEY"] as const)
  return cached(`psi:${url}`, 12 * HOUR, async () => {
    const params = new URLSearchParams({ url, strategy: "mobile", category: "performance", key: PAGESPEED_API_KEY })
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, { cache: "no-store" })
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string }
      lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Record<string, Audit> }
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
    const third = audits["third-party-summary"]?.details?.items ?? []
    return {
      performance: score === undefined || score === null ? null : Math.round(score * 100),
      lcpS: lcp === null ? null : Math.round(lcp / 100) / 10,
      tbtMs: value("total-blocking-time") === null ? null : Math.round(value("total-blocking-time")!),
      cls: value("cumulative-layout-shift"),
      fieldLcp: body.loadingExperience?.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.category ?? null,
      slowestThirdParties: third
        .filter((i) => (i.blockingTime ?? 0) > 100)
        .sort((a, b) => (b.blockingTime ?? 0) - (a.blockingTime ?? 0))
        .slice(0, 3)
        .map((i) => (typeof i.entity === "string" ? i.entity : (i.entity?.text ?? "Unknown"))),
    }
  })
}

export type PageCheck = {
  status: number | null // HTTP status; null when the domain doesn't resolve or the request failed
  resolves: boolean
  h1: string
  formFields: number | null // visible inputs across the page's forms; null when no <form>
  tapToCall: boolean
  reviews: boolean
}

// Asks public DNS rather than the server's resolver, which may sit behind a proxy.
export function domainResolves(host: string): Promise<boolean> {
  return cached(`dns:${host}`, HOUR, async () => {
    try {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, { cache: "no-store" })
      const body = (await res.json()) as { Status?: number }
      return body.Status === 0
    } catch {
      return true // can't tell: don't raise a false alarm
    }
  })
}

// The site's firewall answers 403 to HEAD and bot-looking requests, so this is a normal GET
// with a phone browser's user agent.
export function checkPage(url: string): Promise<PageCheck> {
  return cached(`page:${url}`, HOUR, async () => {
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
      })
      if (!res.ok) return { status: res.status, resolves: true, ...empty }
      const html = await res.text()
      const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ")
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>|\s+/g, " ").trim() ?? ""
      const hasForm = /<form\b/i.test(html)
      const fields = html.match(/<(input|select|textarea)\b(?![^>]*type=["']?(hidden|submit|button|checkbox|radio))[^>]*>/gi) ?? []
      return {
        status: res.status,
        resolves: true,
        h1: h1.slice(0, 120),
        formFields: hasForm ? fields.length : null,
        tapToCall: /href=["']tel:/i.test(html),
        reviews: /review|testimonial|\bstars?\b|rating/i.test(text),
      }
    } catch {
      return { status: null, resolves: true, ...empty } // timed out or refused: shown as unreachable
    }
  })
}
