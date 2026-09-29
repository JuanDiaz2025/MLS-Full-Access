"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"

import { signOut } from "@/app/login/actions"
import BrandLogo from "@/components/brand-logo"
import { cn } from "@/lib/utils"

export const navLinks = [
  { href: "/overview", label: "Overview" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/search-terms", label: "Search terms" },
  { href: "/keywords", label: "Keywords" },
  { href: "/locations", label: "Locations" },
  { href: "/schedule", label: "Day & hour" },
  { href: "/conversions", label: "Conversions" },
  { href: "/landing-pages", label: "Landing pages" },
  { href: "/behavior", label: "Behavior" },
  { href: "/forecast", label: "Forecast" },
  { href: "/alerts", label: "Alerts" },
  { href: "/changes", label: "Changes" },
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

  const links = navLinks.map((l) => {
    const current = pathname === l.href
    return (
      <Link
        key={l.href}
        href={`${l.href}${query}`}
        aria-current={current ? "page" : undefined}
        className={cn(
          "shrink-0 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground",
          current && "bg-muted font-medium text-foreground",
        )}
      >
        {l.label}
      </Link>
    )
  })

  return (
    <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <BrandLogo />
        <div className="flex items-center gap-2">
          {admin ? (
            <span
              className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
              title="You can change negative keywords and excluded locations in Google Ads."
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
      <nav aria-label="Reports" className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 text-sm sm:px-6">
        {links}
      </nav>
    </header>
  )
}
