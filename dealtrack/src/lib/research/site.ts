// "https://www.sacramento.example.co.uk/page" → "example.co.uk"; "https://www.opendoor.com" →
// "opendoor.com". A bare address ("www.example.com/sell") works too.
export function siteOf(url: string) {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "")
    const parts = host.split(".")
    const keep = parts.length > 2 && /^(co|com|org|net|gov|ac)$/.test(parts.at(-2) ?? "") ? 3 : 2
    return parts.slice(-keep).join(".")
  } catch {
    return ""
  }
}
