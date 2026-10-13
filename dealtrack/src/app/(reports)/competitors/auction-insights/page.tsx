import type { Metadata } from "next"
import Link from "next/link"
import { ExternalLink } from "lucide-react"

import { AuctionUpload, DeleteAuctionUpload } from "@/components/competitors/auction-upload"
import { DataTable, KpiGrid, PageHeader, Pill, Section, type Column } from "@/components/report"
import { getAuctionUploads, type AuctionUpload as Upload } from "@/lib/competitors/auction-insights"
import type { AuctionRow, MetricId } from "@/lib/competitors/auction-parse"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Auction insights · DealTrack" }

const SPLIT_LABELS: Record<string, string> = { campaign: "Campaign", adGroup: "Ad group", keyword: "Keyword", device: "Device", period: "Period" }

// 0.455 → "45.5%"; "< 10%" stays as Google wrote it.
function pctText(row: AuctionRow, id: MetricId) {
  const v = row[id]
  if (v === undefined) return "–"
  return row.below?.includes(id) ? `< ${Math.round(v * 100)}%` : `${(v * 100).toFixed(1)}%`
}
const pct = (row: AuctionRow, id: MetricId) => (row[id] === undefined ? <span className="text-muted-foreground/60">–</span> : pctText(row, id))

const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" })
const periodOf = (u: Upload) => u.range ?? `Uploaded ${when(u.at)}`

