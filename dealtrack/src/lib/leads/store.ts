// Website leads, saved in .data/leads.json (the same file and format as One Marketing Command
// Center, so its leads can be copied over). Older files may also hold QR codes; DealTrack only
// reads their placement names to label those leads.
import { randomBytes } from "node:crypto"

import { jsonFileStore } from "@/lib/json-file-store"
import type { Lead, QrCode } from "@/lib/leads/types"

type Db = { qrCodes: QrCode[]; leads: Lead[] }

const file = jsonFileStore<Db>("leads.json", () => ({ qrCodes: [], leads: [] }))

const newId = () =>
  randomBytes(6)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8)
    .padEnd(8, "0")

export async function listQrCodes() {
  const db = await file.read()
  return [...(db.qrCodes ?? [])]
}

// Newest first.
export async function listLeads() {
  const db = await file.read()
  return [...(db.leads ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function addLead(input: Omit<Lead, "id" | "createdAt">) {
  return file.update((db) => {
    const lead: Lead = { ...input, id: newId(), createdAt: new Date().toISOString() }
    db.leads ??= []
    db.leads.push(lead)
    return lead
  })
}
