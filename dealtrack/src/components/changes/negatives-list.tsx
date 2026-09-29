"use client"

import { removeNegativesAction } from "@/app/actions/changes"
import { useChange } from "@/components/changes/shared"
import { Button } from "@/components/ui/button"

export type NegativeItem = { resourceName: string; label: string; campaignName: string }

// What's currently blocked in Google Ads, with Remove to undo. Viewers see the list only.
export default function NegativesList({
  items,
  canEdit,
  empty,
  noun,
}: {
  items: NegativeItem[]
  canEdit: boolean
  empty: string
  noun: string // "negative keyword", "location exclusion"
}) {
  const { ask, ui, busy } = useChange()

  if (!items.length) return <p className="py-2 text-sm text-muted-foreground">{empty}</p>

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y rounded-xl border">
        {items.map((item) => (
          <li key={item.resourceName} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="flex flex-col">
              <span className="font-medium">{item.label}</span>
              <span className="text-xs text-muted-foreground">{item.campaignName}</span>
            </span>
            {canEdit && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  ask({
                    title: `Remove this ${noun}?`,
                    details: (
                      <p>
                        {item.label} from {item.campaignName}. Ads can show for it again.
                      </p>
                    ),
                    confirmLabel: "Remove from Google Ads",
                    run: () => removeNegativesAction([item.resourceName]),
                  })
                }
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {ui}
    </div>
  )
}
