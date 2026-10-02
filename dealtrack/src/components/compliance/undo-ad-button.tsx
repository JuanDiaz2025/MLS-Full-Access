"use client"

// On an applied ad edit: files a request to put the old text back (checked and approved too).

import { useState, useTransition } from "react"
import { Undo2 } from "lucide-react"

import { undoAdEditAction } from "@/app/actions/ads"
import { Button } from "@/components/ui/button"

export default function UndoAdButton({ id, personName }: { id: string; personName: string }) {
  const [name, setName] = useState(personName)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5">
        {!personName && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            aria-label="Your name"
            className="h-7 w-28 rounded-md border border-input bg-background px-2 text-xs"
          />
        )}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const res = await undoAdEditAction(id, name)
              setMessage({ ok: res.ok, text: res.message })
            })
          }
        >
          <Undo2 data-icon="inline-start" /> Put the old text back
        </Button>
      </span>
      {message && <span className={message.ok ? "text-xs text-emerald-700" : "text-xs text-destructive"}>{message.text}</span>}
    </span>
  )
}
