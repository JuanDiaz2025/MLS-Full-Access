// Google's rules for responsive search ad text, shared by the ad editor and the server.

export const HEADLINE_PINS = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] as const
export const DESCRIPTION_PINS = ["DESCRIPTION_1", "DESCRIPTION_2"] as const
export const LIMITS = { headlines: { min: 3, max: 15, chars: 30 }, descriptions: { min: 2, max: 4, chars: 90 } } as const

export type AdText = { text: string; pin?: string }

// Length as Google counts it: inserted text like {LOCATION(City):Local} or {KeyWord:Houses}
// counts as its default text, and a countdown as about 8 characters.
export function adTextLength(text: string) {
  return text
    .trim()
    .replace(/\{=[^{}]*\}/g, "x".repeat(8))
    .replace(/\{[^{}:]+:([^{}]*)\}/g, "$1").length
}

// Trims text, then checks counts, lengths, pins, and duplicates against Google's rules.
export function cleanAdText(
  headlines: AdText[],
  descriptions: AdText[],
): { headlines: AdText[]; descriptions: AdText[] } | string {
  const clean = (items: AdText[], pins: readonly string[]) =>
    items
      .map((i) => ({ text: i.text.replace(/\s+/g, " ").trim(), ...(i.pin && pins.includes(i.pin) ? { pin: i.pin } : {}) }))
      .filter((i) => i.text)
  const h = clean(headlines, HEADLINE_PINS)
  const d = clean(descriptions, DESCRIPTION_PINS)
  for (const [items, rule, noun] of [
    [h, LIMITS.headlines, "headline"],
    [d, LIMITS.descriptions, "description"],
  ] as const) {
    if (items.length < rule.min || items.length > rule.max) return `An ad needs ${rule.min} to ${rule.max} ${noun}s.`
    const long = items.find((i) => adTextLength(i.text) > rule.chars)
    if (long) return `"${long.text}" is longer than ${rule.chars} characters, the limit for a ${noun}.`
    const seen = new Set<string>()
    for (const i of items) {
      const key = i.text.toLowerCase()
      if (seen.has(key)) return `"${i.text}" is in the ad twice. Each ${noun} has to be different.`
      seen.add(key)
    }
  }
  return { headlines: h, descriptions: d }
}
