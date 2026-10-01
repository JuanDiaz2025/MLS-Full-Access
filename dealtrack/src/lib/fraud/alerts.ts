// Fraud checks for the Alerts page and the Overview: yesterday's click patterns, and ad visitors
// who clicked again and again in the last 7 days. Alert only; the Fraud page has the details.

import type { Fired, RuleGroup } from "@/lib/alert-rules"
import { addDays, formatDay, today } from "@/lib/date-range"
import { getClickPatterns } from "@/lib/fraud/clicks"
import { FLAG_LABELS } from "@/lib/fraud/flags"
import { REPEAT_CLICKS, getAdVisits, groupNetworks } from "@/lib/fraud/visitors"
import { MissingSettingsError } from "@/lib/services"
import type { Data } from "@/lib/store"

export function fraudRules(data: Data): RuleGroup[] {
  const end = today()
  const yesterday = addDays(end, -1)
  return [
    {
      prefix: "fraud:clicks:",
      run: async () => {
        const p = await getClickPatterns({ from: yesterday, to: yesterday, label: "Yesterday" })
        const day = p.days[0]
        // A plain click spike is already its own alert ("daily:click-spike"); these add the rest.
        const flags = day?.flags.filter((f) => f !== "click-spike") ?? []
        if (!day || !flags.length) return []
        return [
          {
            key: `fraud:clicks:${yesterday}`,
            severity: flags.includes("invalid-spike") || flags.length > 1 ? "high" : "medium",
            title: `Possible click fraud on ${formatDay(yesterday)}: ${flags.map((f) => FLAG_LABELS[f].toLowerCase()).join(", ")}`,
            detail: `${day.reasons.join(". ")}. If billed clicks rose too, build a refund claim on the Fraud page within 60 days.`,
            href: `/fraud?range=30d&view=clicks&day=${yesterday}`,
          } satisfies Fired,
        ]
      },
    },
    {
      prefix: "fraud:visitors:",
      run: async () => {
        let visits
        try {
          visits = await getAdVisits({ from: addDays(end, -6), to: end, label: "Last 7 days" })
        } catch (e) {
          if (e instanceof MissingSettingsError) return []
          throw e
        }
        const repeat = groupNetworks(visits, data.knownNetworks).filter((n) => !n.known && n.adClicks >= REPEAT_CLICKS)
        return repeat.slice(0, 3).map(
          (n): Fired => ({
            key: `fraud:visitors:${n.network}`,
            severity: n.adClicks >= 2 * REPEAT_CLICKS ? "high" : "medium",
            title: `One connection clicked the ads ${n.adClicks} times in the last 7 days`,
            detail: `${n.place} (${n.network}). If it's the team, mark it as yours on the Fraud page; if not, it's evidence for a refund claim.`,
            href: "/fraud?range=7d&view=visitors",
          }),
        )
      },
    },
  ]
}
