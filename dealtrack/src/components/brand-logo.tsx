import Link from "next/link"

// The Twin Home Buyer logo with "Marketing Command Center" beside it, as in One Marketing Command Center.
// `large` is for the sign-in page, where the logo stands on its own with the name under it.
export default function BrandLogo({ href = "/overview", large = false }: { href?: string; large?: boolean }) {
  if (large) {
    return (
      <Link href={href} aria-label="DealTrack" className="flex flex-col items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Twin Home Buyer" className="h-auto w-72 max-w-full dark:rounded-xl dark:bg-white dark:p-2" />
        <span className="text-sm font-medium text-muted-foreground">Marketing Command Center</span>
      </Link>
    )
  }
  return (
    <Link href={href} aria-label="DealTrack" className="flex items-center gap-3 font-semibold tracking-tight whitespace-nowrap">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="Twin Home Buyer" className="h-12 w-auto shrink-0 dark:rounded-lg dark:bg-white dark:px-1.5 dark:py-0.5" />
      <span className="hidden border-l pl-3 text-sm text-muted-foreground sm:inline">Marketing Command Center</span>
    </Link>
  )
}
