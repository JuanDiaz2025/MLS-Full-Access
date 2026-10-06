"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { MessageSquareText } from "lucide-react"

import Assistant from "@/components/assistant/assistant"
import { ASK_EVENT } from "@/components/assistant/ask-button"
import { cn } from "@/lib/utils"

// A button that stays in the bottom corner of every page and opens the assistant in a panel.
// The assistant stays mounted while closed, so the conversation is still there when reopened.
// It can grow to fill the screen (remembered on this browser), and the /ask page has it on its own.
const BIG_KEY = "dealtrack-chat-big"

export default function AssistantLauncher({ enabled, context }: { enabled: boolean; context?: string }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [big, setBig] = useState(false)
  // The full-screen choice is read when the panel opens (not while the page is drawn on the server).
  const openPanel = () => {
    try {
      setBig(window.localStorage.getItem(BIG_KEY) === "1")
    } catch {}
    setOpen(true)
  }
  const toggleBig = () =>
    setBig((b) => {
      try {
        window.localStorage.setItem(BIG_KEY, b ? "0" : "1")
      } catch {}
      return !b
    })

  // "Ask how to fix" buttons open the panel; the assistant itself picks up the question.
  useEffect(() => {
    const onAsk = () => openPanel()
    window.addEventListener(ASK_EVENT, onAsk)
    return () => window.removeEventListener(ASK_EVENT, onAsk)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  // The /ask page is the chat itself.
  if (pathname === "/ask") return null

  return (
    <>
      {open && big && <div className="fixed inset-0 z-30 hidden bg-black/30 sm:block" onClick={() => setOpen(false)} aria-hidden />}
      <div
        className={cn(
          "fixed inset-x-3 bottom-3 z-40 h-[min(44rem,calc(100dvh-1.5rem))] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[28rem]",
          big && "sm:top-6 sm:right-1/2 sm:h-auto sm:w-[min(64rem,calc(100vw-3rem))] sm:translate-x-1/2",
          !open && "hidden",
        )}
      >
        <Assistant enabled={enabled} context={context} onClose={() => setOpen(false)} expanded={big} onExpand={toggleBig} />
      </div>
      {!open && (
        <button
          type="button"
          onClick={openPanel}
          className="fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-semibold text-primary-foreground shadow-xl shadow-primary/30 transition hover:brightness-110 sm:right-6 sm:bottom-6 print:hidden"
        >
          <MessageSquareText className="size-5" />
          Ask about your ads
        </button>
      )}
    </>
  )
}
