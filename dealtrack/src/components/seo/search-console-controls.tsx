"use client"

// Competitors → SEO → Our Google numbers: picking the Search Console property (admins) and
// getting the numbers again now (they're kept an hour).

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { LoaderCircle, RefreshCw, Save } from "lucide-react"

import { pickSearchConsoleSiteAction, refreshSearchConsoleAction, type SeoState } from "@/app/actions/seo"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function Message({ m }: { m: SeoState | null }) {
  if (!m) return null
  return (
    <p role="status" className={cn("text-xs", m.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
      {m.message}
    </p>
  )
}

// "sc-domain:twinhomebuyer.com" → "twinhomebuyer.com (the whole domain)"
const siteLabel = (s: string) => (s.startsWith("sc-domain:") ? `${s.slice(10)} (the whole domain)` : s)

export function SitePicker({ sites, current, admin }: { sites: { site: string; level: string }[]; current: string | null; admin: boolean }) {
  const router = useRouter()
  const [site, setSite] = useState(current && sites.some((s) => s.site === current) ? current : (sites[0]?.site ?? ""))
  const [message, setMessage] = useState<SeoState | null>(null)
  const [busy, start] = useTransition()
  if (!sites.length)
    return (
      <p className="text-sm text-muted-foreground">
        The connected Google account can&apos;t open any Search Console property. In Search Console, add it under Settings → Users and permissions (Restricted is enough), then
        refresh this page.
      </p>
    )
  if (!admin) return <p className="text-sm text-muted-foreground">An admin picks the Search Console property once.</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={site} onChange={(e) => setSite(e.target.value)} aria-label="Search Console property" className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm">
          {sites.map((s) => (
            <option key={s.site} value={s.site}>
              {siteLabel(s.site)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          disabled={busy || !site}
          onClick={() =>
            start(async () => {
              setMessage(null)
              setMessage(await pickSearchConsoleSiteAction(site))
              router.refresh()
            })
          }
        >
          {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
          Read this one
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Pick the one for twinhomebuyer.com. “The whole domain” covers www and every page.</p>
      <Message m={message} />
    </div>
  )
}

export function RefreshButton({ days }: { days: number }) {
  const router = useRouter()
  const [message, setMessage] = useState<SeoState | null>(null)
  const [busy, start] = useTransition()
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          start(async () => {
            setMessage(null)
            const r = await refreshSearchConsoleAction(days)
            if (!r.ok) setMessage(r)
            router.refresh()
          })
        }
      >
        {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
        Get the latest
      </Button>
      <Message m={message} />
    </span>
  )
}
