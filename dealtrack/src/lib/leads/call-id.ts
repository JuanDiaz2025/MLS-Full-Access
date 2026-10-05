// The key a Google Ads call is remembered by once it's been added as a lead.
export type CallInfo = { start: string; areaCode: string; campaign: string; seconds: number }
export const callIdOf = (c: Pick<CallInfo, "start" | "areaCode">) => `call:${c.start}:${c.areaCode}`
