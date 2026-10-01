// Names for the day patterns the Fraud page flags. Kept apart from the Google Ads code so the
// browser can use them.

export type DayFlag = "click-spike" | "invalid-spike" | "night-clicks" | "burst-hour"

export const FLAG_LABELS: Record<DayFlag, string> = {
  "click-spike": "Click spike",
  "invalid-spike": "Invalid-click burst",
  "night-clicks": "Night clicks",
  "burst-hour": "One-hour burst",
}
