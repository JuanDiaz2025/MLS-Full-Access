// The lead rules, saved in .data/lead-rules.json. Until you change them, they're the defaults
// (Junk is never sent to Google Ads, Hot leads are sent as qualified leads).
import { jsonFileStore } from "@/lib/json-file-store"
import { asAction, defaultRules, type LeadRule } from "@/lib/leads/rules"

const file = jsonFileStore<{ rules: LeadRule[] }>("lead-rules.json", () => ({ rules: defaultRules() }))

export const getRules = async () => (await file.read()).rules.map((r) => ({ ...r, then: asAction(r.then) }))
export const saveRules = (rules: LeadRule[]) =>
  file.update((db) => {
    db.rules = rules
  })
