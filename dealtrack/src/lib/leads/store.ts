// Website leads, saved in .data/leads.json (the same file and format as One Marketing Command
// Center, so its leads can be copied over). Older files may also hold QR codes; DealTrack only
// reads their placement names to label those leads.
import { randomBytes } from "node:crypto"

import { jsonFileStore } from "@/lib/json-file-store"
import { getScoringSettings, scoreLead } from "@/lib/leads/scoring"
import { firstMatch } from "@/lib/leads/rules"
import { getRules } from "@/lib/leads/rules-store"
import { applyRule } from "@/lib/leads/status"
import type { Lead, QrCode } from "@/lib/leads/types"

type Db = { qrCodes: QrCode[]; leads: Lead[] }

const file = jsonFileStore<Db>("leads.json", () => ({ qrCodes: [], leads: [] }))

// Leads deleted from the Leads page, kept in .data/deleted-leads.json exactly as they were (status,
// score, what Google Ads heard), so Restore can put them back. Every page and report reads only
// leads.json, so a deleted lead is out of all of them. Nothing is sent to Google Ads either way.
export type DeletedLead = { deletedAt: string; lead: Lead }
const bin = jsonFileStore<{ leads: DeletedLead[] }>("deleted-leads.json", () => ({ leads: [] }))

export const newId = () =>
  randomBytes(6)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8)
    .padEnd(8, "0")

export async function listQrCodes() {
  const db = await file.read()
  return [...(db.qrCodes ?? [])]
}

