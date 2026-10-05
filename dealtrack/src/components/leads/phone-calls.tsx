import { Phone, PhoneMissed } from "lucide-react"

import { formatNumber } from "@/components/dashboard/format"
import CallLeadButton from "@/components/leads/call-lead-button"
import Paged from "@/components/ui/paged"
import type { Call, CallCounting } from "@/lib/google-ads/calls"
import { callIdOf } from "@/lib/leads/call-id"
import { cn } from "@/lib/utils"

type Props = { result: { calls: Call[]; counting?: CallCounting | null } | { error: string } | null; addedCalls?: string[] }

const duration = (s: number) => (s < 60 ? `${s} sec` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} sec` : ""}`.trim())

// "2026-09-29 14:03:11" → "Sep 29, 2:03 PM" (already in the Google Ads account's time zone).
function when(start: string) {
  const [date, time = "00:00:00"] = start.split(" ")
  const d = new Date(`${date}T${time}Z`)
  if (Number.isNaN(d.getTime())) return start
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })
}

// Calls from Google Ads over the last 30 days, missed calls first in the highlights.
export default function PhoneCalls({ result, addedCalls = [] }: Props) {
  const counting = result && "calls" in result ? result.counting : undefined
  const countingPrimary = counting?.filter((c) => c.primary) ?? []
  const calls = result && "calls" in result ? result.calls : []
  const missed = calls.filter((c) => c.missed).length
  const answered = calls.length - missed
  const longCalls = calls.filter((c) => !c.missed && c.seconds >= 60).length

  return (
    <section id="calls" className="scroll-mt-20 rounded-2xl border bg-card shadow-xs">
      <div className="flex items-start gap-3 px-5 pt-5 sm:px-6">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Phone className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold">Phone calls from Google Ads</h2>
          <p className="text-sm text-muted-foreground">
            Last 30 days. Google shows the caller&apos;s area code, not the full number.
          </p>
        </div>
      </div>

      {!result ? (
        <p className="px-5 py-4 text-sm text-muted-foreground sm:px-6">
          Connect Google Ads on the Google Ads page to see calls here.
        </p>
      ) : "error" in result ? (
        <p className="px-5 py-4 text-sm text-destructive sm:px-6">{result.error}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 px-5 pt-4 sm:grid-cols-4 sm:px-6">
            {[
              { label: "Calls", value: calls.length },
              { label: "Missed", value: missed, bad: missed > 0 },
              { label: "Answered", value: answered },
              { label: "Longer than 1 min", value: longCalls },
            ].map((k) => (
              <div
                key={k.label}
                className={cn("rounded-xl border p-3", k.bad && "border-destructive/40 bg-destructive/10 text-destructive")}
              >
                <p className="text-xs">{k.label}</p>
                <p className="text-2xl font-semibold tabular-nums">{formatNumber(k.value)}</p>
              </div>
            ))}
          </div>
          {missed > 0 && (
            <p className="mx-5 mt-3 flex gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive sm:mx-6">
              <PhoneMissed className="mt-0.5 size-4 shrink-0" />
              {missed} call{missed === 1 ? " was" : "s were"} missed. Each one could be a seller: call back from
              the Google Ads call report, and make sure someone answers during ad hours.
            </p>
          )}
          {counting !== undefined && counting !== null && (
            <p className="mx-5 mt-3 rounded-xl bg-muted/60 p-3 text-sm sm:mx-6">
              {counting.length ? (
                <>
                  <strong>Google Ads counts calls on its own:</strong>{" "}
                  {counting.map((c) => `“${c.name}”${c.seconds ? ` (calls of ${c.seconds}+ seconds)` : ""}${c.primary ? "" : " (secondary)"}`).join(", ")}. Calls have
                  no click ID to send back; for a caller who turns into a real seller, click <strong>Add as lead</strong> and type their number,
                  and the app sends it as a qualified lead (and later a closed deal), matched by that phone number.
                  {countingPrimary.length > 0 && (
                    <>
                      {" "}
                      <strong>Watch for double counting:</strong> a call counted by Google and also added here as a lead counts twice for bidding
                      while both are main goals. Keep one of them primary (Google Ads → Goals → Conversions).
                    </>
                  )}
                </>
              ) : (
                <>
                  <strong>Google Ads isn&apos;t counting calls as conversions yet.</strong> Calls have no click ID to send back, so turn it on in
                  Google Ads: <strong>Goals → Conversions → + New conversion action → Phone calls → Calls from ads using call extensions</strong>,
                  count calls of 60 seconds or longer. For a caller who becomes a real seller, also click <strong>Add as lead</strong> below.
                </>
              )}
            </p>
          )}
          {calls.length ? (
            <div className="mt-4">
              <Paged
                noun="calls"
                table={{
                  className: "w-full min-w-[720px] text-sm",
                  bodyClassName: "divide-y tabular-nums",
                  head: (
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr className="border-y">
                        <th className="px-5 py-3 font-medium sm:px-6">When</th>
                        <th className="px-3 py-3 font-medium">Result</th>
                        <th className="px-3 py-3 text-right font-medium">Length</th>
                        <th className="px-3 py-3 font-medium">Area code</th>
                        <th className="px-3 py-3 font-medium">Campaign</th>
                        <th className="px-5 py-3 font-medium sm:px-6">Lead</th>
                      </tr>
                    </thead>
                  ),
                }}
                items={calls.map((c, i) => (
                  <tr key={`${c.start}-${i}`} className={c.missed ? "bg-destructive/5" : undefined}>
                    <td className="px-5 py-3 sm:px-6">{when(c.start)}</td>
                    <td className="px-3 py-3">
                      {c.missed ? (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">Missed</span>
                      ) : (
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">Answered</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">{c.missed ? "–" : duration(c.seconds)}</td>
                    <td className="px-3 py-3">{c.areaCode ? `(${c.areaCode})` : "–"}</td>
                    <td className="px-3 py-3">
                      {c.campaign}
                      <span className="text-xs text-muted-foreground"> · from {c.from === "Website" ? "website" : "ad"}</span>
                    </td>
                    <td className="px-5 py-3 sm:px-6">
                      {c.missed ? (
                        <span className="text-xs text-muted-foreground">–</span>
                      ) : (
                        <CallLeadButton
                          call={{ start: c.start, areaCode: c.areaCode, campaign: c.campaign, seconds: c.seconds }}
                          added={addedCalls.includes(callIdOf(c))}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              />
            </div>
          ) : (
            <div className="px-5 py-4 text-sm text-muted-foreground sm:px-6">
              <p className="font-medium text-foreground">No calls from Google Ads in the last 30 days.</p>
              <p className="mt-1">To track calls, in Google Ads:</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                <li>Open <strong>Admin → Account settings → Call reporting</strong>, turn it on, and save.</li>
                <li>Add your phone number as a <strong>Call asset</strong> (Campaigns → Assets → + → Call).</li>
                <li>
                  For calls from your website&apos;s phone number too: <strong>Goals → Conversions → New → Phone calls → Calls to a
                  number on your website</strong>, and add Google&apos;s snippet to WordPress.
                </li>
              </ol>
            </div>
          )}
        </>
      )}
      <div className="h-4" />
    </section>
  )
}
