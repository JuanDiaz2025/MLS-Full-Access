// A responsive search ad drawn the way Google shows it on a results page: one combination of its
// headlines and descriptions (pinned ones in their spot, Google's best-rated first), with the
// sitelinks and callouts that can show underneath. Google mixes these itself, so it's a likely
// look, not the only one.

import { shownText } from "@/lib/ad-text"
import type { AdText, CampaignAd, CampaignAssets } from "@/lib/google-ads/campaign"
import { cn } from "@/lib/utils"

// The preview shows a location or keyword insertion's fallback text ("{LOCATION(City):Local}" → "Local").
export { shownText }

const RANK: Record<string, number> = { BEST: 0, GOOD: 1, LEARNING: 2, PENDING: 3, UNKNOWN: 3, LOW: 4 }

function pick(items: AdText[], slots: string[]): AdText[] {
  const free = items.filter((t) => !t.pinned).sort((a, b) => (RANK[a.label] ?? 3) - (RANK[b.label] ?? 3))
  const out: AdText[] = []
  for (const slot of slots) {
    const pinned = items.find((t) => t.pinned === slot && !out.includes(t))
    const next = pinned ?? free.shift()
    if (next) out.push(next)
  }
  return out
}

export type PreviewAd = Pick<CampaignAd, "displayUrl" | "finalUrl"> & {
  headlines: Pick<AdText, "text" | "pinned" | "label">[]
  descriptions: Pick<AdText, "text" | "pinned" | "label">[]
}

export default function AdPreview({ ad, assets, className }: { ad: PreviewAd; assets: CampaignAssets; className?: string }) {
  const headlines = pick(ad.headlines, ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"])
  const descriptions = pick(ad.descriptions, ["DESCRIPTION_1", "DESCRIPTION_2"])
  const name = assets.businessName || ad.displayUrl.split("/")[0]
  return (
    <div className={cn("rounded-xl border bg-white p-4 font-[Arial,sans-serif] text-[#202124] shadow-xs", className)}>
      <p className="text-xs font-bold">Sponsored</p>
      <div className="mt-2 flex items-center gap-2.5">
        {assets.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={assets.logo} alt="" className="size-7 rounded-full border object-cover" />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-full border bg-[#f1f3f4] text-xs font-bold text-[#5f6368]">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm">{name}</span>
          <span className="truncate text-xs text-[#4d5156]">{ad.displayUrl ? `https://${ad.displayUrl.replace(/\//g, " › ")}` : ad.finalUrl}</span>
        </span>
      </div>
      <p className="mt-2 text-xl leading-snug text-[#1a0dab]">{headlines.map((h) => shownText(h.text)).join(" | ") || "(no headlines)"}</p>
      <p className="mt-1 text-sm leading-snug text-[#4d5156]">
        {assets.phone && <span className="font-medium text-[#202124]">Call {assets.phone} · </span>}
        {descriptions.map((d) => shownText(d.text)).join(" ")}
      </p>
      {assets.callouts.length > 0 && <p className="mt-1 text-sm text-[#4d5156]">{assets.callouts.slice(0, 4).join(" · ")}</p>}
      {assets.sitelinks.length > 0 && (
        <ul className="mt-2 grid gap-x-6 gap-y-2 border-t pt-2 sm:grid-cols-2">
          {assets.sitelinks.slice(0, 4).map((s) => (
            <li key={s.text} className="text-sm leading-snug">
              <span className="text-[#1a0dab]">{s.text}</span>
              {(s.line1 || s.line2) && (
                <span className="block text-xs text-[#4d5156]">
                  {s.line1} {s.line2}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
