"use server"

// Who gets alert emails (Alerts page), and the "Send test email" button. Admins only.

import { refresh } from "next/cache"

import { isAdmin } from "@/lib/auth"
import { parseEmails, saveNotifySettings, sendTestEmail, SEVERITY_RANK, type Severity } from "@/lib/notify"
import { rememberName } from "@/lib/people"

export type NotifyFormState = { ok?: boolean; message?: string }

export async function notifyAction(_prev: NotifyFormState, form: FormData): Promise<NotifyFormState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can change who gets alert emails. Sign in as an admin." }
  const name = await rememberName(form.get("name"))
  if (!name) return { ok: false, message: "Type your name, so everyone can see who changed this." }
  const emails = parseEmails(String(form.get("emails") ?? ""))
  if (typeof emails === "string") return { ok: false, message: emails }

  if (form.get("intent") === "test") {
    if (!emails.length) return { ok: false, message: "Add at least one email address to send the test to." }
    try {
      await sendTestEmail(emails, name)
    } catch (e) {
      refresh()
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
    refresh()
    return { ok: true, message: `Test email sent to ${emails.join(", ")}. Check the inbox (and spam) in a minute.` }
  }

  const severity = String(form.get("minSeverity") ?? "high") as Severity
  const enabled = form.get("enabled") === "on"
  if (!(severity in SEVERITY_RANK)) return { ok: false, message: "Pick which alerts to email." }
  if (enabled && !emails.length) return { ok: false, message: "Add at least one email address, or turn alert emails off." }
  await saveNotifySettings({ enabled, emails, minSeverity: severity, updatedBy: name })
  refresh()
  return { ok: true, message: enabled ? "Saved. New alerts will be emailed." : "Saved. Alert emails are off." }
}
