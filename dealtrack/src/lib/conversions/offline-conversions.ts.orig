// Feeding lead quality back to Google Ads: when the team marks a lead Interested or Closed deal,
// the app sends an offline conversion for it through Google's Data Manager API (data-manager.ts), so Google's bidding learns which clicks bring real
// sellers. Each upload is matched by the lead's Google click id (gclid, from the WordPress tracking
// snippet) and, when there is one, the lead's email and phone, scrambled with SHA-256 first
// (Google's "enhanced conversions for leads"). Google never receives the plain email or phone.
//
// Each stage goes to a conversion action in the account: your own "Qualified lead" and "Converted
// lead" actions when there are ones that accept imports (found by name, then by category), or
// one you pick on the Leads page. Only when there's none does the app create its own
// ("Command Center – Interested lead" / "– Deal closed"), as secondary conversions.
import { createHash } from "node:crypto"

import { ingestEvents, requestStatus } from "@/lib/conversions/data-manager"
import { AdsApiError, DATA_MANAGER_SCOPE, postToAds, runQuery, type AdsAccount, type AdsConnection } from "@/lib/conversions/google"
import { dryRun } from "@/lib/google-ads/client"
import { jsonFileStore } from "@/lib/json-file-store"
import { shared } from "@/lib/shared-state"
import { applyStatus } from "@/lib/leads/status"
import { listLeads, updateLead } from "@/lib/leads/store"
import { conversionKinds, type ConversionKind, type Lead, type LeadStatus } from "@/lib/leads/types"
import { googleClick } from "@/lib/leads/tracking"

// The actions the app makes when the account has none that accept imported leads. The same names
// as One Marketing Command Center, so both apps send to the same actions.
export const ACTIONS: Record<ConversionKind, { name: string; category: string; legacy: string }> = {
  interested: { name: "Qualified lead (Command Center import)", category: "QUALIFIED_LEAD", legacy: "Command Center – Interested lead" },
  closed: { name: "Converted lead (Command Center import)", category: "CONVERTED_LEAD", legacy: "Command Center – Deal closed" },
  invalid: { name: "Invalid lead (Command Center, reporting only)", category: "DEFAULT", legacy: "" },
}

// Per account: the conversion action each stage goes to, and whether you picked it yourself.
type Targets = { interested?: string; closed?: string; invalid?: string; chosen?: Partial<Record<ConversionKind, boolean>>; checkedAt?: string; v?: 2 }
const actionsFile = jsonFileStore<Record<string, Targets>>("conversion-actions.json", () => ({}))
const RECHECK_MS = 24 * 60 * 60_000

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

// Google's normalizing rules: lower case, no spaces; Gmail addresses without dots before the @.
export function normalizeEmail(email: string) {
  const e = email.trim().toLowerCase()
  const [local, domain] = e.split("@")
  if (!local || !domain) return null
  return domain === "gmail.com" || domain === "googlemail.com" ? `${local.replace(/\./g, "")}@${domain}` : e
}

