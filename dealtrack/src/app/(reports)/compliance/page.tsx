import type { Metadata } from "next"

import RequestCard, { type RequestView } from "@/components/compliance/request-card"
import StatusRequestForm from "@/components/compliance/status-request-form"
import { DataTable, PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import { isAdmin } from "@/lib/auth"
import { OVERRIDE_DAYS, getLearning, isOpen, requestStage, requestTitle } from "@/lib/compliance"
import { ACCOUNT_TIME_ZONE } from "@/lib/date-range"
import { getEditableCampaigns } from "@/lib/google-ads/changes"
import { load } from "@/lib/load"
import { currentName } from "@/lib/people"
import { readData, type ChangeRequest } from "@/lib/store"

export const metadata: Metadata = { title: "Compliance · DealTrack" }

const CLOSED_SHOWN = 20

const when = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { timeZone: ACCOUNT_TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : undefined

function view(r: ChangeRequest): RequestView {
  return {
    ...r,
    stage: requestStage(r),
    times: { requested: when(r.requested.at), checked: when(r.checked?.at), approved: when(r.approved?.at), applied: when(r.applied?.at) },
  }
}

export default async function CompliancePage() {
  const [data, campaigns, learning, admin, name] = await Promise.all([
    readData(),
    load(() => getEditableCampaigns()),
    load(() => getLearning()),
    isAdmin(),
    currentName(),
  ])
  const requests = data.changeRequests.map(view)
  const open = requests.filter((r) => isOpen(r))
  const closed = requests.filter((r) => !isOpen(r)).slice(0, CLOSED_SHOWN)
  const learningBy = new Map((learning.ok ? learning.data : []).map((l) => [l.id, l.reason]))

  return (
    <>
      <PageHeader
        title="Compliance"
        description="The brake. Two kinds of change wait for a check and an approval before they reach Google Ads, the same way the weekly negatives and keyword ideas do: turning campaigns on or off, and any change to a campaign while Google's bidding is still learning."
      />

      <section aria-label="Rules" className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border bg-card p-4 text-sm shadow-xs">
          <p className="font-semibold">1. Ads on or off</p>
          <p className="mt-1 text-muted-foreground">
            Turning a campaign on or off resets Google&apos;s learning, so it&apos;s never done in one click. Ask below (or from the budget&apos;s
            pause line); someone checks it, someone approves it, and an admin applies it here.
          </p>
        </div>
        <div className="rounded-2xl border bg-card p-4 text-sm shadow-xs">
          <p className="font-semibold">2. Hands off while Google is learning</p>
          <p className="mt-1 text-muted-foreground">
            Pushing negatives, keyword ideas, or location exclusions to a campaign that&apos;s still learning is held, and an override request appears
            here. Once it&apos;s checked and approved, push again and it goes through once (the approval lasts {OVERRIDE_DAYS} days). Removing a
            negative or exclusion is never held, so a mistake can always be undone.
          </p>
        </div>
      </section>

      <Section
        title="Waiting on someone"
        description={open.length ? "Newest first. Check, then approve, then apply." : undefined}
        actions={open.length ? <Pill tone="violet">{open.length} open</Pill> : undefined}
      >
        {open.length ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {open.map((r) => (
              <RequestCard key={r.id} r={r} admin={admin} personName={name} />
            ))}
          </div>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">Nothing waiting.</p>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Turn ads on or off" description="Files a request. Nothing changes in Google Ads until it's checked, approved, and applied.">
          {campaigns.ok ? (
            <StatusRequestForm
              campaigns={campaigns.data.map((c) => ({ id: c.id, name: c.name, status: c.status, learning: learningBy.get(c.id) }))}
              personName={name}
            />
          ) : (
            <ReportProblem problem={campaigns} />
          )}
        </Section>

        <Section
          title="Learning right now"
          description="Running campaigns whose bidding Google is still learning. Changes to these are held until an override is approved."
        >
          {!learning.ok ? (
            <ReportProblem problem={learning} />
          ) : (
            <DataTable
              rows={learning.data}
              rowKey={(l) => l.id}
              empty="No running campaign is learning. Changes go straight through (on and off still need approval)."
              columns={[
                { key: "name", label: "Campaign", render: (l) => <span className="font-medium">{l.name}</span> },
                { key: "why", label: "Why", render: (l) => <Pill tone="amber">{l.reason}</Pill> },
              ]}
            />
          )}
        </Section>
      </div>

      <Section title="Done and stopped" description={`The last ${CLOSED_SHOWN} requests that were applied, used, stopped, or expired.`}>
        <DataTable
          rows={closed}
          rowKey={(r) => r.id}
          empty="No closed requests yet."
          columns={[
            { key: "what", label: "Request", render: (r) => <span className="font-medium">{requestTitle(r)}</span> },
            {
              key: "stage",
              label: "Outcome",
              render: (r) =>
                r.stage === "done" ? (
                  <span className="flex flex-col gap-0.5">
                    <Pill tone={r.applied?.failures.length ? "red" : "green"}>
                      {r.kind === "status" ? "Applied" : "Went through"}
                      {r.applied?.dryRun ? " (dry run, nothing changed)" : ""}
                    </Pill>
                    {r.applied?.failures.length ? <span className="text-xs text-destructive">{r.applied.failures.join("; ")}</span> : null}
                  </span>
                ) : r.stage === "expired" ? (
                  <Pill>Approval expired</Pill>
                ) : (
                  <Pill tone="red">Stopped</Pill>
                ),
            },
            {
              key: "who",
              label: "Who",
              render: (r) => (
                <span className="text-xs">
                  Asked by {r.requested.by}
                  {r.checked && ` · checked by ${r.checked.by}`}
                  {r.approved && ` · approved by ${r.approved.by}`}
                  {r.applied && ` · applied by ${r.applied.by}`}
                </span>
              ),
            },
            {
              key: "when",
              label: "When",
              render: (r) => (
                <span className="text-xs whitespace-nowrap">{r.times.applied ?? r.times.approved ?? r.times.checked ?? r.times.requested}</span>
              ),
            },
          ]}
        />
      </Section>
    </>
  )
}
