// Where a lead came from: the UTM tags, ad click ids, landing page and referrer a website form
// sends, and a one-word channel worked out from them ("Google Ads", "Organic search", ...).
import type { Lead, LeadTracking } from "@/lib/leads/types"

// Field names each tracking value goes by, after lowercasing and dropping spaces and punctuation.
export const trackingAliases: Record<keyof LeadTracking, string[]> = {
  utmSource: ["utmsource", "source"],
  utmMedium: ["utmmedium", "medium"],
  utmCampaign: ["utmcampaign", "campaign"],
  utmTerm: ["utmterm", "term", "keyword"],
  utmContent: ["utmcontent", "content"],
  gclid: ["gclid"],
  gbraid: ["gbraid"],
  wbraid: ["wbraid"],
  fbclid: ["fbclid"],
  msclkid: ["msclkid"],
  landingPage: ["landingpage", "landingpageurl", "pageurl", "url", "sourceurl", "posturl", "page", "formpage"],
  referrer: ["referrer", "referer", "httpreferer", "referringsite", "referrerurl"],
}

const fromUrl: [keyof LeadTracking, string[]][] = [
  ["utmSource", ["utm_source"]],
  ["utmMedium", ["utm_medium"]],
  ["utmCampaign", ["utm_campaign"]],
  ["utmTerm", ["utm_term"]],
  ["utmContent", ["utm_content"]],
  ["gclid", ["gclid"]],
  ["gbraid", ["gbraid"]],
  ["wbraid", ["wbraid"]],
  ["fbclid", ["fbclid"]],
  ["msclkid", ["msclkid"]],
]

// The Google Ads click a lead came from, each id under its own name, the way Google wants it. A
// gbraid/wbraid that an older website script copied into gclid (they start with "0AAAA") isn't sent
// as a gclid, which Google would refuse.
export function googleClick(t?: LeadTracking) {
  if (!t) return null
  const braid = (v?: string) => Boolean(v && /^0AAAA/.test(v))
  const gbraid = t.gbraid || (braid(t.gclid) && !t.wbraid ? t.gclid : undefined)
  const wbraid = t.wbraid
  const gclid = t.gclid && t.gclid !== gbraid && t.gclid !== wbraid && !braid(t.gclid) ? t.gclid : undefined
  if (gclid) return { gclid }
  if (gbraid) return { gbraid }
  if (wbraid) return { wbraid }
  return null
}
export const hasAdClick = (t?: LeadTracking) => Boolean(t?.gclid || t?.gbraid || t?.wbraid)

// Fills in anything missing from the landing page's own address (?utm_source=...&gclid=...).
export function completeTracking(t: LeadTracking): LeadTracking | undefined {
  const out = { ...t }
  if (out.landingPage) {
    try {
      const params = new URL(out.landingPage).searchParams
      for (const [key, names] of fromUrl) {
        if (out[key]) continue
        const value = names.map((n) => params.get(n)).find(Boolean)
        if (value) out[key] = value.slice(0, 300)
      }
    } catch {
      // Not a full address; keep it as sent.
    }
  }
  const kept = Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as LeadTracking
  return Object.keys(kept).length ? kept : undefined
}

const host = (url?: string) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : ""
  } catch {
    return ""
  }
}

// The one-glance answer to "where did this lead come from?". Short names (fb, ig, meta) only count
// as whole words, so "craigslist" or "metasearch" aren't taken for Facebook.
export function leadChannel(lead: Lead): string {
  const t = lead.tracking
  if (lead.qrCodeId) return "QR code"
  if (!t) return "Unknown"
  const source = t.utmSource?.toLowerCase() ?? ""
  const medium = t.utmMedium?.toLowerCase() ?? ""
  const paid = /cpc|ppc|paid|ads?$|display|search/.test(medium)
  if (hasAdClick(t) || (/google|adwords/.test(source) && paid)) return "Google Ads"
  if (t.msclkid || (/bing|microsoft/.test(source) && paid)) return "Microsoft Ads"
  if (t.fbclid || /facebook|instagram|(^|[^a-z])(fb|ig|meta)([^a-z]|$)/.test(source)) return paid || t.fbclid ? "Facebook / Instagram Ads" : "Facebook / Instagram"
  if (/lsa|localservices/.test(source)) return "Local Services Ads"
  if (/gbp|gmb|googlebusiness|maps/.test(source + medium)) return "Google Business Profile"
  if (/email|newsletter/.test(source + medium)) return "Email"
  if (/sms|text/.test(source + medium)) return "Text message"
  if (/postcard|mail|flyer|sign/.test(source + medium)) return "Direct mail"
  if (source) return t.utmMedium ? `${t.utmSource} / ${t.utmMedium}` : t.utmSource!
  const from = host(t.referrer)
  if (/google\.|bing\.|yahoo\.|duckduckgo\./.test(from)) return "Organic search"
  if (/facebook\.|instagram\.|t\.co$|twitter\.|x\.com|linkedin\.|youtube\./.test(from)) return "Social"
  if (from && from !== host(t.landingPage)) return `Referral: ${from}`
  return "Direct"
}

// The landing page without the tracking tags, e.g. "/sell-my-house-fast".
export function pagePath(url?: string) {
  if (!url) return ""
  try {
    const u = new URL(url)
    return u.pathname === "/" ? u.hostname.replace(/^www\./, "") : u.pathname
  } catch {
    return url
  }
}
