"use client"

// Competitors → Google rankings: the scan form (which keywords, which places, how many searches it
// will use), the scan under way, and the results: competitors by share of voice, each keyword's top
// 10 and ads, and the past scans.

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Download, LoaderCircle, Play, Search, Square, Trash2, X } from "lucide-react"

import { continueScanAction, deleteScanAction, startScanAction, stopScanAction, type SerpState } from "@/app/actions/serp"
import { Button, buttonVariants } from "@/components/ui/button"
import Disclosure from "@/components/ui/disclosure"
import type { Scan, SerpEngine } from "@/lib/research/serp"
import type { Analysis, KeywordRow, SiteRow } from "@/lib/research/serp-analysis"
import { cn } from "@/lib/utils"

type Props = {
  admin: boolean
  engines: SerpEngine[]
  engineLabels: Record<SerpEngine, string>
  balance: number | null
  balanceError: string
  running: string | null
  scans: Scan[]
  shownId: string
  comparedAt: string
  analysis: Analysis | null
  topics: { id: string; label: string }[]
  places: string[]
  keywords: { t: string; v: number | null; named: boolean }[]
}

const STATEWIDE = "California"
const SKIP_BY_DEFAULT = new Set(["home-buyers", "other"])
const PAGE = 100
const fmt = (n: number) => n.toLocaleString("en-US")
const pct = (n: number) => `${(n * 100).toFixed(n >= 0.1 ? 0 : 1)}%`
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export default function Rankings(props: Props) {
  const { running, scans, analysis, shownId } = props
  const router = useRouter()
  const [tab, setTab] = useState<"sites" | "keywords" | "scans">("sites")
  const [message, setMessage] = useState<SerpState | null>(null)
  const [busy, start] = useTransition()
  const live = scans.find((s) => s.id === running)

  // While a scan runs, the page refreshes itself every few seconds.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => router.refresh(), 3000)
    return () => clearInterval(timer)
  }, [running, router])

  const act = (fn: () => Promise<SerpState>) =>
    start(async () => {
      setMessage(null)
      setMessage(await fn())
    })

  return (
    <div className="flex flex-col gap-5">
      <ScanPanel {...props} busy={busy} act={act} open={!scans.length} />

      {message?.message && (
        <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", message.ok ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900")}>
          {message.message}
        </p>
      )}

      {live && (
        <div className="flex flex-col gap-2 rounded-2xl border bg-card p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden />
              Scanning: <b className="tabular-nums">{fmt(live.done + live.failed)}</b> of <b className="tabular-nums">{fmt(live.planned)}</b> searches
              {live.failed > 0 && <span className="text-amber-700">({fmt(live.failed)} failed, tried again on Continue)</span>}
            </p>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(stopScanAction)}>
              <Square data-icon="inline-start" /> Stop
            </Button>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.min(100, ((live.done + live.failed) / Math.max(1, live.planned)) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            You can leave this page; the scan keeps going while the app is open. Results show below as they come in.
          </p>
        </div>
      )}

      {scans.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm font-medium" role="tablist">
              {(
                [
                  ["sites", "Competitors"],
                  ["keywords", "Keywords"],
                  ["scans", `Scans (${scans.length})`],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={cn("rounded-md px-3 py-1.5", tab === id ? "bg-background shadow-xs" : "text-muted-foreground")}
                >
                  {label}
                </button>
              ))}
            </div>
            <ShownScan scans={scans} shownId={shownId} comparedAt={props.comparedAt} engineLabels={props.engineLabels} />
          </div>

          {tab === "scans" ? (
            <ScanList {...props} busy={busy} act={act} />
          ) : !analysis || !analysis.keywords.length ? (
            <p className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">No results in this scan yet.</p>
          ) : tab === "sites" ? (
            <Sites analysis={analysis} compared={Boolean(props.comparedAt)} />
          ) : (
            <Keywords analysis={analysis} compared={Boolean(props.comparedAt)} />
          )}
        </div>
      )}
    </div>
  )
}

