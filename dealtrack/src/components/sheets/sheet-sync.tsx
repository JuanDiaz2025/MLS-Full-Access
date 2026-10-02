"use client"

import { useActionState } from "react"
import { FileSpreadsheet, LoaderCircle, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import Disclosure from "@/components/ui/disclosure"
import { sheetAction } from "@/app/actions/sheets"
import { cn } from "@/lib/utils"

type Props = { open?: boolean; spreadsheetId?: string; title?: string; lastSync?: string; lastError?: string; deals?: number; months?: number }

// Linking your Google Sheet: the app keeps a "Google Ads data" tab and a "2024–2026 Combined"
// tab up to date in it.
export default function SheetSync({ open, spreadsheetId, title, lastSync, lastError, deals, months }: Props) {
  const [state, action, pending] = useActionState(sheetAction, undefined)
  const link = spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : undefined
  return (
    // Stays open or shut the way you leave it, even when the page refreshes after a sync.
    <Disclosure className="group rounded-2xl border bg-card shadow-xs" initialOpen={open ?? (!spreadsheetId || Boolean(lastError))}>
      <summary className="flex cursor-pointer list-none items-center gap-3 p-5 sm:px-6">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-700">
          <FileSpreadsheet className="size-5" />
        </span>
        <span className="flex flex-col">
          <span className="text-lg font-semibold">Spreadsheet connection</span>
          <span className={cn("text-sm", lastError ? "font-medium text-destructive" : "text-muted-foreground")}>
            {lastError
              ? "Couldn't update your sheet. Click to see why."
              : spreadsheetId
                ? `Keeping “${title ?? "your sheet"}” up to date: Google Ads results and your 2024–2026 deals in one place.`
                : "Put your Google Ads results and your 2024–2026 deals together in your Google Sheet."}
          </span>
        </span>
      </summary>
      <form action={action} className="flex flex-col gap-3 border-t px-5 py-5 text-sm sm:px-6">
        <p className="text-muted-foreground">
          DealTrack adds two tabs to your spreadsheet and keeps them up to date (every 6 hours while DealTrack is open, or when you click
          Sync now): <strong>Google Ads data</strong> (spend, clicks and conversions per campaign per month since January 2024) and{" "}
          <strong>2024–2026 Combined</strong> (every deal from your year tabs in one list, with ad spend per deal and return on ad spend by
          year and by campaign). Your other tabs are never changed.
        </p>
        {link && (
          <p>
            <a href={link} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-4">
              Open {title ?? "the sheet"}
            </a>
            {lastSync && !lastError && (
              <span className="text-muted-foreground">
                {" "}
                · updated {new Date(lastSync).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                {deals !== undefined ? ` · ${deals} deals, ${months} campaign-months` : ""}
              </span>
            )}
          </p>
        )}
        {lastError && !state && <p className="font-medium text-destructive">{lastError}</p>}
        <label className="flex flex-col gap-1">
          <span className="font-medium">{spreadsheetId ? "Use a different sheet (optional)" : "Your spreadsheet's link"}</span>
          <input name="sheet" placeholder="https://docs.google.com/spreadsheets/d/…" className="h-11 rounded-lg border bg-card px-3 text-sm" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="lg" className="h-11 px-5" disabled={pending}>
            {pending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            {pending ? "Updating your sheet…" : spreadsheetId ? "Sync now" : "Connect and sync"}
          </Button>
          {spreadsheetId && (
            <Button type="submit" name="disconnect" value="1" variant="outline" size="lg" className="h-11" disabled={pending}>
              Disconnect
            </Button>
          )}
          <a href="/api/conversions/connect" className="inline-flex items-center px-2 text-primary underline underline-offset-4">
            Connect Google again (if it asks for permission)
          </a>
        </div>
        {state?.error && <p className="font-medium text-destructive">{state.error}</p>}
        {state?.ok && <p className="font-medium text-emerald-700">{state.ok}</p>}
      </form>
    </Disclosure>
  )
}
