"use client"

import { useState } from "react"
import { Plus, X } from "lucide-react"

import { updateAdTextAction } from "@/app/actions/controls"
import { List, useChange } from "@/components/changes/shared"
import { formatConversions, formatNumber, formatUsd } from "@/components/dashboard/format"
import { Button } from "@/components/ui/button"
import { DESCRIPTION_PINS, HEADLINE_PINS, LIMITS, adTextLength, cleanAdText, type AdText } from "@/lib/ad-text"
import type { SearchAd } from "@/lib/google-ads/controls"
import { cn } from "@/lib/utils"

const pinLabel = (pin?: string) => (pin ? pin.replace("HEADLINE_", "Headline ").replace("DESCRIPTION_", "Description ") : "")
const approvalTone: Record<string, string> = {
  APPROVED: "bg-emerald-100 text-emerald-800",
  APPROVED_LIMITED: "bg-amber-100 text-amber-800",
  DISAPPROVED: "bg-red-100 text-red-800",
}
const label = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replaceAll("_", " ") : "Unknown")

// One responsive search ad: its text and results, with an editor for admins.
export default function AdCard({ ad, canEdit }: { ad: SearchAd; canEdit: boolean }) {
  const change = useChange()
  const [editing, setEditing] = useState(false)

  return (
    <article className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">{ad.adGroup}</span>
          {ad.finalUrl && (
            <span className="truncate text-xs text-muted-foreground">
              {ad.finalUrl}
              {ad.path ? ` · /${ad.path}` : ""}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", ad.status === "ENABLED" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800")}>
            {ad.status === "ENABLED" ? "On" : label(ad.status)}
          </span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", approvalTone[ad.approval] ?? "bg-muted text-muted-foreground")}>
            {label(ad.approval)}
          </span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {formatNumber(ad.metrics.impressions)} impressions · {formatNumber(ad.metrics.clicks)} clicks · {formatUsd(ad.metrics.cost)} spend ·{" "}
        {formatConversions(ad.metrics.conversions)} conversions
      </p>

      {editing ? (
        <Editor ad={ad} change={change} onDone={() => setEditing(false)} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <TextList title={`Headlines (${ad.headlines.length})`} items={ad.headlines} />
            <TextList title={`Descriptions (${ad.descriptions.length})`} items={ad.descriptions} />
          </div>
          {canEdit && (
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={change.busy} onClick={() => setEditing(true)}>
              Edit text
            </Button>
          )}
        </>
      )}
      {change.ui}
    </article>
  )
}

function TextList({ title, items }: { title: string; items: AdText[] }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((i, n) => (
          <li key={n} className="flex items-baseline justify-between gap-2">
            <span>{i.text}</span>
            {i.pin && <span className="shrink-0 text-[11px] text-muted-foreground">Pinned: {pinLabel(i.pin)}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Editor({ ad, change, onDone }: { ad: SearchAd; change: ReturnType<typeof useChange>; onDone: () => void }) {
  const [headlines, setHeadlines] = useState(ad.headlines)
  const [descriptions, setDescriptions] = useState(ad.descriptions)
  const checked = cleanAdText(headlines, descriptions)
  const problem = typeof checked === "string" ? checked : null

  function review() {
    if (typeof checked === "string") return
    const before = [...ad.headlines, ...ad.descriptions].map((i) => i.text)
    const after = [...checked.headlines, ...checked.descriptions].map((i) => i.text)
    const removed = before.filter((t) => !after.includes(t))
    const added = after.filter((t) => !before.includes(t))
    const pinsChanged =
      JSON.stringify([...ad.headlines, ...ad.descriptions].map((i) => [i.text, i.pin ?? ""]).sort()) !==
      JSON.stringify([...checked.headlines, ...checked.descriptions].map((i) => [i.text, i.pin ?? ""]).sort())
    change.ask({
      title: `Update the ad in ${ad.adGroup}?`,
      details: (
        <>
          {added.length > 0 && (
            <>
              <p className="font-medium text-foreground">Adding</p>
              <List items={added} />
            </>
          )}
          {removed.length > 0 && (
            <>
              <p className="mt-2 font-medium text-foreground">Removing</p>
              <List items={removed} />
            </>
          )}
          {!added.length && !removed.length && <p>{pinsChanged ? "Only pins change." : "Nothing changes."}</p>}
          <p className="mt-2">Google reviews the ad again, which usually takes up to a day. It keeps its history.</p>
        </>
      ),
      confirmLabel: "Update ad",
      note: "You can undo it from the message that follows.",
      run: async () => {
        const r = await updateAdTextAction({ adId: ad.id, headlines: checked.headlines, descriptions: checked.descriptions })
        if (r.ok) onDone()
        return r
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Fields
          title="Headlines"
          items={headlines}
          onChange={setHeadlines}
          rule={LIMITS.headlines}
          pins={HEADLINE_PINS}
          idPrefix={`h-${ad.id}`}
        />
        <Fields
          title="Descriptions"
          items={descriptions}
          onChange={setDescriptions}
          rule={LIMITS.descriptions}
          pins={DESCRIPTION_PINS}
          idPrefix={`d-${ad.id}`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={review} disabled={change.busy || !!problem}>
          Review changes
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone} disabled={change.busy}>
          Cancel
        </Button>
        {problem && <span className="text-xs text-destructive">{problem}</span>}
      </div>
    </div>
  )
}

function Fields({
  title,
  items,
  onChange,
  rule,
  pins,
  idPrefix,
}: {
  title: string
  items: AdText[]
  onChange: (items: AdText[]) => void
  rule: { min: number; max: number; chars: number }
  pins: readonly string[]
  idPrefix: string
}) {
  const update = (n: number, patch: Partial<AdText>) => onChange(items.map((i, k) => (k === n ? { ...i, ...patch } : i)))
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">
        {title} ({items.length} of {rule.min}–{rule.max}, up to {rule.chars} characters each)
      </legend>
      {items.map((item, n) => {
        const length = adTextLength(item.text)
        return (
          <div key={n} className="flex items-center gap-1.5">
            <input
              id={`${idPrefix}-${n}`}
              aria-label={`${title.slice(0, -1)} ${n + 1}`}
              value={item.text}
              onChange={(e) => update(n, { text: e.target.value })}
              className={cn(
                "h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm",
                length > rule.chars && "border-destructive",
              )}
            />
            <span className={cn("w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground", length > rule.chars && "text-destructive")}>
              {length}/{rule.chars}
            </span>
            <select
              aria-label={`Pin for ${title.slice(0, -1).toLowerCase()} ${n + 1}`}
              value={item.pin ?? ""}
              onChange={(e) => update(n, { pin: e.target.value || undefined })}
              className="h-8 shrink-0 rounded-lg border border-input bg-background px-1 text-xs"
            >
              <option value="">Any position</option>
              {pins.map((p) => (
                <option key={p} value={p}>
                  Pin: {pinLabel(p)}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={`Remove ${title.slice(0, -1).toLowerCase()} ${n + 1}`}
              disabled={items.length <= rule.min}
              onClick={() => onChange(items.filter((_, k) => k !== n))}
              className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        )
      })}
      {items.length < rule.max && (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => onChange([...items, { text: "" }])}>
          <Plus aria-hidden />
          Add {title.slice(0, -1).toLowerCase()}
        </Button>
      )}
    </fieldset>
  )
}
