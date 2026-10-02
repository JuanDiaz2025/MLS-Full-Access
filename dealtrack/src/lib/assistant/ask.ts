// One question to whichever AI is set up (see shared.ts), outside the chat: same instructions and
// tools, no saved conversation.

import { askClaude } from "@/lib/assistant/claude"
import { askClaudeCode } from "@/lib/assistant/claude-code"
import { askOpenAI } from "@/lib/assistant/openai"
import { AssistantError, assistantProvider, type AskInput } from "@/lib/assistant/shared"

export async function askAssistant(input: AskInput): Promise<string> {
  const provider = assistantProvider()
  if (!provider)
    throw new AssistantError(
      "No AI is set up yet. Add OPENAI_API_KEY or ANTHROPIC_API_KEY to .env.local (or set ASSISTANT_PROVIDER=claude-code) and restart DealTrack.",
      503,
    )
  return provider === "openai" ? askOpenAI(input) : provider === "claude-code" ? askClaudeCode(input) : askClaude(input)
}
