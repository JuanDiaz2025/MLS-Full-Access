"use client"

// Competitors → Google rankings: the Google Maps tab (which businesses Google Maps shows for our
// keywords, city by city, their stars and newest reviews) and the Brand check tab (what a seller
// sees when they look us up).

import { useMemo, useState } from "react"
import { LoaderCircle, MessageSquareText, Search, Star } from "lucide-react"

import { fetchReviewsAction } from "@/app/actions/serp"
import type { Act } from "@/components/research/rankings"
import { Button } from "@/components/ui/button"
import type { PlaceReviews, SerpResult } from "@/lib/research/serp"
import { isOurBusiness, type Business, type MapsAnalysis } from "@/lib/research/serp-analysis"
import { cn } from "@/lib/utils"

const OUR_SITES = ["twinhomebuyer.com"]
const fmt = (n: number) => n.toLocaleString("en-US")
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "")
const DAY = 86_400_000

// What reviews talk about, by the words they use.
const THEMES: [string, RegExp][] = [
  ["Fast / quick", /\b(fast|quick(ly)?|days?|weeks?|on time|smooth)\b/i],
  ["Fair offer", /\b(fair|honest|great (price|offer)|good (price|offer)|transparent)\b/i],
  ["Easy / stress-free", /\b(easy|stress|hassle|simple|painless)\b/i],
  ["Communication", /\b(communicat\w*|responsive|answered|explained|kept (me|us) (informed|updated))\b/i],
  ["Low offer", /\b(low ?ball\w*|low offer|too low|insulting)\b/i],
  ["Bad experience", /\b(rude|scam|never (called|showed)|unprofessional|waste of time|backed out|ghosted)\b/i],
]

