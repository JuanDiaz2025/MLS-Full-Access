// "Improve this ad": the AI reads one responsive search ad with everything around it (Google's
// rating of each line, the campaign's keywords, what people really searched, the landing page) and
// drafts better headlines and descriptions. Nothing is sent anywhere: the draft goes into the
// editor, a person changes what they like, and it then goes through approval like any change.

import { HEADLINE_PINS, DESCRIPTION_PINS, LIMITS, adTextProblems, clean, type AdLine, type AdTextSet } from "@/lib/ad-text"
import { askAssistant } from "@/lib/assistant/ask"
import { addDays, today } from "@/lib/date-range"
import { getCampaignAds, getCampaignInfo, getCampaignKeywords, type CampaignAd } from "@/lib/google-ads/campaign"
import { getSearchTerms, isWaste } from "@/lib/google-ads/reports"
import { checkPage } from "@/lib/pagespeed"

export type FixLine = AdLine & { was?: string; why?: string }
export type AdFix = {
  summary: string
  problems: string[]
  headlines: FixLine[]
  descriptions: FixLine[]
  ruleProblems: string[] // anything in the draft Google would still refuse (shown so it can be fixed)
}

const describe = (ad: CampaignAd) => {
  const lines = (items: CampaignAd["headlines"]) =>
    items
      .map(
        (t) =>
          `- "${t.text}"${t.pinned ? ` (pinned to ${t.pinned})` : ""}${t.label && !["UNKNOWN", "PENDING"].includes(t.label) ? ` [Google: ${t.label}]` : ""}`,
      )
      .join("\n")
  return `Ad strength: ${ad.strength}. Approval: ${ad.approval}${ad.topics.length ? ` (${ad.topics.join(", ")})` : ""}.
Display path: ${ad.displayUrl}. Final URL: ${ad.finalUrl}.
Headlines (${ad.headlines.length}):
${lines(ad.headlines)}
Descriptions (${ad.descriptions.length}):
${lines(ad.descriptions)}`
}

export async function suggestAdFix(campaignId: string, adId: string): Promise<AdFix> {
  const range = { from: addDays(today(), -89), to: today(), label: "Last 90 days" }
  const [info, ads, keywords, terms] = await Promise.all([
    getCampaignInfo(campaignId),
    getCampaignAds(campaignId, range),
    getCampaignKeywords(campaignId, range),
    getSearchTerms(range, campaignId),
  ])
  const ad = ads.find((a) => a.id === adId)
  if (!info || !ad) throw new Error("That ad isn't in this campaign any more. Reload the page.")
  const page = ad.finalUrl ? await checkPage(ad.finalUrl).catch(() => null) : null
  const groupKeywords = keywords.filter((k) => k.adGroup === ad.adGroup && k.status === "ENABLED")
  const converting = terms.filter((t) => t.metrics.conversions > 0).slice(0, 12)
  const wasted = terms.filter((t) => isWaste(t.metrics)).slice(0, 8)

  const question = `Improve this Google responsive search ad so its ad strength goes up and it brings more seller leads. Draft the full new set of headlines and descriptions.

Campaign: ${info.name}. Ad group: ${ad.adGroup}.
${describe(ad)}

Keywords in this ad group (most clicked first): ${
    groupKeywords
      .slice(0, 20)
      .map((k) => `"${k.text}" (${k.matchType.toLowerCase()}, ${k.metrics.clicks} clicks, ${k.metrics.conversions} leads)`)
      .join("; ") || "none"
  }.
Searches that brought leads in the last 90 days: ${converting.map((t) => `"${t.term}"`).join(", ") || "none yet"}.
Searches that cost money with no leads: ${wasted.map((t) => `"${t.term}"`).join(", ") || "none"}.
Landing page: ${page ? `title "${page.title ?? ""}", main heading "${page.h1}", description "${page.description ?? ""}", ${page.formFields ?? 0} form fields, ${page.tapToCall ? "has" : "no"} tap-to-call` : "couldn't be read"}.

Rules:
- Up to ${LIMITS.headline.max} headlines of at most ${LIMITS.headline.chars} characters and up to ${LIMITS.description.max} descriptions of at most ${LIMITS.description.chars} characters. Use the full counts. Use most of the description length.
- Keep lines Google rates BEST or GOOD unchanged. Replace LOW ones. Replace lines that say nearly the same as another line.
- Put the ad group's main keywords (or close variants) in at least 3 headlines.
- Mix angles: speed, no repairs/as-is, no fees or commissions, local family business, fair cash offer, any situation (inherited, behind on payments, tenants, divorce), how it works, a call to action.
- Only use facts that are already in the ad or on the landing page; don't invent numbers, awards or guarantees.
- Pins lower ad strength: unpin everything unless the business name must stay first (then keep only that one pin on HEADLINE_1).
- Google's rules: no ALL-CAPS words, at most one exclamation mark per line (none in headlines is safest), no phone numbers in text, no repeated punctuation, no "click here". Avoid loan, credit or financing words (Google's consumer finance policy) and superlatives like "#1" or "best" without proof.
- Keep {LOCATION(City):...} insertions only if they were already there.

Answer with only a JSON object in a \`\`\`json block, no other text:
{"summary": "one sentence on what's holding the ad back", "problems": ["short problem", ...], "headlines": [{"text": "...", "pinned": "" or "HEADLINE_1", "was": "the old line it replaces, or \\"\\" if kept or new", "why": "short reason if new or changed, else \\"\\""}], "descriptions": [{"text": "...", "pinned": "", "was": "...", "why": "..."}]}`

  const reply = await askAssistant({
    turns: [{ role: "user", content: question }],
    situation: `Today is ${today()} (Pacific time). Everything needed is in the question; answer from it without running queries.`,
  })
  return parseAdFix(reply)
}

export function parseAdFix(reply: string): AdFix {
  const block = reply.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)
  let raw: unknown
  try {
    raw = JSON.parse(block)
  } catch {
    throw new Error("The AI's answer couldn't be read. Try again.")
  }
  const o = raw as Record<string, unknown>
  const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "")
  const lines = (v: unknown, pins: readonly string[], cap: number): FixLine[] =>
    (Array.isArray(v) ? v : [])
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({
        text: str(x.text, 200),
        pinned: pins.includes(str(x.pinned)) ? str(x.pinned) : "",
        was: str(x.was, 200) || undefined,
        why: str(x.why) || undefined,
      }))
      .filter((x) => x.text)
      .slice(0, cap)
  const fix = {
    summary: str(o.summary, 400),
    problems: (Array.isArray(o.problems) ? o.problems : [])
      .map((p) => str(p))
      .filter(Boolean)
      .slice(0, 8),
    headlines: lines(o.headlines, HEADLINE_PINS, LIMITS.headline.max),
    descriptions: lines(o.descriptions, DESCRIPTION_PINS, LIMITS.description.max),
  }
  if (!fix.headlines.length || !fix.descriptions.length) throw new Error("The AI didn't draft any headlines or descriptions. Try again.")
  const set: AdTextSet = clean(fix)
  return { ...fix, ruleProblems: adTextProblems(set) }
}
