"use client"

// Competitors → Google rankings: the scan form (Google results, Google Maps or the brand check;
// which keywords and places; how many credits it will use), the scan under way, and the results:
// competitors by share of voice, each keyword's top 10, the Google Maps businesses and their
// reviews, what people see when they look us up, and the past scans.

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { LoaderCircle, Play, Search, Square, Trash2 } from "lucide-react"

import { continueScanAction, deleteScanAction, startScanAction, stopScanAction, type SerpState } from "@/app/actions/serp"
import { KeywordTable, Overview } from "@/components/research/rankings-dashboard"
import { BrandView, MapsView } from "@/components/research/rankings-maps"
import { Button, buttonVariants } from "@/components/ui/button"
import Disclosure from "@/components/ui/disclosure"
import type { PlaceReviews, Scan, ScanKind, SerpEngine, SerpResult } from "@/lib/research/serp"
import type { Analysis, MapsAnalysis, SiteRow } from "@/lib/research/serp-analysis"
import { placeKind } from "@/lib/research/classify"
import { cn } from "@/lib/utils"

type Shown<T> = { shownId: string; comparedAt: string; analysis: T | null }
export type Tab = "overview" | "sites" | "keywords" | "maps" | "brand" | "scans"
export type Act = (fn: () => Promise<SerpState>) => void

type Props = {
  admin: boolean
  engines: SerpEngine[]
  engineLabels: Record<SerpEngine, string>
  kindLabels: Record<ScanKind, string>
  balance: number | null
  balanceError: string
  running: string | null
  scans: Scan[]
  web: Shown<Analysis>
  maps: Shown<MapsAnalysis>
  brand: { shownId: string; results: SerpResult[] }
  brandQueries: string[]
  reviews: PlaceReviews[]
  initialTab: Tab
  topics: { id: string; label: string }[]
  places: string[]
  targeted: string[] // places our running campaigns target
  // named: the keyword names a city ("city") or a region like "bay area" ("region").
  keywords: { t: string; v: number | null; named: "city" | "region" | "" }[]
}

const STATEWIDE = "California"
// A starting list for "Type my own": the core searches a seller makes when they want a cash buyer.
const SELLER_STARTER = [
  "sell my house fast",
  "we buy houses",
  "cash home buyers",
  "sell my house for cash",
  "companies that buy houses",
  "cash for houses",
  "sell house as is",
  "sell inherited house",
]
const SKIP_BY_DEFAULT = new Set(["home-buyers", "agents", "competitor", "other"])
const fmt = (n: number) => n.toLocaleString("en-US")
const pct = (n: number) => `${(n * 100).toFixed(n >= 0.1 ? 0 : 1)}%`
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const kindOf = (s: Scan): ScanKind => s.kind ?? "web"

export default function Rankings(props: Props) {
  const { running, scans, web, maps, brand } = props
  const router = useRouter()
  const [tab, setTab] = useState<Tab>(props.initialTab)
  const [message, setMessage] = useState<SerpState | null>(null)
  const [busy, start] = useTransition()
  const live = scans.find((s) => s.id === running)

  // While a scan runs, the page refreshes itself every few seconds.
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => router.refresh(), 3000)
    return () => clearInterval(timer)
  }, [running, router])

  const act: Act = (fn) =>
    start(async () => {
      setMessage(null)
      setMessage(await fn())
    })

  const shown = tab === "overview" || tab === "sites" || tab === "keywords" ? web : tab === "maps" ? maps : tab === "brand" ? { ...brand, comparedAt: "" } : null
  const none = (what: string) => (
    <p className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">No {what} yet: run one from New scan above.</p>
  )

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
              {props.kindLabels[kindOf(live)]} scan: <b className="tabular-nums">{fmt(live.done + live.failed)}</b> of{" "}
              <b className="tabular-nums">{fmt(live.planned)}</b> searches
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
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 text-sm font-medium" role="tablist">
              {(
                [
                  ["overview", "Overview"],
                  ["sites", "Competitors"],
                  ["keywords", "Keywords"],
                  ["maps", "Google Maps"],
                  ["brand", "Brand check"],
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
            {shown && <ShownScan scans={scans} shownId={shown.shownId} comparedAt={shown.comparedAt} engineLabels={props.engineLabels} />}
          </div>

          {tab === "scans" ? (
            <ScanList {...props} busy={busy} act={act} />
          ) : tab === "maps" ? (
            maps.analysis?.rows.length ? (
              <MapsView
                analysis={maps.analysis}
                compared={Boolean(maps.comparedAt)}
                reviews={props.reviews}
                admin={props.admin}
                busy={busy}
                act={act}
              />
            ) : (
              none("Google Maps scan")
            )
          ) : tab === "brand" ? (
            brand.results.length ? (
              <BrandView results={brand.results} />
            ) : (
              none("brand check")
            )
          ) : !web.analysis?.keywords.length ? (
            none("Google results scan")
          ) : tab === "overview" ? (
            <Overview analysis={web.analysis} onOpen={setTab} />
          ) : tab === "sites" ? (
            <Sites analysis={web.analysis} compared={Boolean(web.comparedAt)} />
          ) : (
            <KeywordTable analysis={web.analysis} compared={Boolean(web.comparedAt)} />
          )}
        </div>
      )}
    </div>
  )
}

