// The Compliance agent's plain rules (no Google Ads calls), shared by the server and the browser.

import type { ChangeRequest } from "@/lib/store"

// An approved override stays usable for this long.
export const OVERRIDE_DAYS = 7

export type RequestStage = "checking" | "approving" | "ready" | "done" | "rejected" | "expired"

export function requestStage(r: ChangeRequest, now = Date.now()): RequestStage {
  if (r.checked && !r.checked.ok) return "rejected"
  if (r.approved && !r.approved.ok) return "rejected"
  if (r.applied) return "done"
  if (!r.checked) return "checking"
  if (!r.approved) return "approving"
  if (r.kind === "learning" && now - Date.parse(r.approved.at) > OVERRIDE_DAYS * 86_400_000) return "expired"
  return "ready"
}

export const isOpen = (r: ChangeRequest) => ["checking", "approving", "ready"].includes(requestStage(r))

// The key of a change, so an approved override unlocks exactly that change.
export const changeKey = (type: string, ref: string | string[]) => `${type}:${Array.isArray(ref) ? [...ref].sort().join(",") : ref}`

export const newRequestId = () => `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

// "Turn off THB | Brand | Protect", or the held change's label.
export function requestTitle(r: ChangeRequest) {
  if (r.kind === "status")
    return `${r.status === "ENABLED" ? "Turn on" : "Turn off"} ${r.campaigns.length === 1 ? r.campaigns[0].name : `${r.campaigns.length} campaigns`}`
  return r.change?.label ?? "Change during learning"
}
