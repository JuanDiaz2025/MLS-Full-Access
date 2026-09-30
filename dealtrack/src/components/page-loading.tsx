// What a page shows while its numbers load: a spinner with what's happening, and grey outlines
// of the page so it doesn't jump when the content arrives.

export default function PageLoading({ message = "Getting the latest numbers from Google Ads." }: { message?: string }) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="size-8 shrink-0 animate-spin rounded-full border-[3px] border-primary/20 border-t-primary motion-reduce:animate-none" aria-hidden />
        <div className="flex flex-col">
          <p className="font-medium">Loading…</p>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2" aria-hidden>
        <div className="h-7 w-56 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-full max-w-xl animate-pulse rounded-md bg-muted" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl border bg-card" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-2xl border bg-card" aria-hidden />
    </div>
  )
}
