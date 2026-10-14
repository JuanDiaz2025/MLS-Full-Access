"use client"

// Competitors → SEO → Keywords: the table. Each keyword's estimated searches a month in the place
// picked (with its range, how sure it is and how it was worked out), its trend, the real numbers we
// have (our ads, Search Console), who ranks there and where we are, and the visits that's worth.
// Admins can check Google Trends for a few keywords (Bright Data's free searches).

import { Fragment, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown, ChevronRight, LoaderCircle, TrendingUp } from "lucide-react"

import { checkTrendsAction, type SeoState } from "@/app/actions/seo"
import Sparkline from "@/components/dashboard/sparkline"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { EstimateRow } from "@/lib/seo/keywords"
import { cn } from "@/lib/utils"

export type KeywordRow = EstimateRow & { top: { site: string; dir: boolean; ours: boolean }[]; trendsFresh: boolean }

const fmt = (n: number) => n.toLocaleString("en-US")
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })
const CONFIDENCE = { high: ["green", "Sure"], medium: ["violet", "Fair"], low: ["amber", "Rough"] } as const
const PAGE = 100

type SortKey = "searches" | "visits" | "position" | "k"

function Now({ r }: { r: KeywordRow }) {
  if (r.now === null) return null
  const pct = Math.round((r.now - 1) * 100)
  return (
    <span className={cn("text-[11px] whitespace-nowrap", pct >= 5 ? "text-emerald-700 dark:text-emerald-400" : pct <= -5 ? "text-destructive" : "text-muted-foreground")}>
      {pct > 0 ? "+" : ""}
      {pct}% now <span className="text-muted-foreground">({r.nowFrom === "Google Trends" ? "Trends" : "Planner"})</span>
    </span>
  )
}

function Position({ r }: { r: KeywordRow }) {
  if (r.ourPositionFrom === "Google")
    return r.ourPosition ? (
      <span className="flex flex-col items-end">
        <b>#{r.ourPosition}</b>
        <span className="text-[11px] text-muted-foreground">Google, {r.rank ? day(r.rank.at) : ""}</span>
      </span>
    ) : (
      <span className="flex flex-col items-end">
        <span className="text-muted-foreground">Not in top 10</span>
        <span className="text-[11px] text-muted-foreground">Google, {r.rank ? day(r.rank.at) : ""}</span>
      </span>
    )
  if (r.ourPositionFrom === "Search Console")
    return (
      <span className="flex flex-col items-end">
        <b>{r.ourPosition?.toFixed(1)}</b>
        <span className="text-[11px] text-muted-foreground">Search Console avg.</span>
      </span>
    )
  return <span className="text-muted-foreground">Not checked</span>
}

