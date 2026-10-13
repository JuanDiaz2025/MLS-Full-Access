// Bright Data's free tier: 5,000 Google searches a month. DealTrack keeps itself under it on its
// own: every Bright Data search is counted here before it's made, and none is made once 4,800 were
// made in the last 32 days, so no billing month can go over, whenever it starts and in any time
// zone. BRIGHTDATA_MONTHLY_CAP can lower the limit (2,400 on each of two computers sharing one
// Bright Data account, say), never raise it. Saved in .data/brightdata-usage.json, a count per
// day (UTC).
import { jsonFileStore } from "@/lib/json-file-store"

export const FREE_LIMIT = 4800
export const WINDOW_DAYS = 32
const DAY = 86_400_000

const file = jsonFileStore<{ days: Record<string, number> }>("brightdata-usage.json", () => ({ days: {} }))

export function freeCap() {
  const n = Math.floor(Number(process.env.BRIGHTDATA_MONTHLY_CAP))
  return n > 0 ? Math.min(FREE_LIMIT, n) : FREE_LIMIT
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)
const windowDays = (now: number) => Array.from({ length: WINDOW_DAYS }, (_, i) => dayOf(now - i * DAY))
const usedIn = (days: Record<string, number>, now: number) => windowDays(now).reduce((n, d) => n + (days[d] ?? 0), 0)

export type FreeSearches = { used: number; cap: number; left: number; today: number; moreOn?: string }

export async function freeSearches(): Promise<FreeSearches> {
  const days = (await file.read()).days ?? {}
  const now = Date.now()
  const used = usedIn(days, now)
  const cap = freeCap()
  // When it's all used, room comes back as the oldest days leave the 32.
  const oldest = windowDays(now).findLast((d) => (days[d] ?? 0) > 0)
  const moreOn = used >= cap && oldest ? dayOf(Date.parse(oldest) + WINDOW_DAYS * DAY) : undefined
  return { used, cap, left: Math.max(0, cap - used), today: days[dayOf(now)] ?? 0, moreOn }
}

// Takes `n` searches from what's left. False, with nothing taken, if that would pass the limit.
// Called before each search, so a search that fails still counts: Bright Data bills only the ones
// that work, so the count can only be on the safe side.
export function takeFreeSearches(n = 1): Promise<boolean> {
  return file.update((x) => {
    x.days ??= {}
    const now = Date.now()
    if (usedIn(x.days, now) + n > freeCap()) return false
    const today = dayOf(now)
    x.days[today] = (x.days[today] ?? 0) + n
    const keep = new Set(windowDays(now))
    for (const d of Object.keys(x.days)) if (!keep.has(d)) delete x.days[d]
    return true
  })
}
