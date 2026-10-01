"use client"

// What the Weekly negatives workspace shares between its tabs: the name that goes on every step,
// the open tab, the selected batch, and the last status message. The tab and batch are kept in
// the URL (?tab=&batch=), so a refresh or a shared link opens the same view.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

import type { StepResult } from "@/app/actions/negatives"
import type { Tab } from "@/components/negatives/tabs"

type Workspace = {
  name: string
  setName: (name: string) => void
  tab: Tab
  setTab: (tab: Tab) => void
  batchId: string | null
  selectBatch: (id: string) => void
  // Shows the batch a draft just made, on the Batches tab.
  openBatch: (id: string) => void
  notice: StepResult | null
  setNotice: (notice: StepResult | null) => void
}

const WorkspaceContext = createContext<Workspace | null>(null)

export function WorkspaceProvider({
  initial,
  children,
}: {
  initial: { name: string; tab: Tab; batchId: string | null }
  children: ReactNode
}) {
  const [name, setName] = useState(initial.name)
  const [tab, setTab] = useState<Tab>(initial.tab)
  const [batchId, selectBatch] = useState<string | null>(initial.batchId)
  const [notice, setNotice] = useState<StepResult | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set("tab", tab)
    if (batchId && tab === "batches") params.set("batch", batchId)
    else params.delete("batch")
    const next = `${window.location.pathname}?${params}`
    // The native History API is how Next.js expects a shallow URL change (it syncs its router).
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next)
  }, [tab, batchId])

  const openBatch = (id: string) => {
    selectBatch(id)
    setTab("batches")
  }
  // A message belongs to the tab it came from; moving on clears it.
  const changeTab = (next: Tab) => {
    if (next !== tab) setNotice(null)
    setTab(next)
  }

  return (
    <WorkspaceContext.Provider value={{ name, setName, tab, setTab: changeTab, batchId, selectBatch, openBatch, notice, setNotice }}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error("useWorkspace needs a WorkspaceProvider")
  return value
}
