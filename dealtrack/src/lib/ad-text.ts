// Google's rules for a responsive search ad's text, shared by the editor in the browser and the
// server that sends the edit: 3–15 headlines of up to 30 characters, 2–4 descriptions of up to 90,
// no repeats, and pins only to the slots Google has.

export type AdLine = { text: string; pinned: string } // pinned: "", HEADLINE_1-3 or DESCRIPTION_1-2
export type AdTextSet = { headlines: AdLine[]; descriptions: AdLine[] }

export const LIMITS = { headline: { min: 3, max: 15, chars: 30 }, description: { min: 2, max: 4, chars: 90 } } as const
export const HEADLINE_PINS = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] as const
export const DESCRIPTION_PINS = ["DESCRIPTION_1", "DESCRIPTION_2"] as const

// "{LOCATION(City):Local}" shows the searcher's city, or "Local" when Google can't tell; Google
// counts the fallback toward the limit. Keyword insertion ("{KeyWord:Cash Offer}") works the same.
export const shownText = (text: string) => text.replace(/\{[A-Za-z]+(?:\([^)]*\))?:([^}]*)\}/g, "$1")
export const shownLength = (text: string) => shownText(text).length

export const clean = (set: AdTextSet): AdTextSet => ({
  headlines: set.headlines.map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), pinned: l.pinned || "" })).filter((l) => l.text),
  descriptions: set.descriptions.map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), pinned: l.pinned || "" })).filter((l) => l.text),
})

// What's wrong with a set of ad text, in plain words; empty when Google will accept it.
export function adTextProblems(raw: AdTextSet): string[] {
  const set = clean(raw)
  const out: string[] = []
  const check = (lines: AdLine[], kind: "headline" | "description", pins: readonly string[]) => {
    const rule = LIMITS[kind]
    if (lines.length < rule.min) out.push(`At least ${rule.min} ${kind}s are needed.`)
    if (lines.length > rule.max) out.push(`At most ${rule.max} ${kind}s are allowed.`)
    for (const l of lines) {
      if (shownLength(l.text) > rule.chars) out.push(`“${l.text}” is ${shownLength(l.text)} characters; ${kind}s can be ${rule.chars}.`)
      if (l.pinned && !pins.includes(l.pinned)) out.push(`“${l.text}” has a pin Google doesn't have.`)
      if (/!.*!|[!?]{2,}/.test(l.text)) out.push(`“${l.text}”: Google allows one exclamation mark per ${kind} at most, and no repeated punctuation.`)
      if (/\b[A-Z]{5,}\b/.test(shownText(l.text)) && !/\b(BBB|LLC|USA)\b/.test(l.text)) out.push(`“${l.text}”: Google rejects words in all capitals.`)
    }
    const seen = new Set<string>()
    for (const l of lines) {
      const key = l.text.toLowerCase()
      if (seen.has(key)) out.push(`“${l.text}” is in the ${kind}s twice.`)
      seen.add(key)
    }
  }
  check(set.headlines, "headline", HEADLINE_PINS)
  check(set.descriptions, "description", DESCRIPTION_PINS)
  return out
}

export const sameText = (a: AdTextSet, b: AdTextSet) => JSON.stringify(clean(a)) === JSON.stringify(clean(b))

// What changed, line by line, for the approval card: kept, removed and added lines, and pin moves.
export function adTextDiff(before: AdTextSet, after: AdTextSet) {
  const side = (b: AdLine[], a: AdLine[]) => {
    const was = new Map(b.map((l) => [l.text.toLowerCase(), l]))
    const now = new Map(a.map((l) => [l.text.toLowerCase(), l]))
    return {
      removed: b.filter((l) => !now.has(l.text.toLowerCase())),
      added: a.filter((l) => !was.has(l.text.toLowerCase())),
      repinned: a.filter((l) => was.has(l.text.toLowerCase()) && (was.get(l.text.toLowerCase())!.pinned || "") !== (l.pinned || "")),
      kept: a.filter((l) => was.has(l.text.toLowerCase())).length,
    }
  }
  return { headlines: side(before.headlines, after.headlines), descriptions: side(before.descriptions, after.descriptions) }
}
