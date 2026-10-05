"use client"

// Competitors → Competitor sites: look up a competitor's website, switch between the ones looked
// up, and filter its keywords down to the seller searches we don't have yet.

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { LoaderCircle, Plus, Search, Trash2 } from "lucide-react"

import { addSiteIdeasAction, analyzeSiteAction, deleteSiteAction, type SiteResult } from "@/app/actions/competitor-sites"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type SiteRow = {
  text: string
  volume?: number
  cpcLow?: number
  cpcHigh?: number
  competition?: string
  topic: string
  seller: boolean
  inList: boolean
  weBid: boolean | null
  sites: number // competitors looked up for the same place that have it
}

type Report = { id: string; site: string; place: string; at: string; by: string; count: number }

const fmt = (n: number) => n.toLocaleString("en-US")
const money = (n: number) => `$${n.toFixed(2)}`
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
const PAGE = 100

export default function CompetitorSites({
  reports,
  current,
  rows,
  places,
  suggested,
  bidsKnown,
}: {
  reports: Report[]
  current: string
  rows: SiteRow[]
  places: string[]
  suggested: { site: string; share: number }[]
  bidsKnown: boolean
}) {
  const router = useRouter()
  const [site, setSite] = useState("")
  const [place, setPlace] = useState(places[0])
  const [busy, start] = useTransition()
  const [message, setMessage] = useState<SiteResult | null>(null)
  const [sellerOnly, setSellerOnly] = useState(true)
  const [gapOnly, setGapOnly] = useState(true)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState(PAGE)
  const report = reports.find((r) => r.id === current)

  const act = (fn: () => Promise<SiteResult>, after?: (r: SiteResult) => void) =>
    start(async () => {
      setMessage(null)
      const res = await fn()
      setMessage(res)
      after?.(res)
    })
  const lookUp = (s: string) =>
    act(
      () => analyzeSiteAction(s, place),
      (res) => {
        if (res.ok && res.id) {
          setSelected(new Set())
          router.push(`/competitors/sites?r=${encodeURIComponent(res.id)}`)
        }
      },
    )

  const visible = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
    return rows.filter((r) => (!sellerOnly || r.seller) && (!gapOnly || (!r.inList && !r.weBid)) && terms.every((t) => r.text.includes(t)))
  }, [rows, sellerOnly, gapOnly, search])
  // Close variants get the same searches and bids (to the cent) from Google: counted once.
  const total = (list: SiteRow[]) => {
    const seen = new Set<string>()
    return list.reduce((s, r) => {
      if (!r.volume) return s
      const key = r.cpcHigh === undefined ? null : `${r.volume}|${r.cpcLow ?? ""}|${r.cpcHigh}`
      if (key && seen.has(key)) return s
      if (key) seen.add(key)
      return s + r.volume
    }, 0)
  }
  const gap = rows.filter((r) => r.seller && !r.inList && !r.weBid)

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
        <h2 className="font-semibold">Look up a competitor</h2>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            lookUp(site)
          }}
        >
          <input
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="sellfast.com or a page address"
            aria-label="Competitor website"
            className="h-9 min-w-64 flex-1 rounded-lg border border-input bg-background px-2.5 text-sm"
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Searches in
            <select
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
            >
              {places.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy || !site.trim()}>
            {busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Search data-icon="inline-start" />} Look up
          </Button>
        </form>
        {suggested.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">From your latest Google rankings scan:</span>
            {suggested.map((s) => (
              <button
                key={s.site}
                type="button"
                disabled={busy}
                onClick={() => {
                  setSite(s.site)
                  lookUp(s.site)
                }}
                className="rounded-full border px-2 py-0.5 hover:border-primary hover:text-primary disabled:opacity-50"
                title={`${(s.share * 100).toFixed(1)}% share of voice`}
              >
                {s.site}
              </button>
            ))}
          </div>
        )}
        {places.length === 1 && (
          <p className="text-xs text-muted-foreground">
            For a city&apos;s searches, first get city volumes on the Keyword explorer (California + every targeted city).
          </p>
        )}
        {message && (
          <p role="status" className={cn("text-sm", message.ok ? "text-emerald-700" : "text-destructive")}>
            {message.message}
          </p>
        )}
      </section>

      {reports.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {reports.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => (setSelected(new Set()), setShown(PAGE), router.push(`/competitors/sites?r=${encodeURIComponent(r.id)}`))}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-left text-xs",
                r.id === current ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted",
              )}
            >
              <span className="font-medium">{r.site}</span>
              <span className="text-muted-foreground"> · {r.place}</span>
            </button>
          ))}
        </div>
      )}

      {report && (
        <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-semibold">
                {report.site} <span className="font-normal text-muted-foreground">· searches in {report.place}</span>
              </h2>
              <p className="text-sm text-muted-foreground">
                {fmt(report.count)} keywords Google ties to this site · {fmt(gap.length)} seller searches not in our list ({fmt(total(gap))} searches
                a month) · looked up {when(report.at)} by {report.by}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                act(
                  () => deleteSiteAction(report.id),
                  () => router.push("/competitors/sites"),
                )
              }
            >
              <Trash2 data-icon="inline-start" /> Remove
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex h-9 min-w-48 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-2.5">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              <input
                value={search}
                onChange={(e) => (setSearch(e.target.value), setShown(PAGE))}
                placeholder="Search these keywords…"
                aria-label="Search these keywords"
                className="w-full bg-transparent outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={sellerOnly} onChange={(e) => (setSellerOnly(e.target.checked), setShown(PAGE))} /> Seller searches only
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={gapOnly} onChange={(e) => (setGapOnly(e.target.checked), setShown(PAGE))} /> Only the gap (not in our
              list, not bid on)
            </label>
            {selected.size > 0 && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(
                    () => addSiteIdeasAction(report.id, [...selected]),
                    (res) => res.ok && setSelected(new Set()),
                  )
                }
              >
                <Plus data-icon="inline-start" /> Add {selected.size} to Keyword explorer
              </Button>
            )}
          </div>
          <p className="text-sm">
            <b className="tabular-nums">{fmt(visible.length)}</b> keywords · <b className="tabular-nums">{fmt(total(visible))}</b>
            <span className="text-muted-foreground"> searches a month in {report.place} (close variants counted once)</span>
          </p>

          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      checked={visible.length > 0 && visible.slice(0, shown).every((r) => selected.has(r.text))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(visible.slice(0, shown).map((r) => r.text)) : new Set())}
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">Keyword</th>
                  <th className="px-3 py-2 font-medium">Topic</th>
                  <th className="px-3 py-2 text-right font-medium">Searches</th>
                  <th className="px-3 py-2 text-right font-medium">CPC (top of page)</th>
                  <th className="px-3 py-2 font-medium">Competition</th>
                  <th className="px-3 py-2 font-medium">Us</th>
                  <th className="px-3 py-2 text-right font-medium" title="Competitors looked up for the same place that also have it">
                    Competitors
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, shown).map((r) => (
                  <tr key={r.text} className="border-t">
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.text}`}
                        checked={selected.has(r.text)}
                        onChange={(e) =>
                          setSelected((s) => {
                            const n = new Set(s)
                            if (e.target.checked) n.add(r.text)
                            else n.delete(r.text)
                            return n
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-1.5 font-medium">{r.text}</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.topic}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.volume === undefined ? "–" : fmt(r.volume)}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                      {r.cpcHigh === undefined ? "–" : `${r.cpcLow !== undefined ? `${money(r.cpcLow)} – ` : ""}${money(r.cpcHigh)}`}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{r.competition ?? "–"}</td>
                    <td className="px-3 py-1.5">
                      <span className="flex flex-wrap gap-1">
                        {r.weBid && <Pill tone="green">We bid on it</Pill>}
                        {r.inList && !r.weBid && <Pill tone="gray">In our list</Pill>}
                        {!r.inList && !r.weBid && <Pill tone="amber">Gap</Pill>}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.sites}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!bidsKnown && (
            <p className="text-xs text-muted-foreground">Couldn&apos;t read our Google Ads keywords just now, so “We bid on it” isn&apos;t shown.</p>
          )}
          {visible.length > shown && (
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown)} more (of {fmt(visible.length - shown)})
            </Button>
          )}
        </section>
      )}
    </div>
  )
}
