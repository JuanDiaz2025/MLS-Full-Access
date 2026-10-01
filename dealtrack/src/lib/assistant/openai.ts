// Answers with OpenAI, through the Responses API (GPT-5.5 only accepts function tools there).
// Used when OPENAI_API_KEY is set; see shared.ts.
import OpenAI from "openai"

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

const model = () => process.env.OPENAI_MODEL?.trim() || "gpt-5.5"

const tools: OpenAI.Responses.FunctionTool[] = toolSpecs.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.parameters,
  strict: true,
}))

export async function askOpenAI({ turns, situation }: AskInput): Promise<string> {
  const input: OpenAI.Responses.ResponseInputItem[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }))
  const client = new OpenAI()
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.responses.create({
        model: model(),
        instructions: `${INSTRUCTIONS}\n\n${situation}`,
        input,
        tools,
        reasoning: { effort: "medium" },
        max_output_tokens: 16000,
        // Nothing is kept on OpenAI's side between requests; the reasoning travels back encrypted.
        store: false,
        include: ["reasoning.encrypted_content"],
      })

      const messages = response.output.filter(
        (o): o is OpenAI.Responses.ResponseOutputMessage => o.type === "message",
      )
      if (messages.some((m) => m.content.some((c) => c.type === "refusal"))) return REFUSED
      const text = response.output_text.trim()

      const calls = response.output.filter(
        (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call",
      )
      if (response.status === "incomplete") {
        return text ? `${text}\n\n${CUT_OFF}` : CUT_OFF
      }
      if (!calls.length) return text || "I don't have an answer for that."

      // Send the whole turn back (reasoning included), then each tool's result.
      input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]))
      // The tools only read data, so they can run at once, like in claude.ts.
      const outputs = await Promise.all(
        calls.map(async (call): Promise<OpenAI.Responses.ResponseInputItem> => {
          let args: unknown
          try {
            args = JSON.parse(call.arguments)
          } catch {
            args = {}
          }
          const result = await runTool(call.name, args)
          return {
            type: "function_call_output",
            call_id: call.call_id,
            output: result.isError ? `Error: ${result.content}` : result.content,
          }
        }),
      )
      input.push(...outputs)
    }
    return TOO_MANY_STEPS
  } catch (error) {
    if (error instanceof OpenAI.AuthenticationError) {
      throw new AssistantError("The OPENAI_API_KEY in .env.local isn't valid.", 502)
    }
    if (error instanceof OpenAI.RateLimitError) {
      throw new AssistantError(
        "OpenAI is busy or the account is out of credit. Check Billing at platform.openai.com, then try again.",
        429,
      )
    }
    if (error instanceof OpenAI.APIError) {
      console.error("OpenAI API error:", error.status, error.message)
      throw new AssistantError("The assistant ran into a problem. Please try again.", 502)
    }
    throw error
  }
}
