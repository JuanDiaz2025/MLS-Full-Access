"use client"

import { useState } from "react"

// A <details> box that starts open or closed and then stays the way the person leaves it, even
// when the page's data refreshes (a plain open={...} would snap shut when the data changes).
export default function Disclosure({
  initialOpen,
  className,
  children,
}: {
  initialOpen: boolean
  className?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <details className={className} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      {children}
    </details>
  )
}
