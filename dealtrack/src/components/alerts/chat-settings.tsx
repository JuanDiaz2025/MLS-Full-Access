"use client"

// Alerts page: the webhook new alerts are posted to (a Zapier "Catch Hook" that sends them on to a
// Google Chat space), from which severity, and a button that sends a test to the address in the box.

import { useActionState } from "react"
import { LoaderCircle, Send } from "lucide-react"

import { chatAction } from "@/app/actions/notify"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Props = {
  enabled: boolean
  url: string
  minSeverity: string
  personName: string
}

const LEVELS = [
  { value: "critical", label: "Critical only" },
  { value: "high", label: "High and critical" },
  { value: "medium", label: "Medium and up" },
  { value: "info", label: "Every alert" },
]

export default function ChatSettings({ enabled, url, minSeverity, personName }: Props) {
  const [state, action, pending] = useActionState(chatAction, {})
  return (
    <form action={action} className="flex flex-col gap-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Webhook URL from Zapier</span>
          <input
            name="url"
            type="url"
            defaultValue={url}
            placeholder="https://hooks.zapier.com/hooks/catch/…"
            autoComplete="off"
            spellCheck={false}
            className="h-9 rounded-lg border border-input bg-background px-2.5 font-mono text-xs"
          />
          <span className="text-xs text-muted-foreground">
            In Zapier: trigger “Webhooks by Zapier → Catch Hook”, action “Google Chat → Send Message”, message text = <code>text</code>.
          </span>
        </label>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Which alerts</span>
            <select name="minSeverity" defaultValue={minSeverity} className="h-9 rounded-lg border border-input bg-background px-2 text-sm">
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="enabled" defaultChecked={enabled} className="size-4" />
            <span>Send new alerts to Google Chat</span>
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!personName && (
          <input
            name="name"
            placeholder="Your name"
            aria-label="Your name"
            className="h-9 w-40 rounded-lg border border-input bg-background px-2 text-sm"
          />
        )}
        {personName && <input type="hidden" name="name" value={personName} />}
        <Button type="submit" name="intent" value="save" disabled={pending}>
          Save
        </Button>
        <Button type="submit" name="intent" value="test" variant="outline" disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}
          Send test
        </Button>
      </div>
      {state.message && (
        <p role="status" className={cn("font-medium", state.ok ? "text-emerald-700" : "text-destructive")}>
          {state.message}
        </p>
      )}
    </form>
  )
}