function ShownScan({
  scans,
  shownId,
  comparedAt,
  engineLabels,
}: {
  scans: Scan[]
  shownId: string
  comparedAt: string
  engineLabels: Props["engineLabels"]
}) {
  const s = scans.find((x) => x.id === shownId)
  if (!s) return null
  return (
    <p className="text-xs text-muted-foreground">
      Showing the scan from <b className="text-foreground">{when(s.at)}</b> ({engineLabels[s.engine]}, {fmt(s.done)} searches)
      {kindOf(s) !== "brand" && (comparedAt ? ` · changes compared with ${when(comparedAt)}` : " · run another scan later to see changes")}
    </p>
  )
}

// ---- The scan form ----------------------------------------------------------------------------

// What a scan costs, roughly: credits left after it, the money it would be at each service's list
// price (Serper's free credits cover it until they run out; Brave's first ~1,000 a month are free),
// and how long it runs at the scan's own pace (3 Serper searches at a time, about 4–5 a second;
// Brave one a second). Prices change: check serper.dev and brave.com/search/api.
const PRICE_PER_1000 = { serper: 1, brave: 5 } as const
const SECONDS_PER_SEARCH = { serper: 0.22, brave: 1.1 } as const
const BRAVE_FREE_MONTHLY = 1000

function ScanCost({ service, searches, credits, balance }: { service: SerpEngine; searches: number; credits: number; balance: number | null }) {
  const usd = (n: number) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`)
  const secs = searches * SECONDS_PER_SEARCH[service]
  const time = secs < 90 ? "about a minute" : secs < 3600 ? `about ${Math.round(secs / 60)} minutes` : `about ${(secs / 3600).toFixed(1)} hours`
  const price = (credits / 1000) * PRICE_PER_1000[service]
  return (
    <span className="mt-1 block text-xs text-muted-foreground">
      {service === "serper" ? (
        <>
          {balance !== null && credits <= balance ? (
            <>
              Leaves <b className="text-foreground tabular-nums">{fmt(balance - credits)}</b> credits. Free: your credits cover it (about {usd(price)}{" "}
              at Serper&apos;s paid price).
            </>
          ) : (
            <>About {usd(price)} at Serper&apos;s paid price (roughly $1 per 1,000 credits).</>
          )}
        </>
      ) : (
        <>
          {searches <= BRAVE_FREE_MONTHLY
            ? "Free if it fits in Brave's ~1,000 free searches this month"
            : `About ${usd(((searches - BRAVE_FREE_MONTHLY) / 1000) * PRICE_PER_1000.brave)} beyond Brave's ~1,000 free searches a month`}{" "}
          ($5 per 1,000 after that).
        </>
      )}{" "}
      Takes {time}; you can leave the page, or stop it and keep what it found.
    </span>
  )
}

