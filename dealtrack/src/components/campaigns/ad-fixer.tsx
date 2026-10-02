"use client"

// "Improve this ad" / "Edit this ad": only opens when someone wants to change the ad. The AI can
// draft new text (or the person writes it), every line stays editable with Google's limits shown,
// the preview updates as you type, and "Send for approval" files a Compliance request. Nothing
// reaches Google Ads until it's checked, approved, and applied by an admin.

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { Loader2, Plus, Sparkles, Trash2, Undo2, X } from "lucide-react"

import { requestAdEditAction, suggestAdFixAction } from "@/app/actions/ads"
import AdPreview from "@/components/campaigns/ad-preview"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { AdFix } from "@/lib/ad-fix"
import { DESCRIPTION_PINS, HEADLINE_PINS, LIMITS, adTextProblems, sameText, shownLength, type AdTextSet } from "@/lib/ad-text"
import type { CampaignAd, CampaignAssets } from "@/lib/google-ads/campaign"
import { cn } from "@/lib/utils"

type Row = { text: string; pinned: string; was?: string; why?: string }
type Kind = "headlines" | "descriptions"

const toRows = (ad: CampaignAd, kind: Kind): Row[] => ad[kind].map((t) => ({ text: t.text, pinned: t.pinned }))

export default function AdFixer({
  campaignId,
  ad,
  assets,
  personName,
  aiReady,
}: {
  campaignId: string
  ad: CampaignAd
  assets: CampaignAssets
  personName: string
  aiReady: boolean
}) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Record<Kind, Row[]>>({ headlines: toRows(ad, "headlines"), descriptions: toRows(ad, "descriptions") })
  const [fix, setFix] = useState<AdFix | null>(null)
  const [reason, setReason] = useState("")
  const [name, setName] = useState(personName)
  const [message, setMessage] = useState<{ ok: boolean; text: string; requestId?: string } | null>(null)
  const [thinking, startThinking] = useTransition()
  const [sending, startSending] = useTransition()

  const original: AdTextSet = useMemo(() => ({ headlines: toRows(ad, "headlines"), descriptions: toRows(ad, "descriptions") }), [ad])
  const draft: AdTextSet = { headlines: rows.headlines, descriptions: rows.descriptions }
  const problems = adTextProblems(draft)
  const changed = !sameText(original, draft)

  function reset() {
    setRows({ headlines: toRows(ad, "headlines"), descriptions: toRows(ad, "descriptions") })
    setFix(null)
    setMessage(null)
  }

  function askAi() {
    setMessage(null)
    startThinking(async () => {
      const res = await suggestAdFixAction(campaignId, ad.id)
      if (!res.ok) return setMessage({ ok: false, text: res.message })
      setFix(res.fix)
      setRows({ headlines: res.fix.headlines, descriptions: res.fix.descriptions })
      setReason(res.fix.summary ? `AI suggestion: ${res.fix.summary}` : "AI suggestion to raise ad strength.")
    })
  }

  function send() {
    setMessage(null)
    startSending(async () => {
      const res = await requestAdEditAction({ adId: ad.id, text: draft, reason, name, ai: !!fix })
      setMessage({ ok: res.ok, text: res.message, requestId: res.requestId })
    })
  }

  const update = (kind: Kind, i: number, patch: Partial<Row>) =>
    setRows((r) => ({ ...r, [kind]: r[kind].map((row, j) => (j === i ? { ...row, ...patch } : row)) }))
  const remove = (kind: Kind, i: number) => setRows((r) => ({ ...r, [kind]: r[kind].filter((_, j) => j !== i) }))
  const add = (kind: Kind) => setRows((r) => ({ ...r, [kind]: [...r[kind], { text: "", pinned: "" }] }))

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-3 text-sm">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setOpen(true)
            if (aiReady) askAi()
          }}
          disabled={!aiReady}
          title={aiReady ? undefined : "Set up the AI chat first (an OpenAI or Anthropic key, or Claude Code)."}
        >
          <Sparkles data-icon="inline-start" /> Improve this ad with AI
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          Edit it myself
        </Button>
        <span className="text-xs text-muted-foreground">Nothing changes in Google Ads until the edit is checked, approved and applied.</span>
      </div>
    )
  }

  const original_ = (kind: Kind) => new Set(original[kind].map((l) => l.text.toLowerCase()))
  const lineList = (kind: Kind) => {
    const rule = kind === "headlines" ? LIMITS.headline : LIMITS.description
    const pins = kind === "headlines" ? HEADLINE_PINS : DESCRIPTION_PINS
    const was = original_(kind)
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          {kind === "headlines" ? "Headlines" : "Descriptions"} ({rows[kind].length} of {rule.max}, up to {rule.chars} characters)
        </p>
        <ol className="flex flex-col gap-1.5">
          {rows[kind].map((row, i) => {
            const len = shownLength(row.text)
            const isNew = row.text.trim() && !was.has(row.text.trim().toLowerCase())
            return (
              <li key={i} className={cn("flex flex-col gap-1 rounded-lg border p-1.5", isNew && "border-emerald-300 bg-emerald-50/50")}>
                <div className="flex items-center gap-1.5">
                  {kind === "headlines" ? (
                    <input
                      value={row.text}
                      onChange={(e) => update(kind, i, { text: e.target.value })}
                      aria-label={`Headline ${i + 1}`}
                      className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                    />
                  ) : (
                    <textarea
                      value={row.text}
                      onChange={(e) => update(kind, i, { text: e.target.value })}
                      aria-label={`Description ${i + 1}`}
                      rows={3}
                      className="min-w-0 flex-1 resize-y rounded-md border border-input bg-background px-2 py-1 text-sm"
                    />
                  )}
                  <span
                    className={cn(
                      "w-7 text-right text-[11px] tabular-nums",
                      len > rule.chars ? "font-semibold text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {len}
                  </span>
                  <select
                    value={row.pinned}
                    onChange={(e) => update(kind, i, { pinned: e.target.value })}
                    aria-label="Pin"
                    className="h-8 rounded-md border border-input bg-background px-1 text-xs"
                  >
                    <option value="">No pin</option>
                    {pins.map((p) => (
                      <option key={p} value={p}>
                        Pin {p.replace(/\D/g, "")}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => remove(kind, i)}
                    className="p-1 text-muted-foreground hover:text-destructive"
                    aria-label="Remove"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </div>
                {isNew && (row.was || row.why) && (
                  <p className="px-1 text-[11px] text-muted-foreground">
                    {row.was && (
                      <>
                        Replaces <span className="line-through">{row.was}</span>
                        {row.why ? " · " : ""}
                      </>
                    )}
                    {row.why}
                  </p>
                )}
              </li>
            )
          })}
        </ol>
        {rows[kind].length < rule.max && (
          <button type="button" onClick={() => add(kind)} className="flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline">
            <Plus className="size-3.5" aria-hidden /> Add a {kind === "headlines" ? "headline" : "description"}
          </button>
        )}
      </div>
    )
  }

  return (
    <section aria-label="Edit this ad" className="flex flex-col gap-4 rounded-2xl border-2 border-primary/30 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-semibold">{fix ? "AI suggestion for this ad" : "Edit this ad"}</h3>
          <p className="text-xs text-muted-foreground">
            Change anything below. New lines are green. Sending files a request; it&apos;s checked and approved before an admin applies it in Google
            Ads.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {aiReady && (
            <Button type="button" size="sm" variant="outline" onClick={askAi} disabled={thinking}>
              <Sparkles data-icon="inline-start" /> {fix ? "Ask again" : "Ask the AI"}
            </Button>
          )}
          {changed && (
            <Button type="button" size="sm" variant="ghost" onClick={reset} disabled={thinking}>
              <Undo2 data-icon="inline-start" /> Start over
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {thinking && (
        <p className="flex items-center gap-2 rounded-xl bg-muted/50 p-3 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden /> The AI is reading the ad, its keywords, what people searched, and the landing page…
          (up to a minute)
        </p>
      )}

      {fix && !thinking && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-violet-50 p-3 text-sm text-violet-950">
          {fix.summary && <p className="font-medium">{fix.summary}</p>}
          {fix.problems.length > 0 && (
            <ul className="list-disc pl-5 text-[13px]">
              {fix.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="grid content-start gap-4 lg:grid-cols-2">
          {lineList("headlines")}
          {lineList("descriptions")}
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Preview</p>
          <AdPreview
            ad={{
              displayUrl: ad.displayUrl,
              finalUrl: ad.finalUrl,
              headlines: rows.headlines.filter((r) => r.text.trim()).map((r) => ({ ...r, label: "UNKNOWN" })),
              descriptions: rows.descriptions.filter((r) => r.text.trim()).map((r) => ({ ...r, label: "UNKNOWN" })),
            }}
            assets={assets}
          />
          {problems.length > 0 ? (
            <ul className="flex flex-col gap-1 rounded-lg bg-red-50 p-2 text-xs text-red-900">
              {problems.slice(0, 6).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            changed && <Pill tone="green">Fits Google&apos;s limits</Pill>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t pt-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Why (the checker and approver see this)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {!personName && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              className="h-9 w-40 rounded-lg border border-input bg-background px-2 text-sm"
            />
          )}
          <Button type="button" onClick={send} disabled={sending || thinking || !changed || problems.length > 0 || !reason.trim()}>
            {sending ? "Sending…" : "Send for approval"}
          </Button>
          {!changed && <span className="text-xs text-muted-foreground">Change something first.</span>}
        </div>
        {message && (
          <p role="status" className={cn("text-sm", message.ok ? "text-emerald-700" : "text-destructive")}>
            {message.text}{" "}
            {message.ok && (
              <Link href="/compliance" className="font-medium text-primary hover:underline">
                Open Compliance
              </Link>
            )}
          </p>
        )}
      </div>
    </section>
  )
}
