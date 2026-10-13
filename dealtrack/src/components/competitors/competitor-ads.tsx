"use client"

// Competitors → Competitor ads: the weekly sampling's settings, the keyword × city grid for one
// advertiser, and their ads with what they offer.

import { useMemo, useState, useTransition } from "react"
import { FlaskConical, LoaderCircle, Save } from "lucide-react"

import { saveSamplerAction, testSearchAction, type SamplerState } from "@/app/actions/ad-sampler"
import { PlaceChecklist } from "@/components/research/place-checklist"
import { Button } from "@/components/ui/button"
import { OFFER_TAGS, cellKey, type AdAnalysis, type Creative, type OfferTag } from "@/lib/competitors/ad-analysis"
import type { SamplerView } from "@/lib/competitors/ad-sampler"
import type { FreeSearches } from "@/lib/competitors/free-searches"
import { cn } from "@/lib/utils"

const fmt = (n: number) => n.toLocaleString("en-US")
const pct = (n: number) => `${Math.round(n * 100)}%`
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })

export function SamplerCard({
  admin,
  ready,
  view,
  free,
  allPlaces,
  targeted,
  maxPerWeek,
  windowDays,
}: {
  admin: boolean
  ready: boolean
  view: SamplerView
  free: FreeSearches
  allPlaces: string[]
  targeted: string[]
  maxPerWeek: number
  windowDays: number
}) {
  const s = view.settings
  const [on, setOn] = useState(s.on)
  const [keywordsText, setKeywordsText] = useState(s.keywords.join("\n"))
  const [mode, setMode] = useState<"targeted" | "pick">(s.places === "targeted" ? "targeted" : "pick")
  const [where, setWhere] = useState<string[]>(s.places === "targeted" ? view.targeted : s.places)
  const [perWeek, setPerWeek] = useState(String(s.perWeek))
  const [mobile, setMobile] = useState(String(Math.round(s.mobile * 100)))
  const [message, setMessage] = useState<SamplerState | null>(null)
  const [busy, start] = useTransition()

  const keywords = useMemo(() => [...new Set(keywordsText.split("\n").map((k) => k.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean))], [keywordsText])
  const places = mode === "targeted" ? view.targeted : where
  const combos = keywords.length * places.length
  const week = Math.min(Number(perWeek) || 0, maxPerWeek)
  const perWindow = Math.round((week * windowDays) / 7)
  const act = (fn: () => Promise<SamplerState>) =>
    start(async () => {
      setMessage(null)
      setMessage(await fn())
    })

  const status = !ready
    ? "Bright Data isn't set up on this computer yet."
    : view.mainComputer
      ? `On a team, the main computer (${view.mainComputer}) does the weekly sampling, so two computers can't both use the free searches.`
      : !s.on
        ? "The weekly sampling is off."
        : view.pausedUntil
          ? `Waiting until ${when(view.pausedUntil)} after a failed search.`
          : view.week
            ? `On. This week: ${fmt(view.week.done)} of ${fmt(view.week.planned)} searches done${view.week.skipped ? ` (${fmt(view.week.skipped)} skipped)` : ""}${view.week.next ? `, next around ${when(view.week.next)}` : ""}.`
            : "On. The first searches are planned within a few minutes."

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cn("font-medium", s.on && ready && !view.mainComputer ? "text-emerald-700" : "text-muted-foreground")}>{status}</p>
        <p className="text-xs text-muted-foreground">
          Free Bright Data searches left: <b className="text-foreground tabular-nums">{fmt(free.left)}</b> of {fmt(free.cap)} (last {windowDays} days)
          {free.moreOn ? `, more from ${day(free.moreOn)}` : ""}
        </p>
      </div>
      {view.notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {view.notes.slice(0, 4).map((n) => (
            <li key={n.at}>
              {when(n.at)}: {n.text}
            </li>
          ))}
        </ul>
      )}
      {view.weeks.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Earlier weeks: {view.weeks.slice(0, 6).map((w) => `${day(w.start)} ${fmt(w.done)} of ${fmt(w.planned)}`).join(" · ")}
        </p>
      )}

      {admin && ready && (
        <div className="flex flex-col gap-4 rounded-xl border p-3">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
            Search every week, at random times
          </label>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Keywords (one per line, without a city: each is searched from each city)</span>
              <textarea
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
                rows={10}
                aria-label="Keywords to sample, one per line"
                className="resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-sm"
              />
              <span className="text-xs text-muted-foreground">{fmt(keywords.length)} keywords, up to 60.</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Search from</span>
              <div className="flex gap-1 self-start rounded-lg bg-muted p-1 text-xs font-medium" role="radiogroup" aria-label="Which cities">
                {(
                  [
                    ["targeted", `Our targeted cities (${view.targeted.length})`],
                    ["pick", "Pick cities"],
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
              {mode === "targeted" ? (
                <p className="text-xs text-muted-foreground">
                  {view.targeted.slice(0, 12).join(", ")}
                  {view.targeted.length > 12 ? ` and ${view.targeted.length - 12} more` : ""}. Follows the campaigns&apos; targeting.
                </p>
              ) : (
                <PlaceChecklist places={allPlaces} targeted={targeted} where={where} setWhere={setWhere} allowState={false} />
              )}
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    max={maxPerWeek}
                    step={50}
                    value={perWeek}
                    onChange={(e) => setPerWeek(e.target.value)}
                    className="h-8 w-24 rounded-md border border-input bg-background px-2"
                  />
                  searches a week (up to {fmt(maxPerWeek)})
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                    className="h-8 w-16 rounded-md border border-input bg-background px-2"
                  />
                  % on a phone
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {fmt(keywords.length)} keywords × {fmt(places.length)} cities = {fmt(combos)} searches to cover once
                {week > 0 && combos > 0 ? `; at ${fmt(week)} a week, each is searched about ${week >= combos ? `${Math.min(3, Math.floor(week / combos))}× a week` : `every ${Math.ceil(combos / week)} weeks`}` : ""}.
                That uses about {fmt(perWindow)} of the {fmt(free.cap)} free searches every {windowDays} days, leaving about {fmt(Math.max(0, free.cap - perWindow))} for Google rankings scans.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                act(() =>
                  saveSamplerAction({ on, keywords, places: mode === "targeted" ? "targeted" : where, perWeek: Number(perWeek) || 0, mobile: (Number(mobile) || 0) / 100 }),
                )
              }
            >
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
              Save
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => act(testSearchAction)}>
              <FlaskConical data-icon="inline-start" /> Test one search
            </Button>
            <span className="text-xs text-muted-foreground">The test uses one free search: the first keyword, from the first city.</span>
          </div>
        </div>
      )}
      {!admin && <p className="text-xs text-muted-foreground">Only admins can change the sampling.</p>}
      {message && (
        <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", message.ok ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900")}>
          {message.message}
        </p>
      )}
    </div>
  )
}

