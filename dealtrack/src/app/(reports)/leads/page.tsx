import type { Metadata } from "next"
import { after } from "next/server"
import { CircleCheck, Download, TriangleAlert } from "lucide-react"

import { formatNumber } from "@/components/dashboard/format"
import LeadBackup from "@/components/leads/lead-backup"
import LeadsTable, { type LeadRow } from "@/components/leads/leads-table"
import LiveRefresh from "@/components/leads/live-refresh"
import PhoneCalls from "@/components/leads/phone-calls"
import ScoringGuide from "@/components/leads/scoring-guide"
import ScoringGuideTab from "@/components/leads/scoring-guide-tab"
import SendingCheck from "@/components/leads/sending-check"
import WebhookSetup from "@/components/leads/webhook-setup"
import { KpiGrid, PageHeader, Section } from "@/components/report"
import { buttonVariants } from "@/components/ui/button"
import { DATA_MANAGER_LIBRARY } from "@/lib/conversions/data-manager"
import { getConnection, SHEETS_SCOPE } from "@/lib/conversions/google"
import { callCounting, getCalls, RECENT_CALL_DAYS } from "@/lib/google-ads/calls"
import { leadSource } from "@/lib/leads/source"
import { catchUp, leadsVersion } from "@/lib/leads/background"
import { callLeads } from "@/lib/leads/call-id"
import { leadDetail } from "@/lib/leads/panel"
import { getLeadBackup } from "@/lib/leads/sheet-backup"
import { listDeletedLeads, listLeads, listQrCodes } from "@/lib/leads/store"
import { sharedKey, type Sender } from "@/lib/leads/team-sync"
import { countSince, timeAgo } from "@/lib/leads/time"
import { takeBackFrom } from "@/lib/leads/status"
import { cleanTracking, leadChannel, pagePath, testClick } from "@/lib/leads/tracking"
import type { Lead, LeadPlace } from "@/lib/leads/types"
import { getWordPress, sentElsewhere } from "@/lib/leads/wordpress"
import { siteKeepsNotes } from "@/lib/leads/wordpress-plugin"
import { load } from "@/lib/load"
import { personName } from "@/lib/people"

export const metadata: Metadata = { title: "Leads · DealTrack" }

// A date in the account's time zone, e.g. "Oct 9, 2026, 3:35 PM".
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

// One spreadsheet row per lead. `elsewhere` is the team's computer that sends website leads to
// Google Ads, when it isn't this one.
function toRow(lead: Lead, placements: Map<string, string>, elsewhere: Sender | null): LeadRow {
  const t = cleanTracking(lead.tracking) ?? {}
  return {
    id: lead.id,
    receivedAt: lead.createdAt,
    received: when(lead.createdAt),
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    address: lead.propertyAddress,
    channel: leadChannel(lead),
    form: leadSource(lead, placements).replace(/^Website( · )?/, ""),
    utmSource: t.utmSource,
    utmMedium: t.utmMedium,
    utmCampaign: t.utmCampaign,
    utmTerm: t.utmTerm,
    gclid: t.gclid || t.gbraid || t.wbraid,
    landingPage: t.landingPage && /^https?:\/\//.test(t.landingPage) ? t.landingPage : undefined,
    landingPath: pagePath(t.landingPage),
    referrer: t.referrer,
    notes: lead.notes,
    place: placeRow(lead.place),
    status: lead.status ?? "new",
    statusBy: lead.statusBy,
    statusRule: lead.statusRule,
    statusByName: lead.statusByName,
    score: lead.score,
    google:
      elsewhere && sharedKey(lead)
        ? // New, or Unresponsive with nothing for Google Ads: nothing to say.
          lead.status && lead.status !== "new" && (lead.status !== "unresponsive" || Object.keys(lead.conversions ?? {}).length)
          ? { state: "elsewhere", detail: `Google Ads hears about it from ${elsewhere.name || "your team's main computer"}.` }
          : undefined
        : googleState(lead),
    detail: leadDetail(lead, Boolean(sharedKey(lead)), elsewhere),
  }
}

