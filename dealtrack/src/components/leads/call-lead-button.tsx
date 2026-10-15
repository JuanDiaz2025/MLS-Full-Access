"use client"

import { useState, useTransition } from "react"
import { UserPlus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { addCallLeadAction } from "@/lib/leads/call-actions"
import type { CallInfo } from "@/lib/leads/call-id"

const input = "h-9 rounded-lg border bg-card px-2 text-sm"

// "Add as lead" on a Google Ads call: you type the caller's full number (Google never gives it to the
// app; `hint` says where it is) and how it went; the lead is then sent to Google Ads like any other,
// matched by that number. A missed call starts at New, since nobody has spoken to the caller yet.
export default function CallLeadButton({ call, added, hint }: { call: CallInfo; added: boolean; hint?: string }) {
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState(call.areaCode ? `(${call.areaCode}) ` : "")
  const [name, setName] = useState("")
  const [status, setStatus] = useState(call.missed ? "new" : "interested")
  const [notes, setNotes] = useState("")
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()

  if (added || note?.ok) return <span className="text-xs font-medium text-emerald-700">{note?.text ?? "Added as a lead ✓"}</span>
  const where = hint ? <span className="w-full text-xs text-muted-foreground">{hint}</span> : null
  if (!open) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <UserPlus data-icon="inline-start" />
          Add as lead
        </Button>
        {where}
      </div>
    )
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        setNote(null)
        start(async () => {
          try {
            const res = await addCallLeadAction(call, { phone, name, status, notes })
            setNote(res.error ? { ok: false, text: res.error } : { ok: true, text: res.ok ?? "Added ✓" })
          } catch {
            setNote({ ok: false, text: "Couldn't add it. Try again." })
          }
        })
      }}
    >
      <input aria-label="Caller's phone number" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(510) 555-0123" className={`${input} w-36`} />
      <input aria-label="Caller's name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={`${input} w-36`} />
      <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={input}>
        <option value="new">New</option>
        <option value="interested">Interested</option>
        <option value="appointment">Appointment</option>
        <option value="offer">Offer made</option>
        <option value="closed">Closed deal</option>
      </select>
      <input aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className={`${input} w-44`} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Adding…" : "Add"}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {where}
      {note && !note.ok && <span className="w-full text-xs text-destructive">{note.text}</span>}
    </form>
  )
}
