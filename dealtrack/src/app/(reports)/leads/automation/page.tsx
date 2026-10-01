import type { Metadata } from "next"
import Link from "next/link"

import ConversionsConnect from "@/components/leads/conversions-connect"
import ConversionTargets from "@/components/leads/conversion-targets"
import RulesEditor from "@/components/leads/rules-editor"
import ScoringSettings from "@/components/leads/scoring-settings"
import SendingCheck from "@/components/leads/sending-check"
import { PageHeader } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { connectionInfo, getConnection, DATA_MANAGER_SCOPE } from "@/lib/conversions/google"
import { loadTargets, recentLeads } from "@/lib/leads/automation-data"
import { getRules } from "@/lib/leads/rules-store"
import { getScoringSettings } from "@/lib/leads/scoring"
import { listLeads } from "@/lib/leads/store"
import { leadChannel } from "@/lib/leads/tracking"

export const metadata: Metadata = { title: "Lead automation · DealTrack" }

// The automation behind the Leads page (ported from One Marketing Command Center): how leads are
// scored, the Google Ads rules, where conversions go, and the connection that sends them.
// Everything here runs whether this page is open or not. Admins change it; everyone can look.
export default async function AutomationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const [leads, scoring, rules, targets, admin, connected, connection] = await Promise.all([
    listLeads(),
    getScoringSettings(),
    getRules(),
    loadTargets(),
    isAdmin(),
    connectionInfo(),
    getConnection().catch(() => null),
  ])
  const channels = [...new Set(leads.map((l) => leadChannel(l)))].sort()
  const canSend = Boolean(connection?.scopes.includes(DATA_MANAGER_SCOPE))
  return (
    <>
      <PageHeader
        title="Lead automation"
        description="How leads are scored and what Google Ads hears about them. This runs by itself; change it only if you want to."
      />
      <p className="-mt-2 text-sm">
        <Link href="/leads" className="font-medium text-primary hover:underline">
          ← Back to Leads
        </Link>
      </p>
      <ConversionsConnect
        admin={admin}
        canSend={canSend}
        source={connection?.source ?? null}
        connected={connected ? { email: connected.email, by: connected.by, at: connected.connectedAt } : null}
        result={typeof params.connect === "string" ? params.connect : undefined}
      />
      {!admin && <p className="text-sm text-muted-foreground">Only admins can change these settings. Sign in as an admin to edit them.</p>}
      <ScoringSettings autoStatus={scoring.autoStatus} />
      <RulesEditor initial={rules} recent={recentLeads(leads)} channels={channels} enabled={scoring.autoStatus} />
      {targets && <ConversionTargets view={targets} />}
      <div className="mt-2">
        <SendingCheck stuck={0} />
      </div>
    </>
  )
}
