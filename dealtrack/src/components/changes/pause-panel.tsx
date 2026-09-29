"use client"

import { useState } from "react"

import { pauseCampaignsAction } from "@/app/actions/changes"
import { List, useChange, type CampaignOption } from "@/components/changes/shared"
import { Button } from "@/components/ui/button"

// Shown to admins once spend reaches the pause line. Pausing is always a person's decision.
export default function PausePanel({ campaigns }: { campaigns: CampaignOption[] }) {
  const [picked, setPicked] = useState(() => campaigns.map((c) => c.id))
  const { ask, ui, busy } = useChange()
  const names = campaigns.filter((c) => picked.includes(c.id)).map((c) => c.name)

  if (!campaigns.length) return <p className="text-sm text-muted-foreground">No campaigns are running, so there&apos;s nothing to pause.</p>

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">Running campaigns</legend>
        {campaigns.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={picked.includes(c.id)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((p) => p !== c.id))}
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      <div>
        <Button
          type="button"
          variant="destructive"
          disabled={busy || !picked.length}
          onClick={() =>
            ask({
              title: `Pause ${picked.length} campaign${picked.length === 1 ? "" : "s"}?`,
              details: (
                <>
                  <List items={names} />
                  <p className="mt-2">Ads stop showing until someone turns the campaigns back on in Google Ads.</p>
                </>
              ),
              note: "This pauses campaigns in your live Google Ads account. Turn them back on in Google Ads when you're ready; switching ads off and on resets Google's learning, so do it rarely.",
              confirmLabel: "Pause in Google Ads",
              run: () => pauseCampaignsAction(picked),
            })
          }
        >
          Pause {picked.length} campaign{picked.length === 1 ? "" : "s"}
        </Button>
      </div>
      {ui}
    </div>
  )
}
