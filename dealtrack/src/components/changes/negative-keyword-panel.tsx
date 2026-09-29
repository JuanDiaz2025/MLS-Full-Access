"use client"

import { useState } from "react"

import { addNegativeKeywordsAction } from "@/app/actions/changes"
import { CampaignPicker, List, runningIds, useChange, type CampaignOption } from "@/components/changes/shared"
import { formatConversions, formatUsd } from "@/components/dashboard/format"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export type NegativeSuggestion = {
  negative: string
  reason: string
  terms: number
  cost: number
  conversions: number
}

const matchLabels = { PHRASE: "Phrase", EXACT: "Exact", BROAD: "Broad" } as const
type Match = keyof typeof matchLabels

const notation = (text: string, match: Match) => (match === "PHRASE" ? `"${text}"` : match === "EXACT" ? `[${text}]` : text)

export default function NegativeKeywordPanel({
  suggestions,
  campaigns,
  existing,
}: {
  suggestions: NegativeSuggestion[]
  campaigns: CampaignOption[]
  // "campaignId|text|MATCH" for negatives already in Google Ads.
  existing: string[]
}) {
  const [campaignIds, setCampaignIds] = useState(() => runningIds(campaigns))
  const [match, setMatch] = useState<Match>("PHRASE")
  // Terms that converted aren't pre-selected: blocking them could cost leads.
  const [picked, setPicked] = useState(suggestions.filter((s) => s.conversions === 0).map((s) => s.negative))
  const [custom, setCustom] = useState("")
  const { ask, ui, busy } = useChange()

  const existingSet = new Set(existing)
  const inAll = (text: string) => campaignIds.length > 0 && campaignIds.every((id) => existingSet.has(`${id}|${text}|${match}`))
  const campaignNames = campaigns.filter((c) => campaignIds.includes(c.id)).map((c) => c.name)

  function add(keywords: string[]) {
    ask({
      title: `Add ${keywords.length} negative keyword${keywords.length === 1 ? "" : "s"} (${matchLabels[match].toLowerCase()} match)?`,
      details: (
        <>
          <List items={keywords.map((k) => notation(k, match))} />
          <p className="mt-2">To: {campaignNames.join(", ")}</p>
          <p className="mt-1">Ads will stop showing for searches that contain these words.</p>
        </>
      ),
      confirmLabel: "Add to Google Ads",
      run: () => addNegativeKeywordsAction({ campaignIds, keywords, matchType: match }),
    })
  }

  const toAdd = picked.filter((p) => !inAll(p))
  const customWords = custom
    .split(/[\n,]/)
    .map((w) => w.trim())
    .filter(Boolean)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-start sm:justify-between">
        <CampaignPicker campaigns={campaigns} selected={campaignIds} onChange={setCampaignIds} idPrefix="neg-campaign" />
        <label htmlFor="neg-match" className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Match type
          <select
            id="neg-match"
            value={match}
            onChange={(e) => setMatch(e.target.value as Match)}
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
          >
            <option value="PHRASE">Phrase: blocks searches containing the words in order</option>
            <option value="EXACT">Exact: blocks only that exact search</option>
            <option value="BROAD">Broad: blocks searches containing all the words</option>
          </select>
        </label>
      </div>

      {suggestions.length > 0 ? (
        <div className="-mx-4 overflow-x-auto sm:-mx-5">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th scope="col" className="w-10 py-2 pl-4 sm:pl-5">
                  <span className="sr-only">Select</span>
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">Negative keyword</th>
                <th scope="col" className="px-4 py-2 text-left font-medium">Why</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Terms</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Spend</th>
                <th scope="col" className="px-4 py-2 pr-4 text-right font-medium sm:pr-5">Conversions</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => {
                const added = inAll(s.negative)
                const id = `neg-${s.negative.replace(/\W+/g, "-")}`
                return (
                  <tr key={s.negative} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pl-4 sm:pl-5">
                      <input
                        id={id}
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        disabled={added}
                        checked={!added && picked.includes(s.negative)}
                        onChange={(e) =>
                          setPicked(e.target.checked ? [...picked, s.negative] : picked.filter((p) => p !== s.negative))
                        }
                      />
                    </td>
                    <td className="px-4 py-2">
                      <label htmlFor={id} className="flex items-center gap-2">
                        <code className="font-mono text-xs">{notation(s.negative, match)}</code>
                        {added && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-800">Added</span>}
                      </label>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{s.reason}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.terms}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatUsd(s.cost)}</td>
                    <td className={cn("px-4 py-2 pr-4 text-right tabular-nums sm:pr-5", s.conversions > 0 && "font-medium text-amber-700")}>
                      {formatConversions(s.conversions)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="py-4 text-center text-sm text-muted-foreground">No flagged search terms in this period.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => add(toAdd)} disabled={busy || !toAdd.length || !campaignIds.length}>
          Add {toAdd.length} selected to Google Ads
        </Button>
        <span className="text-xs text-muted-foreground">Terms that converted are left unchecked. Tick them only if you&apos;re sure.</span>
      </div>

      <form
        className="flex flex-col gap-2 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (customWords.length && campaignIds.length) add(customWords)
        }}
      >
        <label htmlFor="neg-custom" className="text-xs font-medium text-muted-foreground">
          Add your own negative keywords (separate with commas)
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="neg-custom"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. rent to own, foreclosure listings"
            className="max-w-md"
          />
          <Button type="submit" variant="outline" disabled={busy || !customWords.length || !campaignIds.length}>
            Add
          </Button>
        </div>
      </form>

      {ui}
    </div>
  )
}
