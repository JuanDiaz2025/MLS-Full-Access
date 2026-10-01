"use client"

import { useEffect, useState } from "react"
import { MessageSquareText } from "lucide-react"

import Assistant from "@/components/assistant/assistant"
import { ASK_EVENT } from "@/components/assistant/ask-button"
import { cn } from "@/lib/utils"

// A button that stays in the bottom corner of every page and opens the assistant in a panel.
// The assistant stays mounted while closed, so the conversation is still there when reopened.
export default function AssistantLauncher({ enabled, context }: { enabled: boolean; context?: string }) {
  const [open, setOpen] = useState(false)

  // "Ask how to fix" buttons open the panel; the assistant itself picks up the question.
  useEffect(() => {
    const onAsk = () => setOpen(true)
    window.addEventListener(ASK_EVENT, onAsk)
    return () => window.removeEventListener(ASK_EVENT, onAsk)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <>
      <div
        className={cn(
          "fixed inset-x-3 bottom-3 z-40 h-[min(44rem,calc(100dvh-1.5rem))] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[28rem]",
          !open && "hidden",
        )}
      >
        <Assistant enabled={enabled} context={context} onClose={() => setOpen(false)} />
      </div>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-semibold text-primary-foreground shadow-xl shadow-primary/30 transition hover:brightness-110 sm:right-6 sm:bottom-6 print:hidden"
        >
          <MessageSquareText className="size-5" />
          Ask about your ads
        </button>
      )}
    </>
  )
}