// Roughly where they were (location.ts): Google's place for the ad click first, PostHog's city
// for the visit too when it's another one.
function placeRow(p?: LeadPlace): LeadRow["place"] {
  const main = p?.google ?? p?.posthog
  if (!p || !main) return undefined
  const town = (s?: string) => s?.replace(/ \d{5}$/, "").toLowerCase()
  const agree = Boolean(p.google && p.posthog && town(p.google) === town(p.posthog))
  return {
    text: main,
    source: p.google ? (agree ? "Google Ads click · PostHog" : "Google Ads click") : "PostHog (internet connection)",
    other: p.google && p.posthog && !agree ? p.posthog : undefined,
    about: p.googleInterest,
  }
}

// One line on what Google Ads has heard about this lead, for the table.
function googleState(lead: Lead): LeadRow["google"] {
  const main = mainGoogleState(lead)
  // A test of the website's form: nothing about it goes to Google (a take-back still going on shows).
  const typed = testClick(lead.tracking)
  if (typed && !(main && ["retracting", "retract_failed"].includes(main.state))) {
    return { state: "test", detail: `A test lead (its click ID is “${typed}”), so nothing about it goes to Google Ads.` }
  }
  // Reported as an invalid lead (reporting only): say so when nothing else is going on with it.
  const invalid = lead.conversions?.invalid
  if (!invalid || invalid.retraction || (main && !["retracted", "untaken", "retracting", "held"].includes(main.state))) return main
  const also = main?.state === "retracted" ? "Its earlier conversion was taken back. " : main?.state === "untaken" ? "Google never counted its earlier conversion. " : ""
  if (invalid.state === "sent") return { state: "invalid", detail: `${also}Reporting only: Google won't bid for leads like this, and its reports show which ads bring them.` }
  if (invalid.state === "pending") return { state: "invalid_pending", detail: `${also}Reporting it to Google as an invalid lead (reporting only).` }
  return main ?? { state: invalid.state === "failed" ? "failed" : "skipped", detail: invalid.error }
}

function mainGoogleState(lead: Lead): LeadRow["google"] {
  const { invalid: _invalid, ...rest } = lead.conversions ?? {}
  void _invalid
  // (A parked entry only keeps a resend id; there's nothing to show for it.)
  const all = Object.values(rest).filter((c) => !c?.parked)
  // Taken back (or being taken back) because the lead turned out Not interested.
  const backs = all.map((c) => c?.retraction).filter(Boolean)
  if (backs.length) {
    const failed = backs.find((r) => r!.state === "failed")
    if (failed) return { state: "retract_failed", detail: failed.error }
    const why = lead.status === "new" ? "Put back as New" : "Not interested"
    const waiting = all.find((c) => c?.retraction?.state === "pending")
    if (waiting) {
      return {
        state: "retracting",
        detail: Date.now() < takeBackFrom(waiting)
          ? `${why}: Google only takes a conversion back a day after it got it, so DealTrack tells it then.`
          : `${why}: telling Google to stop counting it.`,
      }
    }
    if (backs.every((r) => r!.state === "none")) return { state: "untaken", detail: `${why}: Google never counted it, so there was nothing to take back.` }
    return { state: "retracted", detail: `${why}: Google no longer counts it as a good lead.` }
  }
  if (!all.length) return lead.googleBlockedBy ? { state: "held", detail: `Not sent: rule “${lead.googleBlockedBy}”` } : undefined
  const order = ["failed", "pending", "skipped", "sent"] as const
  const worst = order.find((s) => all.some((c) => c?.state === s))!
  const entry = all.find((c) => c?.state === worst)!
  // Once Google has checked what it was sent, say what it decided.
  const decided = all.map((c) => c?.google).filter(Boolean)
  if (worst === "sent" && decided.some((g) => g!.status === "rejected")) {
    return { state: "rejected", detail: `Google: ${decided.find((g) => g!.status === "rejected")!.reason}` }
  }
  if (worst === "sent" && decided.length && decided.every((g) => g!.status === "accepted")) {
    return { state: "accepted", detail: decided.map((g) => g!.reason).filter(Boolean).join("; ") || "Google counts it. It shows in Google Ads under the date of the ad click." }
  }
  // Google is asked for 3 days; after that it's simply sent (Google took it in and never objected).
  if (worst === "sent" && all.some((c) => c?.requestId && Date.now() - Date.parse(c.lastTry ?? c.at) < 3 * 86_400_000)) {
    const asked = all
      .map((c) => c?.google)
      .filter(Boolean)
      .sort((a, b) => b!.checkedAt.localeCompare(a!.checkedAt))[0]
    const at = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    const sentAt = all
      .map((c) => c?.lastTry ?? c?.at)
      .filter(Boolean)
      .sort()
      .at(-1)
    const progress = asked
      ? asked.reason
        ? ` Last asked ${at(asked.checkedAt)}: ${asked.reason}. The app tries again every 30 minutes.`
        : ` Last asked ${at(asked.checkedAt)}: still checking. The app asks again every 30 minutes.`
      : sentAt
        ? ` Sent ${at(sentAt)}. The app first asks Google 30 minutes after sending.`
        : ""
    return { state: "checking", detail: `Google has it and is checking it (30 minutes to 24 hours). This is normal.${progress}` }
  }
  const why = [entry.rule && `Rule “${entry.rule}”`, entry.value !== undefined && entry.value !== 1 && `worth $${entry.value}`].filter(Boolean).join(", ")
  return { state: worst, detail: entry.error ?? ([why, entry.matchedBy && `matched by ${entry.matchedBy}`].filter(Boolean).join(" · ") || undefined) }
}

