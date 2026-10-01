"use client"

// "This is us": marks an ad visitor's connection as the team's (the office, a VA's home), so its
// clicks stop counting as an attack. Saved in DealTrack only.

import { useState, useTransition } from "react"

import { markNetworkAction, unmarkNetworkAction } from "@/app/actions/fraud"
import { Button } from "@/components/ui/button"
import type { KnownNetwork } from "@/lib/store"

export default function NetworkMark({ network, known, personName }: { network: string; known?: KnownNetwork; personName: string }) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState("")
  const [name, setName] = useState(personName)
  const [message, setMessage] = useState("")
  const [pending, start] = useTransition()

  if (known) {
    return (
      <span className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
        <span>Marked by {known.by}</span>
        <button
          type="button"
          disabled={pending}
          className="font-medium text-primary hover:underline disabled:opacity-50"
          onClick={() => start(async () => setMessage((await unmarkNetworkAction(network)).message))}
        >
          Not ours
        </button>
      </span>
    )
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(true)}>
        This is us
      </Button>
    )
  }

  return (
    <form
      className="flex min-w-48 flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        start(async () => {
          const r = await markNetworkAction(network, label, name)
          setMessage(r.message)
          if (r.ok) setOpen(false)
        })
      }}
    >
      <input
        autoFocus
        autoComplete="off"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Whose? e.g. Manila team"
        aria-label="Whose connection this is"
        className="h-7 rounded-md border border-input bg-background px-2 text-xs"
      />
      {!personName && (
        <input
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
        />
      )}
      <span className="flex gap-1.5">
        <Button type="submit" size="xs" disabled={pending}>
          Save
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
      {message && <span className="text-xs text-destructive">{message}</span>}
    </form>
  )
}