export function MapsView({
  analysis,
  compared,
  reviews,
  admin,
  busy,
  act,
}: {
  analysis: MapsAnalysis
  compared: boolean
  reviews: PlaceReviews[]
  admin: boolean
  busy: boolean
  act: Act
}) {
  const [search, setSearch] = useState("")
  const [shown, setShown] = useState(50)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [pages, setPages] = useState(1)
  const [rowsShown, setRowsShown] = useState(100)
  const [missingOnly, setMissingOnly] = useState(false)
  const [hideOutOfState, setHideOutOfState] = useState(true)
  const { businesses, rows, stars } = analysis
  const away = businesses.filter((b) => b.outOfState).length
  const list = businesses
    .filter((b) => !hideOutOfState || !b.outOfState)
    .filter((b) => !search || b.name.toLowerCase().includes(search.toLowerCase().trim()) || b.site.includes(search.toLowerCase().trim()))
  const ours = businesses.find((b) => b.ours)
  const searched = rows.filter((r) => !r.err).length
  const fetched = new Set(reviews.map((r) => r.cid))
  const pickable = (b: Business) => /^\d+$/.test(b.cid)
  const shownRows = rows.filter((r) => !missingOnly || (r.ours === null && !r.err))

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs">
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile
            label="We're in the map's top 3"
            value={ours ? `${fmt(ours.top3)} of ${fmt(searched)}` : `0 of ${fmt(searched)}`}
            note={ours ? `listed in ${fmt(ours.results)} searches, best #${ours.best}` : "not listed for any of these searches"}
          />
          <Tile label="Businesses seen" value={fmt(businesses.length)} note={`across ${fmt(new Set(rows.map((r) => r.loc)).size)} cities`} />
          <Tile
            label="Most top-3 spots"
            value={businesses[0]?.name ?? "–"}
            note={businesses[0] ? `${fmt(businesses[0].top3)} searches${businesses[0].rating ? ` · ${businesses[0].rating}★` : ""}` : ""}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Google shows the top 3 businesses in a map box above the results; that’s where map calls come from. Pick businesses to read their newest
          reviews.
          {!stars && " Stars and review counts show when a Maps scan includes them."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={search} onChange={setSearch} placeholder="Find a business…" />
          {away > 0 && (
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={hideOutOfState} onChange={(e) => setHideOutOfState(e.target.checked)} />
              Hide businesses in other states ({fmt(away)})
            </label>
          )}
          {picked.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={pages}
                onChange={(e) => setPages(Number(e.target.value))}
                aria-label="How many reviews"
                className="h-8 rounded-md border border-input bg-background px-2"
              >
                <option value={1}>10 newest reviews</option>
                <option value={2}>20 newest reviews</option>
                <option value={3}>30 newest reviews</option>
              </select>
              <Button
                type="button"
                size="sm"
                disabled={busy || !admin}
                onClick={() =>
                  act(async () => {
                    const places = businesses.filter((b) => picked.has(b.key)).map((b) => ({ cid: b.cid, name: b.name, site: b.site }))
                    const res = await fetchReviewsAction(places, pages)
                    if (res.ok) setPicked(new Set())
                    return res
                  })
                }
              >
                {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <MessageSquareText data-icon="inline-start" />}
                Get reviews for {picked.size} (up to {picked.size * pages} credits)
              </Button>
              {!admin && <span className="text-muted-foreground">Admins only</span>}
            </div>
          )}
        </div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Business</th>
                <th className="px-3 py-2 text-right font-medium">Top 3</th>
                <th className="px-3 py-2 text-right font-medium">Listed</th>
                <th className="px-3 py-2 text-right font-medium">Best</th>
                <th className="px-3 py-2 text-right font-medium">Avg.</th>
                {stars && <th className="px-3 py-2 text-right font-medium">Stars</th>}
                {stars && <th className="px-3 py-2 text-right font-medium">Reviews</th>}
                <th className="px-3 py-2 font-medium">Cities</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, shown).map((b) => (
                <tr key={b.key} className={cn("border-t align-top", b.ours && "bg-primary/5")}>
                  <td className="px-3 py-1.5">
                    {pickable(b) && (
                      <input
                        type="checkbox"
                        aria-label={`Pick ${b.name} for reviews`}
                        checked={picked.has(b.key)}
                        onChange={(e) =>
                          setPicked((s) => {
                            const n = new Set(s)
                            if (e.target.checked && n.size < 30) n.add(b.key)
                            else n.delete(b.key)
                            return n
                          })
                        }
                      />
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-medium">{b.name}</span>
                    {b.ours && <span className="ml-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">US</span>}
                    {fetched.has(b.cid) && <span className="ml-1.5 text-[10px] text-muted-foreground">reviews below</span>}
                    <div className="text-xs text-muted-foreground">{[b.site, b.type, b.phone].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                    <b>{fmt(b.top3)}</b>
                    {compared && b.change ? (
                      <span className={cn("ml-1 text-[10px]", b.change > 0 ? "text-emerald-700" : "text-red-700")}>
                        {b.change > 0 ? `▲${b.change}` : `▼${-b.change}`}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(b.results)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{b.best}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{b.avg}</td>
                  {stars && <td className="px-3 py-1.5 text-right tabular-nums">{b.rating === null ? "–" : `${b.rating}★`}</td>}
                  {stars && <td className="px-3 py-1.5 text-right tabular-nums">{b.reviews === null ? "–" : fmt(b.reviews)}</td>}
                  <td className="max-w-56 px-3 py-1.5 text-xs text-muted-foreground">
                    {b.cities.slice(0, 3).join(", ")}
                    {b.cities.length > 3 ? ` +${b.cities.length - 3}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length > shown && (
          <Button type="button" variant="outline" size="sm" className="self-center" onClick={() => setShown(shown + 50)}>
            Show more ({fmt(list.length - shown)} left)
          </Button>
        )}
      </section>

      {reviews.length > 0 && <Reviews reviews={reviews} />}

      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Each search</h3>
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
            Only where we’re not listed
          </label>
        </div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Keyword</th>
                <th className="px-3 py-2 font-medium">City</th>
                <th className="px-3 py-2 text-right font-medium">Us</th>
                <th className="px-3 py-2 font-medium">#1</th>
                <th className="px-3 py-2 font-medium">#2</th>
                <th className="px-3 py-2 font-medium">#3</th>
              </tr>
            </thead>
            <tbody>
              {shownRows.slice(0, rowsShown).map((r) => (
                <tr key={`${r.k}|${r.loc}`} className="border-t align-top">
                  <td className="px-3 py-1.5 font-medium">{r.k}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.loc}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                    {r.err ? (
                      <span className="text-xs text-amber-700" title={r.err}>
                        failed
                      </span>
                    ) : r.ours === null ? (
                      <span className="text-muted-foreground">–</span>
                    ) : (
                      <b className={r.ours <= 3 ? "text-emerald-700" : ""}>{r.ours}</b>
                    )}
                  </td>
                  {[0, 1, 2].map((i) => (
                    <td
                      key={i}
                      className={cn(
                        "max-w-48 truncate px-3 py-1.5 text-xs",
                        r.top[i] && /twin ?home ?buyer/i.test(r.top[i]) && "font-semibold text-primary",
                      )}
                    >
                      {r.top[i] ?? <span className="text-muted-foreground">–</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shownRows.length > rowsShown && (
          <Button type="button" variant="outline" size="sm" className="self-center" onClick={() => setRowsShown(rowsShown + 100)}>
            Show more ({fmt(shownRows.length - rowsShown)} left)
          </Button>
        )}
      </section>
    </div>
  )
}

function Reviews({ reviews }: { reviews: PlaceReviews[] }) {
  const [open, setOpen] = useState("")
  const rows = useMemo(
    () =>
      reviews.map((p) => {
        const dated = p.reviews.filter((r) => r.at)
        const avg = p.reviews.length ? p.reviews.reduce((s, r) => s + r.r, 0) / p.reviews.length : null
        const recent = dated.filter((r) => Date.parse(p.at) - Date.parse(r.at) < 90 * DAY).length
        const themes = THEMES.map(([label, re]) => [label, p.reviews.filter((r) => re.test(r.text)).length] as const).filter(([, n]) => n > 0)
        return { p, avg, recent, newest: dated[0]?.at ?? "", themes }
      }),
    [reviews],
  )
  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs">
      <div>
        <h3 className="font-semibold">Newest Google reviews</h3>
        <p className="text-xs text-muted-foreground">
          How often each business gets reviews (a sign of how many deals it closes) and what sellers say. Only the reviews fetched are counted.
        </p>
      </div>
      <div className="flex flex-col divide-y rounded-xl border">
        {rows.map(({ p, avg, recent, newest, themes }) => (
          <div key={p.cid} className="flex flex-col gap-2 p-3">
            <button
              type="button"
              onClick={() => setOpen(open === p.cid ? "" : p.cid)}
              aria-expanded={open === p.cid}
              className="flex flex-wrap items-baseline justify-between gap-2 text-left"
            >
              <span className="font-medium">
                {open === p.cid ? "▾" : "▸"} {p.name}
                {isOurBusiness({ n: p.name, d: p.site }, OUR_SITES) && (
                  <span className="ml-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">US</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {p.reviews.length} fetched · {avg === null ? "–" : `${avg.toFixed(1)}★ average`} · {recent} in the 90 days before fetching
                {newest ? ` · newest ${day(newest)}` : ""} · fetched {day(p.at)}
              </span>
            </button>
            {themes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {themes.map(([label, n]) => (
                  <span
                    key={label}
                    className={cn("rounded-full px-2 py-0.5 text-[11px]", /Low|Bad/.test(label) ? "bg-red-50 text-red-800" : "bg-muted")}
                  >
                    {label} {n}
                  </span>
                ))}
              </div>
            )}
            {open === p.cid && (
              <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto text-sm">
                {p.reviews.map((r, i) => (
                  <li key={i} className="rounded-lg bg-muted/40 p-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-0.5 text-amber-600">
                        {r.r}
                        <Star className="size-3 fill-current" aria-label="stars" />
                      </span>
                      {day(r.at)}
                    </div>
                    {r.text ? <p className="mt-1">{r.text}</p> : <p className="mt-1 text-xs text-muted-foreground">(stars only, no words)</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ---- Brand check ------------------------------------------------------------------------------

const REVIEW_SITES = /^(yelp|bbb|trustpilot|reddit|facebook|google|nextdoor|angi|birdeye|glassdoor|ripoffreport|complaintsboard|pissedconsumer)\./

export function BrandView({ results }: { results: SerpResult[] }) {
  const web = results.filter((r) => r.t !== "maps")
  const maps = results.find((r) => r.t === "maps")
  const listing = maps?.maps?.find((h) => isOurBusiness(h, OUR_SITES))
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4 shadow-xs">
        <h3 className="font-semibold">Our Google Maps listing</h3>
        {!maps ? (
          <p className="text-sm text-muted-foreground">Not checked in this scan.</p>
        ) : maps.err ? (
          <p className="text-sm text-amber-700">The Maps search failed: {maps.err}</p>
        ) : listing ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <b>{listing.n}</b>
            {listing.r !== undefined && (
              <span className="flex items-center gap-1">
                <Star className="size-4 fill-amber-500 text-amber-500" aria-hidden />
                {listing.r} ({fmt(listing.c ?? 0)} reviews)
              </span>
            )}
            {listing.addr && <span className="text-muted-foreground">{listing.addr}</span>}
            {listing.phone && <span className="text-muted-foreground">{listing.phone}</span>}
          </div>
        ) : (
          <p className="text-sm text-amber-700">
            Google Maps didn’t show a Twin Home Buyer listing for “{maps.k}”.
            {maps.maps?.length
              ? ` It showed: ${maps.maps
                  .slice(0, 3)
                  .map((h) => h.n)
                  .join(", ")}.`
              : ""}{" "}
            If there’s a Google Business Profile, check it’s verified and named the same as the website.
          </p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {web.map((r) => {
          const ourTop = r.org.find((h) => OUR_SITES.includes(h.d))
          return (
            <section key={r.k} className="flex flex-col gap-2 rounded-2xl border bg-card p-4 shadow-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">“{r.k}”</h3>
                <span className={cn("text-xs", ourTop ? "text-emerald-700" : "text-amber-700")}>
                  {r.err ? "failed" : ourTop ? `our site is #${ourTop.p}` : "our site isn’t on page 1"}
                </span>
              </div>
              <ol className="flex flex-col gap-1 text-sm">
                {r.org.map((h) => (
                  <li key={`${h.p}-${h.u}`} className={cn("flex gap-2", OUR_SITES.includes(h.d) && "font-semibold")}>
                    <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{h.p}</span>
                    <span className="min-w-0">
                      <a href={h.u} target="_blank" rel="noreferrer noopener" className="block truncate text-primary hover:underline">
                        {h.t || h.u}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {h.d}
                        {OUR_SITES.includes(h.d) && " · us"}
                        {REVIEW_SITES.test(h.d) && " · review site: read what it says"}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
              {r.ads.length > 0 && <p className="text-xs text-amber-700">Ads on this search: {[...new Set(r.ads.map((a) => a.d))].join(", ")}</p>}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// ---- Small pieces -----------------------------------------------------------------------------

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 rounded-xl border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-xl font-semibold tabular-nums">{value}</p>
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
