// Phone calls from Google Ads: calls to Google's forwarding number on call ads, call assets and
// (with Google's website call snippet) the website. Google keeps each call's time, length, whether
// it was answered, and the caller's area code, never the full phone number.

import { addDays, today } from "@/lib/date-range"
import { gaql } from "@/lib/google-ads/client"

export type Call = {
  start: string // "2026-09-29 14:03:11", in the account's time zone
  seconds: number
  missed: boolean
  areaCode: string
  campaign: string
  from: string // "Ad" or "Website"
}

type Row = {
  callView?: { startCallDateTime?: string; callDurationSeconds?: string | number; callStatus?: string; callerAreaCode?: string; callTrackingDisplayLocation?: string }
  campaign?: { name?: string }
}

export async function getCalls(sinceDays = 30): Promise<Call[]> {
  const rows = await gaql<Row>(
    `SELECT call_view.start_call_date_time, call_view.call_duration_seconds, call_view.call_status, call_view.caller_area_code,
       call_view.call_tracking_display_location, campaign.name
     FROM call_view WHERE call_view.start_call_date_time >= '${addDays(today(), -sinceDays)} 00:00:00'
     ORDER BY call_view.start_call_date_time DESC LIMIT 500`,
  )
  return rows.map((r) => ({
    start: String(r.callView?.startCallDateTime ?? ""),
    seconds: Number(r.callView?.callDurationSeconds ?? 0),
    missed: r.callView?.callStatus === "MISSED",
    areaCode: String(r.callView?.callerAreaCode ?? ""),
    campaign: String(r.campaign?.name ?? ""),
    from: r.callView?.callTrackingDisplayLocation === "LANDING_PAGE" ? "Website" : "Ad",
  }))
}

// Whether Google Ads counts calls as conversions on its own ("Calls from ads", calls to the number
// on your website), and from how many seconds. Asked at most once an hour.
export type CallCounting = { name: string; seconds?: number; website: boolean; primary: boolean }[]
let counting: { at: number; result: CallCounting | null } | null = null
export async function callCounting(): Promise<CallCounting | null> {
  if (counting && Date.now() - counting.at < 60 * 60_000) return counting.result
  let result: CallCounting | null = null
  try {
    const rows = await gaql<{ conversionAction?: { name?: string; type?: string; phoneCallDurationSeconds?: string | number; primaryForGoal?: boolean } }>(
      "SELECT conversion_action.name, conversion_action.type, conversion_action.phone_call_duration_seconds, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.status = 'ENABLED' AND conversion_action.type IN ('AD_CALL', 'WEBSITE_CALL')",
    )
    result = rows.map((r) => ({
      name: String(r.conversionAction?.name ?? ""),
      seconds: r.conversionAction?.phoneCallDurationSeconds ? Number(r.conversionAction.phoneCallDurationSeconds) : undefined,
      website: r.conversionAction?.type === "WEBSITE_CALL",
      primary: r.conversionAction?.primaryForGoal !== false,
    }))
  } catch {
    result = null // unknown this time
  }
  counting = { at: Date.now(), result }
  return result
}
