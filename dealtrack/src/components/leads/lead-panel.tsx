"use client"

// The panel that opens on the right when a lead is clicked in the Leads table: everything about
// the lead in one place, the team's notes and when to get back to them.
import { Fragment, useEffect, useRef, useState, useTransition, type ReactNode } from "react"
import { CalendarClock, Check, Copy, History, MapPin, Megaphone, Phone, Send, StickyNote, Trash2, UserRound, X } from "lucide-react"

import type { LeadRow } from "@/components/leads/leads-table"
import { googleLabel, gradeStyle, StatusCell, statusLabel } from "@/components/leads/lead-ui"
import { Button, buttonVariants } from "@/components/ui/button"
import { addLeadNoteAction, deleteLeadNoteAction, setFollowUpAction } from "@/lib/leads/note-actions"
import type { LeadDetail } from "@/lib/leads/panel"
import { formatPhone, telHref } from "@/lib/phone"
import { cn } from "@/lib/utils"

// Whether notes reach the team's other computers: the website's plugin keeps them (1.5+), it's
// older, or no website is connected.
export type NotesSharing = "on" | "needs-plugin" | "off"

const mapsUrl = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
const input = "rounded-lg border bg-card px-2 text-sm"
// The quick buttons that are links (cn settles the button's border classes, as the Button does).
const quick = cn(buttonVariants({ variant: "outline", size: "sm" }))

// Today and later days in Pacific time, "2026-10-15".
const pacificToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date())
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

