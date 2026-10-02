"use server"

// Saving DealTrack's own settings (budget lines, alert thresholds, go-live checks) to the local
// store. These never touch Google Ads. Budget and alert settings are admin-only; every save
// records who made it.

import { refresh } from "next/cache"

import { MANUAL_CHECKS } from "@/lib/audit"
import { isAdmin, isSignedIn } from "@/lib/auth"
import { rememberName } from "@/lib/people"
import { updateData, type GradeSettings } from "@/lib/store"

export type FormState = { ok?: boolean; message?: string }

const MAX_MONEY = 10_000_000

// "" -> null, "12,500" or "$12500" -> 12500. Anything else is an error message.
function money(form: FormData, field: string, label: string): number | null | string {
  const raw = String(form.get(field) ?? "").replace(/[$,\s]/g, "")
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return `${label} must be a dollar amount.`
  return Math.round(n)
}

const signedName = (form: FormData) => rememberName(form.get("name"))

export async function saveBudgetSettings(_prev: FormState, form: FormData): Promise<FormState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can change the budget. Sign in as an admin." }
  const name = await signedName(form)
  if (!name) return { ok: false, message: "Type your name, so everyone can see who set the budget." }

  const monthly = money(form, "monthly", "The monthly budget")
  const alertLine = money(form, "alertLine", "The alert line")
  const pauseLine = money(form, "pauseLine", "The pause line")
  for (const v of [monthly, alertLine, pauseLine]) if (typeof v === "string") return { ok: false, message: v }
  if (typeof alertLine === "number" && typeof pauseLine === "number" && alertLine > pauseLine) {
    return { ok: false, message: "The alert line should come before the pause line, so it has to be lower." }
  }

  await updateData((d) => {
    d.budget = {
      monthly: monthly as number | null,
      alertLine: alertLine as number | null,
      pauseLine: pauseLine as number | null,
      updatedBy: name,
      updatedAt: new Date().toISOString(),
    }
  })
  refresh()
  return { ok: true, message: "Saved." }
}

export async function saveAlertSettings(_prev: FormState, form: FormData): Promise<FormState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can change alert rules. Sign in as an admin." }
  const name = await signedName(form)
  if (!name) return { ok: false, message: "Type your name, so everyone can see who changed the rules." }

  const maxCostPerLead = money(form, "maxCostPerLead", "The cost per lead limit")
  const clickCostAlert = money(form, "clickCostAlert", "The expensive click line")
  const noLeadSpend = money(form, "noLeadSpend", "The spend with no leads")
  const monthNoLeadSpend = money(form, "monthNoLeadSpend", "The monthly spend with nothing back")
  for (const v of [maxCostPerLead, clickCostAlert, noLeadSpend, monthNoLeadSpend]) if (typeof v === "string") return { ok: false, message: v }
  const noLeadDays = Number(form.get("noLeadDays"))
  if (!Number.isInteger(noLeadDays) || noLeadDays < 1 || noLeadDays > 30) return { ok: false, message: "Days with no leads must be 1 to 30." }
  const invalidPct = Number(String(form.get("invalidClickRate") ?? "").replace("%", ""))
  if (!Number.isFinite(invalidPct) || invalidPct <= 0 || invalidPct > 100) return { ok: false, message: "The invalid click share must be 1 to 100%." }

  await updateData((d) => {
    d.alerts = {
      maxCostPerLead: maxCostPerLead as number | null,
      clickCostAlert: clickCostAlert as number | null,
      noLeadDays,
      noLeadSpend: (noLeadSpend as number | null) ?? 0,
      monthNoLeadSpend: (monthNoLeadSpend as number | null) ?? 0,
      invalidClickRate: invalidPct / 100,
      updatedBy: name,
      updatedAt: new Date().toISOString(),
    }
  })
  refresh()
  return { ok: true, message: "Saved." }
}

export async function saveGradeSettings(_prev: FormState, form: FormData): Promise<FormState> {
  if (!(await isAdmin())) return { ok: false, message: "Only admins can change how the grade works. Sign in as an admin." }
  const name = await signedName(form)
  if (!name) return { ok: false, message: "Type your name, so everyone can see who changed the grade." }

  const leadCost = money(form, "leadCost", "What a lead usually costs")
  if (typeof leadCost === "string") return { ok: false, message: leadCost }
  if (!leadCost) return { ok: false, message: "Type what a lead usually costs, e.g. 1500." }
  const strictness = String(form.get("strictness")) as GradeSettings["strictness"]
  if (!["relaxed", "normal", "strict"].includes(strictness)) return { ok: false, message: "Pick how strict the grade is." }

  await updateData((d) => {
    d.grade = { leadCost, strictness, updatedBy: name, updatedAt: new Date().toISOString() }
  })
  refresh()
  return { ok: true, message: "Saved. The grade uses it now." }
}

// Ticks (or unticks) a go-live check that only a person can confirm, like after-hours coverage.
// Anyone signed in can do it, since it records a fact rather than changing anything.
export async function setManualCheck(id: string, done: boolean, rawName: string): Promise<FormState> {
  if (!(await isSignedIn())) return { ok: false, message: "Sign in first." }
  const check = MANUAL_CHECKS.find((m) => m.id === id)
  if (!check) return { ok: false, message: "That check doesn't exist." }
  const name = await rememberName(rawName)
  if (!name) return { ok: false, message: "Type your name first, so everyone can see who checked it." }

  await updateData((d) => {
    d.audit[id] = { done: !!done, by: name, at: new Date().toISOString() }
  })
  refresh()
  return { ok: true, message: done ? `Marked “${check.title}” as checked.` : `Unticked “${check.title}”.` }
}
