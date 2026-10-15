// The team's notes on a lead and when to get back to them (the lead panel on the Leads page).
// On website leads both are shared with the team's other computers through the website, like
// statuses (team-sync.ts, Lead Saver plugin 1.5+); on other leads they stay on this computer.
import { randomBytes } from "node:crypto"

import { listLeads, updateLead } from "@/lib/leads/store"
import { sharedKey } from "@/lib/leads/team-sync"
import type { Lead, LeadNote } from "@/lib/leads/types"

export const NOTE_MAX = 2000
export const FOLLOW_UP_NOTE_MAX = 300
// The most notes kept per lead (deleted ones included, until they're the oldest).
export const NOTES_MAX = 200

// "2026-10-17", a real day (not "2026-02-31").
export const isDay = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T12:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// Today in Pacific time, "2026-10-15": follow-ups are due by the day.
export const pacificDay = (ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(ms)

// The notes to show: not deleted, oldest first.
export const liveNotes = (lead: Pick<Lead, "teamNotes">) => (lead.teamNotes ?? []).filter((n) => !n.deletedAt)

export function addNote(id: string, text: string, by?: string) {
  const note: LeadNote = { id: randomBytes(9).toString("base64url"), at: new Date().toISOString(), by, text: text.trim().slice(0, NOTE_MAX) }
  return updateLead(id, (l) => {
    if (sharedKey(l)) note.share = "pending"
    l.teamNotes = [...(l.teamNotes ?? []), note].slice(-NOTES_MAX)
  })
}

// Kept without its text, so the team's other computers delete their copy too.
export async function deleteNote(id: string, noteId: string) {
  let found = false
  const lead = await updateLead(id, (l) => {
    const note = l.teamNotes?.find((n) => n.id === noteId && !n.deletedAt)
    if (!note) return
    found = true
    note.text = ""
    note.deletedAt = new Date().toISOString()
    if (sharedKey(l)) note.share = "pending"
    else delete note.share
  })
  return lead && found ? lead : null
}

// Sets the day to get back to the lead, or clears it (`on` undefined: done).
export function setFollowUp(id: string, on: string | undefined, note: string | undefined, by?: string) {
  return updateLead(id, (l) => {
    l.followUp = { on, note: on ? note?.trim().slice(0, FOLLOW_UP_NOTE_MAX) || undefined : undefined, by, at: new Date().toISOString() }
    if (sharedKey(l)) l.followUp.share = "pending"
  })
}

// ---- Sharing with the team (wordpress.ts) ----------------------------------------------------

// One change as the website keeps it: a note written or deleted, or a follow-up date set or
// cleared ("note_id" is "followup" then). `at` is milliseconds since 1970 on the website.
export type NoteKind = "note" | "note_deleted" | "followup"
export type NoteChange = { seq?: number; key: string; kind: string; id: string; text?: string; due?: string; at: string | number; by?: string; from?: string }
type Pending = { lead: string; key: string; kind: NoteKind; id: string; text: string; due: string; at: string; by: string }

// Notes and follow-ups changed here and not yet reported, oldest first.
export async function unsharedNotes(): Promise<Pending[]> {
  const out: Pending[] = []
  for (const l of await listLeads()) {
    const key = sharedKey(l)
    if (!key) continue
    for (const n of l.teamNotes ?? []) {
      if (n.share !== "pending") continue
      out.push(
        n.deletedAt
          ? { lead: l.id, key, kind: "note_deleted", id: n.id, text: "", due: "", at: n.deletedAt, by: n.by ?? "" }
          : { lead: l.id, key, kind: "note", id: n.id, text: n.text, due: "", at: n.at, by: n.by ?? "" },
      )
    }
    const f = l.followUp
    if (f?.share === "pending") out.push({ lead: l.id, key, kind: "followup", id: "followup", text: f.note ?? "", due: f.on ?? "", at: f.at, by: f.by ?? "" })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

// Items by a key, in order (Map.groupBy needs a newer Node than some computers have).
function group<T>(items: T[], key: (item: T) => string) {
  const out = new Map<string, T[]>()
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item])
  return out
}

// Reported: unless it changed again meanwhile (then that goes next time).
export async function markNotesShared(sent: Pending[]) {
  for (const [id, changes] of group(sent, (c) => c.lead)) {
    await updateLead(id, (l) => {
      for (const c of changes) {
        if (c.kind === "followup") {
          if (l.followUp?.at === c.at) delete l.followUp.share
          continue
        }
        const n = l.teamNotes?.find((x) => x.id === c.id)
        if (n && (n.deletedAt ?? n.at) === c.at) delete n.share
      }
    })
  }
}

// "1760545200000" (the website's) or an ISO time → ISO, or null.
function isoOf(at: string | number) {
  const ms = /^\d+$/.test(String(at)) ? Number(at) : Date.parse(String(at))
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

// Applies the notes and follow-ups the team's other computers reported. A note is added once (by
// its id); for the follow-up date the latest change wins, wherever it was made.
export async function applyNoteChanges(changes: NoteChange[], me: string) {
  const theirs = changes.filter((c) => c.from !== me && typeof c.key === "string" && typeof c.id === "string")
  if (!theirs.length) return 0
  const leads = await listLeads()
  const byKey = new Map(leads.flatMap((l) => (sharedKey(l) ? [[sharedKey(l)!, l.id] as const] : [])))
  let applied = 0
  for (const [id, list] of group(theirs.filter((c) => byKey.has(c.key)), (c) => byKey.get(c.key)!)) {
    await updateLead(id, (l) => {
      for (const c of list) {
        const at = isoOf(c.at)
        if (!at) continue
        if (c.kind === "note") {
          const text = String(c.text ?? "").trim().slice(0, NOTE_MAX)
          if (!text || !/^[A-Za-z0-9_-]{1,40}$/.test(c.id) || l.teamNotes?.some((n) => n.id === c.id)) continue
          l.teamNotes = [...(l.teamNotes ?? []), { id: c.id, at, by: c.by || undefined, text }].sort((a, b) => a.at.localeCompare(b.at)).slice(-NOTES_MAX)
          applied++
        } else if (c.kind === "note_deleted") {
          const n = l.teamNotes?.find((x) => x.id === c.id && !x.deletedAt)
          if (!n) continue
          n.text = ""
          n.deletedAt = at
          delete n.share
          applied++
        } else if (c.kind === "followup") {
          if (l.followUp && Date.parse(l.followUp.at) >= Date.parse(at)) continue
          const on = isDay(c.due) ? c.due : undefined
          l.followUp = { on, note: on ? String(c.text ?? "").trim().slice(0, FOLLOW_UP_NOTE_MAX) || undefined : undefined, by: c.by || undefined, at }
          applied++
        }
      }
    })
  }
  return applied
}
