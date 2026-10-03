"use client"

// Alerts page: who gets an email when a new alert opens, from which severity, and a button that
// sends a test email to the addresses in the box (saved or not).

import { useActionState } from "react"
import { LoaderCircle, Mail, Send } from "lucide-react"

import { notifyAction } from "@/app/actions/notify"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Props = {
  enabled: boolean
  emails: string[]
  minSeverity: string
  sender: { email: string; canSend: boolean; source: "connected" | "env" } | null
  personName: string
}

const LEVELS = [
  { value: "critical", label: "Critical only" },
  { value: "high", label: "High and critical" },
  { value: "medium", label: "Medium and up" },
  { value: "info", label: "Every alert" },
]

export default function NotifySettings({ enabled, emails, minSeverity, sender, personName }: Props) {
  const [state, action, pending] = useActionState(notifyAction, {})
  return (
    <form action={action} className="flex flex-col gap-4 text-sm">
      {sender ? (
        sender.canSend ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Mail className="size-4" aria-hidden /> Emails are sent from <strong className="text-foreground">{sender.email}</strong> (the Google
            account connected on Leads → Lead automation).
          </p>
        ) : (
          <p className="rounded-lg bg-amber-50 p-3 text-amber-900">
            DealTrack needs permission to send email from {sender.source === "env" ? "your Google account" : <strong>{sender.email}</strong>}.{" "}
            <a href="/api/conversions/connect" className="font-medium underline underline-offset-4">
              Connect Google again
            </a>{" "}
            and leave every box ticked (it now asks to send email). Then send a test.
          </p>
        )
      ) : (
        <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Google isn&apos;t connected. Check the Google Ads keys in .env.local.</p>
      )}

      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Who gets alert emails</span>
          <textarea
            name="emails"
            defaultValue={emails.join("\n")}
            rows={3}
            placeholder={"name@twinhomebuyer.com\nsomeone.else@gmail.com"}
            className="resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-sm"
          />
          <span className="text-xs text-muted-foreground">One per line, or separated by commas.</span>
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
            <span>Email new alerts</span>
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
          Send test email
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
