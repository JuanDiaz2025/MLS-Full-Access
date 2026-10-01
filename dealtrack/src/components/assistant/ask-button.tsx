"use client"

import { MessageSquareText } from "lucide-react"

import { Button } from "@/components/ui/button"

export const ASK_EVENT = "assistant:ask"

// Opens the assistant panel with this question.
export default function AskButton({ question }: { question: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: question }))
      }}
    >
      <MessageSquareText data-icon="inline-start" />
      Ask how to fix
    </Button>
  )
}
