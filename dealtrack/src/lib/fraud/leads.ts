// Junk form leads, as the lead scoring grades them the moment they arrive (lib/leads/scoring.ts,
// from One Marketing Command Center): tests and fake names, advertising instead of a seller, no
// real phone or email. Junk is reported to Google Ads as an invalid lead (reporting only) by the
// default lead rule, so it never teaches bidding to find more of the same.

import type { Lead } from "@/lib/leads/types"

export type JunkLead = { lead: Lead; reasons: string[]; google: string }

function googleNote(lead: Lead) {
  const invalid = lead.conversions?.invalid
  if (invalid?.retraction) return "Invalid report taken back"
  if (invalid?.state === "sent") return "Reported to Google as invalid"
  if (invalid?.state === "pending") return "Waiting to be reported as invalid"
  if (invalid?.state === "failed") return "Couldn't report it as invalid"
  if (lead.googleBlockedBy) return `Not sent (rule “${lead.googleBlockedBy}”)`
  return "Not reported"
}

// Leads graded Junk, newest first, limited to a period.
export function findJunkLeads(all: Lead[], inPeriod: (lead: Lead) => boolean = () => true): JunkLead[] {
  return all
    .filter((l) => inPeriod(l) && l.score?.grade === "junk" && !l.score.unscored)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((lead) => ({ lead, reasons: lead.score!.reasons, google: googleNote(lead) }))
}

// The main reason, for counting: "Junk: no phone number or email" → "no phone number or email".
export const mainReason = (j: JunkLead) => (j.reasons[0] ?? "Junk").replace(/^Junk:\s*/, "")
