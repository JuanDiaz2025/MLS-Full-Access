// A small colored label. Kept on its own (no server imports) so client components can use it too.

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

const pillTones = {
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
  gray: "bg-muted text-muted-foreground",
  violet: "bg-secondary text-secondary-foreground",
} as const

export type PillTone = keyof typeof pillTones

export function Pill({ tone = "gray", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", pillTones[tone])}>
      {children}
    </span>
  )
}