function Part({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t px-5 py-4">
      <h3 className="mb-2.5 flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

// Label and value pairs; empty ones are left out.
function Facts({ items }: { items: [string, ReactNode][] }) {
  const shown = items.filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
  if (!shown.length) return null
  return (
    <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {shown.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

function CopyNumber({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard
          ?.writeText(formatPhone(phone))
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          })
          .catch(() => undefined)
      }}
    >
      {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {copied ? "Copied" : "Copy number"}
    </Button>
  )
}

const dueTone = {
  overdue: "border-destructive/40 bg-destructive/10 text-destructive",
  today: "border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  soon: "border-sky-500/40 bg-sky-500/10",
  later: "bg-muted/40",
} as const

// `name` is the one typed at the top of the panel, when DealTrack doesn't know who's using it.
type Author = { needName: boolean; name: string }
const NAME_FIRST = "Type your name at the top of the panel first, so the team sees who it's from."

function FollowUp({ id, followUp, readOnly, author }: { id: string; followUp: LeadDetail["followUp"]; readOnly: boolean; author: Author }) {
  const [editing, setEditing] = useState(!followUp)
  const [day, setDay] = useState(followUp?.on ?? "")
  const [note, setNote] = useState(followUp?.note ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const save = (on: string | null) => {
    setError(null)
    if (on && author.needName && !author.name.trim()) {
      setError(NAME_FIRST)
      return
    }
    start(async () => {
      try {
        const res = await setFollowUpAction(id, on, on ? note : undefined, author.name.trim() || undefined)
        if (res.error) setError(res.error)
        else if (on) setEditing(false)
      } catch {
        setError("Couldn't save it. Try again.")
      }
    })
  }
  if (readOnly) return followUp ? <p className="text-sm">{followUp.label}</p> : <p className="text-sm text-muted-foreground">None.</p>
  if (followUp && !editing) {
    return (
      <div className={cn("rounded-xl border p-3", dueTone[followUp.due])}>
        <p className="flex items-center gap-2 font-medium">
          <CalendarClock className="size-4" aria-hidden />
          {followUp.label}
        </p>
        {followUp.note && <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{followUp.note}</p>}
        {followUp.by && <p className="mt-1 text-xs text-muted-foreground">Set by {followUp.by}</p>}
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={pending} onClick={() => save(null)}>
            <Check data-icon="inline-start" />
            Done
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
    )
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (day) save(day)
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ["Tomorrow", 1],
            ["In 3 days", 3],
            ["In a week", 7],
            ["In 2 weeks", 14],
          ] as const
        ).map(([label, n]) => (
          <Button key={label} type="button" variant="outline" size="xs" onClick={() => setDay(plusDays(pacificToday(), n))}>
            {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" aria-label="Follow-up day" required value={day} onChange={(e) => setDay(e.target.value)} className={cn(input, "h-9")} />
        <input
          aria-label="What to do"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What to do (optional)"
          className={cn(input, "h-9 min-w-0 flex-1")}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || !day}>
          {pending ? "Saving…" : "Set follow-up"}
        </Button>
        {followUp && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  )
}

function Note({ leadId, note, readOnly, shared }: { leadId: string; note: LeadDetail["notes"][number]; readOnly: boolean; shared: boolean }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <li className={cn("rounded-xl border bg-card p-3", pending && "opacity-60")}>
      <p className="text-sm break-words whitespace-pre-wrap">{note.text}</p>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {note.by || "Someone"} · {note.when}
        </span>
        {!readOnly && (
          <button
            type="button"
            aria-label="Delete this note"
            title="Delete this note"
            disabled={pending}
            onClick={() => {
              if (!window.confirm(shared ? "Delete this note? It's deleted on your team's other computers too." : "Delete this note?")) return
              setError(null)
              start(async () => {
                try {
                  const res = await deleteLeadNoteAction(leadId, note.id)
                  if (res.error) setError(res.error)
                } catch {
                  setError("Couldn't delete it. Try again.")
                }
              })
            }}
            className="rounded p-1 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </li>
  )
}

function Notes({ id, d, readOnly, author, sharing }: { id: string; d: LeadDetail; readOnly: boolean; author: Author; sharing: NotesSharing }) {
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const where = !d.shared
    ? "Kept on this computer: only website leads are shared with the team."
    : sharing === "on"
      ? "Your team's other computers see it too."
      : sharing === "needs-plugin"
        ? "Reaches your team's other computers once the website's Lead Saver plugin is updated (Website leads, below the table)."
        : "Kept on this computer."
  return (
    <>
      {!readOnly && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            if (author.needName && !author.name.trim()) {
              setError(NAME_FIRST)
              return
            }
            start(async () => {
              try {
                const res = await addLeadNoteAction(id, text, author.name.trim() || undefined)
                if (res.error) setError(res.error)
                else setText("")
              } catch {
                setError("Couldn't save the note. Try again.")
              }
            })
          }}
        >
          <textarea
            aria-label="New note"
            value={text}
            maxLength={2000}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            placeholder="What they said, the plan, the price they mentioned…"
            className={cn(input, "resize-y py-2")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={pending || !text.trim()}>
              {pending ? "Saving…" : "Add note"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{where}</p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </form>
      )}
      {d.notes.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {d.notes.map((n) => (
            <Note key={n.id} leadId={id} note={n} readOnly={readOnly} shared={d.shared && sharing !== "off"} />
          ))}
        </ul>
      ) : (
        <p className={cn("text-sm text-muted-foreground", !readOnly && "mt-3")}>No notes yet.</p>
      )}
    </>
  )
}

type Props = { row?: LeadRow; onClose: () => void; you?: string; sharing: NotesSharing }

export default function LeadPanel({ row, onClose, you, sharing }: Props) {
  const heading = useRef<HTMLHeadingElement>(null)
  const close = useRef(onClose)
  // Who's writing, when DealTrack doesn't know yet (it remembers it once a note or date is saved).
  const [name, setName] = useState("")
  useEffect(() => {
    close.current = onClose
  }, [onClose])
  // The panel takes focus when it opens, so the keyboard lands in it; Esc closes it (not while
  // typing, so a half-written note isn't lost).
  useEffect(() => {
    heading.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
      if (e.key === "Escape" && !typing) close.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const shell = (children: ReactNode, label: string) => (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={label}
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[34rem] flex-col border-l bg-background text-foreground shadow-2xl sm:w-[34rem] print:hidden"
    >
      {children}
    </aside>
  )

  if (!row) {
    return shell(
      <div className="flex items-start justify-between gap-3 p-5">
        <div>
          <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
            Lead not found
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">It isn&apos;t in the leads on this computer (deleted, or not picked up here yet).</p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>,
      "Lead not found",
    )
  }

  const d = row.detail
  const readOnly = Boolean(row.deleted)
  const author: Author = { needName: !you, name }
  const g = row.score ? gradeStyle[row.score.grade] : null
  const actions = [
    row.phone && <CopyNumber key="copy" phone={row.phone} />,
    row.address && (
      <a key="map" href={mapsUrl(row.address)} target="_blank" rel="noreferrer" className={quick}>
        <MapPin data-icon="inline-start" />
        Map
      </a>
    ),
  ].filter(Boolean)

  return shell(
    <>
      <header className="border-b px-5 pt-4 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold break-words outline-none">
              {row.name}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Received {row.received} · {row.channel}
              {row.form ? ` · ${row.form}` : ""}
            </p>
            {row.deleted && <p className="mt-1 text-sm font-medium text-destructive">Deleted {row.deleted}. Restore it from the Deleted tab to work on it.</p>}
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-start gap-4">
          {readOnly ? (
            <span className="rounded-lg border px-2 py-1 text-xs font-semibold">{statusLabel(row.status)}</span>
          ) : (
            <StatusCell
              key={`${row.id}-${row.status}-${row.statusBy ?? ""}-${row.statusByName ?? ""}`}
              id={row.id}
              status={row.status}
              auto={row.statusBy === "auto"}
              rule={row.statusRule}
              by={row.statusByName}
              className="h-9 text-sm"
            />
          )}
          {row.score && g && (
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm">
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", g.cls)}>{g.label}</span>
                {row.score.grade !== "junk" && <span className="font-medium tabular-nums">{row.score.value} / 100</span>}
              </p>
              {row.score.reasons.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {row.score.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {actions.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </header>

      <div className="flex-1 overflow-y-auto pb-6">
        {author.needName && !readOnly && (
          <div className="bg-muted/40 px-5 py-3">
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Your name</span>
              <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Seth" className={cn(input, "h-8 w-44")} />
            </label>
            <p className="mt-1 text-xs text-muted-foreground">Shown on your notes and follow-ups. DealTrack remembers it on this computer.</p>
          </div>
        )}

        <Part title="Follow-up" icon={<CalendarClock />}>
          <FollowUp key={`${d.followUp?.on ?? ""}-${d.followUp?.note ?? ""}`} id={row.id} followUp={d.followUp} readOnly={readOnly} author={author} />
        </Part>

        <Part title={`Notes${d.notes.length ? ` (${d.notes.length})` : ""}`} icon={<StickyNote />}>
          <Notes id={row.id} d={d} readOnly={readOnly} author={author} sharing={sharing} />
        </Part>

        <Part title="Contact & property" icon={<UserRound />}>
          <Facts
            items={[
              [
                "Phone",
                row.phone && (
                  <a href={telHref(row.phone)} className="text-primary hover:underline">
                    {formatPhone(row.phone)}
                  </a>
                ),
              ],
              [
                "Email",
                row.email && (
                  <a href={`mailto:${row.email}`} className="break-all text-primary hover:underline">
                    {row.email}
                  </a>
                ),
              ],
              ["Property address", row.address],
              [
                "Where they were",
                row.place && (
                  <>
                    {row.place.text}
                    <span className="block text-xs text-muted-foreground">
                      Roughly, from {row.place.source}
                      {row.place.other ? ` · PostHog: ${row.place.other}` : ""}
                      {row.place.about ? ` · searched about ${row.place.about}` : ""}
                    </span>
                  </>
                ),
              ],
            ]}
          />
          {row.notes && (
            <div className="mt-3">
              <p className="text-xs font-medium text-muted-foreground">{d.call ? "Written when the call was added" : "Their message"}</p>
              <p className="mt-1 rounded-xl bg-muted/50 p-3 text-sm break-words whitespace-pre-wrap">{row.notes}</p>
            </div>
          )}
          {!row.phone && !row.email && !row.address && !row.notes && !row.place && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
        </Part>

        {d.call && (
          <Part title="Phone call from Google Ads" icon={<Phone />}>
            <Facts
              items={[
                ["When", d.call.when],
                ["Result", <span key="result" className={d.call.missed ? "font-medium text-destructive" : undefined}>{d.call.result}</span>],
                ["Campaign", d.call.campaign],
                ["Area code", d.call.areaCode && `(${d.call.areaCode})`],
              ]}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Google Ads never gives DealTrack a caller&apos;s number: it was typed in from REI BlackBook&apos;s call log.
            </p>
          </Part>
        )}

        <Part title="How they found us" icon={<Megaphone />}>
          <Facts
            items={[
              ["Channel", row.channel],
              ["Campaign", d.ad?.campaign],
              ["Ad group", d.ad?.adGroup],
              [
                "Keyword",
                d.ad?.keyword && (
                  <>
                    “{d.ad.keyword}”{d.ad.matchType && <span className="text-muted-foreground"> · {d.ad.matchType}</span>}
                  </>
                ),
              ],
              ["Device", d.ad?.device],
              ["Ad showed", d.ad?.position],
              [
                "Landing page",
                row.landingPage && (
                  <a href={row.landingPage} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">
                    {row.landingPath || row.landingPage}
                  </a>
                ),
              ],
              ["Came from", row.referrer],
            ]}
          />
          {d.ad?.fromLink && <p className="mt-2 text-xs text-muted-foreground">Campaign and keyword from the tracking tags on the ad&apos;s link.</p>}
          {d.adNote && <p className="mt-2 text-xs text-muted-foreground">{d.adNote}</p>}
          {d.tracking.length > 0 && (
            <details className="group mt-3">
              <summary className="cursor-pointer list-none text-sm font-medium text-primary hover:underline">
                <span className="group-open:hidden">Show tracking details</span>
                <span className="hidden group-open:inline">Hide tracking details</span>
              </summary>
              <div className="mt-2">
                <Facts items={d.tracking.map(([k, v]) => [k, <span key={k} className="break-all">{v}</span>])} />
              </div>
            </details>
          )}
        </Part>

        <Part title="Google Ads feedback" icon={<Send />}>
          {row.google && (
            <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", googleLabel[row.google.state].cls)}>{googleLabel[row.google.state].text}</span>
          )}
          {d.googleNote && <p className="mt-2 text-sm text-muted-foreground">{d.googleNote}</p>}
          {d.google.map((block) => (
            <div key={block.title} className="mt-2 rounded-xl border p-3">
              <p className="text-sm font-medium">{block.title}</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {block.lines.map((l, i) => (
                  <li key={i} className={cn(l.tone === "good" && "text-emerald-700 dark:text-emerald-400", l.tone === "bad" && "text-destructive")}>
                    {l.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!d.google.length && !d.googleNote && (
            <p className="text-sm text-muted-foreground">
              Nothing sent yet. Interested, Appointment, Offer made and Closed deal are sent to Google Ads; Not interested takes back what was sent.
            </p>
          )}
        </Part>

        <Part title="History" icon={<History />}>
          <ol className="space-y-2.5 border-l pl-4">
            {d.history.map((h, i) => (
              <li key={i} className="relative text-sm">
                <span aria-hidden className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-muted-foreground/50" />
                <p className={cn(h.tone === "good" && "text-emerald-700 dark:text-emerald-400", h.tone === "bad" && "text-destructive")}>
                  {h.text}
                  {h.by && <span className="text-muted-foreground"> · by {h.by}</span>}
                </p>
                <p className="text-xs text-muted-foreground">{h.when}</p>
              </li>
            ))}
          </ol>
        </Part>
      </div>
    </>,
    `Lead: ${row.name}`,
  )
}