export default async function LeadsPage() {
  // New leads from the WordPress site (checked at most every 30 seconds) and conversions for Google
  // Ads are handled after the page is sent, so it never waits on them; the page updates itself
  // when they change anything (LiveRefresh).
  after(() => catchUp())
  // The version first: a change saved while the leads are read then still shows on the next check.
  const version = await leadsVersion()
  const [qrCodes, leads, deleted, calls, counting, backup, connection, site, you] = await Promise.all([
    listQrCodes(),
    listLeads(),
    listDeletedLeads(),
    load(() => getCalls(RECENT_CALL_DAYS)),
    callCounting().catch(() => null),
    getLeadBackup(),
    getConnection().catch(() => null),
    getWordPress(),
    personName(),
  ])
  // Whether the lead panel's notes reach the team's other computers (Lead Saver plugin 1.5+).
  const sharing = !site.site ? "off" : siteKeepsNotes(site.plugin) ? "on" : "needs-plugin"
  const placements = new Map(qrCodes.map((c) => [c.id, c.placement]))
  const callResult = calls.ok ? { calls: calls.data, counting } : { error: calls.kind === "missing" ? "Google Ads isn't connected." : calls.message }
  const missed = calls.ok ? calls.data.filter((c) => c.missed).length : 0
  // Another computer on the team sends the website leads to Google Ads: their Google Ads state is
  // that computer's to show, not this one's.
  const elsewhere = await sentElsewhere()
  const ownSending = elsewhere ? leads.filter((l) => !sharedKey(l)) : leads
  // Conversions held back by a set-up step Google needs, so the page can say what to do.
  const waiting = ownSending.flatMap((l) => Object.values(l.conversions ?? {})).filter((c) => c?.state === "pending" && c.waitingFor)
  // Leads Google Ads hasn't taken yet (failed, or still waiting after a try), and the latest reason.
  const stuckEntries = ownSending
    .flatMap((l) => Object.values(l.conversions ?? {}))
    .filter((c) => c && (c.state === "failed" || (c.state === "pending" && c.lastTry)))
  const lastError = stuckEntries.sort((a, b) => (b!.lastTry ?? "").localeCompare(a!.lastTry ?? ""))[0]?.error

  return (
    <>
      <PageHeader
        title="Leads"
        description="Every lead from the website forms as it comes in (from WordPress), scored the moment it arrives, with where it came from, plus taps on the website's phone number (from PostHog) and phone calls from Google Ads. Good leads are sent back to Google Ads as conversions, so its bidding learns which clicks bring real sellers. The page updates on its own every few seconds. Leads are saved on this computer."
      />
      <div className="-mt-2 flex flex-wrap items-center gap-3">
        {leads.length > 0 && (
          <a href="/leads/export" className={buttonVariants({ variant: "outline" })}>
            <Download data-icon="inline-start" />
            Export CSV
          </a>
        )}
        <a href="/leads/automation" className={buttonVariants({ variant: "outline" })}>
          Automation: scoring and what Google hears
        </a>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
          Live: new leads appear on their own
        </span>
        {backup.spreadsheetId && (
          <a
            href="#lead-backup"
            className={
              backup.lastError
                ? "inline-flex items-center gap-1.5 text-xs font-medium text-destructive hover:underline"
                : "inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            }
          >
            {backup.lastError ? <TriangleAlert className="size-3.5" aria-hidden /> : <CircleCheck className="size-3.5 text-emerald-600" aria-hidden />}
            {backup.lastError
              ? "Backup to Google Sheets isn't working"
              : `Backed up to Google Sheets${backup.lastBackup ? ` ${timeAgo(backup.lastBackup)}` : ""}`}
          </a>
        )}
      </div>

      {waiting.length > 0 && (
        <section className="rounded-2xl border-2 border-amber-500/50 bg-amber-500/10 p-5 text-amber-950">
          <h2 className="text-lg font-semibold">
            {waiting.length} conversion{waiting.length === 1 ? " is" : "s are"} waiting to go to Google Ads
          </h2>
          <p className="mt-1">
            Google takes offline conversions through its Data Manager API. Two one-time steps, then they&apos;re sent by themselves within a
            few minutes:
          </p>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            <li>
              <strong>Turn on the Data Manager API:</strong> open{" "}
              <a href={DATA_MANAGER_LIBRARY} target="_blank" rel="noreferrer" className="font-medium underline">
                the Data Manager API page in Google Cloud
              </a>{" "}
              in the project of DealTrack&apos;s Google client (GOOGLE_ADS_CLIENT_ID), and click <strong>Enable</strong>.
            </li>
            <li>
              <strong>Allow it in DealTrack:</strong> an admin opens{" "}
              <a href="/leads/automation" className="font-medium underline">
                Automation
              </a>{" "}
              and clicks <strong>Connect Google for conversions</strong>, with the account you use for Google Ads, leaving every box ticked.
            </li>
          </ol>
        </section>
      )}

      <KpiGrid
        items={[
          { label: "Form leads, last 7 days", value: formatNumber(countSince(leads, 7)) },
          { label: "Form leads, last 30 days", value: formatNumber(countSince(leads, 30)) },
          { label: "Form leads, all time", value: formatNumber(leads.length) },
          { label: `Ad calls, last ${RECENT_CALL_DAYS} days`, value: calls.ok ? formatNumber(calls.data.length) : "—", note: calls.ok ? undefined : "Google Ads not reachable" },
          { label: "Missed calls", value: calls.ok ? formatNumber(missed) : "—", tone: missed ? "bad" : "default" },
          { label: "Calls of 60s+", value: calls.ok ? formatNumber(calls.data.filter((c) => !c.missed && c.seconds >= 60).length) : "—" },
        ]}
      />

      <Section
        title="All leads"
        description={
          <>
            Every lead is scored and good ones are sent to Google Ads automatically. Set a lead&apos;s <strong>Status</strong> as you work it:{" "}
            <strong>Interested</strong> and <strong>Closed deal</strong> are sent to Google Ads too, and <strong>Not interested</strong> takes
            back what was sent.
          </>
        }
      >
        {stuckEntries.length > 0 && <SendingCheck stuck={stuckEntries.length} lastError={lastError} />}
        {leads.length || deleted.length ? (
          <LeadsTable
            rows={leads.map((l) => toRow(l, placements, elsewhere))}
            deleted={deleted.map((d) => ({ ...toRow(d.lead, placements, elsewhere), deleted: when(d.deletedAt) }))}
            you={you}
            sharing={sharing}
          />
        ) : (
          <p className="py-6 text-sm text-muted-foreground">No leads yet. Connect the website form below.</p>
        )}
      </Section>

      <PhoneCalls result={callResult} addedCalls={callLeads(leads)} />

      <div id="lead-backup" className="scroll-mt-20">
        <LeadBackup
          spreadsheetId={backup.spreadsheetId}
          title={backup.title}
          lastBackup={backup.lastBackup}
          lastError={backup.lastError}
          others={backup.others}
          leads={backup.leads}
          deleted={backup.deleted}
          canEdit={Boolean(connection?.scopes.includes(SHEETS_SCOPE))}
        />
      </div>

      <WebhookSetup websiteLeads={leads.filter((l) => !l.qrCodeId).length} />
      {/* On the left edge of the screen, wherever you are on the page. */}
      <ScoringGuideTab>
        <ScoringGuide />
      </ScoringGuideTab>
      <LiveRefresh version={version} />
    </>
  )
}
