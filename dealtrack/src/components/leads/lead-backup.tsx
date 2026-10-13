"use client"

import { useActionState, useState, useTransition } from "react"
import { FileSpreadsheet, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import Disclosure from "@/components/ui/disclosure"
import { leadBackupAction, restoreLeadBackupAction } from "@/lib/leads/backup-actions"
import { cn } from "@/lib/utils"

type Props = {
  spreadsheetId?: string
  title?: string
  lastBackup?: string
  lastError?: string
  others?: number // leads in the tab this DealTrack doesn't have: Restore first
  leads?: number
  deleted?: number
  canEdit: boolean // the Google connection may edit spreadsheets
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })

// The lead backup sheet (lib/leads/sheet-backup.ts): DealTrack keeps a "DealTrack leads" tab in it
// up to date, and Restore brings the leads back from it.
export default function LeadBackup({ spreadsheetId, title, lastBackup, lastError, others, leads, deleted, canEdit }: Props) {
  const [state, action, pending] = useActionState(leadBackupAction, undefined)
  const [restoring, startRestore] = useTransition()
  const [restored, setRestored] = useState<{ error?: string; ok?: string }>()
  const link = spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : undefined
  const busy = pending || restoring
  const restore = () => {
    if (
      !window.confirm(
        "Bring back the leads saved in the backup tab that this DealTrack doesn't have? Leads someone has worked on here aren't changed, and deleted leads stay deleted.",
      )
    )
      return
    startRestore(async () => setRestored(await restoreLeadBackupAction()))
  }
  return (
    // Stays open or shut the way you leave it, even when the page refreshes after a backup.
    <Disclosure className="group rounded-2xl border bg-card shadow-xs" initialOpen={!spreadsheetId || Boolean(lastError)}>
      <summary className="flex cursor-pointer list-none items-center gap-3 p-5 sm:px-6">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700">
          <FileSpreadsheet className="size-5" />
        </span>
        <span className="flex flex-col">
          <span className="text-lg font-semibold">Backup to Google Sheets</span>
          <span className={cn("text-sm", lastError ? "font-medium text-destructive" : "text-muted-foreground")}>
            {lastError
              ? "The last backup didn't go through. Click to see why."
              : spreadsheetId
                ? `On: every lead is copied to the “DealTrack leads” tab of “${title ?? "your sheet"}”.`
                : "Off: keep a copy of every lead in your Google Sheet, in case this computer is ever lost."}
          </span>
        </span>
      </summary>
      {/* Only the latest result shows: submitting the form clears Restore's, and Restore's hides the form's. */}
      <form action={action} onSubmit={() => setRestored(undefined)} className="flex flex-col gap-3 border-t px-5 py-5 text-sm sm:px-6">
        <p className="text-muted-foreground">
          DealTrack keeps a <strong>DealTrack leads</strong> tab in your spreadsheet with every lead: contact details, message, status, score,
          where it came from and what Google Ads heard. It&apos;s updated within about a minute of any change, even with no page open, and deleted
          leads stay in it with when they were deleted. If this computer is ever lost, link the same sheet in the new DealTrack and click{" "}
          <strong>Restore</strong>. Your other tabs are never changed.
        </p>
        {!canEdit && (
          <p className="text-amber-800">
            First, an admin clicks <strong>Connect Google for conversions</strong> on{" "}
            <a href="/leads/automation" className="font-medium underline underline-offset-4">
              Automation
            </a>
            : that also lets DealTrack edit spreadsheets.
          </p>
        )}
        {link && (
          <p>
            <a href={link} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-4">
              Open {title ?? "the sheet"}
            </a>
            {lastBackup && !lastError && (
              <span className="text-muted-foreground">
                {" "}
                · backed up {when(lastBackup)}
                {leads !== undefined ? ` · ${leads} lead${leads === 1 ? "" : "s"}${deleted ? `, ${deleted} deleted` : ""}` : ""}
              </span>
            )}
          </p>
        )}
        {lastError && !state && !restored && <p className="font-medium text-destructive">{lastError}</p>}
        <label className="flex flex-col gap-1">
          <span className="font-medium">{spreadsheetId ? "Use a different sheet (optional)" : "Your spreadsheet's link"}</span>
          <input name="sheet" placeholder="https://docs.google.com/spreadsheets/d/…" className="h-11 rounded-lg border bg-card px-3 text-sm" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" className="h-11 px-5" disabled={busy}>
            {pending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            {pending ? "Backing up…" : spreadsheetId ? "Back up now" : "Turn on backup"}
          </Button>
          {spreadsheetId && (
            <Button type="button" variant={others ? "default" : "outline"} size="lg" className="h-11" disabled={busy} onClick={restore}>
              {restoring ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}
              {restoring ? "Restoring…" : "Restore from this sheet"}
            </Button>
          )}
          {spreadsheetId && (
            <Button type="submit" name="disconnect" value="1" variant="ghost" size="lg" className="h-11" disabled={busy}>
              Turn off
            </Button>
          )}
        </div>
        {!restored && state?.error && <p className="font-medium text-destructive">{state.error}</p>}
        {!restored && state?.ok && <p className="font-medium text-emerald-700">{state.ok}</p>}
        {restored?.error && <p className="font-medium text-destructive">{restored.error}</p>}
        {restored?.ok && <p className="font-medium text-emerald-700">{restored.ok}</p>}
      </form>
    </Disclosure>
  )
}
