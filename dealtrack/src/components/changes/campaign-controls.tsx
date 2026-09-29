"use client"

import { useState } from "react"

import { setCampaignStatusAction, setDailyBudgetAction } from "@/app/actions/controls"
import { useChange } from "@/components/changes/shared"
import { formatUsdCents } from "@/components/dashboard/format"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { CampaignControl } from "@/lib/google-ads/controls"

const MAX_SHOWN = 25

// Pause or turn on campaigns and change daily budgets. Running campaigns are listed; paused
// ones are behind a search box, since the account has many old ones.
export default function CampaignControls({ campaigns, maxBudget }: { campaigns: CampaignControl[]; maxBudget: number }) {
  const { ask, ui, busy } = useChange()
  const [search, setSearch] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const [amount, setAmount] = useState("")

  const running = campaigns.filter((c) => c.status === "ENABLED")
  const term = search.trim().toLowerCase()
  const paused = term ? campaigns.filter((c) => c.status !== "ENABLED" && c.name.toLowerCase().includes(term)) : []

  function toggle(c: CampaignControl) {
    const pause = c.status === "ENABLED"
    ask({
      title: pause ? `Pause ${c.name}?` : `Turn on ${c.name}?`,
      details: pause ? (
        <p>Its ads stop showing right away. Nothing is deleted.</p>
      ) : (
        <p>
          Its ads start showing again and it starts spending
          {c.budget ? ` up to ${formatUsdCents(c.budget.amount)} a day` : ""}.
        </p>
      ),
      confirmLabel: pause ? "Pause campaign" : "Turn on campaign",
      note: "You can undo it from the message that follows.",
      run: () => setCampaignStatusAction({ campaignId: c.id, status: pause ? "PAUSED" : "ENABLED" }),
    })
  }

  function saveBudget(c: CampaignControl) {
    const value = Math.round(Number(amount) * 100) / 100
    if (!c.budget || !Number.isFinite(value) || value < 1 || value > maxBudget) return
    const others = c.budget.campaigns.filter((n) => n !== c.name)
    const bigJump = value > c.budget.amount * 2
    ask({
      title: `Change the daily budget for ${c.name}?`,
      details: (
        <>
          <p>
            {formatUsdCents(c.budget.amount)} → <span className="font-semibold text-foreground">{formatUsdCents(value)}</span> a day.
            Google can spend up to twice the daily budget on a busy day, averaging it out over the month.
          </p>
          {others.length > 0 && (
            <p className="mt-1 font-medium text-foreground">This budget is shared. It also changes for: {others.join(", ")}.</p>
          )}
          {bigJump && <p className="mt-1 font-medium text-destructive">That&apos;s more than double the current budget.</p>}
        </>
      ),
      confirmLabel: "Change budget",
      note: "You can undo it from the message that follows.",
      run: async () => {
        const r = await setDailyBudgetAction({ campaignId: c.id, amount: value })
        if (r.ok) setEditing(null)
        return r
      },
    })
  }

  const row = (c: CampaignControl) => {
    const value = Number(amount)
    const invalid = amount !== "" && (!Number.isFinite(value) || value < 1 || value > maxBudget)
    return (
      <li key={c.id} className="flex flex-col gap-2 px-3 py-2.5 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{c.name}</span>
            <span className="text-xs text-muted-foreground">
              {c.status === "ENABLED" ? "Running" : "Paused"}
              {" · "}
              {c.budget
                ? `${formatUsdCents(c.budget.amount)}/day${c.budget.campaigns.length > 1 ? ` (shared by ${c.budget.campaigns.length} campaigns)` : ""}`
                : "No daily budget"}
            </span>
          </div>
          <div className="flex gap-2">
            {c.budget && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditing(editing === c.id ? null : c.id)
                  setAmount(String(c.budget?.amount ?? ""))
                }}
              >
                {editing === c.id ? "Cancel" : "Change budget"}
              </Button>
            )}
            <Button type="button" variant={c.status === "ENABLED" ? "outline" : "default"} size="sm" disabled={busy} onClick={() => toggle(c)}>
              {c.status === "ENABLED" ? "Pause" : "Turn on"}
            </Button>
          </div>
        </div>
        {editing === c.id && c.budget && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              saveBudget(c)
            }}
          >
            <label htmlFor={`budget-${c.id}`} className="text-xs font-medium text-muted-foreground">
              New daily budget ($)
            </label>
            <Input
              id={`budget-${c.id}`}
              type="number"
              inputMode="decimal"
              min={1}
              max={maxBudget}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-8 w-32"
              aria-invalid={invalid || undefined}
            />
            <Button type="submit" size="sm" disabled={busy || amount === "" || invalid}>
              Review change
            </Button>
            {invalid && <span className="text-xs text-destructive">Between $1 and ${maxBudget.toLocaleString("en-US")}.</span>}
          </form>
        )}
      </li>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {ui}
      {running.length ? (
        <ul className="flex flex-col divide-y rounded-xl border">{running.map(row)}</ul>
      ) : (
        <p className="text-sm text-muted-foreground">No campaigns are running right now.</p>
      )}
      <div className="flex flex-col gap-2">
        <input
          type="search"
          aria-label="Find a paused campaign"
          placeholder={`Find a paused campaign (${campaigns.length - running.length})`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 max-w-sm rounded-lg border border-input bg-background px-2 text-sm"
        />
        {term && !paused.length && <p className="text-sm text-muted-foreground">No paused campaigns match.</p>}
        {paused.length > 0 && (
          <>
            <ul className="flex flex-col divide-y rounded-xl border">{paused.slice(0, MAX_SHOWN).map(row)}</ul>
            {paused.length > MAX_SHOWN && (
              <p className="text-xs text-muted-foreground">
                Showing {MAX_SHOWN} of {paused.length}. Keep typing to narrow it down.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
