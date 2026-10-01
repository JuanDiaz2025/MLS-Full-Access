import { z } from "zod"

import { askClaude } from "@/lib/assistant/claude"
import { askClaudeCode } from "@/lib/assistant/claude-code"
import { askOpenAI } from "@/lib/assistant/openai"
import { AssistantError, assistantProvider } from "@/lib/assistant/shared"
import { isSignedIn } from "@/lib/auth"
import { today } from "@/lib/date-range"
import { getAccount } from "@/lib/google-ads/reports"
import { currentName } from "@/lib/people"

const requestSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20_000) }))
    .min(1)
    .max(40)
    .refine((m) => m.at(-1)?.role === "user", "The last message must be a question."),
  // What the page is showing, e.g. its date range.
  context: z.string().max(300).optional(),
})

const fail = (error: string, status: number) => Response.json({ error }, { status })

// POST { messages: [{ role, content }], context? } → { reply }
// Earlier turns are sent back as plain text; tool calls happen inside a single request.
export async function POST(request: Request) {
  if (!(await isSignedIn())) return fail("Sign in first.", 401)
  const provider = assistantProvider()
  if (!provider) {
    return fail("The chat isn't set up yet. Add OPENAI_API_KEY or ANTHROPIC_API_KEY to .env.local (or set ASSISTANT_PROVIDER=claude-code) and restart DealTrack.", 503)
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("That message couldn't be read.", 400)

  const account = await getAccount().catch(() => null)
  const name = await currentName()
  const situation =
    `Today is ${today()} (Pacific time). ` +
    (account
      ? `The Google Ads account is "${account.name}" (${account.id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}), currency ${account.currency}.`
      : "Google Ads isn't reachable right now, so only website leads and DealTrack's records are available.") +
    (name ? ` The person asking is ${name}.` : "") +
    (parsed.data.context ? ` ${parsed.data.context} Use that period unless the question names another.` : "")

  const input = { turns: parsed.data.messages, situation }
  try {
    const reply = provider === "openai" ? await askOpenAI(input) : provider === "claude-code" ? await askClaudeCode(input) : await askClaude(input)
    return Response.json({ reply })
  } catch (error) {
    if (error instanceof AssistantError) return Response.json({ error: error.message, code: error.code }, { status: error.status })
    console.error("Chat failed:", error)
    return fail("The chat couldn't be reached. Check your internet connection.", 502)
  }
}
