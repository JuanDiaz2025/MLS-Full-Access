import type { Lead } from "@/lib/leads/types"

// "Yard sign, 123 Main St" for a QR code lead, "Website · Cash offer form" for a website lead.
export function leadSource(lead: Lead, qrPlacements: Map<string, string>) {
  if (lead.qrCodeId) return qrPlacements.get(lead.qrCodeId) ?? "QR code"
  return lead.source ?? "Website"
}
