// Junk form leads: fake phone numbers, keyboard-mash names, throwaway emails, the same person
// sending the form again and again, or one ad click sending several forms. Junk leads that are
// counted as conversions teach Google's bidding to find more people like them, so they're worth
// catching early (and taking out of the conversion count). Pure functions: leads in, flags out.

import type { Lead } from "@/lib/leads/types"

export type JunkReason =
  | "fake-phone"
  | "gibberish-name"
  | "throwaway-email"
  | "repeat-person"
  | "repeat-click"
  | "burst"
  | "competitor"
  | "outside-ca"
  | "test"

export const JUNK_LABELS: Record<JunkReason, string> = {
  "fake-phone": "Fake phone number",
  "gibberish-name": "Made-up name",
  "throwaway-email": "Throwaway email",
  "repeat-person": "Same person again",
  "repeat-click": "Same ad click, several forms",
  burst: "Many forms within minutes",
  competitor: "Looks like a competitor",
  "outside-ca": "Property outside California",
  test: "Test entry",
}

export type JunkLead = { lead: Lead; reasons: { reason: JunkReason; detail: string }[] }

const DISPOSABLE = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "trashmail.com",
  "getnada.com",
  "maildrop.cc",
  "dispostable.com",
  "throwawaymail.com",
  "fakeinbox.com",
  "mailnesia.com",
  "mohmal.com",
  "emailondeck.com",
  "spamgourmet.com",
  "mintemail.com",
  "tempr.email",
])

const KEYBOARD = /(asdf|qwer|zxcv|hjkl|sdfg|dfgh|wert|erty|uiop|jkl;|1234|aaaa|xxxx)/i
const TEST = /\b(test|testing|asdf|sample|dummy|fake|n\/a|none)\b/i
// Wording that points at another investor or wholesaler rather than a seller.
const COMPETITOR = /\b(we buy|buys? houses|buys? homes|cash buyers?|wholesal\w*|properties llc)\b/i
const CA_ZIP = /\b9[0-6]\d{3}\b/
const OTHER_STATE =
  /,\s*(A[LKZR]|C[OT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b(\s+\d{5})?\s*$/i
const BURST_MINUTES = 10

const digits = (phone = "") => phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")
const emailKey = (email = "") => email.trim().toLowerCase()

export function fakePhone(phone: string | undefined): string | null {
  if (!phone?.trim()) return null
  const d = digits(phone)
  if (d.length !== 10) return `${phone} isn't a 10-digit US number`
  if (/^(\d)\1{9}$/.test(d)) return `${phone} is one digit repeated`
  if (d === "1234567890" || d === "0123456789" || d === "9876543210") return `${phone} is a counting sequence`
  if (/^[01]/.test(d) || /^\d{3}[01]/.test(d)) return `${phone} can't be a real US number (area code or exchange starts with 0 or 1)`
  if (/^\d{3}555(01\d\d)$/.test(d)) return `${phone} is a 555 number reserved for TV and films`
  return null
}

export function gibberishName(name: string | undefined): string | null {
  const n = (name ?? "").trim()
  if (!n) return null
  if (KEYBOARD.test(n.replace(/\s/g, ""))) return `"${n}" looks like keyboard mashing`
  for (const word of n.toLowerCase().split(/\s+/)) {
    const letters = word.replace(/[^a-z]/g, "")
    if (letters.length >= 4 && !/[aeiouy]/.test(letters)) return `"${n}" has a word with no vowels`
    if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(letters)) return `"${n}" has five consonants in a row`
  }
  if (/\d{3,}/.test(n)) return `"${n}" has numbers in it`
  return null
}

const minutes = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 60_000

// Leads with at least one sign of junk, newest first. `all` is every lead (for repeats across the
// whole history); `shown` limits the result to a period.
export function findJunkLeads(all: Lead[], inPeriod: (lead: Lead) => boolean = () => true): JunkLead[] {
  const sorted = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const byPhone = new Map<string, Lead[]>()
  const byEmail = new Map<string, Lead[]>()
  const byClick = new Map<string, Lead[]>()
  for (const l of sorted) {
    const p = digits(l.phone)
    if (p.length === 10) byPhone.set(p, [...(byPhone.get(p) ?? []), l])
    const e = emailKey(l.email)
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), l])
    const g = l.tracking?.gclid
    if (g) byClick.set(g, [...(byClick.get(g) ?? []), l])
  }

  const out: JunkLead[] = []
  sorted.forEach((lead, i) => {
    if (!inPeriod(lead)) return
    const reasons: JunkLead["reasons"] = []
    const add = (reason: JunkReason, detail: string) => reasons.push({ reason, detail })

    const phone = fakePhone(lead.phone)
    if (phone) add("fake-phone", phone)
    const name = gibberishName(lead.name)
    if (name) add("gibberish-name", name)
    const domain = emailKey(lead.email).split("@")[1]
    if (domain && DISPOSABLE.has(domain)) add("throwaway-email", `${domain} hands out throwaway inboxes`)
    const text = [lead.name, lead.email, lead.notes].filter(Boolean).join(" ")
    if (TEST.test(text)) add("test", "The form says test, sample, or similar")
    if (COMPETITOR.test(text)) add("competitor", `The form mentions "${text.match(COMPETITOR)![0]}"`)
    const address = lead.propertyAddress?.trim() ?? ""
    if (address && (OTHER_STATE.test(address) || (/\b\d{5}\b/.test(address) && !CA_ZIP.test(address)))) {
      add("outside-ca", `${address} isn't in California`)
    }

    const earlier = (list: Lead[] | undefined) => (list ?? []).filter((l) => l.createdAt < lead.createdAt)
    const samePerson = [...new Set([...earlier(byPhone.get(digits(lead.phone))), ...earlier(byEmail.get(emailKey(lead.email)))])]
    if (samePerson.length)
      add(
        "repeat-person",
        `${samePerson.length === 1 ? "Sent once before" : `Sent ${samePerson.length} times before`}, first on ${samePerson[0].createdAt.slice(0, 10)}`,
      )
    const g = lead.tracking?.gclid
    if (g && (byClick.get(g)?.length ?? 0) > 1) add("repeat-click", `${byClick.get(g)!.length} forms came from one ad click`)
    const near = sorted.filter((l, j) => j !== i && minutes(l.createdAt, lead.createdAt) <= BURST_MINUTES)
    if (near.length >= 2) add("burst", `${near.length + 1} forms within ${BURST_MINUTES} minutes`)

    if (reasons.length) out.push({ lead, reasons })
  })
  return out.reverse()
}
