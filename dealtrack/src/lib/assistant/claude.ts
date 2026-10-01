// Answers with Claude (Anthropic). Used when ANTHROPIC_API_KEY is set; see shared.ts.
import Anthropic from "@anthropic-ai/sdk"

import {
  AssistantError,
  CUT_OFF,
  INSTRUCTIONS,
  MAX_ROUNDS,
  REFUSED,
  TOO_MANY_STEPS,
  type AskInput,
} from "@/lib/assistant/shared"
import { runTool, toolSpecs } from "@/lib/assistant/tools"

const MODEL = "claude-opus-5-5"

const tools: Anthropic.Beta.BetaTool[] = toolSpecs.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
  strict: true,
}))

export async function askClaude({ turns, situation }: AskInput): Promise<string> {
  const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }))
  const client = new Anthropic()
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: [
          { type: "text", text: INSTRUCTIONS, cache_control: { type: "ephemeral" } },
          { type: "text", text: situation },
        ],
        tools,
        messages,
      })

      if (response.stop_reason === "refusal") return REFUSED

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n\n")
        .trim()

      if (response.stop_reason === "end_turn" || response.stop_reason === "stop_sequence") {
        return text || "I don't have an answer for that."
      }
      if (response.stop_reason === "max_tokens") return `${text}\n\n${CUT_OFF}`

      // Keep the whole turn (thinking and tool calls included) so the next round continues it.
      messages.push({ role: "assistant", content: response.content })
      if (response.stop_reason === "pause_turn") continue

      const calls = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      )
      const results = await Promise.all(
        calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const result = await runTool(call.name, call.input)
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          }
        }),
      )
      messages.push({ role: "user", content: results })
    }
    return TOO_MANY_STEPS
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new AssistantError("The ANTHROPIC_API_KEY in .env.local isn't valid.", 502)
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new AssistantError("The assistant is busy right now. Try again in a minute.", 429)
    }
    if (error instanceof Anthropic.APIError) {
      console.error("Claude API error:", error.status, error.message)
      throw new AssistantError("The assistant ran into a problem. Please try again.", 502)
    }
    throw error
  }
}
