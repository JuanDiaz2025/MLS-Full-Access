import type { Metadata } from "next"
import Link from "next/link"
import { ExternalLink } from "lucide-react"

import { AdGallery, CoverageGrid, SamplerCard } from "@/components/competitors/competitor-ads"
import { DataTable, KpiGrid, PageHeader, Section, type Column } from "@/components/report"
import { WatchButton } from "@/components/seo/watch-controls"
import { isAdmin } from "@/lib/auth"
import { DAYPARTS, analyzeAds, type AdvertiserRow, type Range } from "@/lib/competitors/ad-analysis"
import { readSamples } from "@/lib/competitors/ad-samples"
import { MAX_PER_WEEK, getSampler } from "@/lib/competitors/ad-sampler"
import { brightReady } from "@/lib/competitors/brightdata"
import { FREE_LIMIT, WINDOW_DAYS, freeSearches } from "@/lib/competitors/free-searches"
import { isDirectory } from "@/lib/research/serp-analysis"
import { OUR_SITES, scanPlaces } from "@/lib/research/serp"
import { getWatchList } from "@/lib/seo/competitors"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Competitor ads · DealTrack" }

const PERIODS = [7, 28, 90]
const DEVICES = [
  ["all", "Computer and phone"],
  ["desktop", "Computer"],
  ["mobile", "Phone"],
] as const

const fmt = (n: number) => n.toLocaleString("en-US")
const pct = (n: number) => `${Math.round(n * 100)}%`
const pctFine = (n: number) => (n < 0.1 ? `${(n * 100).toFixed(1)}%` : pct(n))
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })

// "32% (21–45%)", with "5 of 16" under it.
function Share({ r }: { r: Range }) {
  if (!r.n) return <span className="text-muted-foreground/60">–</span>
  return (
    <span className="flex flex-col items-end">
      <span>
        <b>{pct(r.share)}</b> <span className="text-xs text-muted-foreground">
          ({pct(r.lo)}–{pct(r.hi)})
        </span>
      </span>
      <span className="text-[11px] text-muted-foreground">
        {fmt(r.seen)} of {fmt(r.n)}
      </span>
    </span>
  )
}

function AdLibraries({ domain }: { domain: string }) {
  const name = domain.replace(/\.[a-z.]+$/, "")
  const link = "inline-flex items-center gap-0.5 whitespace-nowrap text-primary hover:underline"
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
      <a href={`https://adstransparency.google.com/?region=US&domain=${encodeURIComponent(domain)}`} target="_blank" rel="noreferrer" className={link}>
        Google ads <ExternalLink className="size-3" />
      </a>
      <a
        href={`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(name)}&search_type=keyword_unordered`}
        target="_blank"
        rel="noreferrer"
        className={link}
      >
        Facebook ads <ExternalLink className="size-3" />
      </a>
    </span>
  )
}

function SetupSteps() {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
      <li>
        Sign up at <b>brightdata.com</b>. The SERP API&apos;s free tier is 5,000 searches a month with no card. Don&apos;t add a card: then nothing can
        ever be charged.
      </li>
      <li>
        In the control panel, add a <b>SERP API</b> zone (name it, for example, <code>serp_dealtrack</code>).
      </li>
      <li>
        <b>Account settings → API keys</b>: create a key and copy it.
      </li>
      <li>
        In <code>dealtrack\.env.local</code> on <b>one</b> computer, add <code>BRIGHTDATA_API_KEY=</code> the key and <code>BRIGHTDATA_SERP_ZONE=</code> the
        zone&apos;s name. Restart the app.
      </li>
      <li>Come back here, click Test one search, then turn on the weekly searches.</li>
    </ol>
  )
}

