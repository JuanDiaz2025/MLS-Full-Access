// How many Google Ads API operations DealTrack has used today, for the meter in the header.
// Google counts a day in Pacific time and Explorer access allows 2,880 operations a day
// (GOOGLE_ADS_DAILY_LIMIT overrides it, e.g. 15000 once Basic access is approved).
//
// This is DealTrack's own count of the requests it sends, so it's close but not Google's official
// number: another app using the same developer token (One Marketing Command Center, scripts) isn't
// counted here. Every request counts once; a change counts once per item it changes. Saved in
// .data/ads-usage.json so a restart doesn't reset it.

import { jsonFileStore } from "@/lib/json-file-store"
import { shared } from "@/lib/shared-state"

export const DAILY_LIMIT = Number(process.env.GOOGLE_ADS_DAILY_LIMIT) || 2880

type Usage = { day: string; used: number; hours: number[]; limitHit?: string }
export type UsageView = Usage & { limit: number }

const file = jsonFileStore<Usage>("ads-usage.json", () => ({ day: pacificDay(), used: 0, hours: [] }))
const state = shared("ads-usage", () => ({
  usage: null as Usage | null,
  loading: null as Promise<Usage> | null,
  timer: null as NodeJS.Timeout | null,
}))

function pacificDay(at = new Date()) {
  return at.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
}
function pacificHour(at = new Date()) {
  return Number(at.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }))
}

async function load(): Promise<Usage> {
  if (state.usage) return state.usage
  state.loading ??= file
    .read()
    .catch((): Usage => ({ day: pacificDay(), used: 0, hours: [] }))
    .then((u) => (state.usage ??= { day: u.day, used: u.used || 0, hours: Array.isArray(u.hours) ? u.hours : [], limitHit: u.limitHit }))
  return state.loading
}

// A new Pacific day starts from zero.
function current(u: Usage): Usage {
  const day = pacificDay()
  if (u.day !== day) Object.assign(u, { day, used: 0, hours: [], limitHit: undefined })
  return u
}

function save() {
  if (state.timer) return
  state.timer = setTimeout(() => {
    state.timer = null
    const u = state.usage
    if (u) file.write({ ...u }).catch(() => undefined)
  }, 3000)
}

// How many operations one request to `path` with `payload` costs.
export function operationsIn(path: string, payload: unknown): number {
  const p = payload as { operations?: unknown[]; mutateOperations?: unknown[]; conversions?: unknown[]; conversionAdjustments?: unknown[] } | null
  if (!/:mutate$|:upload/i.test(path)) return 1
  const items = p?.operations ?? p?.mutateOperations ?? p?.conversions ?? p?.conversionAdjustments
  return Math.max(1, items?.length ?? 1)
}

export async function countRequest(ops: number) {
  const u = current(await load())
  u.used += ops
  const h = pacificHour()
  while (u.hours.length <= h) u.hours.push(0)
  u.hours[h] += ops
  save()
}

// Google said the day's allowance is used up.
export async function markLimitHit() {
  const u = current(await load())
  u.limitHit = new Date().toISOString()
  save()
}

export async function getUsage(): Promise<UsageView> {
  const u = current(await load())
  return { ...u, hours: [...u.hours], limit: DAILY_LIMIT }
}