function ShownScan({ scans, shownId, comparedAt, engineLabels }: Pick<Props, "scans" | "shownId" | "comparedAt" | "engineLabels">) {
  const s = scans.find((x) => x.id === shownId)
  if (!s) return null
  return (
    <p className="text-xs text-muted-foreground">
      Showing the scan from <b className="text-foreground">{when(s.at)}</b> ({engineLabels[s.engine]}, {fmt(s.done)} searches)
      {comparedAt ? ` · changes compared with ${when(comparedAt)}` : " · run another scan later to see changes"}
    </p>
  )
}

// ---- The scan form ----------------------------------------------------------------------------

function ScanPanel({
  admin,
  engines,
  engineLabels,
  balance,
  balanceError,
  running,
  topics,
  places,
  keywords,
  busy,
  act,
  open,
}: Props & { busy: boolean; act: (fn: () => Promise<SerpState>) => void; open: boolean }) {
  const [engine, setEngine] = useState<SerpEngine>(engines[0] ?? "serper")
  const [picked, setPicked] = useState<Set<string>>(() => new Set(topics.map((t) => t.id).filter((id) => !SKIP_BY_DEFAULT.has(id))))
  const [minVolume, setMinVolume] = useState(0)
  const [max, setMax] = useState("")
  const [where, setWhere] = useState<string[]>([STATEWIDE])
  const [city, setCity] = useState("")
  const hasVolumes = keywords.some((k) => k.v !== null)

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const k of keywords) m.set(k.t, (m.get(k.t) ?? 0) + 1)
    return m
  }, [keywords])

  // The same choice the app makes: most searched first, then the cap.
  const chosen = useMemo(() => {
    const list = keywords.filter((k) => picked.has(k.t) && (!minVolume || (k.v ?? 0) >= minVolume)).sort((a, b) => (b.v ?? -1) - (a.v ?? -1))
    const cap = Number(max)
    return cap > 0 ? list.slice(0, cap) : list
  }, [keywords, picked, minVolume, max])
  const places_ = engine === "brave" ? 1 : Math.max(1, where.length)
  // A keyword that names a city is searched there only, once.
  const searches = engine === "brave" ? chosen.length : chosen.reduce((n, k) => n + (k.named ? 1 : places_), 0)
  const tooMany = engine === "serper" && balance !== null && searches > balance

  const addCity = () => {
    const match = places.find((p) => p.toLowerCase() === city.trim().toLowerCase())
    if (match && !where.includes(match)) setWhere([...where, match])
    setCity("")
  }

  return (
    <Disclosure className="group rounded-2xl border bg-card shadow-xs" initialOpen={open}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 p-4">
        <span className="font-semibold">New scan</span>
        <span className="text-xs text-muted-foreground">
          {engines.includes("serper") ? (
            balanceError ? (
              <span className="text-amber-700">{balanceError}</span>
            ) : (
              <>
                Serper searches left: <b className="text-foreground tabular-nums">{balance === null ? "–" : fmt(balance)}</b>
              </>
            )
          ) : (
            "No search service set up yet"
          )}
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t p-4 text-sm">
        {!engines.length ? (
          <div className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3 text-amber-900">
            <p className="font-medium">Add a search service key to .env.local, then restart the app:</p>
            <ul className="list-disc pl-5 text-xs">
              <li>
                <code>SERPER_API_KEY=…</code> from serper.dev (2,500 free searches, once; real Google results, set to a city)
              </li>
              <li>
                <code>BRAVE_SEARCH_API_KEY=…</code> from brave.com/search/api (free every month; regular results only, US-wide)
              </li>
            </ul>
          </div>
        ) : !keywords.length ? (
          <p className="text-muted-foreground">
            Add keywords in the{" "}
            <Link href="/competitors/keywords" className="text-primary underline">
              Keyword explorer
            </Link>{" "}
            first.
          </p>
        ) : (
          <>
            {engines.length > 1 && (
              <fieldset className="flex flex-wrap items-center gap-3">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">Search with</legend>
                {engines.map((e) => (
                  <label key={e} className="flex items-center gap-1.5">
                    <input type="radio" name="engine" checked={engine === e} onChange={() => setEngine(e)} />
                    {engineLabels[e]}
                  </label>
                ))}
              </fieldset>
            )}

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">Keywords: which topics</legend>
              <div className="flex flex-wrap gap-1.5">
                {topics.map((t) => (
                  <label
                    key={t.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                      picked.has(t.id) ? "border-primary bg-primary/10" : "text-muted-foreground",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={picked.has(t.id)}
                      onChange={(e) =>
                        setPicked((s) => {
                          const n = new Set(s)
                          if (e.target.checked) n.add(t.id)
                          else n.delete(t.id)
                          return n
                        })
                      }
                    />
                    {t.label} <span className="tabular-nums opacity-70">{fmt(counts.get(t.id) ?? 0)}</span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {hasVolumes && (
                  <label className="flex items-center gap-1.5">
                    At least
                    <select
                      value={minVolume}
                      onChange={(e) => setMinVolume(Number(e.target.value))}
                      className="h-8 rounded-md border border-input bg-background px-2"
                    >
                      <option value={0}>any</option>
                      <option value={10}>10</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={500}>500</option>
                    </select>
                    searches a month
                  </label>
                )}
                <label className="flex items-center gap-1.5">
                  At most
                  <input
                    type="number"
                    min={1}
                    value={max}
                    onChange={(e) => setMax(e.target.value)}
                    placeholder="all"
                    className="h-8 w-20 rounded-md border border-input bg-background px-2"
                  />
                  keywords{hasVolumes ? " (most searched first)" : ""}
                </label>
              </div>
            </fieldset>

            {engine === "serper" ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">Search from</legend>
                <div className="flex flex-wrap items-center gap-1.5">
                  {where.map((p) => (
                    <span key={p} className="flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs">
                      {p === STATEWIDE ? "California (whole state)" : p}
                      <button type="button" aria-label={`Remove ${p}`} onClick={() => setWhere(where.filter((x) => x !== p))}>
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    list="serp-places"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCity())}
                    placeholder="Add a city…"
                    aria-label="Add a city"
                    className="h-8 w-44 rounded-md border border-input bg-background px-2 text-xs"
                  />
                  <datalist id="serp-places">
                    {places
                      .filter((p) => !where.includes(p))
                      .map((p) => (
                        <option key={p} value={p} />
                      ))}
                  </datalist>
                  <Button type="button" size="sm" variant="outline" onClick={addCity} disabled={!city.trim()}>
                    Add
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Each keyword is searched once from each place. Keywords that name a city (“sell my house fast sacramento”) are searched from that
                  city only.
                </p>
              </fieldset>
            ) : (
              <p className="text-xs text-muted-foreground">Brave searches the whole US, so each keyword is searched once.</p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3">
              <p>
                This scan uses <b className="tabular-nums">{fmt(searches)}</b> searches ({fmt(chosen.length)} keywords)
                {engine === "serper" && balance !== null && (
                  <>
                    {" "}
                    of the <b className="tabular-nums">{fmt(balance)}</b> left
                  </>
                )}
                .
                {tooMany && (
                  <span className="block text-xs text-amber-700">
                    That’s more than Serper has left: pick fewer topics or places, or set “At most”.
                  </span>
                )}
              </p>
              <Button
                type="button"
                disabled={busy || !admin || Boolean(running) || !searches || tooMany || (engine === "serper" && !where.length)}
                onClick={() =>
                  act(() =>
                    startScanAction({ engine, topics: [...picked], minVolume, max: Number(max) || 0, locations: engine === "serper" ? where : [] }),
                  )
                }
              >
                {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
                Start scan
              </Button>
            </div>
            {!admin && <p className="text-xs text-muted-foreground">Only admins can start a scan, because it uses search credits.</p>}
            {running && <p className="text-xs text-muted-foreground">A scan is running. Start another when it’s done.</p>}
          </>
        )}
      </div>
    </Disclosure>
  )
}

// ---- Competitors ------------------------------------------------------------------------------

function Change({ value, points }: { value: number | null | undefined; points?: boolean }) {
  if (value === null || value === undefined || Math.abs(value) < (points ? 0.5 : 0.001)) return <span className="text-muted-foreground">–</span>
  const up = value > 0
  return (
    <span className={up ? "text-emerald-700" : "text-red-700"}>
      {up ? "▲" : "▼"} {points ? Math.abs(value) : `${(Math.abs(value) * 100).toFixed(1)} pts`}
    </span>
  )
}

function Sites({ analysis, compared }: { analysis: Analysis; compared: boolean }) {
  // The search services rarely see ads, so the ad numbers only show when a scan found some.
  const hasAds = analysis.sites.some((s) => s.ads > 0)
  const [hideDirectories, setHideDirectories] = useState(true)
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState("")
  const [shown, setShown] = useState(50)
  const rows = analysis.sites.filter((s) => (!hideDirectories || !s.directory || s.ours) && (!search || s.site.includes(search.toLowerCase().trim())))
  const ours = analysis.sites.find((s) => s.ours)
  const searched = analysis.keywords.filter((k) => !k.err).length

  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs">
      <div className={cn("grid gap-3", hasAds ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <Tile
          label="Our share of voice"
          value={pct(analysis.ourShare)}
          note={ours ? `in the top 10 for ${fmt(ours.results)} of ${fmt(searched)} searches` : "not in the top 10 for any search"}
        />
        <Tile
          label="Sites that rank"
          value={fmt(analysis.sites.filter((s) => !s.directory).length)}
          note={`plus ${fmt(analysis.sites.filter((s) => s.directory).length)} listing sites and directories`}
        />
        {hasAds && (
          <Tile
            label="Advertisers seen"
            value={fmt(analysis.sites.filter((s) => s.ads > 0).length)}
            note={`ads on ${fmt(analysis.keywords.filter((k) => k.ads.length).length)} searches`}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox value={search} onChange={setSearch} placeholder="Find a site…" />
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={hideDirectories} onChange={(e) => setHideDirectories(e.target.checked)} />
          Hide listing sites and directories (Zillow, Yelp, Reddit…)
        </label>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Site</th>
              <th className="px-3 py-2 text-right font-medium" title="Of the clicks these searches get, about how many go to this site (by position)">
                Share of voice
              </th>
              {compared && <th className="px-3 py-2 text-right font-medium">Change</th>}
              <th className="px-3 py-2 text-right font-medium">In top 10</th>
              <th className="px-3 py-2 text-right font-medium">Top 3</th>
              <th className="px-3 py-2 text-right font-medium">Avg. position</th>
              {hasAds && <th className="px-3 py-2 text-right font-medium">Ads seen</th>}
              {analysis.byVolume && (
                <th className="px-3 py-2 text-right font-medium" title="Monthly searches × the share of people who click that position">
                  Est. visits / mo
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((s) => (
              <SiteLine
                key={s.site}
                s={s}
                compared={compared}
                byVolume={analysis.byVolume}
                hasAds={hasAds}
                open={open === s.site}
                onToggle={() => setOpen(open === s.site ? "" : s.site)}
                pages={analysis.pages[s.site]}
              />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <Button type="button" variant="outline" size="sm" className="self-center" onClick={() => setShown(shown + 50)}>
          Show more ({fmt(rows.length - shown)} left)
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        Share of voice and visits are estimates: each position gets the share of clicks it usually does (about 28% for #1, 15% for #2, 11% for #3…)
        {analysis.byVolume
          ? ", times the keyword's monthly searches from Keyword Planner."
          : ". Add Keyword Planner volumes to weigh busy keywords more and see estimated visits."}
      </p>
    </section>
  )
}

function SiteLine({
  s,
  compared,
  byVolume,
  hasAds,
  open,
  onToggle,
  pages,
}: {
  s: SiteRow
  compared: boolean
  byVolume: boolean
  hasAds: boolean
  open: boolean
  onToggle: () => void
  pages?: Analysis["pages"][string]
}) {
  const cols = 5 + (compared ? 1 : 0) + (byVolume ? 1 : 0) + (hasAds ? 1 : 0)
  return (
    <>
      <tr className={cn("border-t", s.ours && "bg-primary/5")}>
        <td className="px-3 py-1.5">
          <button type="button" onClick={onToggle} aria-expanded={open} className="text-left font-medium hover:text-primary">
            {open ? "▾" : "▸"} {s.site}
            {s.ours && <span className="ml-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">US</span>}
            {s.directory && <span className="ml-1.5 text-[10px] text-muted-foreground">directory</span>}
          </button>
        </td>
        <td className="px-3 py-1.5 text-right font-medium tabular-nums">{pct(s.share)}</td>
        {compared && (
          <td className="px-3 py-1.5 text-right text-xs tabular-nums">
            <Change value={s.change} />
          </td>
        )}
        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(s.results)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(s.top3)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{s.results ? s.avg : "–"}</td>
        {hasAds && <td className="px-3 py-1.5 text-right tabular-nums">{s.ads ? fmt(s.ads) : "–"}</td>}
        {byVolume && <td className="px-3 py-1.5 text-right tabular-nums">{s.visits === null ? "–" : fmt(s.visits)}</td>}
      </tr>
      {open && (
        <tr className="border-t bg-muted/30">
          <td colSpan={cols} className="px-3 py-2">
            {!pages?.length ? (
              <p className="text-xs text-muted-foreground">No details kept for this site.</p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Keyword</th>
                      <th className="py-1 pr-3 font-medium">From</th>
                      <th className="py-1 pr-3 text-right font-medium">Position</th>
                      <th className="py-1 font-medium">Their page</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((p, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="py-1 pr-3">{p.k}</td>
                        <td className="py-1 pr-3 text-muted-foreground">{p.loc}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {p.ad ? <span className="rounded bg-amber-100 px-1 text-amber-900">Ad {p.p}</span> : p.p}
                        </td>
                        <td className="max-w-md truncate py-1">
                          <a href={p.u} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
                            {p.u.replace(/^https?:\/\/(www\.)?/, "")}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ---- Keywords ---------------------------------------------------------------------------------

function Keywords({ analysis, compared }: { analysis: Analysis; compared: boolean }) {
  const hasAds = analysis.keywords.some((k) => k.ads.length > 0)
  const [search, setSearch] = useState("")
  const [show, setShow] = useState<"all" | "ranked" | "missing" | "ads">("all")
  const [loc, setLoc] = useState("")
  const [shown, setShown] = useState(PAGE)
  const places = useMemo(() => [...new Set(analysis.keywords.map((k) => k.loc))].sort(), [analysis.keywords])
  const rows = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
    return analysis.keywords
      .filter(
        (k) =>
          terms.every((t) => k.k.includes(t)) &&
          (!loc || k.loc === loc) &&
          (show === "all" || (show === "ranked" ? k.ours !== null : show === "missing" ? k.ours === null && !k.err : k.ads.length > 0)),
      )
      .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || (a.ours ?? 99) - (b.ours ?? 99) || a.k.localeCompare(b.k))
  }, [analysis.keywords, search, loc, show])

  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={search} onChange={(v) => (setSearch(v), setShown(PAGE))} placeholder="Search keywords…" />
        <select
          value={show}
          onChange={(e) => (setShow(e.target.value as typeof show), setShown(PAGE))}
          aria-label="Show"
          className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
        >
          <option value="all">All searches</option>
          <option value="ranked">Where we’re in the top 10</option>
          <option value="missing">Where we’re not in the top 10</option>
          {hasAds && <option value="ads">With ads</option>}
        </select>
        {places.length > 1 && (
          <select
            value={loc}
            onChange={(e) => (setLoc(e.target.value), setShown(PAGE))}
            aria-label="Place"
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
          >
            <option value="">All places</option>
            {places.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => downloadCsv(rows)}>
          <Download data-icon="inline-start" /> CSV
        </Button>
        <span className="text-xs text-muted-foreground">{fmt(rows.length)} searches</span>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Keyword</th>
              <th className="px-3 py-2 font-medium">From</th>
              <th className="px-3 py-2 text-right font-medium">Volume</th>
              <th className="px-3 py-2 text-right font-medium">Us</th>
              <th className="px-3 py-2 font-medium">#1</th>
              <th className="px-3 py-2 font-medium">#2</th>
              <th className="px-3 py-2 font-medium">#3</th>
              {hasAds && <th className="px-3 py-2 font-medium">Ads</th>}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((k) => (
              <tr key={`${k.k}|${k.loc}`} className="border-t align-top">
                <td className="px-3 py-1.5 font-medium">{k.k}</td>
                <td className="px-3 py-1.5 text-xs text-muted-foreground">{k.loc}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {k.volume === null ? <span className="text-muted-foreground">–</span> : fmt(k.volume)}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                  {k.err ? (
                    <span className="text-xs text-amber-700" title={k.err}>
                      failed
                    </span>
                  ) : k.ours === null ? (
                    <span className="text-muted-foreground">–</span>
                  ) : (
                    <b className={k.ours <= 3 ? "text-emerald-700" : ""}>{k.ours}</b>
                  )}
                  {compared && k.oursBefore !== undefined && !k.err && (
                    <span className="ml-1 text-[10px]">
                      <Change
                        value={k.ours === null ? (k.oursBefore === null ? null : -(11 - k.oursBefore)) : (k.oursBefore ?? 11) - k.ours}
                        points
                      />
                    </span>
                  )}
                </td>
                {[0, 1, 2].map((i) => (
                  <td
                    key={i}
                    className={cn("max-w-44 truncate px-3 py-1.5 text-xs", k.top[i] === "twinhomebuyer.com" && "font-semibold text-primary")}
                  >
                    {k.top[i] ?? <span className="text-muted-foreground">–</span>}
                  </td>
                ))}
                {hasAds && (
                  <td className="max-w-56 px-3 py-1.5 text-xs">
                    {k.ads.length ? k.ads.join(", ") : <span className="text-muted-foreground">–</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <Button type="button" variant="outline" size="sm" className="self-center" onClick={() => setShown(shown + PAGE)}>
          Show more ({fmt(rows.length - shown)} left)
        </Button>
      )}
    </section>
  )
}

function downloadCsv(rows: KeywordRow[]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = ["Keyword", "From", "Volume", "Our position", ...Array.from({ length: 10 }, (_, i) => `#${i + 1}`), "Ads"]
  const lines = rows.map((k) =>
    [k.k, k.loc, k.volume, k.ours, ...Array.from({ length: 10 }, (_, i) => k.top[i]), k.ads.join(" ")].map(cell).join(","),
  )
  const url = URL.createObjectURL(new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" }))
  const a = document.createElement("a")
  a.href = url
  a.download = "google-rankings.csv"
  a.click()
  URL.revokeObjectURL(url)
}

// ---- Past scans -------------------------------------------------------------------------------

function ScanList({
  scans,
  shownId,
  admin,
  running,
  engineLabels,
  busy,
  act,
}: Props & { busy: boolean; act: (fn: () => Promise<SerpState>) => void }) {
  return (
    <section className="overflow-x-auto rounded-2xl border bg-card shadow-xs">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">What</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 text-right font-medium">Searches</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {scans.map((s) => {
            const left = s.planned - s.done
            return (
              <tr key={s.id} className={cn("border-t align-top", s.id === shownId && "bg-primary/5")}>
                <td className="px-3 py-2 whitespace-nowrap">
                  {when(s.at)}
                  <div className="text-xs text-muted-foreground">{engineLabels[s.engine]}</div>
                </td>
                <td className="px-3 py-2 text-xs">{s.what}</td>
                <td className="max-w-48 px-3 py-2 text-xs">
                  {s.locations.map((l) => (l === STATEWIDE ? "California (whole state)" : l)).join(", ")}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmt(s.done)} / {fmt(s.planned)}
                  {s.failed > 0 && <div className="text-xs text-amber-700">{fmt(s.failed)} failed</div>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {s.status === "running" ? "Running" : s.status === "done" ? "Done" : "Stopped"}
                  {s.note && <div className="text-muted-foreground">{s.note}</div>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1.5">
                    {s.id !== shownId && s.done > 0 && (
                      <Link href={`/competitors/rankings?scan=${s.id}`} className={buttonVariants({ size: "sm", variant: "outline" })}>
                        View
                      </Link>
                    )}
                    {admin && s.status === "stopped" && left > 0 && !running && (
                      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(() => continueScanAction(s.id))}>
                        <Play data-icon="inline-start" /> Continue ({fmt(left)})
                      </Button>
                    )}
                    {admin && s.status !== "running" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label="Delete scan"
                        onClick={() => confirm("Delete this scan and its results?") && act(() => deleteScanAction(s.id))}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

// ---- Small pieces -----------------------------------------------------------------------------

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  )
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex h-9 min-w-56 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-sm">
      <Search className="size-4 text-muted-foreground" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full bg-transparent outline-none"
      />
    </label>
  )
}
