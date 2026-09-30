"use client"

import { useTransition } from "react"
import { RefreshCw } from "lucide-react"

import { refreshReports } from "@/app/actions/data"
import { cn } from "@/lib/utils"

export default function RefreshButton() {
  const [pending, startTransition] = useTransition()
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => refreshReports())}
      className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-70"
    >
      <RefreshCw className={cn("size-3", pending && "animate-spin")} aria-hidden />
      {pending ? "Refreshing…" : "Refresh now"}
    </button>
  )
}
