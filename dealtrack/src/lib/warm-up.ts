// Fills the caches at server start (see instrumentation.ts): the Overview and alert rules first,
// then the slow checks (landing pages behind ads, the go-live audit's page speed tests).
// Nothing is saved and nothing in Google Ads changes; failures are ignored.

import { googleAdsRules } from "@/lib/alert-rules"
import { brokenDestinations } from "@/lib/alerts"
import { runAudit } from "@/lib/audit"
import { getPacing } from "@/lib/budget"
import { parseRange } from "@/lib/date-range"
import { missingKeys } from "@/lib/google-ads/client"
import { getOverview } from "@/lib/google-ads/overview"
import { getAccount, getAdDestinations, getCampaigns, getLandingPages, getLocations, getSearchTerms } from "@/lib/google-ads/reports"
import { pagesToAudit } from "@/lib/landing-audit"
import { checkPage, getPageSpeed } from "@/lib/pagespeed"
import { readData } from "@/lib/store"

export async function warmUp() {
  if (missingKeys().length) return
  const started = Date.now()
  const range = parseRange({})
  const data = await readData()
  await Promise.allSettled([
    getAccount(),
    getOverview(range),
    getCampaigns(range),
    getSearchTerms(range),
    getLocations(range),
    getPacing(data.budget),
    ...googleAdsRules(data).map((g) => g.run()),
  ])
  await Promise.allSettled([getAdDestinations().then(brokenDestinations), runAudit(data.budget, data.audit), warmLandingPages(range)])
  console.log(`DealTrack: reports ready (${Math.round((Date.now() - started) / 1000)}s)`)
}

// The same pages the Landing pages page tests for the default range.
async function warmLandingPages(range: ReturnType<typeof parseRange>) {
  const [pages, destinations] = await Promise.all([getLandingPages(range), getAdDestinations()])
  const live = destinations.filter((d) => d.campaigns.some((c) => c.status === "ENABLED"))
  await Promise.allSettled(
    pagesToAudit(pages, live).map(async (p) => {
      const check = await checkPage(p.url)
      if (check.resolves && check.status !== null && check.status < 400) await getPageSpeed(p.url)
    }),
  )
}
