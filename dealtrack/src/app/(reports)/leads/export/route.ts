import { isSignedIn } from "@/lib/auth"
import { gradeLabels } from "@/lib/leads/scoring"
import { leadSource } from "@/lib/leads/source"
import { listLeads, listQrCodes } from "@/lib/leads/store"
import { leadChannel } from "@/lib/leads/tracking"
import { leadStatuses } from "@/lib/leads/types"
import { formatPhone } from "@/lib/phone"

// Quote every cell, and stop spreadsheet apps from running a value that starts like a formula.
function cell(value: string | undefined) {
  const text = value ?? ""
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

// GET /leads/export → every lead as a CSV file.
export async function GET() {
  if (!(await isSignedIn())) return new Response("Sign in first.", { status: 401 })
  const [leads, qrCodes] = await Promise.all([listLeads(), listQrCodes()])
  const placements = new Map(qrCodes.map((c) => [c.id, c.placement]))

  const rows = [
    [
      "Date", "Name", "Score", "Grade", "Status", "Phone", "Email", "Property address", "Channel", "UTM source", "UTM medium", "UTM campaign",
      "UTM term", "UTM content", "Google click ID", "Facebook click ID", "Microsoft click ID", "Landing page", "Referrer",
      "Form", "Notes",
    ],
    ...leads.map((l) => [
      l.createdAt, l.name,
      l.score ? String(l.score.value) : "", l.score ? gradeLabels[l.score.grade] : "", leadStatuses.find((s) => s.id === (l.status ?? "new"))?.label,
      l.phone && formatPhone(l.phone), l.email, l.propertyAddress, leadChannel(l),
      l.tracking?.utmSource, l.tracking?.utmMedium, l.tracking?.utmCampaign, l.tracking?.utmTerm, l.tracking?.utmContent,
      l.tracking?.gclid || l.tracking?.gbraid || l.tracking?.wbraid, l.tracking?.fbclid, l.tracking?.msclkid, l.tracking?.landingPage, l.tracking?.referrer,
      leadSource(l, placements), l.notes,
    ]),
  ]
  const csv = rows.map((r) => r.map(cell).join(",")).join("\r\n")
  const date = new Date().toISOString().slice(0, 10)
  return new Response(`﻿${csv}`, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="leads-${date}.csv"` },
  })
}
