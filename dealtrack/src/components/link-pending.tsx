"use client"

// Put inside a <Link>: while the page it opens is loading, a spinner shows on the link and a bar
// runs across the top of the window, so a click visibly does something (some pages, like a
// 12-month range, take a few seconds to gather). From One Marketing Command Center.

import { useLinkStatus } from "next/link"
import { LoaderCircle } from "lucide-react"

export default function LinkPending() {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return (
    <>
      <LoaderCircle aria-label="Loading" className="size-3.5 animate-spin" />
      <span aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-1 animate-pulse bg-primary" />
    </>
  )
}