// E.164, e.g. +13055550100. Ten digits are taken as a US number.
export function normalizePhone(phone: string) {
  const digits = phone.replace(/[^\d]/g, "")
  if (phone.trim().startsWith("+") && digits.length >= 8) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

function identifiers(lead: Lead) {
  const ids: ({ emailAddress: string } | { phoneNumber: string })[] = []
  const email = lead.email ? normalizeEmail(lead.email) : null
  const phone = lead.phone ? normalizePhone(lead.phone) : null
  if (email) ids.push({ emailAddress: sha256(email) })
  if (phone) ids.push({ phoneNumber: sha256(phone) })
  return ids
}

export type ConversionActionOption = {
  resourceName: string
  name: string
  category: string
  type: string
  importable: boolean
  primary: boolean
  // The account that owns it, when that's another one (a manager account's action shared with this one).
  owner?: string
}

// The account's enabled conversion actions. Only "import from clicks" ones can receive leads.
export async function listConversionActions(connection: AdsConnection, account: AdsAccount): Promise<ConversionActionOption[]> {
  const rows = (await runQuery(
    connection,
    account,
    "SELECT conversion_action.resource_name, conversion_action.name, conversion_action.category, conversion_action.type, conversion_action.primary_for_goal, conversion_action.owner_customer FROM conversion_action WHERE conversion_action.status = 'ENABLED'",
  )) as { conversionAction?: { resourceName?: string; name?: string; category?: string; type?: string; primaryForGoal?: boolean; ownerCustomer?: string } }[]
  return rows
    .map((r) => r.conversionAction ?? {})
    .filter((a): a is Required<typeof a> => Boolean(a.resourceName && a.name))
    .map((a) => {
      const owner = a.ownerCustomer?.match(/customers\/(\d+)/)?.[1]
      return {
        resourceName: a.resourceName,
        name: a.name,
        category: a.category ?? "",
        type: a.type ?? "",
        importable: a.type === "UPLOAD_CLICKS",
        primary: Boolean(a.primaryForGoal),
        ...(owner && owner !== account.customerId ? { owner } : {}),
      }
    })
    .sort((x, y) => x.name.localeCompare(y.name))
}

// The account that owns a conversion action, when it isn't this one (looked up once per run of the app).
const owners = ((globalThis as typeof globalThis & { __omccOwners?: Map<string, string | null> }).__omccOwners ??= new Map())
async function ownerOf(connection: AdsConnection, account: AdsAccount, resource: string) {
  const key = `${account.customerId}:${resource}`
  if (!owners.has(key)) {
    try {
      const found = (await listConversionActions(connection, account)).find((o) => o.resourceName === resource)
      owners.set(key, found?.owner ?? null)
    } catch {
      return undefined // not known this time: send as before
    }
  }
  return owners.get(key) ?? undefined
}

// Your own action for a stage: by name first ("Qualified lead" / "Converted lead"), then by
// Google's category; the app's own actions only if there's nothing else.
const NAMES: Record<ConversionKind, RegExp> = {
  interested: /qualified\s*lead/i,
  closed: /convert(ed)?\s*lead|closed?\s*(deal|lead)|deal\s*closed/i,
  invalid: /invalid|junk|disqualif|not\s*interested|bad\s*lead|spam/i,
}
const isOurs = (o: ConversionActionOption) => o.name.includes("Command Center")
function pick(options: ConversionActionOption[], kind: ConversionKind) {
  // Invalid leads only ever go to a secondary action, so they can't teach bidding to find more.
  if (kind === "invalid") {
    const ok = options.filter((o) => o.importable && !o.primary)
    return ok.find((o) => !isOurs(o) && NAMES.invalid.test(o.name)) ?? ok.find((o) => o.name === ACTIONS.invalid.name)
  }
  const ok = options.filter((o) => o.importable && !isOurs(o))
  return (
    ok.find((o) => NAMES[kind].test(o.name)) ??
    ok.find((o) => o.category === ACTIONS[kind].category) ??
    options.find((o) => o.importable && (o.name === ACTIONS[kind].name || o.name === ACTIONS[kind].legacy))
  )
}

// Which action each stage goes to, looking them up (again once a day, for stages you didn't pick).
export async function conversionTargets(connection: AdsConnection, account: AdsAccount) {
  const options = await listConversionActions(connection, account)
  let saved = (await actionsFile.read())[account.customerId] ?? {}
  const stale = saved.v !== 2 || !saved.checkedAt || Date.now() - Date.parse(saved.checkedAt) > RECHECK_MS
  const gone = (r?: string) => Boolean(r && !options.some((o) => o.resourceName === r))
  if (stale || gone(saved.interested) || gone(saved.closed) || gone(saved.invalid)) {
    saved = await actionsFile.update((db) => {
      const t: Targets = { ...db[account.customerId], v: 2, checkedAt: new Date().toISOString() }
      t.chosen ??= {}
      for (const kind of conversionKinds) {
        if (t.chosen[kind] && !gone(t[kind])) continue
        t.chosen[kind] = false
        t[kind] = pick(options, kind)?.resourceName
      }
      db[account.customerId] = t
      return t
    })
  }
  const named = (r?: string) => options.find((o) => o.resourceName === r)
  // Your own action by that name exists but can't receive imported leads (e.g. it counts a website form).
  const blocked = (kind: ConversionKind) => options.find((o) => !o.importable && !isOurs(o) && NAMES[kind].test(o.name))?.name
  return {
    blocked: { interested: blocked("interested"), closed: blocked("closed") },
    options,
    interested: named(saved.interested),
    closed: named(saved.closed),
    invalid: named(saved.invalid),
    chosen: saved.chosen ?? {},
  }
}

// You pick the action for a stage on the Leads page; it stays until you change it.
export async function setConversionTarget(connection: AdsConnection, account: AdsAccount, kind: ConversionKind, resourceName: string) {
  const options = await listConversionActions(connection, account)
  const chosen = options.find((o) => o.resourceName === resourceName)
  if (!chosen?.importable) {
    throw new AdsApiError("That conversion action can't receive imported leads. Pick one whose source is \"Import from clicks\".")
  }
  if (kind === "invalid" && chosen.primary) {
    throw new AdsApiError("That action is primary, so Google would bid for more leads like these. Pick a secondary one, or make it secondary in Google Ads first.")
  }
  await actionsFile.update((db) => {
    const t: Targets = { ...db[account.customerId], v: 2, checkedAt: db[account.customerId]?.checkedAt ?? new Date().toISOString() }
    t[kind] = resourceName
    t.chosen = { ...t.chosen, [kind]: true }
    db[account.customerId] = t
  })
}

// The conversion action a stage is sent to, creating the app's own one only if the account has
// nothing that fits.
async function conversionAction(connection: AdsConnection, account: AdsAccount, kind: ConversionKind) {
  const saved = (await actionsFile.read())[account.customerId]
  const fresh = saved?.v === 2 && saved.checkedAt && Date.now() - Date.parse(saved.checkedAt) < RECHECK_MS
  if (fresh && saved[kind]) return saved[kind]!
  const targets = await conversionTargets(connection, account)
  const target = targets[kind]?.resourceName
  if (target) return target
  const { name, category } = ACTIONS[kind]
  let created: { results?: { resourceName?: string }[] }
  try {
    created = await createAction(connection, account, kind, name, category)
  } catch (e) {
    // The app's own action is already there (made earlier, maybe by One Marketing Command Center),
    // but wasn't picked: it's primary, hidden, or not an import. Use it if it fits, else say what
    // to change in Google Ads instead of failing the same way every hour.
    if (!(e instanceof AdsApiError) || !/already exists|DUPLICATE_NAME/i.test(e.message)) throw e
    const existing = await existingAction(connection, account, name, kind)
    await actionsFile.update((db) => {
      db[account.customerId] = { ...db[account.customerId], [kind]: existing, v: 2, checkedAt: new Date().toISOString() }
    })
    return existing
  }
  const resource = created.results?.[0]?.resourceName
  if (!resource) throw new AdsApiError("Google Ads didn't create the conversion action.")
  await actionsFile.update((db) => {
    db[account.customerId] = { ...db[account.customerId], [kind]: resource, v: 2, checkedAt: new Date().toISOString() }
  })
  return resource
}

// The app's own action by name, if it can take this stage's leads; otherwise what to fix.
async function existingAction(connection: AdsConnection, account: AdsAccount, name: string, kind: ConversionKind) {
  const rows = (await runQuery(
    connection,
    account,
    `SELECT conversion_action.resource_name, conversion_action.status, conversion_action.type, conversion_action.primary_for_goal
     FROM conversion_action WHERE conversion_action.name = '${name.replace(/'/g, "\\'")}' AND conversion_action.status != 'REMOVED'`,
  )) as { conversionAction?: { resourceName?: string; status?: string; type?: string; primaryForGoal?: boolean } }[]
  const a = rows[0]?.conversionAction
  const where = "In Google Ads: Goals → Conversions → Summary → open it → Edit settings"
  if (!a?.resourceName) throw new AdsApiError(`Google Ads says “${name}” already exists but didn't return it. Pick an action for this stage on Leads → Lead automation.`)
  if (a.type !== "UPLOAD_CLICKS")
    throw new AdsApiError(`“${name}” already exists in Google Ads but isn't an “Import from clicks” action, so it can't receive leads. Rename or remove it in Google Ads, or pick another action on Leads → Lead automation.`)
  if (a.status !== "ENABLED")
    throw new AdsApiError(`“${name}” is ${String(a.status ?? "off").toLowerCase()} in Google Ads. Turn it back on (${where}), or pick another action on Leads → Lead automation.`)
  if (kind === "invalid" && a.primaryForGoal)
    throw new AdsApiError(
      `“${name}” is set as a primary conversion in Google Ads, so junk leads aren't sent to it (Google would bid for more like them). Make it secondary (${where} → Action optimization: Secondary), or pick another secondary action on Leads → Lead automation.`,
    )
  return a.resourceName
}

function createAction(connection: AdsConnection, account: AdsAccount, kind: ConversionKind, name: string, category: string) {
  return postToAds<{ results?: { resourceName?: string }[] }>(connection, account, "/conversionActions:mutate", {
    operations: [
      {
        create: {
          name,
          type: "UPLOAD_CLICKS",
          category,
          status: "ENABLED",
          countingType: "ONE_PER_CLICK",
          primaryForGoal: false,
          // The value comes with each lead (your rules' value, or 1; invalid leads are worth 0).
          valueSettings: { defaultValue: kind === "invalid" ? 0 : 1, alwaysUseDefaultValue: false },
        },
      },
    ],
  })
}

// Errors worth trying again later: a just-created conversion action, or a click Google hasn't
// processed yet. Anything else is reported and not retried.
const RETRY = /NOT_FOUND|TOO_RECENT|CLICK_NOT_FOUND|INTERNAL|TRANSIENT|DEADLINE|UNAVAILABLE|RESOURCE_EXHAUSTED|RATE/i
const SETUP_RETRY_MS = 5 * 60_000
// Refused by the old upload Google closed to new apps: send these again the new way.
const OLD_UPLOAD_CLOSED = /ConversionUploadService|limited to existing users/i
// The old "not found" refusal, from before the app sent to the account that owns the action.
const NOT_FOUND_BEFORE = /^(?!Google can't find)[\s\S]*Resource not found/i
// "The specified conversion action name already exists", from before the app reused its own action.
const NAME_TAKEN_BEFORE = /conversion action name already exists/i
// Refusals that depend on which account the lead went to.
const ACCOUNT_RELATED = /Resource not found|can't find the conversion action|terms for enhanced conversions|customer data terms|PERMISSION_DENIED|can't use that Google Ads account/i
const MAX_TRIES = 12
// One for the whole app (pages and API routes alike), see shared-state.ts.
const run = shared("conversions-run", () => ({
  lastRelookup: 0,
  running: null as Promise<void> | null,
  // Asked again during a run: go once more after it, with the latest account (it may have changed).
  again: null as { connection: AdsConnection; account: AdsAccount } | null,
}))
const RETRY_AFTER_MS = 60 * 60_000

async function upload(connection: AdsConnection, account: AdsAccount, lead: Lead, kind: ConversionKind) {
  const entry = lead.conversions?.[kind]
  if (!entry) return
  // Marked Not interested: only its invalid-lead report goes to Google.
  if (kind !== "invalid" && lead.status === "not_interested") {
    await updateLead(lead.id, (l) => {
      if (l.conversions?.[kind]?.state !== "sent") delete l.conversions?.[kind]
    })
    return
  }
  const click = googleClick(lead.tracking)
  const ids = identifiers(lead)
  if (!click && !ids.length) {
    await updateLead(lead.id, (l) => {
      l.conversions![kind] = { ...entry, state: "skipped", error: "No Google click ID, email or phone to match it with." }
    })
    return
  }
  let error: string | undefined
  let code = ""
  let action = ""
  let requestId: string | undefined
  try {
    action = await conversionAction(connection, account, kind)
    const owner = await ownerOf(connection, account, action)
    ;({ requestId } = await ingestEvents(connection, account, action.split("/").pop()!, [
      {
        eventTimestamp: new Date(entry.at).toISOString(),
        // The same lead and stage is only ever counted once, even if sent again.
        transactionId: entry.transactionId ?? `${lead.id}-${kind}`,
        eventSource: "WEB",
        ...(click ? { adIdentifiers: click } : {}),
        ...(ids.length ? { userData: { userIdentifiers: ids } } : {}),
        conversionValue: entry.value ?? (kind === "invalid" ? 0 : 1),
        currency: account.currency || "USD",
      },
    ], false, owner))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
    code = e instanceof AdsApiError ? (e.code ?? "") : ""
    // The conversion action may have been removed or replaced in Google Ads: look them up again next time.
    if (code === "NOT_FOUND" && Date.now() - run.lastRelookup > 10 * 60_000) {
      run.lastRelookup = Date.now()
      owners.clear()
      await actionsFile.update((db) => {
        if (db[account.customerId]) delete db[account.customerId].checkedAt
      })
    }
  }
  const now = new Date().toISOString()
  await updateLead(lead.id, (l) => {
    // Work from the lead as saved now: the status may have changed while this was being sent.
    const current = l.conversions?.[kind]
    if (!current || current.state !== "pending") return
    if (current.at !== entry.at) return // set again meanwhile: the next run sends the new one
    const tries = (current.tries ?? 0) + 1
    // Waiting on a set-up step (a permission, the API turned on): keep it waiting, without
    // counting tries, and check again every few minutes.
    const waitingFor = code === "NEEDS_PERMISSION" ? "permission" : code === "API_OFF" ? "api" : undefined
    l.conversions![kind] = error
      ? {
          ...current,
          tries: waitingFor ? (current.tries ?? 0) : tries,
          lastTry: now,
          error,
          waitingFor,
          accountId: account.customerId,
          state: waitingFor || (RETRY.test(`${code} ${error}`) && tries < MAX_TRIES) ? "pending" : "failed",
        }
      : { at: current.at, value: current.value, rule: current.rule, transactionId: current.transactionId ?? `${l.id}-${kind}`, action, requestId, tries, lastTry: now, state: "sent", matchedBy: [click && "Google click ID", ids.length && "email/phone"].filter(Boolean).join(" + ") }
  })
}

// Google's reasons in plain words.
const REASONS: Record<string, string> = {
  INVALID_CLICK_ID: "Google doesn't recognize the click ID (a typed-in test, or a click from another account)",
  CLICK_NOT_FOUND: "Google couldn't find that ad click",
  EXPIRED_EVENT: "the ad click was too long ago (over 90 days)",
  EVENT_TOO_OLD: "the ad click was too long ago (over 90 days)",
  DUPLICATE_TRANSACTION_ID: "it was already sent before",
  NO_MATCH: "Google couldn't match it to anyone who clicked your ads",
}
const humanize = (reason: string) => REASONS[reason] ?? reason.toLowerCase().replace(/_/g, " ")

// Asks Google what it decided about a sent conversion: at most every 30 minutes, starting 30
// minutes after sending, for up to 3 days.
async function checkDecision(connection: AdsConnection, lead: Lead, kind: ConversionKind) {
  const entry = lead.conversions?.[kind]
  if (!entry?.requestId) return
  let decided: NonNullable<typeof entry.google>
  const now = new Date().toISOString()
  try {
    const res = await requestStatus(connection, entry.requestId)
    const statuses = res.requestStatusPerDestination ?? []
    const errors = statuses.flatMap((d) => d.errorInfo?.errorCounts ?? []).map((e) => e.reason ?? "").filter(Boolean)
    const warnings = statuses.flatMap((d) => d.warningInfo?.warningCounts ?? []).map((w) => w.reason ?? "").filter(Boolean)
    const states = statuses.map((d) => d.requestStatus)
    if (!states.length || states.some((st) => st === "PROCESSING" || st === "REQUEST_STATUS_UNKNOWN")) decided = { status: "processing", checkedAt: now }
    else if (states.every((st) => st === "SUCCESS") && !errors.length) decided = { status: "accepted", reason: warnings.map(humanize).join("; ") || undefined, checkedAt: now }
    else decided = { status: "rejected", reason: [...errors, ...warnings].map(humanize).join("; ") || "Google turned it down", checkedAt: now }
  } catch (e) {
    // Try again later, but keep why it didn't work, so the Leads page can say so.
    decided = { status: "processing", reason: `Couldn't ask Google: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), checkedAt: now }
  }
  await updateLead(lead.id, (l) => {
    const e = l.conversions?.[kind]
    if (e && e.requestId === entry.requestId) e.google = decided
  })
}
const CHECK_AFTER_MS = 30 * 60_000
const CHECK_FOR_MS = 3 * 24 * 60 * 60_000

// Google Ads' time format: "yyyy-mm-dd hh:mm:ss+00:00".
const adsTime = (iso: string) => `${new Date(iso).toISOString().slice(0, 19).replace("T", " ")}+00:00`
// Not found yet usually means Google hasn't finished processing the conversion (it takes hours).
const RETRACT_RETRY = /CONVERSION_NOT_FOUND|TOO_RECENT|ADJUSTMENT_PRECEDES|INTERNAL|TRANSIENT|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE/i

type AdjustResult = { partialFailureError?: { message?: string; details?: { errors?: { message?: string; errorCode?: Record<string, string> }[] }[] } }

// Takes a sent conversion back from Google Ads (a retraction), by the id it was sent with, or by
// its Google click id and time when Google doesn't know that id.
async function retract(connection: AdsConnection, account: AdsAccount, lead: Lead, kind: ConversionKind) {
  const entry = lead.conversions?.[kind]
  const r = entry?.retraction
  if (!entry || !r) return
  const sentTo = entry.action ?? (await conversionAction(connection, account, kind).catch(() => undefined))
  let error: string | undefined
  let code = ""
  if (!sentTo) error = "Couldn't find which conversion action it was sent to."
  else {
    const base = { conversionAction: sentTo, adjustmentType: "RETRACTION", adjustmentDateTime: adsTime(r.at) }
    // Taken back in the account that owns the conversion action (a manager account, with
    // cross-account conversion tracking), where it was counted.
    const owner = sentTo.match(/^customers\/(\d+)\//)?.[1]
    const target = owner && owner !== account.customerId ? { ...account, customerId: owner, loginCustomerId: account.loginCustomerId ?? owner } : account
    const attempt = async (id: Record<string, unknown>) => {
      const res = await postToAds<AdjustResult>(connection, target, ":uploadConversionAdjustments", {
        conversionAdjustments: [{ ...base, ...id }],
        partialFailure: true,
      })
      const f = res.partialFailureError?.details?.[0]?.errors?.[0]
      return res.partialFailureError
        ? { error: f?.message ?? res.partialFailureError.message ?? "Google Ads refused it.", code: f?.errorCode ? Object.values(f.errorCode)[0] : "" }
        : null
    }
    try {
      let failed = await attempt({ orderId: entry.transactionId ?? `${lead.id}-${kind}` })
      // (Only a gclid works here; iPhone click ids can't be matched this way.)
      const gclid = googleClick(lead.tracking)?.gclid
      if (failed && /NOT_FOUND|ORDER_ID/i.test(`${failed.code} ${failed.error}`) && gclid) {
        failed = await attempt({ gclidDateTimePair: { gclid, conversionDateTime: adsTime(entry.at) } })
      }
      if (failed) ({ error, code } = failed)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      code = e instanceof AdsApiError ? (e.code ?? "") : ""
    }
  }
  const now = new Date().toISOString()
  await updateLead(lead.id, (l) => {
    const current = l.conversions?.[kind]?.retraction
    if (!current || current.state !== "pending") return
    const tries = (current.tries ?? 0) + 1
    l.conversions![kind]!.retraction = error
      ? { ...current, tries, lastTry: now, error, state: RETRACT_RETRY.test(`${code} ${error}`) && tries < MAX_TRIES ? "pending" : "failed" }
      : { at: current.at, tries, lastTry: now, state: "sent" }
  })
}

// Sets a lead's status (chosen by you) and queues the conversions it means; they're sent right
// away when Google Ads is connected, and retried later if Google isn't ready for them yet.
export async function setLeadStatus(id: string, status: LeadStatus) {
  return updateLead(id, (lead) => applyStatus(lead, status, "you"))
}

// Sends every conversion waiting to go: new ones at once, retries at most hourly.
export function sendPendingConversions(connection: AdsConnection, account: AdsAccount): Promise<void> {
  // Asked again while a run is going (e.g. a status was just changed): go once more after it,
  // so the new conversion isn't left for the next page load.
  if (run.running) {
    run.again = { connection, account }
    return run.running
  }
  // DEALTRACK_VALIDATE_ONLY=1 is DealTrack's test mode: nothing reaches Google Ads, so conversions
  // wait (the Leads page's check still asks Google to test one without counting it).
  if (dryRun()) return Promise.resolve()
  run.running = (async () => {
    // Failed in another Google Ads account (you picked another one, or the app now opens on your
    // main account): give it another go in this one, at most a few times, so switching back and
    // forth can't resend the same failures without end. Lead statuses are respected below.
    for (const lead of await listLeads()) {
      for (const kind of conversionKinds) {
        const e = lead.conversions?.[kind]
        if (e?.state !== "failed" || e.accountId === account.customerId || (e.accountResets ?? 0) >= 3) continue
        // No account recorded (failed before this was kept): only account-related refusals.
        if (!e.accountId && !ACCOUNT_RELATED.test(e.error ?? "")) continue
        if (kind !== "invalid" && lead.status === "not_interested") continue
        await updateLead(lead.id, (l) => {
          const c = l.conversions?.[kind]
          if (c?.state === "failed" && c.accountId === e.accountId) {
            l.conversions![kind] = { ...c, state: "pending", tries: 0, lastTry: undefined, error: undefined, accountResets: (c.accountResets ?? 0) + 1 }
          }
        })
      }
    }
    const leads = await listLeads()
    for (const lead of leads) {
      for (const kind of conversionKinds) {
        let entry = lead.conversions?.[kind]
        // Refused as "not found" before the app learned to send to the account that owns the
        // conversion action: try those once more.
        if (entry?.state === "failed" && !entry.fixRetry && NOT_FOUND_BEFORE.test(entry.error ?? "") && !(kind !== "invalid" && lead.status === "not_interested")) {
          const again = { ...entry, state: "pending" as const, tries: 0, error: undefined, lastTry: undefined, fixRetry: true }
          await updateLead(lead.id, (l) => {
            l.conversions![kind] = again
          })
          lead.conversions![kind] = entry = again
        }
        if (entry?.state === "failed" && !entry.nameRetry && NAME_TAKEN_BEFORE.test(entry.error ?? "") && !(kind !== "invalid" && lead.status === "not_interested")) {
          const again = { ...entry, state: "pending" as const, tries: 0, error: undefined, lastTry: undefined, nameRetry: true }
          await updateLead(lead.id, (l) => {
            l.conversions![kind] = again
          })
          lead.conversions![kind] = entry = again
        }
        if (entry?.state === "failed" && OLD_UPLOAD_CLOSED.test(entry.error ?? "")) {
          const again = { state: "pending" as const, at: entry.at, value: entry.value, rule: entry.rule, transactionId: entry.transactionId }
          await updateLead(lead.id, (l) => {
            l.conversions![kind] = again
          })
          lead.conversions![kind] = entry = again
        }
        // Sent earlier but no longer true (Not interested now, or an invalid report on a lead that's
        // good again): take it back.
        if (entry?.state === "sent" && !entry.retraction && entry.google?.status !== "rejected" && (kind === "invalid" ? lead.status !== "not_interested" && !lead.googleBlockedBy && !entry.rule : lead.status === "not_interested")) {
          const at = new Date().toISOString()
          await updateLead(lead.id, (l) => {
            const e = l.conversions?.[kind]
            if (e?.state === "sent" && !e.retraction) e.retraction = { state: "pending", at }
          })
          entry.retraction = { state: "pending", at }
        }
        // What Google decided about one it already has.
        if (entry?.state === "sent" && entry.requestId && entry.google?.status !== "accepted" && entry.google?.status !== "rejected") {
          const sentAt = Date.parse(entry.lastTry ?? entry.at)
          const lastCheck = entry.google ? Date.parse(entry.google.checkedAt) : 0
          if (Date.now() - sentAt >= CHECK_AFTER_MS && Date.now() - sentAt < CHECK_FOR_MS && Date.now() - lastCheck >= CHECK_AFTER_MS) {
            await checkDecision(connection, lead, kind)
          }
        }
        const r = entry?.retraction
        if (r?.state === "pending" && (!r.lastTry || Date.now() - Date.parse(r.lastTry) >= RETRY_AFTER_MS)) {
          await retract(connection, account, lead, kind)
          continue
        }
        if (entry?.state !== "pending") continue
        const wait = entry.waitingFor ? SETUP_RETRY_MS : RETRY_AFTER_MS
        if (entry.lastTry && Date.now() - Date.parse(entry.lastTry) < wait) continue
        await upload(connection, account, lead, kind)
      }
    }
  })().finally(() => {
    run.running = null
    if (run.again) {
      const next = run.again
      run.again = null
      void sendPendingConversions(next.connection, next.account).catch((error) => console.error("Couldn't send conversions to Google Ads:", error))
    }
  })
  return run.running
}

// Sends every waiting or failed conversion again now, without the hourly wait (the Leads page's
// "Try again now"). Ones that can't be matched (no click ID, email or phone) are left as they are.
export async function retryNow(connection: AdsConnection, account: AdsAccount) {
  for (const lead of await listLeads()) {
    for (const kind of conversionKinds) {
      const entry = lead.conversions?.[kind]
      if (entry?.state !== "pending" && entry?.state !== "failed") continue
      if (kind !== "invalid" && lead.status === "not_interested") continue
      await updateLead(lead.id, (l) => {
        const e = l.conversions?.[kind]
        if (e && (e.state === "pending" || e.state === "failed")) l.conversions![kind] = { state: "pending", at: e.at, value: e.value, rule: e.rule, transactionId: e.transactionId }
      })
    }
  }
  await sendPendingConversions(connection, account)
}

export type CheckStep = { ok: boolean; title: string; detail: string }

// Checks, one by one, everything sending to Google Ads needs, and says what to do about the
// first thing that's wrong. The last step asks Google to check a test conversion without
// counting it (validateOnly).
export async function checkSending(connection: AdsConnection, account: AdsAccount): Promise<CheckStep[]> {
  const steps: CheckStep[] = [{ ok: true, title: "Google Ads connected", detail: `Account “${account.name}” (${account.customerId}), signed in as ${connection.email}.` }]
  const granted = connection.scopes ?? []
  if (!granted.includes(DATA_MANAGER_SCOPE)) {
    steps.push({
      ok: false,
      title: "Permission to send conversions",
      detail: granted.length
        ? "Google didn't give DealTrack permission to send conversions. Click “Connect Google for conversions” again and leave every box ticked, including the one about your advertising data."
        : "DealTrack's Google Ads key can read and change the account but not send conversions. On this page, click “Connect Google for conversions” and leave every box ticked.",
    })
  } else steps.push({ ok: true, title: "Permission to send conversions", detail: "Granted." })

  let actionId: string | undefined
  let actionOwner: string | undefined
  try {
    const t = await conversionTargets(connection, account)
    const q = t.interested
    steps.push(
      q
        ? { ok: true, title: "Conversion action for qualified leads", detail: `“${q.name}” (accepts imported leads).` }
        : { ok: true, title: "Conversion action for qualified leads", detail: "None that accepts imports yet: the app makes “Qualified lead (Command Center import)” with the first lead." },
    )
    actionId = q?.resourceName.split("/").pop()
    actionOwner = q?.owner
  } catch (e) {
    steps.push({ ok: false, title: "Conversion actions", detail: `Couldn't read them from Google Ads: ${e instanceof Error ? e.message : String(e)}` })
    return steps
  }

  steps.push(...(await accountSettings(connection, account)))

  if (!actionId) return steps
  try {
    await ingestEvents(
      connection,
      account,
      actionId,
      [
        {
          eventTimestamp: new Date().toISOString(),
          transactionId: `command-center-check-${Date.now()}`,
          eventSource: "WEB",
          userData: { userIdentifiers: [{ emailAddress: sha256("check@example.com") }] },
          conversionValue: 1,
          currency: account.currency || "USD",
        },
      ],
      true,
      actionOwner,
    )
    steps.push({ ok: true, title: "Test send to Google (not counted)", detail: "Google accepted it. Sending works." })
  } catch (e) {
    const code = e instanceof AdsApiError ? e.code : undefined
    steps.push({
      ok: false,
      title: "Test send to Google (not counted)",
      detail:
        code === "API_OFF" || code === "NEEDS_PERMISSION"
          ? (e as Error).message
          : `Google said: “${e instanceof Error ? e.message : String(e)}”. Send this message to your developer.`,
    })
  }
  return steps
}

type TrackingRow = {
  customer?: {
    id?: string
    conversionTrackingSetting?: {
      acceptedCustomerDataTerms?: boolean
      enhancedConversionsForLeadsEnabled?: boolean
      conversionTrackingStatus?: string
      googleAdsConversionCustomer?: string
    }
  }
}
type ActionRow = { conversionAction?: { name?: string; status?: string; type?: string; category?: string; primaryForGoal?: boolean } }

// The Google Ads settings that make imported leads count, read from the account. These can only
// be changed in Google Ads itself, so each one that's off says where to click.
async function accountSettings(connection: AdsConnection, account: AdsAccount): Promise<CheckStep[]> {
  const out: CheckStep[] = []
  try {
    const rows = (await runQuery(
      connection,
      account,
      "SELECT customer.id, customer.conversion_tracking_setting.accepted_customer_data_terms, customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled, customer.conversion_tracking_setting.conversion_tracking_status, customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 1",
    )) as TrackingRow[]
    const t = rows[0]?.customer?.conversionTrackingSetting ?? {}
    out.push(
      t.enhancedConversionsForLeadsEnabled
        ? { ok: true, title: "Enhanced conversions for leads", detail: "On." }
        : {
            ok: false,
            title: "Enhanced conversions for leads",
            detail:
              "Off. In Google Ads: Goals → Settings → Enhanced conversions for leads → turn it on, pick “Google Ads API” as the way you send data, and save. Without it, leads without a click ID can't be matched and lead goals show “Misconfigured”.",
          },
      t.acceptedCustomerDataTerms
        ? { ok: true, title: "Customer data terms", detail: "Accepted." }
        : {
            ok: false,
            title: "Customer data terms",
            detail: "Not accepted. In Google Ads: Goals → Settings → Customer data terms → read and accept them. Google won't use the scrambled email or phone until you do.",
          },
    )
    const owner = t.googleAdsConversionCustomer?.match(/customers\/(\d+)/)?.[1]
    if (owner && owner !== account.customerId) {
      out.push({
        ok: false,
        title: "Who owns the conversion actions",
        detail: `This account's conversions are managed by account ${owner} (cross-account conversion tracking). Leads must be sent to that account: set GOOGLE_ADS_CUSTOMER_ID to it.`,
      })
    }
  } catch (e) {
    out.push({ ok: false, title: "Google Ads conversion settings", detail: `Couldn't read them: ${e instanceof Error ? e.message : String(e)}` })
  }
  // The lead goals' actions: Google flags a goal as misconfigured when its primary action can't
  // take imports, or none is primary.
  try {
    const rows = (await runQuery(
      connection,
      account,
      "SELECT conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.category IN ('QUALIFIED_LEAD', 'CONVERTED_LEAD') AND conversion_action.status != 'REMOVED'",
    )) as ActionRow[]
    for (const goal of ["QUALIFIED_LEAD", "CONVERTED_LEAD"] as const) {
      const label = goal === "QUALIFIED_LEAD" ? "Qualified lead goal" : "Converted lead goal"
      const actions = rows.map((r) => r.conversionAction ?? {}).filter((a) => a.category === goal)
      const primary = actions.filter((a) => a.primaryForGoal && a.status === "ENABLED")
      const list = actions.map((a) => `“${a.name}” (${a.type === "UPLOAD_CLICKS" ? "import" : (a.type ?? "").toLowerCase().replace(/_/g, " ")}${a.primaryForGoal ? ", primary" : ", secondary"}${a.status !== "ENABLED" ? `, ${(a.status ?? "").toLowerCase()}` : ""})`).join(", ")
      if (!actions.length) out.push({ ok: false, title: label, detail: "No conversion action in this goal. The app makes one with the first lead." })
      else if (!primary.length) out.push({ ok: false, title: label, detail: `No primary action, so Google can't use it for bidding: ${list}. In Google Ads: Goals → Summary → ${label.replace(" goal", "")} → Edit goal → make the import action primary.` })
      else if (!primary.some((a) => a.type === "UPLOAD_CLICKS")) out.push({ ok: false, title: label, detail: `Its primary action doesn't take imported leads: ${list}. Make the “import” action primary (Goals → Summary → Edit goal).` })
      else out.push({ ok: true, title: label, detail: list })
    }
  } catch (e) {
    out.push({ ok: false, title: "Lead goals", detail: `Couldn't read them: ${e instanceof Error ? e.message : String(e)}` })
  }
  return out
}
