"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { isAdmin } from "@/lib/auth"
import { defaultRules } from "@/lib/leads/rules"
import { saveRules } from "@/lib/leads/rules-store"

const FILL = "Fill in every condition before saving."
const text = z.string().trim().min(1, FILL).max(300)
const field = z.enum(["phone", "email", "address"])
const condition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scoreAtLeast"), value: z.number().min(0).max(100) }),
  z.object({ kind: z.literal("scoreBelow"), value: z.number().min(0).max(100) }),
  z.object({ kind: z.literal("gradeIs"), value: z.enum(["hot", "warm", "cold", "junk"]) }),
  z.object({ kind: z.literal("fromGoogleAd") }),
  z.object({ kind: z.literal("channelIs"), value: text }),
  z.object({ kind: z.literal("messageHas"), value: text }),
  z.object({ kind: z.literal("searchHas"), value: text }),
  z.object({ kind: z.literal("formIs"), value: text }),
  z.object({ kind: z.literal("has"), value: field }),
  z.object({ kind: z.literal("missing"), value: field }),
])
const rules = z
  .array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]{1,40}$/),
      name: z.string().trim().min(1, "Give every rule a name.").max(80),
      enabled: z.boolean(),
      when: z.array(condition).min(1, "Every rule needs at least one condition.").max(10),
      then: z.enum(["qualified", "converted", "invalid", "dont_send"]),
      value: z.number().min(0).max(10_000_000).optional(),
    }),
  )
  .max(30)

// Saves the Google Ads rules from the Leads page (or puts the defaults back).
export async function saveRulesAction(input: unknown, reset = false): Promise<{ error?: string }> {
  if (!(await isAdmin())) return { error: "Only admins can change the Google Ads rules. Sign in as an admin." }
  if (reset) {
    await saveRules(defaultRules())
  } else {
    const parsed = rules.safeParse(input)
    if (!parsed.success) {
      // Our own messages are plain sentences; anything else (a wrong value) gets the general one.
      const message = parsed.error.issues[0]?.message ?? ""
      return { error: /^(Fill|Give|Every)/.test(message) ? message : FILL }
    }
    await saveRules(parsed.data as Parameters<typeof saveRules>[0])
  }
  revalidatePath("/leads", "layout")
  return {}
}