// "Search from": a searchable checklist. Our targeted cities first (all at once with one click),
// then the other California places; California itself only for Google results.
function PlaceChecklist({
  places,
  targeted,
  where,
  setWhere,
  allowState,
}: {
  places: string[]
  targeted: string[]
  where: string[]
  setWhere: (list: string[]) => void
  allowState: boolean
}) {
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const ours = new Set(targeted)
  const match = (p: string) => !q || p.toLowerCase().includes(q)
  const others = places.filter((p) => p !== STATEWIDE && !ours.has(p)).sort()
  const toggle = (p: string) => setWhere(where.includes(p) ? where.filter((x) => x !== p) : [...where, p])
  const allTargeted = targeted.length > 0 && targeted.every((p) => where.includes(p))
  const chosenCities = where.filter((p) => p !== STATEWIDE)
  const box = (p: string, label = p) => (
    <label key={p} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
      <input type="checkbox" checked={where.includes(p)} onChange={() => toggle(p)} />
      {label}
    </label>
  )
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search cities and counties…"
          aria-label="Search places"
          className="h-8 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-xs"
        />
        {targeted.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setWhere(allTargeted ? where.filter((p) => !ours.has(p)) : [...new Set([...where, ...targeted])])}
          >
            {allTargeted ? "Untick our cities" : `All ${targeted.length} of our cities`}
          </Button>
        )}
        {chosenCities.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setWhere(where.filter((p) => p === STATEWIDE))}>
            Clear cities
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {where.includes(STATEWIDE) && allowState ? "California + " : ""}
          {chosenCities.length} {chosenCities.length === 1 ? "city" : "cities"} picked
        </span>
      </div>
      <div className="flex max-h-64 flex-col overflow-y-auto text-xs">
        {allowState && match("california") && box(STATEWIDE, "California (whole state)")}
        {targeted.some(match) && <p className="mt-1 px-2 font-medium text-muted-foreground">Our targeted cities</p>}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3">{targeted.filter(match).map((p) => box(p))}</div>
        {others.some(match) && <p className="mt-2 px-2 font-medium text-muted-foreground">Other California places</p>}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3">{others.filter(match).map((p) => box(p))}</div>
        {!targeted.some(match) && !others.some(match) && !(allowState && match("california")) && (
          <p className="px-2 py-1 text-muted-foreground">No place matches.</p>
        )}
      </div>
      {!targeted.length && (
        <p className="text-xs text-muted-foreground">
          Your targeted cities show up here after “Get volumes: California + every targeted city” on the Keyword explorer.
        </p>
      )}
    </div>
  )
}

