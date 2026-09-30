// Runs once when the DealTrack server starts. It fetches the reports people open first in the
// background, so the first page view doesn't wait on Google. It never holds up the start.
// Set DEALTRACK_WARMUP=0 to turn it off (it spends a few dozen Google Ads API operations).

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.DEALTRACK_WARMUP === "0") return
  const { warmUp } = await import("@/lib/warm-up")
  setTimeout(() => {
    warmUp().catch(() => undefined)
  }, 2000)
}
