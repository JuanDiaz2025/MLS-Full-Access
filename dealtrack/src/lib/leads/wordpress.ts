// Leads straight from the WordPress site: the Lead Saver plugin (wordpress-plugin.ts) keeps every
// Contact Form 7 submission in WordPress, and the app picks up the new ones whenever it's open, at
// most every 30 seconds. WordPress is always online and its address never changes, so leads sent
// while this computer or the app was off still arrive, with the time they were really sent. The
// same check shares lead statuses with the rest of the team (team-sync.ts, plugin 1.4+), and the
// lead panel's notes and follow-up dates (notes.ts, plugin 1.5+).
import { jsonFileStore } from "@/lib/json-file-store"
import { shared } from "@/lib/shared-state"
import { applyNoteChanges, markNotesShared, unsharedNotes, type NoteChange } from "@/lib/leads/notes"
import { addLead } from "@/lib/leads/store"
import { applyChanges, installId, markShared, unsharedChanges, type Sender, type StatusChange } from "@/lib/leads/team-sync"
import { parseWebsiteLead, webhookSecret } from "@/lib/leads/webhook"
import { logAttempt } from "@/lib/leads/webhook-log"
import { siteKeepsNotes, siteKeepsStatus } from "@/lib/leads/wordpress-plugin"

type WordPressState = {
  site?: string // e.g. https://twinhomebuyer.com
  api?: "wp-json" | "rest_route" // which kind of address the site's REST API answered on
  lastId?: number // the last saved submission already brought in
  lastSync?: string
  lastError?: string
  saved?: number // how many submissions the plugin has saved in all
  plugin?: string // the plugin's version
  events?: SiteEvent[] // what happened to the latest form submissions on the site (plugin 1.2+)
  statusSeq?: number // the last team status change already picked up (plugin 1.4+)
  notesSeq?: number // the last team note or follow-up change already picked up (plugin 1.5+)
  // The computer that sends shared leads to Google Ads: null when none has yet, missing when the
  // site's plugin is older than 1.4 (no team sharing).
  sender?: Sender | null
}

// One form submission as the site saw it: no names or numbers, just when, which form and the outcome.
export type SiteEvent = { at: string; form?: string; status: string; saved: boolean }

type SavedLead = { id: number; received: string; form?: string; fields?: Record<string, unknown> }
type Answer = {
  ok?: boolean
  code?: string
  error?: string
  message?: string
  leads?: SavedLead[]
  total?: number
  plugin?: string
  events?: SiteEvent[]
  statuses?: StatusChange[]
  notes?: NoteChange[]
  sender?: Sender | null
}

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

export const bareHost = (site: string) => new URL(site).host.replace(/^www\./, "")

const DIFFERENT_KEY = "The Lead Saver plugin on your site has a different key. Download the plugin again from this page and reinstall it."

