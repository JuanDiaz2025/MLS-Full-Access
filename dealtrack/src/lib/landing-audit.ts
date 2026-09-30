// Which landing pages get the full check (PageSpeed and the page basics): pages behind running
// ads first, with this period's results if any, then the most-spent other pages. Shared by the
// Landing pages page and the startup warm-up, so both test the same pages.

import { emptyMetrics, type AdDestination, type LandingPageRow } from "@/lib/google-ads/reports"

export const AUDITED = 8

export function pagesToAudit(pages: LandingPageRow[], live: AdDestination[]): (LandingPageRow & { live: boolean })[] {
  const liveUrls = new Set(live.map((d) => d.url))
  const spent = new Map(pages.map((p) => [p.url, p]))
  return [
    ...live.map((d) => ({
      url: d.url,
      campaigns: d.campaigns.filter((c) => c.status === "ENABLED").map((c) => c.name),
      metrics: spent.get(d.url)?.metrics ?? emptyMetrics(),
      live: true,
    })),
    ...pages.filter((p) => !liveUrls.has(p.url)).map((p) => ({ ...p, live: false })),
  ].slice(0, AUDITED)
}
