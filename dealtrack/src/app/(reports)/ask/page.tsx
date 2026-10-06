import type { Metadata } from "next"

import Assistant from "@/components/assistant/assistant"
import { assistantProvider } from "@/lib/assistant/shared"

export const metadata: Metadata = { title: "Ask about your ads · DealTrack" }

// The chat on a page of its own: the same assistant and saved chats as the corner panel.
export default function AskPage() {
  return (
    <div className="mx-auto h-[calc(100dvh-11rem)] min-h-[32rem] w-full max-w-5xl">
      <Assistant enabled={assistantProvider() !== null} fullPage />
    </div>
  )
}
