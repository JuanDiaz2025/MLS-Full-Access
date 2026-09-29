// KPI tiles with the change against the period before and a sparkline of the period.

import Sparkline from "@/components/dashboard/sparkline"
import { cn } from "@/lib/utils"
import type { Delta } from "@/lib/overview-metrics"

export type TrendKpi = { label: string; value: string; delta?: Delta; note?: string; spark: (number | null)[] }

const deltaTone = { good: "text-emerald-700", bad: "text-destructive", neutral: "text-muted-foreground" } as const

export default function TrendKpis({ items, caption }: { items: TrendKpi[]; caption?: string }) {
  return (
    <section aria-label="Summary" className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {items.map((kpi) => (
          <div key={kpi.label} className="flex flex-col rounded-2xl border bg-card p-4 shadow-xs">
            <p className="text-xs text-muted-foreground">{kpi.label}</p>
            <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{kpi.value}</p>
            <p className="mt-1 text-xs">
              {kpi.delta ? <span className={cn("font-medium tabular-nums", deltaTone[kpi.delta.tone])}>{kpi.delta.text}</span> : <span className="text-muted-foreground">—</span>}
              {kpi.note && <span className="text-muted-foreground"> · {kpi.note}</span>}
            </p>
            <Sparkline values={kpi.spark} className="mt-auto pt-2 text-primary/70" />
          </div>
        ))}
      </div>
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </section>
  )
}
