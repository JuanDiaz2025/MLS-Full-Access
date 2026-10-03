// Lead scoring: how good a seller lead looks the moment it arrives, from 0 to 100, with the
// reasons. Hot leads (70+) can be marked Interested automatically, which sends Google Ads an
// offline conversion; Junk (spam, tests, fake numbers) can be marked Not interested. That
// follows Google Ads' advice for lead forms: send back only qualified leads, so Smart Bidding
// learns to find more people like them instead of more form-fillers.
//
// Points (100 at most): a real phone number 25, an email 10, a property address with a house
// number 20, a full name 5, a paid ad click 10, a seller search ("sell my house fast") 10, a
// motivated seller in the message (inherited, foreclosure, repairs...) 15, coming back again 5.
import { jsonFileStore } from "@/lib/json-file-store"
import { hasAdClick } from "@/lib/leads/tracking"
import { CALL_TAP_SOURCE, type Lead, type LeadGrade, type LeadScore, type LeadStatus } from "@/lib/leads/types"

export const HOT_AT = 70
export const WARM_AT = 40

export const gradeLabels: Record<LeadGrade, string> = { hot: "Hot", warm: "Warm", cold: "Cold", junk: "Junk" }

type Settings = { autoStatus: boolean }
const settings = jsonFileStore<Settings>("lead-scoring.json", () => ({ autoStatus: true }))
export const getScoringSettings = () => settings.read()
export const setAutoStatus = (on: boolean) =>
  settings.update((s) => {
    s.autoStatus = on
  })

const digitsOf = (s: string) => s.replace(/\D/g, "")

// A US phone number that could be real: 10 digits (after a leading 1), a real area code, and
// not a made-up pattern like 555-0100, 1234567890 or 9999999999.
export function realPhone(phone?: string) {
  if (!phone) return false
  // "415.222.3333 x101", "ext. 12": the extension isn't part of the number.
  let d = digitsOf(phone.replace(/\s*(x|ext\.?|extension)\s*\d+\s*$/i, ""))
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1)
  if (phone.trim().startsWith("+") && !phone.trim().startsWith("+1")) return d.length >= 8 // outside the US
  if (d.length !== 10 || /^[01]/.test(d) || /^[2-9]11/.test(d)) return false
  if (/^(\d)\1+$/.test(d) || d === "1234567890" || /^\d{3}5550[01]\d\d$/.test(d)) return false
  return true
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
const THROWAWAY = /@(mailinator|guerrillamail|10minutemail|tempmail|temp-mail|yopmail|trashmail|sharklasers|getnada)\./i
const FAKE_NAME = /^(test|testing|asdf\w*|qwerty|fake|none|n\/?a|xxx+|aaa+|abc|john doe|jane doe|sample|demo)$/i
const SELLER_SEARCH = /\b(sell|selling|sold|cash|buy(ers?)? (my|houses?|homes?)|we buy|fast|quick|as[- ]is|offer|foreclos\w*|inherit\w*|probate|ugly)\b/i
const MOTIVATED =
  /\b(foreclos\w*|behind on (my )?(payments?|mortgage)|late payments?|pre-?foreclosure|inherit\w*|probate|divorc\w*|repairs?|fixer|needs work|vacant|tenants?|evict\w*|relocat\w*|moving|job transfer|downsiz\w*|tax(es)? (lien|owed)|back taxes|code violations?|fire damage|water damage|mold|asap|urgent\w*|quickly|as[- ]is|bankrupt\w*|lost (my )?job)\b/i
const SPAM_WORDS = /\b(seo|backlinks?|rank(ing)? (your|on google)|guest post|crypto|bitcoin|forex|loan offer|web ?design services|increase (your )?traffic|casino|viagra)\b/i
const LINKS = /(https?:\/\/|www\.)\S+/gi
// A seller pasting their own listing or a map link isn't spam.
const PROPERTY_LINK = /(zillow|redfin|realtor|trulia|homes|movoto|loopnet|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|apple\.com\/maps)/i
const SPAM_FLAG = "Contact Form 7 marked this as spam"

// Scores a lead. `earlier` are the leads that came before it, to spot someone coming back.
// What the status you set adds: your own judgment is the strongest signal there is.
// Each step also has a lowest score: once you've set an appointment or made an offer, the lead has
// proven itself, whatever it typed into the form.
const STATUS_POINTS: Partial<Record<LeadStatus, { points: number; atLeast?: number; why: string }>> = {
  interested: { points: 15, atLeast: 50, why: "You marked it Interested" },
  appointment: { points: 25, atLeast: 75, why: "You set an appointment" },
  offer: { points: 35, atLeast: 85, why: "You made an offer" },
  not_interested: { points: -40, why: "You marked it Not interested" },
}
const VOUCHED: LeadStatus[] = ["interested", "appointment", "offer", "closed"]

