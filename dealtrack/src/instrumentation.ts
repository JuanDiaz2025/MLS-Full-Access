// Runs once when the DealTrack server starts. It fetches the reports people open first in the
// background, so the first page view doesn't wait on Google. It never holds up the start.
// Set DEALTRACK_WARMUP=0 to turn it off (it spends a few dozen Google Ads API operations).
//
// It also checks today's spend every 15 minutes from 6 AM to 11 PM Pacific while the server runs
// (over budget, expensive clicks, spend far ahead of normal), so those alerts are saved even when
// nobody has a page open. About 70 Google Ads API operations a day; set DEALTRACK_TODAY_CHECKS=0
// to turn it off.
//
// Every hour it also makes last week's Weekly review if there isn't one yet, from Monday 7 AM
// Pacific (about 15 Google Ads API operations a week), and refreshes the Keyword explorer's city
// volumes once they're 30 days old (about one operation per city a month, only after someone ran
// it once). Set DEALTRACK_WEEKLY_REVIEW=0 to turn both off.

const TODAY_EVERY_MS = 15 * 60 * 1000
const REVIEW_EVERY_MS = 60 * 60 * 1000

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  if (process.env.DEALTRACK_WARMUP !== "0") {
    const { warmUp } = await import("@/lib/warm-up")
    setTimeout(() => {
      warmUp().catch(() => undefined)
    }, 2000)
  }
  if (process.env.DEALTRACK_WEEKLY_REVIEW !== "0") {
    const g = globalThis as { __dtReviewTimer?: ReturnType<typeof setInterval> }
    if (!g.__dtReviewTimer) {
      const check = async () => {
        const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }))
        const weekday = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short" })
        if (weekday === "Mon" && hour < 7) return
        const [{ makeReviewIfDue }, { refreshCityVolumesIfDue }] = await Promise.all([
          import("@/lib/weekly-review"),
          import("@/lib/research/city-volumes"),
        ])
        await makeReviewIfDue().catch(() => undefined)
        await refreshCityVolumesIfDue()
      }
      setTimeout(() => check().catch(() => undefined), 5 * 60_000)
      g.__dtReviewTimer = setInterval(() => check().catch(() => undefined), REVIEW_EVERY_MS)
    }
  }
  if (process.env.DEALTRACK_TODAY_CHECKS !== "0") {
    const g = globalThis as { __dtTodayTimer?: ReturnType<typeof setInterval> }
    if (g.__dtTodayTimer) return // a dev-server reload already started one
    const check = async () => {
      const hour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }))
      if (hour < 6 || hour >= 23) return
      const [{ checkAlerts, searchRules, todayRules }, { readData }] = await Promise.all([import("@/lib/alert-rules"), import("@/lib/store")])
      const data = await readData()
      await checkAlerts([todayRules(data), searchRules(data)])
    }
    setTimeout(() => check().catch(() => undefined), 60_000)
    g.__dtTodayTimer = setInterval(() => check().catch(() => undefined), TODAY_EVERY_MS)
  }
}
