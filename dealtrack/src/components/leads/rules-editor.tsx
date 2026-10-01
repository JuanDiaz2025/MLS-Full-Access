"use client"

import { useMemo, useState, useTransition } from "react"
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { conditionKinds, firstMatch, ruleActions, type LeadRule, type RuleCondition } from "@/lib/leads/rules"
import { saveRulesAction } from "@/lib/leads/rules-actions"
import type { Lead } from "@/lib/leads/types"
import { cn } from "@/lib/utils"

// Which conversion action in Google Ads each choice goes to.
const goesTo: Record<LeadRule["then"], string> = {
  qualified: "goes to your Qualified lead conversion",
  converted: "goes to your Converted lead conversion (and counts as qualified too)",
  invalid: "goes to a reporting-only Invalid lead action worth $0: Google never bids for it, and its reports show which ads bring leads like this",
  dont_send: "Google Ads never hears about it, unless you set its status yourself",
}

const newId = () => Math.random().toString(36).slice(2, 10)

function blank(kind: RuleCondition["kind"]): RuleCondition {
  switch (kind) {
    case "scoreAtLeast":
      return { kind, value: 70 }
    case "scoreBelow":
      return { kind, value: 40 }
    case "gradeIs":
      return { kind, value: "hot" }
    case "fromGoogleAd":
      return { kind }
    case "has":
    case "missing":
      return { kind, value: "address" }
    case "channelIs":
      return { kind, value: "Google Ads" }
    default:
      return { kind, value: "" }
  }
}

const input = "h-9 rounded-lg border bg-card px-2 text-sm"

function ConditionRow({ c, channels, onChange, onRemove }: { c: RuleCondition; channels: string[]; onChange: (c: RuleCondition) => void; onRemove: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Condition" value={c.kind} onChange={(e) => onChange(blank(e.target.value as RuleCondition["kind"]))} className={cn(input, "max-w-full min-w-0")}>
        {conditionKinds.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      {(c.kind === "scoreAtLeast" || c.kind === "scoreBelow") && (
        <input
          aria-label="Score"
          type="number"
          min={0}
          max={100}
          value={c.value}
          onChange={(e) => onChange({ ...c, value: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
          className={cn(input, "w-20")}
        />
      )}
      {c.kind === "gradeIs" && (
        <select aria-label="Grade" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value as typeof c.value })} className={input}>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
          <option value="junk">Junk</option>
        </select>
      )}
      {(c.kind === "has" || c.kind === "missing") && (
        <select aria-label="Detail" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value as typeof c.value })} className={input}>
          <option value="address">property address</option>
          <option value="phone">phone number</option>
          <option value="email">email</option>
        </select>
      )}
      {c.kind === "channelIs" && (
        <>
          <input aria-label="Channel" list="rule-channels" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} className={cn(input, "w-52")} />
          <datalist id="rule-channels">
            {channels.map((ch) => (
              <option key={ch} value={ch} />
            ))}
          </datalist>
        </>
      )}
      {(c.kind === "messageHas" || c.kind === "searchHas" || c.kind === "formIs") && (
        <input
          aria-label="Words"
          value={c.value}
          placeholder={c.kind === "formIs" ? "e.g. Ads Form" : "e.g. inherited, foreclosure, repairs"}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
          className={cn(input, "min-w-0 flex-1 sm:min-w-64")}
        />
      )}
      <Button type="button" variant="ghost" size="icon" aria-label="Remove condition" onClick={onRemove}>
        <X />
      </Button>
    </div>
  )
}

