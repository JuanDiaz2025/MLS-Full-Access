// The Compliance agent ("the brake"). Two rules, both handled like a negatives batch (requested,
// checked, approved, applied):
//   1. Turning campaigns on or off is never done straight away; it's a request.
//   2. A change to a campaign while Google's bidding is still learning is held. DealTrack files an
//      override request for it; once checked and approved, the same push goes through once.

import { gaql } from "@/lib/google-ads/client"
import { requestStage } from "@/lib/compliance-rules"
import type { ChangeRequest, Data } from "@/lib/store"

export * from "@/lib/compliance-rules"

// What Google's bid strategy status means, in plain words.
const LEARNING_LABELS: Record<string, string> = {
  LEARNING_NEW: "new bid strategy",
  LEARNING_SETTING_CHANGE: "after a bid strategy setting change",
  LEARNING_BUDGET_CHANGE: "after a budget change",
  LEARNING_COMPOSITION_CHANGE: "after campaigns were added or removed",
  LEARNING_CONVERSION_TYPE_CHANGE: "after a conversion action change",
  LEARNING_CONVERSION_SETTING_CHANGE: "after a conversion setting change",
}

export type LearningCampaign = { id: string; name: string; status: string; reason: string }

type Row = {
  campaign: { id?: string | number; name?: string; status?: string; biddingStrategySystemStatus?: string; primaryStatusReasons?: string[] }
}

// Running campaigns whose bidding is learning right now (all of them, or only these IDs).
export async function getLearning(campaignIds?: string[]): Promise<LearningCampaign[]> {
  const ids = campaignIds?.filter((id) => /^\d+$/.test(id))
  if (campaignIds && !ids?.length) return []
  const rows = await gaql<Row>(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_system_status, campaign.primary_status_reasons
     FROM campaign WHERE campaign.status = 'ENABLED'${ids?.length ? ` AND campaign.id IN (${ids.join(", ")})` : ""}`,
  )
  return rows
    .filter(
      (r) =>
        (r.campaign.biddingStrategySystemStatus ?? "").startsWith("LEARNING") ||
        r.campaign.primaryStatusReasons?.includes("BIDDING_STRATEGY_LEARNING"),
    )
    .map((r) => {
      const status = r.campaign.biddingStrategySystemStatus ?? "LEARNING"
      return {
        id: String(r.campaign.id ?? ""),
        name: r.campaign.name ?? "(no name)",
        status,
        reason: `Learning ${LEARNING_LABELS[status] ?? ""}`.trim(),
      }
    })
}

export type Gate = { ok: true; override?: ChangeRequest } | { ok: false; learning: LearningCampaign[] }

// Checks the campaigns a change touches. Not learning: go ahead. Learning: go ahead only with an
// approved, unused override for this exact change.
export async function learningGate(data: Data, key: string, campaignIds: string[]): Promise<Gate> {
  const learning = await getLearning(campaignIds)
  if (!learning.length) return { ok: true }
  const override = data.changeRequests.find((r) => r.kind === "learning" && r.change?.key === key && requestStage(r) === "ready")
  return override ? { ok: true, override } : { ok: false, learning }
}
