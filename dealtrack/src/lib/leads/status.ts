import type { ConversionKind, Lead, LeadStatus } from "@/lib/leads/types"

// Which conversions each status means for Google Ads. A deal can close without "Interested"
// being set first; Google still hears about both.
const KINDS: Partial<Record<LeadStatus, ConversionKind[]>> = {
  interested: ["interested"],
  appointment: ["interested"],
  offer: ["interested"],
  closed: ["interested", "closed"],
}

// Sets a lead's status and queues the conversions it means (sent by offline-conversions.ts).
// `by` says whether you chose it or the app did from the lead's score.
export function applyStatus(lead: Lead, status: LeadStatus, by: "auto" | "you", now = new Date().toISOString()) {
  lead.status = status
  lead.statusChangedAt = now
  lead.statusBy = by
  if (by === "you") delete lead.statusRule
  lead.conversions ??= {}
  // Not interested after all: take back from Google Ads what was already sent for this lead, so
  // its bidding stops counting that click as a success, and report it as an invalid lead
  // (reporting only), so Google's reports show which ads bring leads like this.
  if (status === "not_interested") {
    for (const kind of ["interested", "closed"] as const) {
      const entry = lead.conversions[kind]
      if (!entry) continue
      // Not sent yet: never send it. Its resend id is kept if it has one (an earlier send under the
      // usual id was taken back, so that id can't be used again).
      if (entry.state !== "sent") {
        if (entry.transactionId) lead.conversions[kind] = { state: "skipped", at: entry.at, transactionId: entry.transactionId, error: "Marked Not interested before it was sent." }
        else delete lead.conversions[kind]
      }
      // Google refused it anyway: nothing to take back.
      else if (!entry.retraction && entry.google?.status !== "rejected") entry.retraction = { state: "pending", at: now }
    }
    reportInvalid(lead, now)
    return
  }
  // Not "not interested" any more (good after all, or put back as New): an invalid report already
  // sent is taken back, one not sent yet is dropped.
  const invalid = lead.conversions.invalid
  if (invalid) {
    if (invalid.state === "sent" && !invalid.retraction) invalid.retraction = { state: "pending", at: now }
    else if (invalid.state !== "sent") delete lead.conversions.invalid
  }
  for (const kind of KINDS[status] ?? []) {
    // Once sent, a conversion stays sent; a failed one is tried again when set again.
    const entry = lead.conversions[kind]
    if (entry?.retraction && entry.retraction.state !== "sent") {
      // Changed your mind before Google was told: keep the conversion, don't take it back.
      delete entry.retraction
    } else if (entry?.retraction?.state === "sent") {
      // Taken back earlier and good again: send it as a new conversion.
      lead.conversions[kind] = { state: "pending", at: now, transactionId: `${lead.id}-${kind}-${Date.now().toString(36)}` }
    } else if (!entry || entry.state === "failed" || entry.state === "skipped") {
      lead.conversions[kind] = { state: "pending", at: now, transactionId: entry?.transactionId }
    }
  }
}

// Queues an invalid-lead report (worth 0, to a reporting-only action), unless one is on its way
// or already counted.
function reportInvalid(lead: Lead, now: string, rule?: string) {
  lead.conversions ??= {}
  const entry = lead.conversions.invalid
  if (entry?.retraction && entry.retraction.state !== "sent") delete entry.retraction
  else if (entry?.retraction?.state === "sent") lead.conversions.invalid = { state: "pending", at: now, value: 0, rule, transactionId: `${lead.id}-invalid-${Date.now().toString(36)}` }
  else if (!entry || entry.state === "failed" || entry.state === "skipped") lead.conversions.invalid = { state: "pending", at: now, value: 0, rule, transactionId: entry?.transactionId }
}

// Queues what a Google Ads rule decided, without touching the lead's status.
export function applyRule(lead: Lead, rule: { name: string; then: "qualified" | "converted" | "invalid" | "dont_send"; value?: number }, now = new Date().toISOString()) {
  if (rule.then === "dont_send") {
    lead.googleBlockedBy = rule.name
    return
  }
  if (rule.then === "invalid") {
    reportInvalid(lead, now, rule.name)
    return
  }
  const kinds: ConversionKind[] = rule.then === "converted" ? ["interested", "closed"] : ["interested"]
  if (lead.status === "not_interested") return
  lead.conversions ??= {}
  for (const kind of kinds) {
    // A converted lead also counts as qualified; the value goes with the conversion the rule is
    // about, so Google doesn't count it twice.
    const value = rule.then === "converted" && kind === "interested" ? undefined : rule.value
    if (!lead.conversions[kind]) lead.conversions[kind] = { state: "pending", at: now, value, rule: rule.name }
  }
}
