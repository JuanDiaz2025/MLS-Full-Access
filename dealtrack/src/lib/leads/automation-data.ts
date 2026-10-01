// What the automation settings page shows: where each stage goes in Google Ads, and the recent
// leads the rules editor previews against.
import type { TargetsView } from "@/components/leads/conversion-targets"
import { activeAccount } from "@/lib/conversions/google"
import { conversionTargets } from "@/lib/conversions/offline-conversions"
import type { Lead } from "@/lib/leads/types"

// Which conversion action each stage goes to, or null when Google Ads isn't connected or answering.
export async function loadTargets(): Promise<TargetsView | null> {
  try {
    const active = await activeAccount()
    if (!active) return null
    const t = await conversionTargets(active.connection, active.account)
    const brief = (o?: { resourceName: string; name: string }) => o && { resourceName: o.resourceName, name: o.name }
    return {
      options: t.options.map((o) => ({ resourceName: o.resourceName, name: o.name, importable: o.importable, primary: o.primary })),
      interested: brief(t.interested),
      closed: brief(t.closed),
      invalid: brief(t.invalid),
      chosen: t.chosen,
      blocked: t.blocked,
    }
  } catch (error) {
    console.error("Couldn't look up conversion actions:", error)
    return null
  }
}

// For the rules editor's "would have set N of your last leads": the last 90 days, at most 300.
export function recentLeads(leads: Lead[]) {
  const since = Date.now() - 90 * 86_400_000
  return leads.filter((l) => !l.qrCodeId && Date.parse(l.createdAt) >= since).slice(0, 300)
}

