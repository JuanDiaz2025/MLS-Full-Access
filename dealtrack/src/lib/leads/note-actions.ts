"use server"

// The lead panel's notes and follow-up dates. On website leads, the team's other computers pick
// them up at their next website check (notes.ts).
import { revalidatePath } from "next/cache"
import { after } from "next/server"

import { isSignedIn } from "@/lib/auth"
import { addNote, deleteNote, FOLLOW_UP_NOTE_MAX, isDay, NOTE_MAX, setFollowUp } from "@/lib/leads/notes"
import { shareNotes } from "@/lib/leads/wordpress"
import { personName, rememberName } from "@/lib/people"

// Who wrote it: the name typed with it (kept for next time), else the one DealTrack knows.
async function author(typed?: string) {
  return (typed ? await rememberName(typed) : null) ?? (await personName())
}

function saved() {
  after(() => shareNotes())
  revalidatePath("/leads", "layout")
  revalidatePath("/overview")
  return {}
}

export async function addLeadNoteAction(id: string, text: string, name?: string): Promise<{ error?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  const note = String(text ?? "").trim()
  if (!note) return { error: "Type a note first." }
  if (note.length > NOTE_MAX) return { error: `Keep a note under ${NOTE_MAX} characters.` }
  const lead = await addNote(String(id), note, await author(name))
  if (!lead) return { error: "That lead is gone." }
  return saved()
}

export async function deleteLeadNoteAction(id: string, noteId: string): Promise<{ error?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  const lead = await deleteNote(String(id), String(noteId))
  if (!lead) return { error: "That note is already gone." }
  return saved()
}

// `on` is the day ("2026-10-17"), or null when it's done.
export async function setFollowUpAction(id: string, on: string | null, note?: string, name?: string): Promise<{ error?: string }> {
  if (!(await isSignedIn())) return { error: "Sign in first." }
  if (on !== null && !isDay(on)) return { error: "Pick a day." }
  if (String(note ?? "").length > FOLLOW_UP_NOTE_MAX) return { error: `Keep it under ${FOLLOW_UP_NOTE_MAX} characters.` }
  const lead = await setFollowUp(String(id), on ?? undefined, note === undefined ? undefined : String(note), await author(name))
  if (!lead) return { error: "That lead is gone." }
  return saved()
}
