// Shown while the slower checks run (PageSpeed tests, page checks, simulations).
export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-4 w-full max-w-xl animate-pulse rounded-md bg-muted" />
      <div className="h-64 animate-pulse rounded-2xl border bg-card" />
      <p className="text-sm text-muted-foreground">Checking pages and crunching numbers. This can take up to 30 seconds the first time.</p>
    </div>
  )
}