// Your Google Ads rules: make, order, switch on/off and save them. Each one shows how many of your
// recent leads it would have matched, so you can see what it does before saving.
export default function RulesEditor({ initial, recent, channels, enabled }: { initial: LeadRule[]; recent: Lead[]; channels: string[]; enabled: boolean }) {
  const [rules, setRules] = useState(initial)
  const [saved, setSaved] = useState(JSON.stringify(initial))
  const [pending, start] = useTransition()
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const dirty = JSON.stringify(rules) !== saved

  // Which rule would set each recent lead's status, given the order (first match wins).
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const lead of recent) {
      const r = firstMatch(lead, rules)
      if (r) out[r.id] = (out[r.id] ?? 0) + 1
    }
    return out
  }, [rules, recent])

  const update = (i: number, change: Partial<LeadRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...change } : r)))
  const move = (i: number, by: number) => {
    const next = [...rules]
    const [r] = next.splice(i, 1)
    next.splice(i + by, 0, r)
    setRules(next)
  }

  function save(reset = false) {
    setNote(null)
    start(async () => {
      const res = await saveRulesAction(rules, reset)
      if (res.error) setNote({ ok: false, text: res.error })
      else {
        if (!reset) setSaved(JSON.stringify(rules))
        setNote({ ok: true, text: reset ? "Back to the starting rules." : "Saved. New leads are sent to Google Ads by these rules." })
        if (reset) window.location.reload()
      }
    })
  }

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 text-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ListChecks className="size-5" />
        </span>
        <div>
          <p className="font-semibold">Google Ads rules: which leads Google hears about</p>
          <p className="text-muted-foreground">
            When a new lead arrives, the app checks these rules from top to bottom. The first one whose conditions all match decides
            whether the lead is sent to Google Ads, as a <strong>Qualified lead</strong> or a <strong>Converted lead</strong>, and what
            it&apos;s worth. The value helps Google&apos;s bidding go after the leads worth most to you. These rules don&apos;t change the
            lead&apos;s status; when you set a status yourself, Google still hears it (Interested → qualified, Closed deal → converted).
            {!enabled && <strong className="text-amber-800"> The rules are switched off above, so they don&apos;t run right now.</strong>}
          </p>
        </div>
      </div>

      <ol className="flex flex-col gap-3">
        {rules.map((rule, i) => (
          <li key={rule.id} className={cn("flex flex-col gap-3 rounded-lg border bg-card p-3", !rule.enabled && "opacity-60")}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
              <input aria-label="Rule name" value={rule.name} onChange={(e) => update(i, { name: e.target.value })} className={cn(input, "min-w-0 flex-1 font-medium")} />
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={rule.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} className="size-4" />
                On
              </label>
              <Button type="button" variant="ghost" size="icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp />
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Move down" disabled={i === rules.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown />
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label={`Delete rule "${rule.name}"`} onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
            <div className="flex min-w-0 flex-col gap-2 sm:pl-8">
              <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">When all of these are true</span>
              {rule.when.map((c, k) => (
                <ConditionRow
                  key={k}
                  c={c}
                  channels={channels}
                  onChange={(next) => update(i, { when: rule.when.map((x, m) => (m === k ? next : x)) })}
                  onRemove={() => update(i, { when: rule.when.filter((_, m) => m !== k) })}
                />
              ))}
              {!rule.when.length && <span className="text-xs text-destructive">Add at least one condition.</span>}
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => update(i, { when: [...rule.when, blank("scoreAtLeast")] })}>
                  <Plus data-icon="inline-start" />
                  Add condition
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Then</span>
                <select aria-label="Then" value={rule.then} onChange={(e) => update(i, { then: e.target.value as LeadRule["then"] })} className={cn(input, "max-w-full min-w-0 font-medium")}>
                  {ruleActions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
                {rule.then !== "dont_send" && rule.then !== "invalid" && (
                  <label className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">worth $</span>
                    <input
                      aria-label="Conversion value"
                      type="number"
                      min={0}
                      step="any"
                      value={rule.value ?? 1}
                      onChange={(e) => update(i, { value: Math.max(0, Number(e.target.value) || 0) })}
                      className={cn(input, "w-24")}
                    />
                  </label>
                )}
                <span className="text-xs text-muted-foreground">({goesTo[rule.then]})</span>
              </div>
              <span className="text-xs text-muted-foreground">
                Would have {rule.then === "dont_send" ? "held back" : rule.then === "invalid" ? "reported as invalid" : "sent"} {counts[rule.id] ?? 0} of your last {recent.length} leads.
              </span>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setRules([...rules, { id: newId(), name: "New rule", enabled: true, when: [blank("scoreAtLeast")], then: "qualified", value: 1 }])}
        >
          <Plus data-icon="inline-start" />
          Add rule
        </Button>
        <Button type="button" onClick={() => save()} disabled={pending || !dirty}>
          {pending ? "Saving…" : dirty ? "Save rules" : "Saved"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => save(true)} disabled={pending}>
          Reset to starting rules
        </Button>
        {note && <span className={note.ok ? "text-emerald-700" : "text-destructive"}>{note.text}</span>}
      </div>
    </div>
  )
}
