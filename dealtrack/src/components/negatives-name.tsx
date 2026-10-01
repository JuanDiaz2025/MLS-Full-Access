"use client"

// The name typed at the top of Weekly negatives, shared with the campaign check below it, so
// every step records who did it without asking twice.

import { createContext, useContext, useState, type ReactNode } from "react"

const NameContext = createContext<{ name: string; setName: (name: string) => void } | null>(null)

export function NameProvider({ initial, children }: { initial: string; children: ReactNode }) {
  const [name, setName] = useState(initial)
  return <NameContext.Provider value={{ name, setName }}>{children}</NameContext.Provider>
}

export function useName() {
  const value = useContext(NameContext)
  if (!value) throw new Error("useName needs a NameProvider")
  return value
}
