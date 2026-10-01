"use client"

// Step 4: an admin sends a batch's approved lines to Google Ads in one change, to the chosen
// campaigns or into the shared list attached to them. The brake allows one push a week.

import { useState } from "react"

import { pushNegativeBatchAction } from "@/app/actions/changes"
import { CampaignPicker, List, runningIds, useChange } from "@/components/changes/shared"
import { useWorkspace } from "@/components/negatives/context"
import type { BatchView, Shared } from "@/components/negatives/parts"
import { Button } from "@/components/ui/button"

export default function PushPanel({ batch: b, shared }: { batch: BatchView; shared: Shared }) {
  const { campaigns, admin, adminLink, brakeNote, dryRun, listName } = shared
  const { name } = useWorkspace()
  const approved = b.items.filter((i) => i.proven && i.approved)
  const lines = approved.map((l) => l.negative)
  const known = new Set(campaigns.map((c) => c.id))
  const sources = [...new Set(approved.flatMap((i) => i.campaigns?.map((c) => c.id) ?? []))].filter((id) => known.has(id))
  const running = runningIds(campaigns)
  // A batch from one campaign goes back to it; a standard batch to the campaigns it was drafted for.
  const [picked, setPicked] = useState(() =>
    b.kind === "standard" && sources.length ? sources : b.campaignId && known.has(b.campaignId) ? [b.campaignId] : running,
  )
  const [toList, setToList] = useState(b.kind === "standard")
  const pick = (ids: string[]) => setPicked([...new Set(ids)])
  const { ask, ui, busy } = useChange()
  const sameName = b.proven?.by && b.approved?.by && b.proven.by.toLowerCase() === b.approved.by.toLowerCase()
  const s = (n: number) => (n === 1 ? "" : "s")

  if (brakeNote) return <p className="text-sm">{brakeNote}</p>
  if (!admin) {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p className="text-muted-foreground">An admin pushes the {lines.length} approved lines.</p>
        {adminLink}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {sameName && <p className="text-xs text-amber-900">The same person reviewed and approved this batch. A second person usually approves.</p>}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-muted-foreground">
          Competitor names and places outside California belong on every campaign you run, and on any you turn back on. A word line belongs where its
          searches came from (under each line).
        </p>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <PickButton label={`Running campaigns (${running.length})`} onClick={() => pick(running)} />
          {sources.length > 0 && <PickButton label={`Where the searches came from (${sources.length})`} onClick={() => pick(sources)} />}
          {sources.length > 0 && running.length > 0 && (
            <PickButton label={`Both (${new Set([...running, ...sources]).size})`} onClick={() => pick([...running, ...sources])} />
          )}
        </div>
      </div>
      <CampaignPicker campaigns={campaigns} selected={picked} onChange={setPicked} idPrefix={`push-${b.id}`} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" autoComplete="off" checked={toList} onChange={(e) => setToList(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
        <span>
          Put them in the shared list &ldquo;{listName}&rdquo; and attach it to the chosen campaigns
          <span className="block text-xs text-muted-foreground">
            Instead of adding them to each campaign. The list is created the first time; a campaign you attach it to later gets every negative in it.
          </span>
        </span>
      </label>
      <div>
        <Button
          type="button"
          disabled={busy || !picked.length}
          onClick={() =>
            ask({
              title: toList
                ? `Add ${lines.length} negative keyword${s(lines.length)} to "${listName}" and attach it to ${picked.length} campaign${s(picked.length)}?`
                : `Add ${lines.length} negative keyword${s(lines.length)} to ${picked.length} campaign${s(picked.length)}?`,
              details: <List items={lines.map((l) => `"${l}" (phrase)`)} />,
              note: dryRun
                ? "Dry run is on (DEALTRACK_VALIDATE_ONLY=1): Google checks the change and applies nothing."
                : "This changes your live Google Ads account. Remove a negative later from the Search terms page if it blocks something good.",
              confirmLabel: "Push to Google Ads",
              run: () => pushNegativeBatchAction(b.id, picked, name, toList),
            })
          }
        >
          Push {lines.length} negative{s(lines.length)}
        </Button>
      </div>
      {ui}
    </div>
  )
}

function PickButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full border bg-background px-2.5 py-0.5 font-medium hover:bg-muted">
      {label}
    </button>
  )
}