// The score, worked out again whenever the lead changes (it arrives, or you change its status).
export function scoreLead(lead: Lead, earlier: Lead[] = []): LeadScore {
  const status = lead.status ?? "new"
  // Once you've said a lead is real (Interested or further), the automatic junk checks don't apply.
  const vouched = VOUCHED.includes(status)
  const base = baseScore(lead, earlier, vouched)
  if (status === "closed") {
    return { value: 100, grade: "hot", reasons: ["100 Closed deal: you closed it", ...base.reasons] }
  }
  const extra = STATUS_POINTS[status]
  if (!extra) return base
  if (base.grade === "junk" && status === "not_interested") return { ...base, reasons: [...base.reasons, extra.why] }
  const reasons = [...base.reasons.filter((r) => !r.startsWith("Warm, not Hot")), `${extra.points > 0 ? "+" : ""}${extra.points} ${extra.why}`]
  const value = Math.max(extra.atLeast ?? 0, Math.min(100, base.value + extra.points))
  // Hot needs a sign they want to sell; you marking them Interested or further is that sign.
  let grade: LeadGrade = value >= HOT_AT ? "hot" : value >= WARM_AT ? "warm" : "cold"
  if (status === "not_interested" && grade !== "cold") grade = "cold"
  return { value, grade, reasons }
}

function baseScore(lead: Lead, earlier: Lead[], vouched: boolean): LeadScore {
  const reasons: string[] = []
  let points = 0
  const add = (n: number, why: string) => {
    points += n
    reasons.push(`${n > 0 ? "+" : ""}${n} ${why}`)
  }
  const junk = (why: string): LeadScore => ({ value: 0, grade: "junk", reasons: [`Junk: ${why}`, ...reasons] })

  const name = lead.name.trim()
  const notes = lead.notes ?? ""
  const message = notes.replace(/^⚠.*$/m, "")
  const phoneOk = realPhone(lead.phone)
  const email = lead.email?.trim().toLowerCase()
  const emailOk = Boolean(email && EMAIL.test(email) && !THROWAWAY.test(email))

  // Someone tapped the phone number on the website: the call itself is in the phone system.
  if (lead.source === CALL_TAP_SOURCE && !vouched) {
    return { value: 50, grade: "warm", reasons: ["Tapped the phone number on the website: check the call in REI BlackBook, then set the status"], unscored: true }
  }

  // Brought in from the website without a recognized name, phone or email: needs a person to look.
  if (name.startsWith("Website lead (check the notes)")) {
    return { value: 0, grade: "cold", reasons: ["Its fields weren't recognized, so it can't be scored: check its notes"], unscored: !vouched }
  }

  // Clear junk first (unless you've already said the lead is real).
  if (!vouched) {
    if (FAKE_NAME.test(name) || /\btest\b/i.test(name) || /(https?:\/\/|www\.)/i.test(name)) return junk("looks like a test or a fake name")
    if (SPAM_WORDS.test(message)) return junk("the message is advertising, not a seller")
    if (!phoneOk && !emailOk) return junk(lead.phone || lead.email ? "the phone number and email don't look real" : "no phone number or email")
  }

  // Contact details.
  if (phoneOk) add(25, "Real phone number")
  else if (lead.phone) add(-15, "Phone number looks fake or incomplete")
  if (emailOk) add(10, "Email address")
  else if (email && THROWAWAY.test(email)) add(-10, "Throwaway email address")

  // The property.
  const address = lead.propertyAddress?.trim() ?? ""
  if (/^\d+[a-z]?\s+\S+/i.test(address) || /\b\d{2,}\s+\w+\s+(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|pl|place|ter|terrace|cir|circle|hwy|pkwy)\b/i.test(address)) {
    add(20, "Property address")
  } else if (address.length >= 4) add(8, "Property area (no house number)")

  if (name.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w)).length >= 2) add(5, "Full name")

  // Where they came from.
  const t = lead.tracking ?? {}
  if (hasAdClick(t) || /^(cpc|ppc|paid|paidsearch|paid_search)$/i.test(t.utmMedium ?? "")) add(10, "Came from a paid ad click")
  // Campaign names often use _ + - for spaces ("Sell_House_Fast").
  const searched = [t.utmTerm, t.utmCampaign].filter(Boolean).join(" ").replace(/[_+-]+/g, " ")
  if (SELLER_SEARCH.test(searched)) add(10, `Searched like a seller ("${(t.utmTerm || t.utmCampaign || "").slice(0, 40)}")`)

  // What they said.
  const motive = message.match(MOTIVATED)
  if (motive) add(15, `Motivated seller: mentions "${motive[0].toLowerCase()}"`)
  const wantsToSell = vouched || Boolean(motive) || SELLER_SEARCH.test(searched)
  const links = (message.match(LINKS) ?? []).filter((l) => !PROPERTY_LINK.test(l)).length
  if (links) add(-30, "Message has links (often spam)")
  if (notes.includes(SPAM_FLAG)) add(-25, "Blocked as spam on the website (check it: it may be a real person)")

  // Coming back: the same phone or email as an earlier lead.
  const phone = lead.phone ? digitsOf(lead.phone).slice(-10) : ""
  const back = earlier.some(
    (l) => l.id !== lead.id && ((phone.length === 10 && l.phone && digitsOf(l.phone).slice(-10) === phone) || (email && l.email?.toLowerCase() === email)),
  )
  if (back) add(5, "Came back: sent a form before")

  const value = Math.max(0, Math.min(100, points))
  // Contact details alone don't make a lead Hot: it also needs a sign they want to sell (a seller
  // search, or their own words), so only real sellers are reported to Google Ads.
  if (value >= HOT_AT && !wantsToSell) {
    return { value, grade: "warm", reasons: [...reasons, "Warm, not Hot: no sign yet they want to sell (no seller search or reason in the message)"] }
  }
  return { value, grade: value >= HOT_AT ? "hot" : value >= WARM_AT ? "warm" : "cold", reasons }
}
