import type { Metadata } from "next"

import AdCard from "@/components/changes/ad-card"
import { AdminLink, PageHeader, ReportProblem, Section } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { parseRange, type DateRange } from "@/lib/date-range"
import { getSearchAds, getSearchCampaigns } from "@/lib/google-ads/controls"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Ads · DealTrack" }

export default async function AdsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const range = parseRange(params)
  const admin = await isAdmin()
  const asked = typeof params.campaign === "string" ? params.campaign : ""
  const result = await load(async () => {
    const campaigns = await getSearchCampaigns()
    // Running campaigns come first, so the default is the first running one.
    const campaign = campaigns.find((c) => c.id === asked) ?? campaigns[0]
    const ads = campaign ? await getSearchAds(campaign.id, range) : []
    return { campaigns, campaign, ads }
  })
  const campaignId = result.ok ? result.data.campaign?.id : undefined

  return (
    <>
      <PageHeader
        title="Ads"
        description="The headlines and descriptions in each responsive search ad, with how the ad did in this period."
        range={range}
        keep={campaignId ? { campaign: campaignId } : undefined}
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body {...result.data} range={range} admin={admin} />}
    </>
  )
}

function Body({
  campaigns,
  campaign,
  ads,
  range,
  admin,
}: {
  campaigns: { id: string; name: string; status: string }[]
  campaign?: { id: string; name: string; status: string }
  ads: Awaited<ReturnType<typeof getSearchAds>>
  range: DateRange
  admin: boolean
}) {
  if (!campaign) return <p className="text-sm text-muted-foreground">There are no Search campaigns in this account.</p>
  const running = campaigns.filter((c) => c.status === "ENABLED")
  const paused = campaigns.filter((c) => c.status !== "ENABLED")

  return (
    <Section
      title={`${campaign.name} (${ads.length} ${ads.length === 1 ? "ad" : "ads"})`}
      description={campaign.status === "ENABLED" ? "Running campaign." : "Paused campaign. Its ads aren't showing."}
      actions={!admin && <AdminLink />}
    >
      <form action="/ads" className="flex flex-wrap items-end gap-2">
        {range.preset ? (
          <input type="hidden" name="range" value={range.preset} />
        ) : (
          <>
            <input type="hidden" name="from" value={range.from} />
            <input type="hidden" name="to" value={range.to} />
          </>
        )}
        <label htmlFor="ads-campaign" className="flex max-w-md flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
          Campaign
          <select
            id="ads-campaign"
            name="campaign"
            defaultValue={campaign.id}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            {running.length > 0 && (
              <optgroup label="Running">
                {running.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
            {paused.length > 0 && (
              <optgroup label="Paused">
                {paused.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <button type="submit" className="h-8 rounded-lg border px-3 text-xs font-medium hover:bg-muted">
          Show ads
        </button>
      </form>
      {ads.length ? (
        <div className="flex flex-col gap-3">
          {ads.map((ad) => (
            <AdCard key={ad.id} ad={ad} canEdit={admin} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">This campaign has no responsive search ads.</p>
      )}
    </Section>
  )
}
