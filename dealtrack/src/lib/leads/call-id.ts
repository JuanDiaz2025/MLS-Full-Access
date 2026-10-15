// The key a Google Ads call is remembered by once it's been added as a lead.
export type CallInfo = { start: string; areaCode: string; campaign: string; seconds: number; missed?: boolean }
export const callIdOf = (c: Pick<CallInfo, "start" | "areaCode">) => `call:${c.start}:${c.areaCode}`
// Calls already added as leads: the call's key → the lead's id (its panel on the Leads page).
export const callLeads = (leads: { id: string; callId?: string }[]): Record<string, string> =>
  Object.fromEntries(leads.flatMap((l) => (l.callId ? [[l.callId, l.id]] : [])))