// Their ads, in Google's and Meta's public ad libraries (opened by a person, never fetched by DealTrack).
function AdLibraries({ domain }: { domain: string }) {
  const name = domain.replace(/\.[a-z.]+$/, "")
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
      <a
        href={`https://adstransparency.google.com/?region=US&domain=${encodeURIComponent(domain)}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 whitespace-nowrap text-primary hover:underline"
      >
        Google ads <ExternalLink className="size-3" />
      </a>
      <a
        href={`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(name)}&search_type=keyword_unordered`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 whitespace-nowrap text-primary hover:underline"
      >
        Facebook ads <ExternalLink className="size-3" />
      </a>
    </span>
  )
}

export default async function AuctionInsightsPage({ searchParams }: { searchParams: Promise<{ u?: string }> }) {
  const { u } = await searchParams
  const uploads = await getAuctionUploads()
  const current = uploads.find((x) => x.id === u) ?? uploads[0]

  const rows = current
    ? [...current.rows].sort(
        (a, b) =>
          current.splitBy.map((s) => (a[s as keyof AuctionRow] as string | undefined) ?? "").join("|").localeCompare(current.splitBy.map((s) => (b[s as keyof AuctionRow] as string | undefined) ?? "").join("|")) ||
          Number(Boolean(b.you)) - Number(Boolean(a.you)) ||
          (b.is ?? 0) - (a.is ?? 0),
      )
    : []
  const columns: Column<AuctionRow>[] = [
    {
      key: "domain",
      label: "Advertiser",
      render: (r) =>
        r.you ? (
          <span className="font-semibold">You (Twin Home Buyer)</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{r.domain}</span>
            <AdLibraries domain={r.domain} />
          </div>
        ),
    },
    ...(current?.splitBy ?? []).map((s) => ({ key: s, label: SPLIT_LABELS[s] ?? s, render: (r: AuctionRow) => (r[s as keyof AuctionRow] as string | undefined) ?? "–" })),
    { key: "is", label: "Impression share", align: "right", render: (r) => pct(r, "is") },
    { key: "overlap", label: "Overlap", align: "right", render: (r) => pct(r, "overlap") },
    { key: "above", label: "Ranks above you", align: "right", render: (r) => pct(r, "above") },
    { key: "top", label: "Top of page", align: "right", render: (r) => pct(r, "top") },
    { key: "absTop", label: "Very top", align: "right", render: (r) => pct(r, "absTop") },
    { key: "out", label: "You outrank them", align: "right", render: (r) => pct(r, "out") },
  ]

  // A whole-report upload (not split by campaign, week...) is one point in each competitor's trend.
  const whole = uploads.filter((x) => !x.splitBy.length).sort((a, b) => (a.to ?? a.at).localeCompare(b.to ?? b.at))
  const latestWhole = whole.at(-1)
  const trendDomains = latestWhole
    ? [...latestWhole.rows]
        .filter((r) => !r.you)
        .sort((a, b) => (b.is ?? 0) - (a.is ?? 0))
        .slice(0, 12)
        .map((r) => r.domain)
    : []
  const you = current?.rows.find((r) => r.you && !current.splitBy.length)
  const others = current ? current.rows.filter((r) => !r.you) : []
  const biggest = [...others].sort((a, b) => (b.is ?? 0) - (a.is ?? 0))[0]
  const above = [...others].sort((a, b) => (b.above ?? 0) - (a.above ?? 0))[0]

  return (
    <>
      <PageHeader
        title="Auction insights"
        description="Who competes with you in your own Google Ads auctions, from Google itself: how often each one shows, how often they show when you do, and how often they rank above you. Free. Google doesn't offer it through its API, so it's a download from Google Ads, uploaded here once a week or once a month."
      />

      <Section
        title="Add a download"
        description={
          <>
            In Google Ads, open <strong>Campaigns</strong> (all, or one campaign), then <strong>Insights and reports → Auction insights</strong>. Pick the date range
            (for example last week or last month), click <strong>Download</strong> and choose <strong>.csv</strong>. Then upload the file here. Each upload is kept, so
            the trend below grows over time.
          </>
        }
      >
        <AuctionUpload />
      </Section>

      {!current ? (
        <p className="rounded-2xl border bg-card p-6 text-center text-sm text-muted-foreground">No downloads yet. Upload your first Auction insights file above.</p>
      ) : (
        <>
          <KpiGrid
            items={[
              { label: "Competitors seen", value: String(new Set(others.map((r) => r.domain)).size), note: periodOf(current) },
              { label: "Your impression share", value: you ? pctText(you, "is") : "–", note: "Of the auctions you could show in" },
              { label: "Biggest competitor", value: biggest ? pctText(biggest, "is") : "–", note: biggest ? `Impression share of ${biggest.domain}` : undefined },
              { label: "Most often above you", value: above ? pctText(above, "above") : "–", note: above ? `${above.domain}, of the auctions you both showed in` : undefined },
            ]}
          />

          <Section
            title={`Competitors · ${periodOf(current)}`}
            description="Impression share: how often they showed, of the auctions they could. Overlap: how often they showed when you did. Ranks above you: of those shared auctions, how often their ad was above yours. You outrank them: how often yours was above theirs, or they didn't show. The links open each one's ads in Google's and Meta's public ad libraries."
          >
            <DataTable rows={rows} columns={columns} rowKey={(r) => `${r.domain}|${current.splitBy.map((s) => r[s as keyof AuctionRow] ?? "").join("|")}`} rowClassName={(r) => (r.you ? "bg-accent/60" : undefined)} empty="No advertisers in this download." />
          </Section>

          {whole.length >= 2 && (
            <Section title="Impression share over time" description="Each column is one whole-account download, oldest first, for the competitors in the newest one.">
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[640px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="px-4 py-2 text-left font-medium sm:pl-5">Advertiser</th>
                      {whole.map((w) => (
                        <th key={w.id} className="px-4 py-2 text-right font-medium whitespace-nowrap">
                          {w.to ? new Date(`${w.to}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : when(w.at)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {["You", ...trendDomains].map((d) => (
                      <tr key={d} className={cn("border-b border-border/60 last:border-0", d === "You" && "bg-accent/60")}>
                        <td className="px-4 py-2 font-medium sm:pl-5">{d === "You" ? "You (Twin Home Buyer)" : d}</td>
                        {whole.map((w) => {
                          const r = w.rows.find((x) => (d === "You" ? x.you : x.domain === d))
                          return (
                            <td key={w.id} className="px-4 py-2 text-right tabular-nums">
                              {r ? pct(r, "is") : <span className="text-muted-foreground/60">not seen</span>}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <Section title="Uploads" description="Click one to see it. Downloads split by campaign, week or device show those columns in the table.">
            <ul className="flex flex-col divide-y text-sm">
              {uploads.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`?u=${x.id}`} className={cn("flex flex-col hover:underline", x.id === current.id && "font-semibold")}>
                    <span>{periodOf(x)}</span>
                    <span className="text-xs text-muted-foreground">
                      {x.file} · {x.rows.filter((r) => !r.you).length} rows · uploaded {when(x.at)} by {x.by}
                    </span>
                  </Link>
                  <span className="flex items-center gap-2">
                    {x.splitBy.length > 0 && <Pill>By {x.splitBy.map((s) => (SPLIT_LABELS[s] ?? s).toLowerCase()).join(", ")}</Pill>}
                    <DeleteAuctionUpload id={x.id} />
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </>
  )
}
