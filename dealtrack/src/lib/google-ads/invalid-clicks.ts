// Invalid clicks: clicks Google decided were accidental or fraudulent (bots, repeat clicks) and
// filtered out. Google doesn't charge for them, but a rising share can mean someone is clicking
// the ads on purpose. The rate is invalid ÷ (valid + invalid) clicks, like Google's own column.

import { gaql } from "@/lib/google-ads/client"

type Num = string | number | undefined
const num = (v: Num) => Number(v ?? 0) || 0

export type InvalidRow = { key: string; label: string; clicks: number; invalid: number; rate: number | null }

const withRate = (r: Omit<InvalidRow, "rate">): InvalidRow => ({ ...r, rate: r.clicks + r.invalid ? r.invalid / (r.clicks + r.invalid) : null })

export async function getInvalidClicks(from: string, to: string): Promise<{ months: InvalidRow[]; campaigns: InvalidRow[] }> {
  const where = `segments.date BETWEEN '${from}' AND '${to}'`
  const [byMonth, byCampaign] = await Promise.all([
    gaql<{ segments: { month: string }; metrics?: { clicks?: Num; invalidClicks?: Num } }>(
      `SELECT segments.month, metrics.clicks, metrics.invalid_clicks FROM customer WHERE ${where}`,
    ),
    gaql<{ campaign: { id?: Num; name?: string }; metrics?: { clicks?: Num; invalidClicks?: Num } }>(
      `SELECT campaign.id, campaign.name, metrics.clicks, metrics.invalid_clicks FROM campaign WHERE ${where}`,
    ),
  ])
  const months = new Map<string, Omit<InvalidRow, "rate">>()
  for (const r of byMonth) {
    const key = r.segments.month.slice(0, 7)
    const m = months.get(key) ?? {
      key,
      label: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
      clicks: 0,
      invalid: 0,
    }
    m.clicks += num(r.metrics?.clicks)
    m.invalid += num(r.metrics?.invalidClicks)
    months.set(key, m)
  }
  const campaigns = new Map<string, Omit<InvalidRow, "rate">>()
  for (const r of byCampaign) {
    const key = String(r.campaign.id ?? "")
    const c = campaigns.get(key) ?? { key, label: r.campaign.name ?? "(no name)", clicks: 0, invalid: 0 }
    c.clicks += num(r.metrics?.clicks)
    c.invalid += num(r.metrics?.invalidClicks)
    campaigns.set(key, c)
  }
  return {
    months: [...months.values()].sort((a, b) => b.key.localeCompare(a.key)).map(withRate),
    campaigns: [...campaigns.values()].filter((c) => c.invalid > 0).sort((a, b) => b.invalid - a.invalid).map(withRate),
  }
}
