// The address a real click on an ad lands on: the final URL plus the tracking suffix Google adds
// to every click (the ad's own, else its ad group's, campaign's or account's), with ValueTrack
// ({keyword}, {campaignid}…) and custom parameters ({_h1}…) filled in, and a click ID. PageSpeed
// tests this address next to the plain page, because scripts on the page (click-fraud checks,
// tracking tags) can do far more work for an ad visit than for a plain one.

// A click ID that's clearly a test: DealTrack's ad-visit counts leave gclid=test… out.
export const TEST_GCLID = "test-pagespeed"

// What a click on a phone would fill in for the ValueTrack values that aren't ids.
const SAMPLE: Record<string, string> = { gclid: TEST_GCLID, keyword: "test", device: "m", matchtype: "e", network: "g" }

export type UrlParam = { key?: string; value?: string }

// The first suffix that's set, from the most specific level to the account.
export const firstSuffix = (...levels: (string | undefined)[]) => levels.find((s) => s?.trim())?.trim() ?? ""

// Custom parameters from the account-wide level to the most specific; a closer level wins.
export const mergeParams = (...levels: (UrlParam[] | undefined)[]) =>
  Object.fromEntries(levels.flatMap((l) => l ?? []).map((p) => [p.key ?? "", p.value ?? ""]))

export function adClickUrl(
  finalUrl: string,
  suffix: string,
  ids: { params?: Record<string, string>; campaignId?: string; adGroupId?: string; adId?: string } = {},
) {
  const known: Record<string, string | undefined> = { campaignid: ids.campaignId, adgroupid: ids.adGroupId, creative: ids.adId }
  const filled = suffix
    .replace(/\{_([a-z0-9]+)\}/gi, (_, name: string) => encodeURIComponent(ids.params?.[name] ?? ""))
    .replace(/\{([a-z_]+)\}/gi, (_, name: string) => encodeURIComponent(known[name.toLowerCase()] ?? SAMPLE[name.toLowerCase()] ?? ""))
    .replace(/^[?&]+/, "")
  // Auto-tagging adds a click ID to every click, whether or not the suffix asks for one.
  const query = /(^|&)gclid=/.test(filled) ? filled : [filled, `gclid=${TEST_GCLID}`].filter(Boolean).join("&")
  return `${finalUrl}${finalUrl.includes("?") ? "&" : "?"}${query}`
}
