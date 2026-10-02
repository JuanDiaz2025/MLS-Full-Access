// Microsoft Clarity "live insights" export. The API only covers the last 1–3 days and allows
// about 10 requests a day per project. Each answer is saved to .data/clarity-cache.json and reused
// for 6 hours, restarts included, so the two reports below ask at most 8 times a day. If Clarity
// says the day's limit is used up, the last saved answer (up to 3 days old) is shown instead.

import { jsonFileStore } from "@/lib/json-file-store"
import { HOUR, MINUTE, ServiceError, cached, settings } from "@/lib/services"

const SAVE_FOR = 6 * HOUR
const FALL_BACK_FOR = 72 * HOUR
const saved = jsonFileStore<Record<string, { at: number; value: unknown }>>("clarity-cache.json", () => ({}))

async function throughDisk<T>(key: string, ask: () => Promise<T>): Promise<T> {
  const hit = (await saved.read().catch(() => ({}) as Record<string, { at: number; value: unknown }>))[key]
  if (hit && Date.now() - hit.at < SAVE_FOR) return hit.value as T
  try {
    const value = await ask()
    await saved
      .update((d) => {
        d[key] = { at: Date.now(), value }
      })
      .catch(() => {})
    return value
  } catch (error) {
    if (hit && Date.now() - hit.at < FALL_BACK_FOR) return hit.value as T
    throw error
  }
}

const SERVICE = "Microsoft Clarity"

type Metric = { metricName: string; information: Record<string, string | number | null>[] }

export type ClaritySnapshot = {
  sessions: number
  botSessions: number
  scriptErrorPct: number | null
  deadClickPct: number | null
  rageClickPct: number | null
  quickBackPct: number | null
  avgScrollDepth: number | null
  fetchedAt: number
}

const pct = (m: Metric | undefined) => {
  const v = m?.information?.[0]?.sessionsWithMetricPercentage
  return v === undefined || v === null ? null : Number(v)
}

export function getClarity(): Promise<ClaritySnapshot> {
  const { CLARITY_API_TOKEN } = settings(SERVICE, ["CLARITY_API_TOKEN"] as const)
  return cached("clarity:3d", 30 * MINUTE, () =>
    throughDisk("3d", async () => {
      const res = await fetch("https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3", {
        headers: { authorization: `Bearer ${CLARITY_API_TOKEN}` },
        cache: "no-store",
      })
      if (!res.ok) {
        throw new ServiceError(
          SERVICE,
          res.status === 429
            ? "Clarity's daily limit (about 10 requests) was reached. It resets tomorrow."
            : res.status === 401 || res.status === 403
              ? "Clarity didn't accept CLARITY_API_TOKEN. Create a new token in Clarity → Settings → Data export."
              : "Clarity returned an error.",
          (await res.text()).slice(0, 200),
        )
      }
      const metrics = new Map(((await res.json()) as Metric[]).map((m) => [m.metricName, m]))
      const traffic = metrics.get("Traffic")?.information?.[0] ?? {}
      const scroll = metrics.get("ScrollDepth")?.information?.[0]?.averageScrollDepth
      return {
        sessions: Number(traffic.totalSessionCount ?? 0),
        botSessions: Number(traffic.totalBotSessionCount ?? 0),
        scriptErrorPct: pct(metrics.get("ScriptErrorCount")),
        deadClickPct: pct(metrics.get("DeadClickCount")),
        rageClickPct: pct(metrics.get("RageClickCount")),
        quickBackPct: pct(metrics.get("QuickbackClick")),
        avgScrollDepth: scroll === undefined || scroll === null ? null : Number(scroll),
        fetchedAt: Date.now(),
      }
    }),
  )
}

export type ClaritySource = { source: string; sessions: number; botSessions: number; users: number }

// Sessions and bot sessions per traffic source, last 3 days (saved like the snapshot above).
export function getClarityBySource(): Promise<ClaritySource[]> {
  const { CLARITY_API_TOKEN } = settings(SERVICE, ["CLARITY_API_TOKEN"] as const)
  return cached("clarity:3d:source", 30 * MINUTE, () =>
    throughDisk("3d:source", async () => {
      const res = await fetch("https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=Source", {
        headers: { authorization: `Bearer ${CLARITY_API_TOKEN}` },
        cache: "no-store",
      })
      if (!res.ok) {
        throw new ServiceError(
          SERVICE,
          res.status === 429 ? "Clarity's daily limit (about 10 requests) was reached. It resets tomorrow." : "Clarity returned an error.",
          (await res.text()).slice(0, 200),
        )
      }
      const traffic = ((await res.json()) as Metric[]).find((m) => m.metricName === "Traffic")?.information ?? []
      return traffic
        .map((t) => ({
          source: String(t.Source || "Direct / unknown"),
          sessions: Number(t.totalSessionCount ?? 0),
          botSessions: Number(t.totalBotSessionCount ?? 0),
          users: Number(t.distinctUserCount ?? 0),
        }))
        .sort((a, b) => b.sessions + b.botSessions - (a.sessions + a.botSessions))
    }),
  )
}