export default function KeywordTable({
  rows,
  ca,
  place,
  topics,
  sellerTopics,
  admin,
  trendsReady,
  freeLeft,
  trendsPerRun,
}: {
  rows: KeywordRow[]
  ca: boolean
  place: string
  topics: { id: string; label: string }[]
  sellerTopics: string[]
  admin: boolean
  trendsReady: boolean
  freeLeft: number | null
  trendsPerRun: number
}) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [topic, setTopic] = useState("seller")
  const [onlyNumbers, setOnlyNumbers] = useState(true)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "searches", desc: true })
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState(PAGE)
  const [message, setMessage] = useState<SeoState | null>(null)
  const [busy, start] = useTransition()
  const topicLabel = useMemo(() => Object.fromEntries(topics.map((t) => [t.id, t.label])), [topics])
  const seller = useMemo(() => new Set(sellerTopics), [sellerTopics])

  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = rows.filter(
      (r) =>
        (!q || r.k.includes(q)) &&
        (topic === "" || (topic === "seller" ? seller.has(r.topic) : r.topic === topic)) &&
        (!onlyNumbers || r.searches !== null || r.sc !== null || r.rank !== null),
    )
    const val = (r: KeywordRow): number | string =>
      sort.key === "k" ? r.k : sort.key === "searches" ? (r.searches ?? -1) : sort.key === "visits" ? (r.visits ?? -1) : (r.ourPosition ?? 999)
    return out.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)
      return sort.desc ? -c : c
    })
  }, [rows, search, topic, onlyNumbers, sort, seller])

  const trendsFor = picked.size ? [...picked] : list.filter((r) => r.searches !== null && !r.trendsFresh).slice(0, trendsPerRun).map((r) => r.k)
  const header = (key: SortKey, label: string, right = true) => (
    <th className={cn("px-3 py-2 font-medium whitespace-nowrap", right && "text-right")}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "position" && key !== "k" }))}
        className="hover:text-foreground"
        aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}
      >
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  )
  const toggle = (set: Set<string>, k: string) => {
    const next = new Set(set)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  }
  const cols = 8 + (admin && trendsReady ? 1 : 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setShown(PAGE)
          }}
          placeholder="Find a keyword"
          aria-label="Find a keyword"
          className="h-8 w-56 max-w-full rounded-md border border-input bg-background px-2.5"
        />
        <select value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic" className="h-8 rounded-md border border-input bg-background px-2">
          <option value="seller">Seller searches</option>
          <option value="">Every topic</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={onlyNumbers} onChange={(e) => setOnlyNumbers(e.target.checked)} />
          Only keywords with numbers
        </label>
        <span className="text-xs text-muted-foreground">{fmt(list.length)} keywords</span>
        {admin && trendsReady && (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !trendsFor.length}
              onClick={() =>
                start(async () => {
                  setMessage(null)
                  setMessage(await checkTrendsAction(trendsFor))
                  setPicked(new Set())
                  router.refresh()
                })
              }
            >
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <TrendingUp data-icon="inline-start" />}
              Check Google Trends ({picked.size ? `${Math.min(picked.size, trendsPerRun)} picked` : `top ${trendsFor.length}`})
            </Button>
            <span className="text-xs text-muted-foreground">
              One free search each{freeLeft !== null ? ` (${fmt(freeLeft)} left)` : ""}. Kept 30 days.
            </span>
          </span>
        )}
      </div>
      {message && (
        <p role="status" className={cn("text-xs", message.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
          {message.message}
        </p>
      )}
      <div className="-mx-4 overflow-x-auto sm:-mx-5">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              {admin && trendsReady && <th className="w-8 px-3 py-2" aria-label="Pick for Google Trends" />}
              {header("k", "Keyword", false)}
              {header("searches", `Searches a month, ${place}`)}
              <th className="px-3 py-2 font-medium">Last 12 months</th>
              <th className="px-3 py-2 text-right font-medium">Our ads{ca ? "" : " (California)"}</th>
              <th className="px-3 py-2 text-right font-medium">Search Console (all places)</th>
              {header("position", "We rank")}
              {header("visits", "Visits to us a month")}
              <th className="px-3 py-2 font-medium">Top business here</th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, shown).map((r) => {
              const isOpen = open.has(r.k)
              return (
                <Fragment key={r.k}>
                  <tr className="border-b border-border/60 align-top hover:bg-muted/40">
                    {admin && trendsReady && (
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Pick ${r.k} for Google Trends`}
                          checked={picked.has(r.k)}
                          onChange={() => setPicked((p) => (p.size >= trendsPerRun && !p.has(r.k) ? p : toggle(p, r.k)))}
                        />
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => setOpen((o) => toggle(o, r.k))} className="flex items-start gap-1 text-left font-medium hover:text-primary" aria-expanded={isOpen}>
                        {isOpen ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />}
                        {r.k}
                      </button>
                      <span className="block pl-4.5 text-[11px] text-muted-foreground">
                        {topicLabel[r.topic] ?? r.topic}
                        {r.named ? ` · ${r.named}` : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.searches === null ? (
                        <span className="text-muted-foreground">–</span>
                      ) : (
                        <span className="flex flex-col items-end gap-0.5">
                          <b className="tabular-nums">{fmt(r.searches)}</b>
                          <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
                            {fmt(r.low ?? 0)}–{fmt(r.high ?? 0)}
                          </span>
                          {r.confidence && <Pill tone={CONFIDENCE[r.confidence][0]}>{CONFIDENCE[r.confidence][1]}</Pill>}
                        </span>
                      )}
                    </td>
                    <td className="w-36 px-3 py-2">
                      {r.trend.length >= 2 ? <Sparkline values={r.trend} className="text-primary" /> : <span className="text-muted-foreground">–</span>}
                      <Now r={r} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.ads ? (
                        <span className="flex flex-col items-end">
                          {r.ads.searches ? <b>{fmt(r.ads.searches)}</b> : <span className="text-muted-foreground">Share under 10%</span>}
                          <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                            {fmt(r.ads.impressions)} shown{r.ads.share ? `, ${Math.round(r.ads.share * 100)}% share` : ""}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.sc ? (
                        <span className="flex flex-col items-end">
                          <span>
                            <b>{fmt(r.sc.impressions)}</b> views
                          </span>
                          <span className="text-[11px] whitespace-nowrap text-muted-foreground">
                            {fmt(r.sc.clicks)} clicks · pos. {r.sc.position.toFixed(1)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      <Position r={r} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.visits === null ? <span className="text-muted-foreground">–</span> : <b>{fmt(r.visits)}</b>}</td>
                    <td className="px-3 py-2">
                      {r.leader ? (
                        <span className="flex flex-col">
                          <span>
                            {r.leader.site} <span className="text-muted-foreground">#{r.leader.position}</span>
                          </span>
                          {r.leader.visits !== null && <span className="text-[11px] text-muted-foreground">~{fmt(r.leader.visits)} visits a month</span>}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-border/60 bg-muted/20">
                      <td colSpan={cols} className="px-4 py-3">
                        <div className="grid gap-4 text-xs md:grid-cols-2">
                          <div className="flex flex-col gap-1">
                            <p className="font-medium">How the searches were worked out</p>
                            {r.basis.length ? (
                              <ol className="list-decimal pl-4">
                                {r.basis.map((b) => (
                                  <li key={b}>{b}</li>
                                ))}
                              </ol>
                            ) : (
                              <p className="text-muted-foreground">
                                No Keyword Planner numbers for this keyword{ca ? "" : ` in ${place}`} yet. Get them in the Keyword explorer.
                              </p>
                            )}
                            {r.searches !== null && (
                              <p className="text-muted-foreground">
                                Likely between {fmt(r.low ?? 0)} and {fmt(r.high ?? 0)} a month. Sure: checked against real numbers. Fair: Keyword Planner for this place. Rough: worked out
                                from California&apos;s numbers.
                              </p>
                            )}
                            {r.trendsAt && <p className="text-muted-foreground">Google Trends checked {day(r.trendsAt)}{r.nowFrom === "Google Trends" ? "" : ": no line for this search"}.</p>}
                            {r.sc?.page && (
                              <p>
                                Our page Google shows most:{" "}
                                <a href={r.sc.page} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">
                                  {r.sc.page}
                                </a>
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col gap-1">
                            <p className="font-medium">Google&apos;s top 10 {r.rank ? `from ${place}, ${day(r.rank.at)}` : ""}</p>
                            {r.top.length ? (
                              <ol className="list-decimal pl-5">
                                {r.top.map((t, i) => (
                                  <li key={`${t.site}-${i}`} className={cn(t.ours && "font-semibold text-emerald-700 dark:text-emerald-400", t.dir && "text-muted-foreground")}>
                                    {t.site}
                                    {t.ours ? " (us)" : t.dir ? " (listing site)" : ""}
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <p className="text-muted-foreground">Not searched from {place} yet: the weekly Competitor ads searches and Google rankings scans fill this in.</p>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {!list.length && <p className="py-6 text-center text-sm text-muted-foreground">No keywords with these filters.</p>}
      {list.length > shown && (
        <Button type="button" variant="outline" size="sm" className="self-center" onClick={() => setShown(shown + PAGE)}>
          Show more ({fmt(list.length - shown)} left)
        </Button>
      )}
    </div>
  )
}
