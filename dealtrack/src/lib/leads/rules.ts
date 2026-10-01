// Google Ads rules: "when a new lead matches all of these, send it to Google Ads as …". You make
// them on the Leads page; they run in order on every new lead and the first one that matches
// wins. They only decide what Google Ads hears (a qualified lead, a converted lead, or nothing),
// with the value you give it; the lead's status stays yours to set. Setting a status yourself
// still sends what it means (Interested → qualified lead, Closed deal → converted lead).
//
// Nothing in here touches the disk, so the Leads page can also use it to show which recent leads
// a rule would have matched.
import { leadChannel } from "@/lib/leads/tracking"
import type { Lead, LeadGrade } from "@/lib/leads/types"

export type RuleCondition =
  | { kind: "scoreAtLeast"; value: number }
  | { kind: "scoreBelow"; value: number }
  | { kind: "gradeIs"; value: LeadGrade }
  | { kind: "fromGoogleAd" }
  | { kind: "channelIs"; value: string }
  | { kind: "messageHas"; value: string } // any of these words, comma-separated
  | { kind: "searchHas"; value: string } // in the keyword or campaign
  | { kind: "formIs"; value: string } // the form's name contains this
  | { kind: "has"; value: "phone" | "email" | "address" }
  | { kind: "missing"; value: "phone" | "email" | "address" }

// What a rule does: send the lead to Google Ads as a qualified lead, as a converted lead (which
// also counts it as qualified), report it as an invalid lead (reporting only), or not send it.
export type RuleAction = "qualified" | "converted" | "invalid" | "dont_send"
export const ruleActions: { id: RuleAction; label: string }[] = [
  { id: "qualified", label: "Send to Google Ads as a Qualified lead" },
  { id: "converted", label: "Send to Google Ads as a Converted lead" },
  { id: "invalid", label: "Report to Google Ads as an invalid lead (reporting only)" },
  { id: "dont_send", label: "Don't send to Google Ads" },
]

export type LeadRule = {
  id: string
  name: string
  enabled: boolean
  when: RuleCondition[]
  then: RuleAction
  // The conversion value Google Ads gets, in the account's currency (1 when not set).
  value?: number
}

// Rules saved before they were about Google Ads named a status; read those as what it sent.
export function asAction(then: string): RuleAction {
  if (then === "qualified" || then === "converted" || then === "invalid" || then === "dont_send") return then
  if (then === "closed") return "converted"
  if (then === "interested" || then === "appointment" || then === "offer") return "qualified"
  return "dont_send"
}

export const conditionKinds: { kind: RuleCondition["kind"]; label: string }[] = [
  { kind: "scoreAtLeast", label: "Score is at least" },
  { kind: "scoreBelow", label: "Score is below" },
  { kind: "gradeIs", label: "Grade is" },
  { kind: "fromGoogleAd", label: "Came from a Google ad click" },
  { kind: "channelIs", label: "Channel is" },
  { kind: "messageHas", label: "Message mentions any of" },
  { kind: "searchHas", label: "Keyword or campaign mentions any of" },
  { kind: "formIs", label: "Form name contains" },
  { kind: "has", label: "Has a" },
  { kind: "missing", label: "Has no" },
]

// The rules you start with: Junk is reported as invalid (reporting only, never bid for), Hot leads
// go to Google Ads as qualified leads.
export const defaultRules = (): LeadRule[] => [
  { id: "junk", name: "Report junk as invalid", enabled: true, when: [{ kind: "gradeIs", value: "junk" }], then: "invalid" },
  { id: "hot", name: "Hot leads are qualified", enabled: true, when: [{ kind: "gradeIs", value: "hot" }], then: "qualified", value: 1 },
]

const words = (list: string) =>
  list
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
const mentions = (text: string, list: string) => {
  const t = text.toLowerCase().replace(/[_+-]+/g, " ")
  return words(list).some((w) => t.includes(w))
}

function matches(lead: Lead, c: RuleCondition): boolean {
  const score = lead.score
  switch (c.kind) {
    case "scoreAtLeast":
      return Boolean(score && !score.unscored && score.value >= c.value)
    case "scoreBelow":
      return Boolean(score && !score.unscored && score.value < c.value)
    case "gradeIs":
      return score?.grade === c.value && !score.unscored
    case "fromGoogleAd":
      return Boolean(lead.tracking?.gclid)
    case "channelIs":
      return leadChannel(lead).toLowerCase() === c.value.trim().toLowerCase()
    case "messageHas":
      return mentions(lead.notes ?? "", c.value)
    case "searchHas":
      return mentions([lead.tracking?.utmTerm, lead.tracking?.utmCampaign].filter(Boolean).join(" "), c.value)
    case "formIs":
      return Boolean(c.value.trim()) && (lead.source ?? "").toLowerCase().includes(c.value.trim().toLowerCase())
    case "has":
    case "missing": {
      const value = c.value === "phone" ? lead.phone : c.value === "email" ? lead.email : lead.propertyAddress
      return c.kind === "has" ? Boolean(value?.trim()) : !value?.trim()
    }
  }
}

// The first switched-on rule a lead matches (every condition), or null. A rule with no
// conditions never matches, so a half-made rule can't change every lead.
export function firstMatch(lead: Lead, rules: LeadRule[]) {
  return rules.find((r) => r.enabled && r.when.length > 0 && r.when.every((c) => matches(lead, c))) ?? null
}