// Newest first.
export async function listLeads() {
  const db = await file.read()
  return [...(db.leads ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const digits = (s?: string) => s?.replace(/\D/g, "").slice(-10) || undefined
const SAME_LEAD_MS = 15 * 60_000
// How new a lead must be for its score to set its status.
const FRESH_MS = 24 * 60 * 60_000
// "wp:www.example.com:12" and "wp:example.com:12" are the same saved lead.
const sameSource = (a?: string, b?: string) => Boolean(a && b && a.replace(/^wp:www\./, "wp:") === b.replace(/^wp:www\./, "wp:"))

// `createdAt` defaults to now; leads picked up from WordPress keep the time they were really sent.
// The same lead can arrive twice when the website uses both the Lead Saver plugin and a webhook:
// one with an email or phone in common from within 15 minutes of the other, where only one of
// them came from the plugin, is taken to be the same lead. A plugin lead is added once (by its id).
// Every new lead is scored on arrival, then your Google Ads rules (rules.ts) run on it, when
// they're switched on: the first rule it matches decides what Google Ads hears about it.
export async function addLead(input: Omit<Lead, "id" | "createdAt">, createdAt?: string) {
  const [{ autoStatus }, rules, deleted] = await Promise.all([getScoringSettings(), getRules(), bin.read()])
  return file.update((db) => {
    const at = createdAt ? new Date(createdAt).toISOString() : new Date().toISOString()
    db.leads ??= []
    if (input.inboxId) {
      const known = db.leads.find((l) => sameSource(l.inboxId, input.inboxId))
      if (known) return known
      // Deleted on purpose: a later sync with the website doesn't bring it back.
      const gone = (deleted.leads ?? []).find((d) => sameSource(d.lead.inboxId, input.inboxId))
      if (gone) return gone.lead
    }
    const email = input.email?.toLowerCase()
    const phone = digits(input.phone)
    const same = db.leads.find(
      (l) =>
        !l.qrCodeId &&
        // A lead made from a phone call is its own lead: never merged with a form lead.
        !l.callId &&
        !input.callId &&
        Boolean(l.inboxId) !== Boolean(input.inboxId) &&
        Math.abs(Date.parse(l.createdAt) - Date.parse(at)) < SAME_LEAD_MS &&
        ((email && l.email?.toLowerCase() === email) || (phone && digits(l.phone) === phone)),
    )
    if (same) {
      same.inboxId ??= input.inboxId
      return same
    }
    const lead: Lead = { ...input, id: newId(), createdAt: at }
    lead.score = scoreLead(lead, db.leads)
    // Only for leads that just arrived: a first sync with the website can bring in months of old
    // ones, and those aren't reported to Google Ads without you choosing.
    const fresh = Date.now() - Date.parse(at) < FRESH_MS
    if (autoStatus && fresh && !lead.qrCodeId && !lead.score.unscored) {
      const rule = firstMatch(lead, rules)
      if (rule) applyRule(lead, rule)
    }
    db.leads.push(lead)
    return lead
  })
}

// Changes one lead in place (status, conversion uploads). Returns the updated lead, or null.
export async function updateLead(id: string, change: (lead: Lead) => void) {
  return file.update((db) => {
    const lead = db.leads.find((l) => l.id === id)
    if (!lead) return null
    const before = lead.status
    change(lead)
    // A new status changes the score (Interested adds points, Closed deal is 100...).
    if (lead.status !== before) {
      lead.score = scoreLead(
        lead,
        db.leads.filter((l) => l.createdAt < lead.createdAt),
      )
    }
    return lead
  })
}

// Deleted leads, the most recently deleted first.
export async function listDeletedLeads() {
  const db = await bin.read()
  return [...(db.leads ?? [])].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

// Something for this lead still has to reach Google Ads: a conversion or a take-back waiting to be
// sent. The app only sends for leads in the list, so deleting it now would leave that undone.
export function waitingOnGoogle(lead: Lead) {
  return Object.values(lead.conversions ?? {}).some((c) => c?.state === "pending" || c?.retraction?.state === "pending")
}

// Moves a Not interested lead to the deleted list. The copy is saved before the lead leaves
// leads.json, so an interruption can only leave it in both lists, never in neither.
export async function deleteLead(id: string): Promise<{ error?: string }> {
  return file.update(async (db) => {
    const lead = (db.leads ?? []).find((l) => l.id === id)
    if (!lead) return { error: "That lead is gone." }
    if (lead.status !== "not_interested") return { error: "Only leads in the Not interested list can be deleted. Mark it Not interested (✕) first." }
    if (waitingOnGoogle(lead)) return { error: "Something for this lead is still waiting to go to Google Ads. Try again once it's sent (usually within a few minutes)." }
    const deletedAt = new Date().toISOString()
    await bin.update((b) => {
      b.leads = [...(b.leads ?? []).filter((d) => d.lead.id !== id), { deletedAt, lead }]
    })
    db.leads = db.leads.filter((l) => l.id !== id)
    return {}
  })
}

// Puts a deleted lead back in the list exactly as it was deleted.
export async function restoreLead(id: string): Promise<{ error?: string }> {
  const entry = (await bin.read()).leads?.find((d) => d.lead.id === id)
  if (!entry) return { error: "That lead isn't in the deleted list any more." }
  const result = await file.update((db): { error?: string } => {
    db.leads ??= []
    // Already back: an earlier Restore was interrupted before it cleared the deleted list.
    if (db.leads.some((l) => l.id === id)) return {}
    const same = db.leads.find(
      (l) => (entry.lead.inboxId && sameSource(l.inboxId, entry.lead.inboxId)) || (entry.lead.callId && l.callId === entry.lead.callId),
    )
    if (same) return { error: `“${same.name}” in your leads is the same lead, so this copy can't be put back.` }
    db.leads.push(entry.lead)
    return {}
  })
  if (result.error) return result
  await bin.update((b) => {
    b.leads = (b.leads ?? []).filter((d) => d.lead.id !== id)
  })
  return {}
}

// Scores leads that came in before scoring existed. Their status is left alone, so nothing old
// is sent to Google Ads without you choosing it.
export async function scoreUnscored() {
  const db = await file.read()
  if ((db.leads ?? []).every((l) => l.score)) return
  await file.update((db) => {
    const byDate = [...db.leads].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    byDate.forEach((lead, i) => {
      lead.score ??= scoreLead(lead, byDate.slice(0, i))
    })
  })
}
