import type { Metadata } from "next"
import { Download } from "lucide-react"

import { formatNumber } from "@/components/dashboard/format"
import LeadsTable, { type LeadRow } from "@/components/leads/leads-table"
import LiveRefresh from "@/components/leads/live-refresh"
import PhoneCalls from "@/components/leads/phone-calls"
import WebhookSetup from "@/components/leads/webhook-setup"
import { KpiGrid, PageHeader, Section } from "@/components/report"
import { buttonVariants } from "@/components/ui/button"
import { getCalls } from "@/lib/google-ads/calls"
import { leadSource } from "@/lib/leads/source"
import { listLeads, listQrCodes } from "@/lib/leads/store"
import { countSince } from "@/lib/leads/time"
import { leadChannel, pagePath } from "@/lib/leads/tracking"
import type { Lead } from "@/lib/leads/types"
import { load } from "@/lib/load"

export const metadata: Metadata = { title: "Leads · DealTrack" }

// One spreadsheet row per lead, with the date in the account's time zone.
function toRow(lead: Lead, placements: Map<string, string>): LeadRow {
  const t = lead.tracking ?? {}
  return {
    id: lead.id,
    receivedAt: lead.createdAt,
    received: new Date(lead.createdAt).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
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
    utmContent: t.utmContent,
    gclid: t.gclid,
    landingPage: t.landingPage && /^https?:\/\//.test(t.landingPage) ? t.landingPage : undefined,
    landingPath: pagePath(t.landingPage),
    referrer: t.referrer,
    notes: lead.notes,
  }
}

export default async function LeadsPage() {
  const [qrCodes, leads, calls] = await Promise.all([listQrCodes(), listLeads(), load(() => getCalls(30))])
  const placements = new Map(qrCodes.map((c) => [c.id, c.placement]))
  const callResult = calls.ok ? { calls: calls.data } : { error: calls.kind === "missing" ? "Google Ads isn't connected." : calls.message }
  const missed = calls.ok ? calls.data.filter((c) => c.missed).length : 0

  return (
    <>
      <PageHeader
        title="Leads"
        description="Every lead from the website forms as it comes in (sent by WordPress), with where it came from, plus phone calls from Google Ads. The page updates on its own every few seconds. Leads are saved on this computer."
      />
      <div className="-mt-2 flex flex-wrap items-center gap-3">
        {leads.length > 0 && (
          <a href="/leads/export" className={buttonVariants({ variant: "outline" })}>
            <Download data-icon="inline-start" />
            Export CSV
          </a>
        )}
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
          Live: new leads appear on their own
        </span>
      </div>

      <KpiGrid
        items={[
          { label: "Form leads, last 7 days", value: formatNumber(countSince(leads, 7)) },
          { label: "Form leads, last 30 days", value: formatNumber(countSince(leads, 30)) },
          { label: "Form leads, all time", value: formatNumber(leads.length) },
          { label: "Ad calls, last 30 days", value: calls.ok ? formatNumber(calls.data.length) : "—", note: calls.ok ? undefined : "Google Ads not reachable" },
          { label: "Missed calls", value: calls.ok ? formatNumber(missed) : "—", tone: missed ? "bad" : "default" },
          { label: "Calls of 60s+", value: calls.ok ? formatNumber(calls.data.filter((c) => !c.missed && c.seconds >= 60).length) : "—" },
        ]}
      />

      <Section title="All leads" description="Search, filter by channel, and open a lead's landing page. Export CSV includes every column.">
        {leads.length ? (
          <LeadsTable rows={leads.map((l) => toRow(l, placements))} />
        ) : (
          <p className="py-6 text-sm text-muted-foreground">No leads yet. Connect the website form below.</p>
        )}
      </Section>

      <PhoneCalls result={callResult} />

      <WebhookSetup websiteLeads={leads.filter((l) => !l.qrCodeId).length} />
      <LiveRefresh />
    </>
  )
}
