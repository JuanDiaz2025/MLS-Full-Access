"use client"

// The Batches tab's left column: batches that need someone first, finished ones folded below.

import { useWorkspace } from "@/components/negatives/context"
import { batchScope, batchSummary, batchTitle, needsAction, stageLabel, waiting, type BatchView } from "@/components/negatives/parts"
import { Pill } from "@/components/pill"
import { cn } from "@/lib/utils"

export default function BatchList({ batches, selectedId, onPick }: { batches: BatchView[]; selectedId: string | null; onPick: (id: string) => void }) {
  const open = batches.filter(needsAction)
  const later = batches.filter(waiting)
  const done = batches.filter((b) => !needsAction(b) && !waiting(b))
  const selectedIsDone = done.some((b) => b.id === selectedId)

  return (
    <nav aria-label="Batches" className="flex flex-col gap-3">
      <Group title="Needs action" empty="Nothing to do right now. Draft a new batch when you're ready." batches={open} selectedId={selectedId} onPick={onPick} />
      {later.length > 0 && <Group title="Waiting for the result check" batches={later} selectedId={selectedId} onPick={onPick} />}
      {done.length > 0 && (
        <details open={selectedIsDone || (!open.length && !later.length)} className="group">
          <summary className="cursor-pointer px-1 text-xs font-medium text-muted-foreground hover:text-foreground">Finished ({done.length})</summary>
          <div className="mt-2">
            <Group batches={done} selectedId={selectedId} onPick={onPick} />
          </div>
        </details>
      )}
    </nav>
  )
}

function Group({
  title,
  empty,
  batches,
  selectedId,
  onPick,
}: {
  title?: string
  empty?: string
  batches: BatchView[]
  selectedId: string | null
  onPick: (id: string) => void
}) {
  const { notice } = useWorkspace()
  return (
    <div className="flex flex-col gap-1.5">
      {title && (
        <h2 className="px-1 text-xs font-medium text-muted-foreground">
          {title} ({batches.length})
        </h2>
      )}
      {batches.length === 0 && empty && <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">{empty}</p>}
      <ul className="flex flex-col gap-1.5">
        {batches.map((b) => {
          const selected = b.id === selectedId
          const stage = stageLabel[b.stage]
          return (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => onPick(b.id)}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "flex w-full flex-col gap-1 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40",
                  selected && "border-primary bg-primary/5 ring-1 ring-primary/30",
                  notice?.batchId === b.id && !selected && "border-emerald-400",
                )}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0 text-sm font-medium">{batchTitle(b)}</span>
                  <Pill tone={stage.tone}>{stage.label}</Pill>
                </span>
                <span className="truncate text-xs text-muted-foreground">{batchScope(b)}</span>
                <span className="text-xs text-muted-foreground">
                  {batchSummary(b)} · drafted by {b.drafted.by}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
