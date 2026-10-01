// Reading a form submission the way WordPress plugins send it: JSON, a regular form post,
// multipart, or form fields in the address. Used by the webhook.

export const MAX_BYTES = 100_000

export async function parseBody(contentType: string, text: string): Promise<unknown> {
  if (text.length > MAX_BYTES) return null
  if (!text.trim()) return {}
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text))
  if (contentType.includes("multipart/form-data")) {
    const form = await new Response(text, { headers: { "content-type": contentType } }).formData()
    return Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"))
  }
  try {
    return JSON.parse(text)
  } catch {
    // Some plugins send form-encoded data without saying so.
    return Object.fromEntries(new URLSearchParams(text))
  }
}

// Fields from the address (minus the key) and the body together; the body wins on a clash.
export function mergeFields(query: Record<string, string>, body: unknown): unknown {
  const fromQuery = Object.fromEntries(Object.entries(query).filter(([k]) => k !== "key"))
  if (body && typeof body === "object" && !Array.isArray(body)) return { ...fromQuery, ...body }
  return Object.keys(fromQuery).length ? fromQuery : body
}

// The top-level field names a form sent, for the Leads page's troubleshooting list.
export const fieldNames = (body: unknown) =>
  body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).slice(0, 30).map((k) => k.slice(0, 60)) : []
