// Microsoft Clarity "live insights" export. The API only covers the last 1–3 days and allows
// about 10 requests a day per project, so results are cached for 3 hours.

import { HOUR, ServiceError, cached, settings } from "@/lib/services"

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
  return cached("clarity:3d", 3 * HOUR, async () => {
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
  })
}
