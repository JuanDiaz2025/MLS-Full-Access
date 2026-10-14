import type { Metadata } from "next"
import Link from "next/link"

import { PageHeader } from "@/components/report"
import GoogleTab, { SC_PERIODS } from "@/components/seo/google-tab"
import KeywordsTab from "@/components/seo/keywords-tab"
import RankingsTab from "@/components/seo/rankings-tab"
import WatchTab from "@/components/seo/watch-tab"
import { isAdmin } from "@/lib/auth"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "SEO · DealTrack" }

const TABS = [
  { id: "keywords", label: "Keywords" },
  { id: "google", label: "Our Google numbers" },
  { id: "rankings", label: "Rankings by city" },
  { id: "watch", label: "Competitor watch" },
] as const
type TabId = (typeof TABS)[number]["id"]

// After "Connect Google" (lib/conversions/connect.ts), Google sends the admin back with how it went.
const CONNECT_RESULTS: Record<string, string> = {
  ok: "Google is connected. Pick the Search Console property below if it asks.",
  cancelled: "Google wasn't connected: it was cancelled, or the account signed in isn't an admin's.",
  expired: "That took too long. Click Connect Google again.",
  failed: "Google didn't finish connecting. Click Connect Google again.",
  no_permission: "Google was connected without every permission DealTrack asked for. Click Connect Google again and leave every box ticked.",
}

// Our own Semrush for Google's free results, California only: how many people search each keyword
// in each city and who ranks there (Keywords, Rankings by city), our own numbers from Google
// (Search Console), and what competitors change on their websites (Competitor watch). Each tab
// loads only its own data.
export default async function SeoPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; place?: string; days?: string; site?: string; connect?: string; pick?: string; dirs?: string }>
}) {
  const sp = await searchParams
  const tab: TabId = TABS.find((t) => t.id === sp.tab)?.id ?? (sp.connect ? "google" : "keywords")
  const admin = await isAdmin()
  const days = SC_PERIODS.includes(Number(sp.days)) ? Number(sp.days) : 28

  return (
    <>
      <PageHeader
        title="SEO"
        description="Our own Semrush for Google, California only: how many people search each keyword in each city, who ranks there and what that's worth in visits, our own numbers from Google, and what competitors change on their websites. Free: Keyword Planner, Search Console and our ads are Google's own numbers; rankings and Google Trends use Bright Data's free searches; competitor websites are read politely, as their robots.txt allows."
      />
      {sp.connect && (
        <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", sp.connect === "ok" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-muted")}>
          {CONNECT_RESULTS[sp.connect] ?? CONNECT_RESULTS.failed}
        </p>
      )}

      <nav aria-label="SEO sections" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`?tab=${t.id}`}
            scroll={false}
            aria-current={t.id === tab ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:border-primary/40 hover:text-foreground",
              t.id === tab && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "keywords" && <KeywordsTab admin={admin} place={sp.place} />}
      {tab === "google" && <GoogleTab admin={admin} days={days} pick={sp.pick === "1"} />}
      {tab === "rankings" && <RankingsTab admin={admin} place={sp.place} dirs={sp.dirs === "1"} />}
      {tab === "watch" && <WatchTab admin={admin} site={sp.site} />}
    </>
  )
}
