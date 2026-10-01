"use client"

import { useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Props = {
  // Rendered rows: <li> elements for a list, <tr> elements for a table.
  items: React.ReactNode[]
  pageSize?: number
  // What the rows are, for "Showing 1–10 of 57 searches".
  noun: string
  // Renders the rows in a table under this <thead>; otherwise in a <ul>.
  table?: { head: React.ReactNode; className?: string; bodyClassName?: string }
  listClassName?: string
  controlsClassName?: string
}

// Shows a long list a page at a time, so the dashboard doesn't scroll forever.
export default function Paged({ items, pageSize = 10, noun, table, listClassName, controlsClassName }: Props) {
  const [page, setPage] = useState(0)
  const top = useRef<HTMLDivElement>(null)
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const current = Math.min(page, pages - 1)
  const visible = items.slice(current * pageSize, (current + 1) * pageSize)

  const go = (next: number) => {
    setPage(next)
    // Keep the top of the list in view when a shorter page makes the content jump.
    top.current?.scrollIntoView({ block: "nearest" })
  }

  return (
    <div ref={top} className="scroll-mt-20">
      {table ? (
        <div className="overflow-x-auto">
          <table className={table.className}>
            {table.head}
            <tbody className={table.bodyClassName}>{visible}</tbody>
          </table>
        </div>
      ) : (
        <ul className={listClassName}>{visible}</ul>
      )}
      {pages > 1 && (
        <nav
          aria-label={`${noun} pages`}
          className={cn("flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-sm sm:px-6", controlsClassName)}
        >
          <span className="text-muted-foreground">
            Showing {current * pageSize + 1}–{current * pageSize + visible.length} of {items.length} {noun}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => go(current - 1)} disabled={current === 0}>
              <ChevronLeft data-icon="inline-start" />
              Previous
            </Button>
            <span className="px-2 text-muted-foreground tabular-nums">
              Page {current + 1} of {pages}
            </span>
            <Button variant="outline" size="sm" onClick={() => go(current + 1)} disabled={current === pages - 1}>
              Next
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </nav>
      )}
    </div>
  )
}
