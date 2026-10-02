"use client"

// Filters the campaigns table as you type. The words go into the address (?q=), so the server
// filters the list and the search survives a refresh or a shared link.

import { useEffect, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Search, X } from "lucide-react"

export default function CampaignSearch() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [value, setValue] = useState(params.get("q") ?? "")
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (value === (params.get("q") ?? "")) return
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params)
      if (value.trim()) next.set("q", value.trim())
      else next.delete("q")
      startTransition(() => router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }))
    }, 250)
    return () => clearTimeout(timer)
  }, [value, params, pathname, router])

  return (
    <label className="relative flex w-full items-center sm:w-72">
      <span className="sr-only">Search campaigns</span>
      <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search campaigns…"
        className="h-9 w-full rounded-lg border border-input bg-background pr-8 pl-8 text-sm [&::-webkit-search-cancel-button]:hidden"
        aria-busy={pending}
      />
      {value && (
        <button
          type="button"
          onClick={() => setValue("")}
          className="absolute right-2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </label>
  )
}
