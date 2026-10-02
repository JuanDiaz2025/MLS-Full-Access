import Link from "next/link"

// The Twin Home Buyer logo with the app name beside it, as in One Marketing Command Center.
// `large` is for the sign-in page, where the logo stands on its own with the name under it.
export default function BrandLogo({ href = "/overview", large = false }: { href?: string; large?: boolean }) {
  if (large) {
    return (
      <Link href={href} aria-label="DealTrack" className="flex flex-col items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Twin Home Buyer" className="h-auto w-72 max-w-full" />
        <span className="text-sm font-medium text-muted-foreground">DealTrack · Marketing Command Center</span>
      </Link>
    )
  }
  return (
    <Link href={href} aria-label="DealTrack" className="flex items-center gap-3 font-semibold tracking-tight whitespace-nowrap">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="Twin Home Buyer" className="h-12 w-auto shrink-0" />
      <span className="hidden border-l pl-3 text-sm text-muted-foreground sm:inline">DealTrack</span>
    </Link>
  )
}