// Keyword × city for one advertiser (or for any ad): how many of the searches there showed them.
export function CoverageGrid({ grid, advertisers }: { grid: AdAnalysis["grid"]; advertisers: { d: string; ours: boolean }[] }) {
  const choices = advertisers.filter((a) => grid.seen[a.d])
  const [who, setWho] = useState("")
  const seen = who ? (grid.seen[who] ?? {}) : grid.withAds
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-wrap items-center gap-2 text-xs">
        Show
        <select value={who} onChange={(e) => setWho(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-sm">
          <option value="">Any ad</option>
          {choices.map((a) => (
            <option key={a.d} value={a.d}>
              {a.ours ? `${a.d} (you)` : a.d}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">Each square: searches that showed {who ? "them" : "any ad"} ÷ searches made there. Hover for the numbers.</span>
      </label>
      <div className="-mx-4 overflow-x-auto sm:-mx-5">
        <table className="border-separate border-spacing-0.5 px-4 text-[11px] sm:px-5">
          <thead>
            <tr>
              <th />
              {grid.places.map((p) => (
                <th key={p} className="h-28 align-bottom font-normal text-muted-foreground">
                  <span className="inline-block max-h-28 rotate-180 overflow-hidden whitespace-nowrap [writing-mode:vertical-rl]">{p}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.keywords.map((k) => (
              <tr key={k}>
                <th className="max-w-56 truncate pr-2 text-left font-normal whitespace-nowrap" title={k}>
                  {k}
                </th>
                {grid.places.map((p) => {
                  const n = grid.n[cellKey(k, p)] ?? 0
                  const x = seen[cellKey(k, p)] ?? 0
                  const share = n ? x / n : 0
                  return (
                    <td
                      key={p}
                      title={`${k} · ${p}: ${n ? `${x} of ${n} searches (${pct(share)})` : "not searched yet"}`}
                      className={cn("size-6 min-w-6 rounded-sm text-center tabular-nums", !n && "bg-muted/40", n && !x && "bg-muted text-muted-foreground/70")}
                      style={n && x ? { backgroundColor: `color-mix(in oklab, var(--cta) ${Math.round(25 + share * 75)}%, transparent)` } : undefined}
                    >
                      {n ? x : ""}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const TAG_LABEL = Object.fromEntries(OFFER_TAGS.map((t) => [t.id, t.label])) as Record<OfferTag, string>

export function AdGallery({ creatives, advertisers }: { creatives: Creative[]; advertisers: string[] }) {
  const [who, setWho] = useState("")
  const [tag, setTag] = useState<OfferTag | "">("")
  const [shown, setShown] = useState(24)
  const list = creatives.filter((c) => (!who || c.d === who) && (!tag || c.tags.includes(tag)))
  const tagCounts = new Map<OfferTag, number>()
  for (const c of creatives) if (!who || c.d === who) for (const t of c.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + c.seen)
  const total = creatives.filter((c) => !who || c.d === who).reduce((n, c) => n + c.seen, 0)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select value={who} onChange={(e) => setWho(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-sm" aria-label="Advertiser">
          <option value="">Every advertiser</option>
          {advertisers.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setTag("")}
          className={cn("rounded-full border px-2.5 py-1", !tag ? "border-primary bg-primary/10" : "text-muted-foreground")}
        >
          Any offer
        </button>
        {OFFER_TAGS.filter((t) => tagCounts.has(t.id)).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTag(tag === t.id ? "" : t.id)}
            className={cn("rounded-full border px-2.5 py-1", tag === t.id ? "border-primary bg-primary/10" : "text-muted-foreground")}
            title="Share of the ads shown that say it"
          >
            {t.label} <span className="tabular-nums opacity-70">{pct((tagCounts.get(t.id) ?? 0) / Math.max(1, total))}</span>
          </button>
        ))}
      </div>
      {!list.length ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No ads match.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.slice(0, shown).map((c) => (
            <article key={`${c.d}|${c.t}|${c.desc}`} className="flex flex-col gap-1.5 rounded-xl border bg-background p-3">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Sponsored</span> · {c.dl || c.d}
              </p>
              <h3 className="leading-snug font-medium text-[#1a0dab] dark:text-[#8ab4f8]">{c.t || "(no headline)"}</h3>
              {c.desc && <p className="text-xs leading-relaxed text-muted-foreground">{c.desc}</p>}
              {c.links.length > 0 && <p className="text-xs text-[#1a0dab] dark:text-[#8ab4f8]">{c.links.join(" · ")}</p>}
              <div className="mt-auto flex flex-wrap gap-1 pt-1">
                {c.tags.map((t) => (
                  <span key={t} className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium">
                    {TAG_LABEL[t]}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Seen {fmt(c.seen)}× in {fmt(c.places)} {c.places === 1 ? "city" : "cities"}, {day(c.first)}
                {day(c.first) !== day(c.last) ? `–${day(c.last)}` : ""} · on {c.keywords.map((k) => `“${k}”`).join(", ")}
              </p>
            </article>
          ))}
        </div>
      )}
      {list.length > shown && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setShown((n) => n + 24)}>
          Show more ({fmt(list.length - shown)} left)
        </Button>
      )}
    </div>
  )
}
