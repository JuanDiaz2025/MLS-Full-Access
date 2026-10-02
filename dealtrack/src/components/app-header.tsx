"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"

import { signOut } from "@/app/login/actions"
import BrandLogo from "@/components/brand-logo"
import LinkPending from "@/components/link-pending"
import { cn } from "@/lib/utils"

// Pages grouped the way PPC tools like Optmyzr group them. The first row picks a group, the
// second row shows that group's pages.
export const navGroups = [
  { label: "Overview", links: [{ href: "/overview", label: "Overview" }] },
  {
    label: "Leads",
    links: [
      { href: "/leads", label: "Leads & calls" },
      { href: "/leads/automation", label: "Lead automation" },
    ],
  },
  {
    label: "Monitor",
    links: [
      { href: "/alerts", label: "Alerts" },
      { href: "/fraud", label: "Fraud" },
      { href: "/compliance", label: "Compliance" },
      { href: "/budget", label: "Budget & pacing" },
      { href: "/quality-score", label: "Quality Score" },
    ],
  },
  {
    label: "Audit",
    links: [
      { href: "/audit", label: "Go-live audit" },
      { href: "/ads", label: "Ads & creatives" },
      { href: "/landing-pages", label: "Landing pages" },
      { href: "/conversions", label: "Conversions" },
    ],
  },
  {
    label: "Optimize",
    links: [
      { href: "/campaigns", label: "Campaigns" },
      { href: "/search-terms", label: "Search terms" },
      { href: "/negatives", label: "Weekly negatives" },
      { href: "/keywords", label: "Keywords" },
      { href: "/keyword-ideas", label: "Keyword ideas" },
      { href: "/locations", label: "Locations" },
      { href: "/schedule", label: "Day & hour" },
    ],
  },
  {
    label: "Insights",
    links: [
      { href: "/behavior", label: "Behavior" },
      { href: "/forecast", label: "Forecast" },
    ],
  },
  {
    label: "Reports",
    links: [
      { href: "/report", label: "Weekly report" },
      { href: "/changes", label: "Changes" },
      { href: "/deals", label: "Deal History" },
    ],
  },
] as const

// Keep the selected date range when switching pages.
function useRangeQuery() {
  const params = useSearchParams()
  const keep = new URLSearchParams()
  for (const key of ["range", "from", "to"]) {
    const value = params.get(key)
    if (value) keep.set(key, value)
  }
  const query = keep.toString()
  return query ? `?${query}` : ""
}

export default function AppHeader({
  showSignOut,
  admin,
  canSignInAsAdmin,
}: {
  showSignOut: boolean
  admin: boolean
  canSignInAsAdmin: boolean
}) {
  const pathname = usePathname()
  const query = useRangeQuery()
  // A page under a tab (a single campaign under Campaigns) lights up that tab, unless it has a tab of its own.
  const hasTab = navGroups.some((g) => g.links.some((l) => l.href === pathname))
  const isCurrent = (href: string) => pathname === href || (!hasTab && pathname.startsWith(`${href}/`))
  const active = navGroups.find((g) => g.links.some((l) => isCurrent(l.href))) ?? navGroups[0]

  const tab = (href: string, label: string, current: boolean) => (
    <Link
      key={href}
      href={`${href}${query}`}
      aria-current={current ? "page" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground",
        current && "bg-muted font-medium text-foreground",
      )}
    >
      {label}
      <LinkPending />
    </Link>
  )

  return (
    <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur-md print:hidden">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <BrandLogo />
        <div className="flex items-center gap-2">
          {admin ? (
            <span
              className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
              title="You can change negative keywords, excluded locations, and campaign status in Google Ads."
            >
              Admin
            </span>
          ) : (
            canSignInAsAdmin && (
              <Link
                href={`/login?admin=1&next=${encodeURIComponent(`${pathname}${query}`)}`}
                className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Admin sign-in
              </Link>
            )
          )}
          {showSignOut && (
            <form action={signOut}>
              <button type="submit" className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                Sign out
              </button>
            </form>
          )}
        </div>
      </div>
      <nav aria-label="Sections" className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-1 text-sm sm:px-6">
        {navGroups.map((g) => tab(g.links[0].href, g.label, g === active))}
      </nav>
      {active.links.length > 1 && (
        <nav aria-label={active.label} className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 text-xs sm:px-6">
          {active.links.map((l) => tab(l.href, l.label, isCurrent(l.href)))}
        </nav>
      )}
    </header>
  )
}
