"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Gauge, X } from "lucide-react"

import { Button } from "@/components/ui/button"

const typing = (t: EventTarget | null) => t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)

// "How scores work" on the left edge of the Leads page: a tab that stays put while you scroll and
// slides the scoring guide out from the left, one click away from anywhere in the list. It sits
// over the page without dimming it, so the leads stay readable next to it (and the lead panel can
// be open on the right at the same time). The guide comes in as children, rendered on the server.
export default function ScoringGuideTab({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const tab = useRef<HTMLButtonElement>(null)
  const drawer = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  // Hands the keyboard back to the tab if it was in the guide.
  const close = useCallback(() => {
    if (drawer.current?.contains(document.activeElement)) tab.current?.focus()
    setOpen(false)
  }, [])

  // The guide takes focus when it opens. Esc inside it is handled on the guide itself, which marks
  // the key as used so the lead panel doesn't close too; this is Esc anywhere else on the page,
  // unless you're typing or working in the lead panel, which has its own Esc.
  useEffect(() => {
    if (!open) return
    heading.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || typing(e.target)) return
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return
      close()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, close])

  return (
    <>
      <button
        ref={tab}
        type="button"
        aria-expanded={open}
        aria-controls="scoring-guide"
        onClick={() => setOpen(true)}
        className="fixed top-1/2 left-0 z-40 flex -translate-y-1/2 items-center gap-2 rounded-r-lg border border-l-0 bg-card px-1.5 py-3.5 text-xs font-semibold text-foreground shadow-md [writing-mode:vertical-rl] hover:bg-muted print:hidden"
      >
        <Gauge className="size-4 text-primary" aria-hidden />
        How scores work
      </button>
      {open && (
        <aside
          id="scoring-guide"
          ref={drawer}
          role="dialog"
          aria-modal="false"
          aria-labelledby="scoring-guide-title"
          onKeyDown={(e) => {
            if (e.key !== "Escape" || typing(e.target)) return
            e.preventDefault()
            close()
          }}
          className="fixed inset-y-0 left-0 z-50 flex w-full max-w-[30rem] flex-col border-r bg-background text-foreground shadow-2xl sm:w-[30rem] print:hidden"
        >
          <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
            <h2 id="scoring-guide-title" ref={heading} tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold outline-none">
              <Gauge className="size-5 text-primary" aria-hidden />
              How lead scores work
            </h2>
            <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={close}>
              <X />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </aside>
      )}
    </>
  )
}