function ScanPanel({
  admin,
  engines,
  engineLabels,
  kindLabels,
  balance,
  balanceError,
  running,
  topics,
  places,
  targeted,
  keywords,
  brandQueries,
  busy,
  act,
  open,
}: Props & { busy: boolean; act: Act; open: boolean }) {
  const [kind, setKind] = useState<ScanKind>("web")
  const [engine, setEngine] = useState<SerpEngine>(engines[0] ?? "serper")
  const [picked, setPicked] = useState<Set<string>>(() => new Set(topics.map((t) => t.id).filter((id) => !SKIP_BY_DEFAULT.has(id))))
  const [minVolume, setMinVolume] = useState(0)
  const [max, setMax] = useState("")
  const [where, setWhere] = useState<string[]>([STATEWIDE])
  const [stars, setStars] = useState(false)
  const [mode, setMode] = useState<"topics" | "typed">("typed")
  const [typedText, setTypedText] = useState("")
  const typed = useMemo(
    () => [...new Set(typedText.split("\n").map((k) => k.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 100),
    [typedText],
  )
  const hasVolumes = keywords.some((k) => k.v !== null)
  // Google Maps and the brand check only run on Serper.
  const service: SerpEngine = kind === "web" ? engine : "serper"
  const serperReady = engines.includes("serper")

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const k of keywords) m.set(k.t, (m.get(k.t) ?? 0) + 1)
    return m
  }, [keywords])

  // The same choice the app makes: most searched first, then the cap.
  const chosen = useMemo(() => {
    if (mode === "typed") return typed.map((k) => ({ t: "", v: null, named: placeKind(k) }))
    const list = keywords.filter((k) => picked.has(k.t) && (!minVolume || (k.v ?? 0) >= minVolume)).sort((a, b) => (b.v ?? -1) - (a.v ?? -1))
    const cap = Number(max)
    return cap > 0 ? list.slice(0, cap) : list
  }, [keywords, picked, minVolume, max, mode, typed])
  const cities = where.filter((p) => p !== STATEWIDE)
  // A keyword that names a city is searched there only, once. Maps needs a city for the rest.
  const searches =
    kind === "brand"
      ? brandQueries.length + 1
      : service === "brave"
        ? chosen.length
        : kind === "maps"
          ? chosen.reduce((n, k) => n + (k.named === "city" ? 1 : cities.length), 0)
          : chosen.reduce((n, k) => n + (k.named ? 1 : Math.max(1, where.length)), 0)
  const credits = kind === "brand" ? brandQueries.length + 3 : kind === "maps" && stars ? searches * 3 : searches
  const tooMany = service === "serper" && balance !== null && credits > balance
  const ready = kind === "brand" ? serperReady : (mode === "typed" || keywords.length > 0) && (kind === "web" || serperReady)

  return (
    <Disclosure className="group rounded-2xl border bg-card shadow-xs" initialOpen={open}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 p-4">
        <span className="font-semibold">New scan</span>
        <span className="text-xs text-muted-foreground">
          {serperReady ? (
            balanceError ? (
              <span className="text-amber-700">{balanceError}</span>
            ) : (
              <>
                Serper credits left: <b className="text-foreground tabular-nums">{balance === null ? "–" : fmt(balance)}</b>
              </>
            )
          ) : engines.length ? (
            "Brave Search set up"
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
                <code>SERPER_API_KEY=…</code> from serper.dev (2,500 free searches, once; real Google results and Google Maps, set to a city)
              </li>
              <li>
                <code>BRAVE_SEARCH_API_KEY=…</code> from brave.com/search/api (free every month; regular results only, US-wide)
              </li>
            </ul>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <div
                className="flex flex-wrap gap-1 self-start rounded-lg bg-muted p-1 text-xs font-medium"
                role="radiogroup"
                aria-label="What to scan"
              >
                {(["web", "maps", "brand"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    onClick={() => setKind(k)}
                    className={cn("rounded-md px-3 py-1.5", kind === k ? "bg-background shadow-xs" : "text-muted-foreground")}
                  >
                    {kindLabels[k]}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {kind === "web"
                  ? "The top 10 Google results for each keyword: who ranks, with which page."
                  : kind === "maps"
                    ? "The businesses Google Maps lists for each keyword in each city: the map box above the results, where sellers call from."
                    : "What a seller sees when they look us up, and our own Google Maps listing with its stars."}
              </p>
            </div>

            {kind !== "web" && !serperReady ? (
              <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">This needs SERPER_API_KEY in .env.local.</p>
            ) : kind === "brand" ? (
              <div className="flex flex-col gap-1 text-xs">
                <p className="font-medium text-muted-foreground">Searches (whole state):</p>
                <p>{brandQueries.map((q) => `“${q}”`).join(", ")}, and “twin home buyer” on Google Maps (with stars, 3 credits).</p>
              </div>
            ) : !keywords.length && mode === "topics" ? (
              <p className="text-muted-foreground">
                Add keywords in the{" "}
                <Link href="/competitors/keywords" className="text-primary underline">
                  Keyword explorer
                </Link>{" "}
                first.
              </p>
            ) : (
              <>
                {kind === "web" && engines.length > 1 && (
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

                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Keywords:</span>
                    <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs font-medium" role="radiogroup" aria-label="How to pick keywords">
                      {(
                        [
                          ["typed", "Type my own"],
                          ["topics", "By topic"],
                        ] as const
                      ).map(([m, label]) => (
                        <button
                          key={m}
                          type="button"
                          role="radio"
                          aria-checked={mode === m}
                          onClick={() => setMode(m)}
                          className={cn("rounded-md px-3 py-1", mode === m ? "bg-background shadow-xs" : "text-muted-foreground")}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {mode === "typed" ? (
                    <div className="flex flex-col gap-1.5">
                      <textarea
                        value={typedText}
                        onChange={(e) => setTypedText(e.target.value)}
                        rows={6}
                        placeholder={"One keyword per line, e.g.\nsell my house fast\nwe buy houses\ncash home buyers"}
                        aria-label="Keywords to search, one per line"
                        className="resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-sm"
                      />
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => setTypedText(SELLER_STARTER.join("\n"))}
                          className="rounded-full border px-2.5 py-0.5 hover:border-primary hover:text-primary"
                        >
                          Fill in the core seller searches ({SELLER_STARTER.length})
                        </button>
                        <span>
                          {fmt(typed.length)} keyword{typed.length === 1 ? "" : "s"}, up to 100. Exactly what you type is searched.
                        </span>
                      </div>
                    </div>
                  ) : (
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
                  )}
                </div>

                {service === "serper" ? (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-xs font-medium text-muted-foreground">Search from</legend>
                    <PlaceChecklist places={places} targeted={targeted} where={where} setWhere={setWhere} allowState={kind === "web"} />
                    <p className="text-xs text-muted-foreground">
                      {kind === "maps"
                        ? "Google Maps needs a city: each keyword is searched once from each city you add. Keywords that name a city (“we buy houses fresno”) are searched from that city only."
                        : "Each keyword is searched once from each place. Keywords that name a city (“sell my house fast sacramento”) are searched from that city only."}
                    </p>
                    {kind === "maps" && (
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={stars} onChange={(e) => setStars(e.target.checked)} />
                        Include stars, number of reviews and category (3 credits per search instead of 1)
                      </label>
                    )}
                  </fieldset>
                ) : (
                  <p className="text-xs text-muted-foreground">Brave searches the whole US, so each keyword is searched once.</p>
                )}
              </>
            )}

            {ready && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3">
                <p>
                  This scan uses <b className="tabular-nums">{fmt(searches)}</b> searches
                  {kind !== "brand" && <> ({fmt(chosen.length)} keywords)</>}
                  {service === "serper" && (
                    <>
                      {" "}
                      = <b className="tabular-nums">{fmt(credits)}</b> credits
                      {balance !== null && <> of the {fmt(balance)} left</>}
                    </>
                  )}
                  .{searches > 0 && <ScanCost service={service} searches={searches} credits={credits} balance={balance} />}
                  {tooMany && (
                    <span className="block text-xs text-amber-700">
                      That’s more than Serper has left: pick fewer topics or places, or set “At most”.
                    </span>
                  )}
                  {kind === "maps" && !cities.length && (
                    <span className="block text-xs text-amber-700">Add at least one city (only keywords that name a city are counted now).</span>
                  )}
                </p>
                <Button
                  type="button"
                  disabled={busy || !admin || Boolean(running) || !searches || tooMany || (service === "serper" && kind === "web" && !where.length)}
                  onClick={() =>
                    act(() =>
                      startScanAction({
                        kind,
                        engine: service,
                        topics: [...picked],
                        typed: mode === "typed" ? typed : [],
                        minVolume,
                        max: Number(max) || 0,
                        locations: service === "serper" ? where : [],
                        stars: kind === "maps" && stars,
                      }),
                    )
                  }
                >
                  {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" />}
                  Start scan
                </Button>
              </div>
            )}
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
  const [hideOutOfState, setHideOutOfState] = useState(true)
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState("")
  const [shown, setShown] = useState(50)
  const rows = analysis.sites.filter(
    (s) =>
      (!hideDirectories || !s.directory || s.ours) && (!hideOutOfState || !s.outOfState) && (!search || s.site.includes(search.toLowerCase().trim())),
  )
  const outOfState = analysis.sites.filter((s) => s.outOfState).length
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
          value={fmt(analysis.sites.filter((s) => !s.directory && !s.outOfState).length)}
          note={`plus ${fmt(analysis.sites.filter((s) => s.directory && !s.outOfState).length)} listing sites and directories, and ${fmt(outOfState)} from other states`}
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
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" checked={hideOutOfState} onChange={(e) => setHideOutOfState(e.target.checked)} />
          Hide sites from other states ({fmt(outOfState)})
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

// ---- Past scans -------------------------------------------------------------------------------

function ScanList({ scans, web, maps, brand, admin, running, engineLabels, kindLabels, busy, act }: Props & { busy: boolean; act: Act }) {
  const shownIds = new Set([web.shownId, maps.shownId, brand.shownId])
  const tabFor: Record<ScanKind, Tab> = { web: "overview", maps: "maps", brand: "brand" }
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
              <tr key={s.id} className={cn("border-t align-top", shownIds.has(s.id) && "bg-primary/5")}>
                <td className="px-3 py-2 whitespace-nowrap">
                  {when(s.at)}
                  <div className="text-xs text-muted-foreground">
                    {kindLabels[kindOf(s)]} · {engineLabels[s.engine]}
                  </div>
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
                    {!shownIds.has(s.id) && s.done > 0 && (
                      <Link
                        href={`/competitors/rankings?scan=${s.id}&tab=${tabFor[kindOf(s)]}`}
                        className={buttonVariants({ size: "sm", variant: "outline" })}
                      >
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