// What went wrong talking to the site, in plain words.
function problem(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  if (error.name === "TimeoutError") return "Your site took too long to answer."
  if (error.message === "fetch failed") return "Couldn't reach your site. Check the address."
  return error.message
}

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
async function ask(
  state: WordPressState,
  key: string,
  after: number,
  statusAfter = state.statusSeq ?? 0,
  notesAfter = state.notesSeq ?? 0,
): Promise<{ answer: Answer; api: WordPressState["api"] }> {
  const order: NonNullable<WordPressState["api"]>[] = state.api === "rest_route" ? ["rest_route", "wp-json"] : ["wp-json", "rest_route"]
  let last: { status: number; answer: Answer | null } = { status: 0, answer: null }
  const get = async (api: NonNullable<WordPressState["api"]>, keyInAddress: boolean) => {
    const params = `after=${after}&status_after=${statusAfter}&notes_after=${notesAfter}${keyInAddress ? `&key=${encodeURIComponent(key)}` : ""}&t=${Date.now()}`
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
  if (answer?.code === "omcc_bad_key") throw new Error(DIFFERENT_KEY)
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

// Whether the site's Lead Saver plugin takes this key (a teammate's team code), without bringing
// anything in: null when it does, else what's wrong.
export async function siteKeyProblem(site: string, key: string): Promise<string | null> {
  const past = 2_147_483_647 // after every saved lead, status and note, so none comes back
  try {
    await ask({ site }, key, past, past, past)
    return null
  } catch (error) {
    if (error instanceof Error && error.message === DIFFERENT_KEY) {
      return "Your site's Lead Saver plugin has another key than that team code. Check your teammate's app says Connected to the site, then copy their team code again."
    }
    return problem(error)
  }
}

// Sends something to the plugin (plugin 1.4+): the team's statuses, notes (1.5+), or which
// computer sends to Google Ads. Null when the site's plugin is older and doesn't take it.
async function post(state: WordPressState, key: string, route: "status" | "notes" | "sender", body: unknown): Promise<Answer | null> {
  if (!state.site) return null
  const send = async (keyInAddress: boolean) => {
    const k = keyInAddress ? `${state.api === "rest_route" ? "&" : "?"}key=${encodeURIComponent(key)}` : ""
    const url = state.api === "rest_route" ? `${state.site}/?rest_route=/omcc/v1/${route}${k}` : `${state.site}/wp-json/omcc/v1/${route}${k}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-omcc-key": key, "content-type": "application/json", accept: "application/json", "user-agent": "OneMarketingCommandCenter/1.0" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    return (await res.json().catch(() => null)) as Answer | null
  }
  let answer = await send(false)
  if (answer?.code === "omcc_bad_key") answer = await send(true)
  return answer?.ok ? answer : null
}

// Reports the statuses set here to the rest of the team, right away (also part of every check).
const sharing = shared("team-share", () => ({ running: null as Promise<void> | null, again: false }))
export function shareStatuses(): Promise<void> {
  if (sharing.running) {
    sharing.again = true
    return sharing.running
  }
  sharing.running = (async () => {
    do {
      sharing.again = false
      const state = await file.read()
      // A status the site's plugin doesn't keep yet (Unresponsive on 1.4.0) waits for the newer plugin.
      const changes = (await unsharedChanges()).filter((c) => siteKeepsStatus(state.plugin, c.status))
      if (!state.site || !changes.length) continue
      const answer = await post(state, await webhookSecret(), "status", {
        from: await installId(),
        changes: changes.slice(0, 100).map(({ key, status, at, by }) => ({ key, status, at: Date.parse(at), by })),
      }).catch(() => null)
      if (answer) await markShared(changes.slice(0, 100))
    } while (sharing.again)
  })()
    .catch((error) => console.error("Couldn't share statuses with the team:", error))
    .finally(() => {
      sharing.running = null
    })
  return sharing.running
}

// Reports the notes and follow-up dates set here to the rest of the team, right away (also part
// of every check). With a plugin older than 1.5 they wait here until the site has the newer one.
const noteSharing = shared("team-note-share", () => ({ running: null as Promise<void> | null, again: false }))
export function shareNotes(): Promise<void> {
  if (noteSharing.running) {
    noteSharing.again = true
    return noteSharing.running
  }
  noteSharing.running = (async () => {
    do {
      noteSharing.again = false
      const state = await file.read()
      if (!state.site || !siteKeepsNotes(state.plugin)) continue
      const changes = (await unsharedNotes()).slice(0, 100)
      if (!changes.length) continue
      const answer = await post(state, await webhookSecret(), "notes", {
        from: await installId(),
        changes: changes.map(({ key, kind, id, text, due, at, by }) => ({ key, kind, id, text, due, at: Date.parse(at), by })),
      }).catch(() => null)
      if (answer) await markNotesShared(changes)
    } while (noteSharing.again)
  })()
    .catch((error) => console.error("Couldn't share notes with the team:", error))
    .finally(() => {
      noteSharing.running = null
    })
  return noteSharing.running
}

// Makes this computer the one that sends shared leads to Google Ads: when none is yet (`take`
// false), or from now on in place of another one (`take`).
export async function claimSender(name: string, take = false) {
  const state = await file.read()
  if (!state.site) return null
  const answer = await post(state, await webhookSecret(), "sender", { id: await installId(), name, take })
  if (answer) {
    await file.update((s) => {
      if (s.site === state.site) s.sender = answer.sender ?? null
    })
  }
  return answer?.sender ?? null
}

// Whether this computer should leave a shared lead's Google Ads conversions to another one.
export async function sentElsewhere(): Promise<Sender | null> {
  const { sender } = await file.read()
  return sender && sender.id !== (await installId()) ? sender : null
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
      await shareStatuses()
      await shareNotes()
      const key = await webhookSecret()
      const host = bareHost(state.site)
      let lastId = state.lastId ?? 0
      let api = state.api
      let info: Answer = {}
      let statuses: StatusChange[] = []
      let notes: NoteChange[] = []
      let allIn = false
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
        if (page === 0) {
          statuses = info.statuses ?? []
          notes = Array.isArray(info.notes) ? info.notes : []
        }
        if (leads.length < 200) {
          allIn = true
          break
        }
      }
      // The statuses the team set (the first answer has up to 500), once their leads are in. With
      // leads still to come, they're asked for again next time, for the leads that weren't here yet.
      if (statuses.length) {
        await applyChanges(statuses, await installId())
        if (allIn) {
          const seq = Math.max(state.statusSeq ?? 0, ...statuses.map((c) => c.seq))
          await file.update((s) => {
            if (s.site === state.site) s.statusSeq = seq
          })
        }
      }
      // The team's notes and follow-up dates the same way (plugin 1.5+, up to 500 at a time).
      if (notes.length) {
        await applyNoteChanges(notes, await installId())
        if (allIn) {
          const seq = Math.max(state.notesSeq ?? 0, ...notes.map((c) => Number(c.seq) || 0))
          await file.update((s) => {
            if (s.site === state.site) s.notesSeq = seq
          })
        }
      }
      await file.update((s) => {
        if (s.site !== state.site) return
        s.api = api
        s.lastSync = new Date().toISOString()
        s.saved = info.total
        s.plugin = info.plugin
        // An older plugin (no team sharing) doesn't say.
        if ("sender" in info) s.sender = info.sender ?? null
        else delete s.sender
        if (Array.isArray(info.events)) s.events = info.events.slice(0, 20)
        delete s.lastError
      })
      // The site was just updated to a plugin that keeps notes: send the ones waiting here now.
      if (siteKeepsNotes(info.plugin) && !siteKeepsNotes(state.plugin)) await shareNotes()
    } catch (error) {
      const message = problem(error)
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