export default async function CompetitorAdsPage({ searchParams }: { searchParams: Promise<{ days?: string; dev?: string }> }) {
  const q = await searchParams
  const days = PERIODS.includes(Number(q.days)) ? Number(q.days) : 28
  const dev = q.dev === "desktop" || q.dev === "mobile" ? q.dev : "all"
  const [all, sampler, free, admin, places, watched] = await Promise.all([readSamples(days), getSampler(), freeSearches(), isAdmin(), scanPlaces(), getWatchList()])
  const watching = new Set(watched.map((w) => w.site))
  const ready = brightReady()
  const samples = dev === "all" ? all : all.filter((s) => s.dev === dev)
  const a = analyzeAds(samples, OUR_SITES)
  const href = (next: { days?: number; dev?: string }) => {
    const p = new URLSearchParams()
    const d = next.days ?? days
    const v = next.dev ?? dev
    if (d !== 28) p.set("days", String(d))
    if (v !== "all") p.set("dev", v)
    return p.size ? `?${p}` : "?"
  }
  const chip = (active: boolean) => cn("rounded-md px-3 py-1.5", active ? "bg-background shadow-xs" : "text-muted-foreground")

  const columns: Column<AdvertiserRow>[] = [
    {
      key: "d",
      label: "Advertiser",
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{r.ours ? `${r.d} (you)` : r.d}</span>
          {!r.ours && <AdLibraries domain={r.d} />}
          {!r.ours && admin && !isDirectory(r.d) && <WatchButton site={r.d} from="ads" watching={watching.has(r.d)} />}
        </div>
      ),
    },
    { key: "share", label: "Shows in", align: "right", render: (r) => <Share r={r} /> },
    { key: "top", label: "Above results", align: "right", render: (r) => pct(r.top / Math.max(1, r.seen)) },
    { key: "first", label: "First ad", align: "right", render: (r) => pct(r.first / Math.max(1, r.seen)) },
    { key: "desktop", label: "On a computer", align: "right", render: (r) => <Share r={r.desktop} /> },
    { key: "mobile", label: "On a phone", align: "right", render: (r) => <Share r={r.mobile} /> },
    {
      key: "keywords",
      label: "Shows most on",
      className: "min-w-56",
      render: (r) => (
        <span className="text-xs">
          {r.keywords
            .slice(0, 3)
            .map((k) => `${k.k} (${k.seen}/${k.n})`)
            .join(" · ")}
        </span>
      ),
    },
    { key: "places", label: "Cities", align: "right", render: (r) => fmt(r.placesSeen) },
    { key: "creatives", label: "Ad versions", align: "right", render: (r) => fmt(r.creatives) },
    { key: "last", label: "Last seen", align: "right", render: (r) => day(r.lastSeen) },
  ]
  const tops = (list: { d: string; seen: number }[], n: number) =>
    list.length ? list.map((t) => `${t.d} ${pct(t.seen / Math.max(1, n))}`).join(" · ") : <span className="text-muted-foreground">no ads seen</span>

  return (
    <>
      <PageHeader
        title="Competitor ads"
        description={`Who advertises on Google for our seller searches, city by city, and what their ads say. DealTrack has Bright Data search Google from each city at random times every week and keeps every search, with ads or without: an advertiser's share is how many of those searches they showed in, with the range it likely sits in. Free: it stops itself at ${fmt(FREE_LIMIT)} searches in ${WINDOW_DAYS} days, under Bright Data's 5,000 free a month.`}
      />

      <Section title="Weekly searches" description="Our core seller searches, from our cities, spread over the week: mostly 6 AM to 10 PM Pacific, a few at night and on weekends.">
        {!ready && <SetupSteps />}
        <SamplerCard
          admin={admin}
          ready={ready}
          view={sampler}
          free={free}
          allPlaces={places.all}
          targeted={places.targeted}
          maxPerWeek={MAX_PER_WEEK}
          windowDays={WINDOW_DAYS}
        />
      </Section>

      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Period">
          {PERIODS.map((d) => (
            <Link key={d} href={href({ days: d })} className={chip(d === days)} aria-current={d === days ? "true" : undefined}>
              Last {d} days
            </Link>
          ))}
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Device">
          {DEVICES.map(([v, label]) => (
            <Link key={v} href={href({ dev: v })} className={chip(v === dev)} aria-current={v === dev ? "true" : undefined}>
              {label}
            </Link>
          ))}
        </div>
      </div>

      {!a.samples ? (
        <p className="rounded-2xl border bg-card p-6 text-center text-sm text-muted-foreground">
          No searches in this period yet. They come from the weekly searches above, and from Google rankings scans made with Bright Data.
        </p>
      ) : (
        <>
          <KpiGrid
            items={[
              { label: "Searches", value: fmt(a.samples), note: `${day(a.from)} – ${day(a.to)}` },
              { label: "With ads", value: pct(a.withAds / a.samples), note: `${fmt(a.withAds)} searches showed at least one ad` },
              { label: "Advertisers seen", value: fmt(a.advertisers.length), note: `${fmt(a.ads)} ads in all` },
              { label: "Free searches left", value: fmt(free.left), note: `Of ${fmt(free.cap)} in the last ${WINDOW_DAYS} days` },
            ]}
          />

          <Section
            title="Advertisers"
            description={`Shows in: the share of the ${fmt(a.samples)} searches that showed their ad, with the range it likely sits in (95%), which narrows as searches add up. Above results and First ad: how often their ad was above the results, or the very first, when it showed. An advertiser that isn't listed wasn't seen: in ${fmt(a.samples)} searches, that means they likely show in under ${pctFine(Math.min(1, 3 / a.samples))} of them. Your own row is a check: compare it with the search impression share Google Ads reports. Google's own numbers for our auctions are in Auction insights.`}
            actions={
              <Link href="/competitors/auction-insights" className="text-sm text-primary hover:underline">
                Auction insights →
              </Link>
            }
          >
            <DataTable rows={a.advertisers} columns={columns} rowKey={(r) => r.d} rowClassName={(r) => (r.ours ? "bg-accent/60" : undefined)} empty="No ads in these searches." />
          </Section>

          {a.advertisers.length > 0 && (
            <Section title="Where they show" description="Each keyword from each city. Pick an advertiser to see where they show and where they don't.">
              <CoverageGrid grid={a.grid} advertisers={a.advertisers.map((x) => ({ d: x.d, ours: x.ours }))} />
            </Section>
          )}

          {a.dayparts.rows.length > 0 && (
            <Section
              title="When they show"
              description="The share of searches at each time of day (Pacific) that showed each advertiser. One that drops off in the evening is likely out of budget by then, or turns ads off."
            >
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[640px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="px-4 py-2 text-left font-medium sm:pl-5">Advertiser</th>
                      {DAYPARTS.map((label, i) => (
                        <th key={label} className="px-3 py-2 text-right font-medium whitespace-nowrap">
                          {label}
                          <span className="block font-normal">{fmt(a.dayparts.n[i])} searches</span>
                        </th>
                      ))}
                      <th className="px-3 py-2 text-right font-medium whitespace-nowrap">
                        Weekdays<span className="block font-normal">{fmt(a.dayparts.weekday)}</span>
                      </th>
                      <th className="px-4 py-2 text-right font-medium whitespace-nowrap sm:pr-5">
                        Weekends<span className="block font-normal">{fmt(a.dayparts.weekend)}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.dayparts.rows.map((r) => (
                      <tr key={r.d} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-2 font-medium sm:pl-5">{r.d}</td>
                        {r.seen.map((x, i) => (
                          <td key={i} className="px-3 py-2 text-right tabular-nums">
                            {a.dayparts.n[i] ? pct(x / a.dayparts.n[i]) : "–"}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right tabular-nums">{a.dayparts.weekday ? pct(r.weekday / a.dayparts.weekday) : "–"}</td>
                        <td className="px-4 py-2 text-right tabular-nums sm:pr-5">{a.dayparts.weekend ? pct(r.weekend / a.dayparts.weekend) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <Section title="By keyword" description="How often each search showed ads, and who showed most.">
            <DataTable
              rows={a.keywords}
              rowKey={(r) => r.k}
              columns={[
                { key: "k", label: "Keyword", render: (r) => r.k },
                { key: "n", label: "Searches", align: "right", render: (r) => fmt(r.n) },
                { key: "ads", label: "With ads", align: "right", render: (r) => pct(r.withAds / Math.max(1, r.n)) },
                { key: "top", label: "Shown most", className: "text-xs", render: (r) => tops(r.top, r.n) },
              ]}
            />
          </Section>
          <Section title="By city" description="How often searches from each city showed ads, and who showed most.">
            <DataTable
              rows={a.places}
              rowKey={(r) => r.loc}
              columns={[
                { key: "loc", label: "City", render: (r) => r.loc },
                { key: "n", label: "Searches", align: "right", render: (r) => fmt(r.n) },
                { key: "ads", label: "With ads", align: "right", render: (r) => pct(r.withAds / Math.max(1, r.n)) },
                { key: "top", label: "Shown most", className: "text-xs", render: (r) => tops(r.top, r.n) },
              ]}
            />
          </Section>

          {a.creatives.length > 0 && (
            <Section title="Their ads" description="Every ad version seen, most seen first, with what it offers. The share on each offer is of the ads shown.">
              <AdGallery creatives={a.creatives} advertisers={a.advertisers.map((x) => x.d)} />
            </Section>
          )}

          {a.ai > 0 && (
            <p className="text-xs text-muted-foreground">
              {fmt(a.ai)} of the searches also showed an AI Overview, which usually leaves no room for ads.
            </p>
          )}
        </>
      )}
    </>
  )
}
