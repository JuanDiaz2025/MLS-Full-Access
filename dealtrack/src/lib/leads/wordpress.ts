// Leads straight from the WordPress site: the Lead Saver plugin (wordpress-plugin.ts) keeps every
// Contact Form 7 submission in WordPress, and the app picks up the new ones whenever it's open, at
// most every 30 seconds. WordPress is always online and its address never changes, so leads sent
// while this computer or the app was off still arrive, with the time they were really sent.
import { jsonFileStore } from "@/lib/json-file-store"
import { shared } from "@/lib/shared-state"
import { addLead } from "@/lib/leads/store"
import { parseWebsiteLead, webhookSecret } from "@/lib/leads/webhook"
import { logAttempt } from "@/lib/leads/webhook-log"

type WordPressState = {
  site?: string // e.g. https://twinhomebuyer.com
  api?: "wp-json" | "rest_route" // which kind of address the site's REST API answered on
  lastId?: number // the last saved submission already brought in
  lastSync?: string
  lastError?: string
  saved?: number // how many submissions the plugin has saved in all
  plugin?: string // the plugin's version
  events?: SiteEvent[] // what happened to the latest form submissions on the site (plugin 1.2+)
}

// One form submission as the site saw it: no names or numbers, just when, which form and the outcome.
export type SiteEvent = { at: string; form?: string; status: string; saved: boolean }

type SavedLead = { id: number; received: string; form?: string; fields?: Record<string, unknown> }
type Answer = { ok?: boolean; code?: string; error?: string; message?: string; leads?: SavedLead[]; total?: number; plugin?: string; events?: SiteEvent[] }

const file = jsonFileStore<WordPressState>("wordpress.json", () => ({}))
const SYNC_EVERY_MS = 30_000
// One for the whole app (pages and API routes alike), see shared-state.ts.
const sync = shared("wordpress-sync", () => ({ lastAttempt: 0, running: null as Promise<void> | null }))

export const getWordPress = () => file.read()

