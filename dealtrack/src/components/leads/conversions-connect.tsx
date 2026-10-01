"use client"

// Whether DealTrack can send conversions to Google Ads, and the one-time button that allows it.

import { useTransition } from "react"

import { forgetConversionsConnectionAction } from "@/lib/leads/conversion-target-actions"
import { buttonVariants } from "@/components/ui/button"

const RESULTS: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: "Connected. DealTrack can send conversions to Google Ads now." },
  no_permission: { ok: false, text: "Google didn't give the permission to send conversions. Try again and leave every box ticked." },
  expired: { ok: false, text: "That took too long or was opened twice. Click Connect again." },
  failed: { ok: false, text: "Google didn't finish the connection. Click Connect again." },
  cancelled: { ok: false, text: "Cancelled. Nothing changed." },
}

export default function ConversionsConnect({
  admin,
  canSend,
  source,
  connected,
  result,
}: {
  admin: boolean
  canSend: boolean
  source: "connected" | "env" | null
  connected: { email: string; by: string; at: string } | null
  result?: string
}) {
  const [busy, start] = useTransition()
  const message = result ? RESULTS[result] : undefined
  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">Sending to Google Ads</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Good leads go back to Google Ads as conversions through Google&apos;s Data Manager API. It needs one permission DealTrack&apos;s reading key
          doesn&apos;t have; an admin gives it once here.
        </p>
      </div>
      {message && <p className={message.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>{message.text}</p>}
      {source === null ? (
        <p className="text-sm text-destructive">Google Ads isn&apos;t set up: fill in the GOOGLE_ADS_ keys in .env.local first.</p>
      ) : canSend ? (
        <p className="text-sm text-emerald-700">
          Ready to send.{" "}
          {connected ? (
            <>
              Connected as {connected.email} by {connected.by} on{" "}
              {new Date(connected.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.
            </>
          ) : (
            "DealTrack's own Google Ads key already has the permission."
          )}
        </p>
      ) : (
        <p className="text-sm text-amber-800">Not allowed yet: leads that should go to Google Ads wait until an admin connects.</p>
      )}
      {admin && source !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <a href="/api/conversions/connect" className={buttonVariants({ variant: canSend ? "outline" : "default", size: "sm" })}>
            {canSend && connected ? "Connect again" : "Connect Google for conversions"}
          </a>
          {connected && (
            <button
              type="button"
              disabled={busy}
              onClick={() => start(async () => void (await forgetConversionsConnectionAction()))}
              className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
          <span className="text-xs text-muted-foreground">
            Use the Google account you use for Google Ads. Google sends you back to /api/auth/google/callback; if Google says the address isn&apos;t
            allowed, add it under Authorized redirect URIs for DealTrack&apos;s Google client.
          </span>
        </div>
      )}
    </section>
  )
}
