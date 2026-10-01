// The last few times something called the website-leads webhook, so the Leads page can show
// whether WordPress is reaching the app at all, and why a lead was turned away.
import { jsonFileStore } from "@/lib/json-file-store"

export type WebhookAttempt = {
  at: string
  ok: boolean
  // "lead", "test", "wrong-key" or "no-contact".
  result: string
  // The field names the form sent (never their values), to fix field-name mismatches.
  fields?: string[]
  lead?: string
}

const file = jsonFileStore<WebhookAttempt[]>("webhook-log.json", () => [])
const KEEP = 10

export async function logAttempt(attempt: Omit<WebhookAttempt, "at">) {
  await file.update((log) => {
    log.unshift({ at: new Date().toISOString(), ...attempt })
    log.splice(KEEP)
  })
}

export const recentAttempts = () => file.read()
