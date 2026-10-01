// Turns a lead sent by a WordPress form webhook into a Lead. Form plugins name their fields
// differently (Elementor: "Name" or fields[name][value]; Contact Form 7: "your-name"; WPForms and
// Gravity Forms: whatever the site owner mapped), so fields are matched by common names and
// anything left over goes into the notes.
import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { completeTracking, trackingAliases } from "@/lib/leads/tracking"
import type { Lead, LeadTracking } from "@/lib/leads/types"
import { DATA_DIR } from "@/lib/store"

export type WebsiteLead = Omit<Lead, "id" | "createdAt" | "qrCodeId">

// The key WordPress must send, from LEADS_WEBHOOK_SECRET or created once in .data/webhook-secret.
const secretFile = path.join(DATA_DIR, "webhook-secret")
let secret: Promise<string> | null = null

export function webhookSecret() {
  secret ??= (async () => {
    const configured = process.env.LEADS_WEBHOOK_SECRET?.trim()
    if (configured) return configured
    try {
      return (await readFile(secretFile, "utf8")).trim()
    } catch {
      const created = randomBytes(18).toString("base64url")
      try {
        await mkdir(path.dirname(secretFile), { recursive: true })
        await writeFile(secretFile, created, { mode: 0o600 })
      } catch (error) {
        // A read-only disk: keep this key until the app restarts (set LEADS_WEBHOOK_SECRET to keep one for good).
        console.error("Couldn't save the webhook key in .data:", error)
      }
      return created
    }
  })()
  return secret
}

// The public address go-online.bat saved (a Cloudflare tunnel), if it's running. The file stays
// behind when its window is closed, so check the address still answers (at most every 30 seconds).
const TUNNEL_CHECK_MS = 30_000
let tunnelCheck: { url: string; at: number; alive: boolean } | null = null

export async function tunnelUrl() {
  let url: string
  try {
    url = (await readFile(path.join(DATA_DIR, "public-url"), "utf8")).trim()
  } catch {
    return null
  }
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url)) return null
  if (!tunnelCheck || tunnelCheck.url !== url || Date.now() - tunnelCheck.at > TUNNEL_CHECK_MS) {
    // Any answer from the app counts; a closed tunnel gets Cloudflare's 5xx error page or no answer.
    const alive = await fetch(`${url}/icon.svg`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(3000) })
      .then((res) => res.status < 500)
      .catch(() => false)
    tunnelCheck = { url, at: Date.now(), alive }
  }
  return tunnelCheck.alive ? url : null
}

export async function isValidSecret(given: string | null | undefined) {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(await webhookSecret())
  return a.length === b.length && timingSafeEqual(a, b)
}

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "")