// "twinhomebuyer.com", "www.twinhomebuyer.com/contact" or a full address → "https://www.twinhomebuyer.com".
export function normalizeSite(input: string) {
  const text = input.trim()
  if (!text) return null
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

const bareHost = (site: string) => new URL(site).host.replace(/^www\./, "")

// Saves the site's address. Typing the same site again (with or without www) keeps how far its
// leads have been brought in; a different site starts from its first saved lead.
export async function setWordPressSite(site: string | null) {
  await file.update((s) => {
    const same = Boolean(site && s.site && bareHost(site) === bareHost(s.site))
    const lastId = s.lastId
    for (const key of Object.keys(s)) delete s[key as keyof WordPressState]
    if (site) {
      s.site = site
      s.lastId = same ? (lastId ?? 0) : 0
    }
  })
  sync.lastAttempt = 0
}

// The site's answer for leads after `after`, trying the usual /wp-json/ address first and then
// ?rest_route= (for sites without "pretty" permalinks).
async function ask(state: WordPressState, key: string, after: number): Promise<{ answer: Answer; api: WordPressState["api"] }> {
  const order: NonNullable<WordPressState["api"]>[] = state.api === "rest_route" ? ["rest_route", "wp-json"] : ["wp-json", "rest_route"]
  let last: { status: number; answer: Answer | null } = { status: 0, answer: null }
  const get = async (api: NonNullable<WordPressState["api"]>, keyInAddress: boolean) => {
    const params = `after=${after}${keyInAddress ? `&key=${encodeURIComponent(key)}` : ""}&t=${Date.now()}`
    const url = api === "wp-json" ? `${state.site}/wp-json/omcc/v1/leads?${params}` : `${state.site}/?rest_route=/omcc/v1/leads&${params}`
    const res = await fetch(url, {
      headers: { "x-omcc-key": key, accept: "application/json", "user-agent": "OneMarketingCommandCenter/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    })
    return { status: res.status, answer: (await res.json().catch(() => null)) as Answer | null }
  }
  for (const api of order) {
    // The key goes in a header, which stays out of the site's logs. Some hosts drop unknown
    // headers; only then is it sent in the address instead.
    let result = await get(api, false)
    if (result.answer?.code === "omcc_bad_key") result = await get(api, true)
    if (result.answer?.ok) return { answer: result.answer, api }
    last = result
    // Our plugin answered (wrong key, still setting up): no point trying the other address.
    if (result.answer?.code?.startsWith("omcc_")) break
  }
  const { status, answer } = last
  if (answer?.code === "omcc_bad_key") {
    throw new Error("The Lead Saver plugin on your site has a different key. Download the plugin again from this page and reinstall it.")
  }
  if (answer?.code?.startsWith("omcc_")) throw new Error(answer.error ?? "The Lead Saver plugin had a problem. Try again.")
  if (status === 404 || answer?.code === "rest_no_route") {
    throw new Error("Your site answered, but the Lead Saver plugin isn't there. Install and activate it (steps below), then click Connect again.")
  }
  if (status === 401 || status === 403) {
    throw new Error(
      `Your site turned the app away (${status}). A security plugin or firewall (Wordfence, iThemes, Cloudflare) may be blocking the WordPress REST API; allow /wp-json/omcc/ in it.`,
    )
  }
  if (status >= 500) throw new Error(`Your site had an error (${status}). Try again in a minute.`)
  throw new Error(
    status
      ? "That address answered, but not like a WordPress site with the Lead Saver plugin. Check the address, and that the plugin is installed and active."
      : "Couldn't reach your site. Check the address.",
  )
}

// Brings in leads saved in WordPress since the last time. At most every 30 seconds, and one at a
// time; `force` skips the wait (e.g. right after connecting).
export function syncWordPress(force = false): Promise<void> {
  // A check already under way may be for the old address: let it finish, then check again.
  if (sync.running) return force ? sync.running.then(() => syncWordPress(true)) : sync.running
  if (!force && Date.now() - sync.lastAttempt < SYNC_EVERY_MS) return Promise.resolve()
  sync.lastAttempt = Date.now()
  sync.running = (async () => {
    const state = await file.read()
    if (!state.site) return
    try {
      const key = await webhookSecret()
      const host = bareHost(state.site)
      let lastId = state.lastId ?? 0
      let api = state.api
      let info: Answer = {}
      // Up to 2,000 leads per check (200 at a time); anything beyond comes in on the next one.
      for (let page = 0; page < 10; page++) {
        const result = await ask({ ...state, api }, key, lastId)
        api = result.api
        info = result.answer
        const leads = info.leads ?? []
        for (const saved of leads) {
          lastId = Math.max(lastId, saved.id)
          const { _omcc_flag: flag, ...fields } = { ...saved.fields }
          if (saved.form && !fields.form_title) fields.form_title = saved.form
          const lead = parseWebsiteLead(fields)
          if (lead && (flag === "spam" || flag === "aborted")) {
            const why =
              flag === "spam"
                ? "Contact Form 7 marked this as spam (usually reCAPTCHA), so you may not have got its email. Check it: it may be a real person."
                : "Another WordPress plugin stopped this form before its email went out."
            lead.notes = [`⚠ ${why}`, lead.notes].filter(Boolean).join("\n")
          }
          if (!lead) {
            // No field the app recognises as a name, email or phone (e.g. renamed form fields).
            // The site saved it, so keep it anyway with everything it sent in the notes.
            const notes = Object.entries(fields)
              .filter(([k, v]) => !k.startsWith("thb_") && typeof v === "string" && v.trim())
              .slice(0, 30)
              .map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`)
              .join("\n")
            await addLead(
              { name: "Website lead (check the notes)", notes: notes || undefined, source: saved.form ? `Website · ${saved.form.slice(0, 60)}` : "Website", inboxId: `wp:${host}:${saved.id}` },
              Number.isNaN(Date.parse(saved.received)) ? undefined : saved.received,
            )
            await logAttempt({ ok: false, result: "unrecognized", fields: Object.keys(fields).slice(0, 30) })
            continue
          }
          await addLead({ ...lead, inboxId: `wp:${host}:${saved.id}` }, Number.isNaN(Date.parse(saved.received)) ? undefined : saved.received)
          await logAttempt({ ok: true, result: "lead", lead: `${lead.name.slice(0, 80)} (from WordPress)` })
        }
        // Save progress after each batch, so a later failure doesn't bring these in twice.
        await file.update((s) => {
          if (s.site === state.site) s.lastId = lastId
        })
        if (leads.length < 200) break
      }
      await file.update((s) => {
        if (s.site !== state.site) return
        s.api = api
        s.lastSync = new Date().toISOString()
        s.saved = info.total
        s.plugin = info.plugin
        if (Array.isArray(info.events)) s.events = info.events.slice(0, 20)
        delete s.lastError
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.name === "TimeoutError"
            ? "Your site took too long to answer."
            : error.message === "fetch failed"
              ? "Couldn't reach your site. Check the address."
              : error.message
          : String(error)
      await file.update((s) => {
        if (s.site !== state.site) return
        s.lastError = message.slice(0, 300)
        s.lastSync = new Date().toISOString()
      })
    }
  })().finally(() => {
    sync.running = null
  })
  return sync.running
}