// Field names each part of a lead goes by, after lowercasing and dropping spaces and punctuation.
const aliases = {
  name: ["name", "fullname", "yourname", "contactname", "customername", "sellername", "ownername"],
  firstName: ["firstname", "fname", "first", "givenname"],
  lastName: ["lastname", "lname", "last", "surname", "familyname"],
  phone: ["phone", "phonenumber", "tel", "telephone", "mobile", "cell", "cellphone", "yourphone", "yourtel", "bestphone"],
  email: ["email", "emailaddress", "youremail", "mail", "eml"],
  address: ["propertyaddress", "address", "streetaddress", "street", "address1", "addressline1", "youraddress", "propertylocation", "location"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip", "zipcode", "postalcode", "postcode"],
  notes: ["message", "notes", "note", "comments", "comment", "yourmessage", "details", "description", "anythingelse", "tellusmore"],
  form: ["formname", "formtitle", "formid", "form"],
} as const

// Plugin bookkeeping that isn't worth keeping in the notes.
const skip = new Set(["formid", "formname", "formtitle", "form", "postid", "referer", "referrer", "remoteip", "useragent", "date", "time", "pageurl", "pagetitle", "sourceurl", "submittedon", "entryid", "id", "nonce", "action", "gdpr", "acceptance", "consent", "recaptcha", "grecaptcharesponse", "honeypot"])

// Flattens nested payloads into label → value pairs. A field sent as { id|name|label, value }
// (Elementor with advanced data, many webhook plugins) is keyed by its label or id.
function flatten(value: unknown, key = "", out: [string, string][] = []): [string, string][] {
  if (value === null || value === undefined) return out
  if (typeof value !== "object") {
    const text = String(value).trim()
    if (text) out.push([key, text])
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, key ? `${key}.${i}` : String(i), out))
    return out
  }
  const obj = value as Record<string, unknown>
  if ("value" in obj && (typeof obj.value !== "object" || obj.value === null)) {
    const label = [obj.label, obj.title, obj.name, obj.id, key].find((l) => typeof l === "string" && l.trim()) as string | undefined
    const text = String(obj.value ?? "").trim()
    if (text) out.push([label ?? key, text])
    return out
  }
  for (const [k, v] of Object.entries(obj)) {
    // A "form" block describes the form itself ({ id, name }), not the person: keep its fields
    // apart as form_id / form_name so they aren't mistaken for the lead's name.
    const child = norm(key) === "form" ? `form_${k}` : k === "value" || k === "raw_value" ? key : k
    flatten(v, child, out)
  }
  return out
}

// Form posts name nested fields with brackets (Elementor's advanced data sends
// fields[name][value]=...); rebuild them as objects so flatten can read each field's label.
function unbracket(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    const m = key.match(/^([^[\]]+)((?:\[[^[\]]*\])+)$/)
    const parts = m ? [m[1], ...[...m[2].matchAll(/\[([^[\]]*)\]/g)].map((p) => p[1])] : [key]
    if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) continue
    let node = out
    for (const part of parts.slice(0, -1)) {
      const next = node[part]
      node = (next && typeof next === "object" && !Array.isArray(next) ? next : (node[part] = {})) as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = value
  }
  return out
}

export function parseWebsiteLead(payload: unknown): WebsiteLead | null {
  const pairs = flatten(unbracket(payload))
  const used = new Set<number>()
  const take = (names: readonly string[]) => {
    for (const alias of names) {
      const i = pairs.findIndex(([k], index) => !used.has(index) && norm(k.split(".").pop() ?? k) === alias)
      if (i >= 0) {
        used.add(i)
        return pairs[i][1].slice(0, 500)
      }
    }
    return undefined
  }

  const email = take(aliases.email)?.toLowerCase()
  const phone = take(aliases.phone)
  const full = take(aliases.name)
  const first = take(aliases.firstName)
  const last = take(aliases.lastName)
  const street = take(aliases.address)
  const cityStateZip = [take(aliases.city), [take(aliases.state), take(aliases.zip)].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ")
  const message = take(aliases.notes)
  const form = take(aliases.form)
  const tracking: LeadTracking = {}
  for (const [key, names] of Object.entries(trackingAliases) as [keyof LeadTracking, string[]][]) {
    const value = take(names)
    if (value) tracking[key] = value.slice(0, 300)
  }

  if (!email && !phone && !full && !first && !last) return null

  const extras = pairs
    .filter(([k], i) => !used.has(i) && !skip.has(norm(k.split(".").pop() ?? k)) && !/^\d+$/.test(k))
    .slice(0, 20)
    .map(([k, v]) => `${k.split(".").pop()}: ${v.slice(0, 300)}`)

  return {
    name: full || [first, last].filter(Boolean).join(" ") || email || phone || "Website lead",
    phone,
    email,
    propertyAddress: [street, cityStateZip].filter(Boolean).join(", ") || undefined,
    notes: [message, ...extras].filter(Boolean).join("\n").slice(0, 2000) || undefined,
    source: form && !/^\d+$/.test(form) ? `Website · ${form.slice(0, 60)}` : "Website",
    tracking: completeTracking(tracking),
  }
}
