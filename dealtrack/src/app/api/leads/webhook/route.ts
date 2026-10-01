import { revalidatePath } from "next/cache"

import { isValidSecret, parseWebsiteLead } from "@/lib/leads/webhook"
import { fieldNames, MAX_BYTES, mergeFields, parseBody } from "@/lib/leads/incoming"
import { addLead } from "@/lib/leads/store"
import { logAttempt } from "@/lib/leads/webhook-log"

// POST /api/leads/webhook?key=<secret>  (or header "X-Webhook-Secret: <secret>")
// Where the WordPress site sends each new form lead. Accepts JSON or a regular form post.
// Open to the internet, so it only answers when the secret matches.

async function authorized(request: Request) {
  const url = new URL(request.url)
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  return isValidSecret(url.searchParams.get("key") ?? request.headers.get("x-webhook-secret") ?? bearer)
}

async function readBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0)
  if (length > MAX_BYTES) return null
  return parseBody(request.headers.get("content-type") ?? "", await request.text())
}

const queryFields = (request: Request) => Object.fromEntries(new URL(request.url).searchParams)

async function receive(body: unknown) {
  const lead = parseWebsiteLead(body)
  if (!lead) {
    await logAttempt({ ok: false, result: "no-contact", fields: fieldNames(body) })
    revalidatePath("/leads")
    return Response.json(
      { ok: false, error: "No name, phone or email found in the data sent." },
      { status: 422 },
    )
  }
  const saved = await addLead(lead)
  await logAttempt({ ok: true, result: "lead", lead: lead.name.slice(0, 80), fields: fieldNames(body) })
  revalidatePath("/leads")
  return Response.json({ ok: true, id: saved.id })
}

export async function POST(request: Request) {
  if (!(await authorized(request))) {
    await logAttempt({ ok: false, result: "wrong-key" })
    return Response.json({ ok: false, error: "Wrong or missing key." }, { status: 401 })
  }
  return receive(mergeFields(queryFields(request), await readBody(request)))
}

// With form fields in the address, a lead sent by GET; otherwise a plugin's "test connection",
// which checks the address and key without adding a lead.
export async function GET(request: Request) {
  if (!(await authorized(request))) {
    await logAttempt({ ok: false, result: "wrong-key" })
    return Response.json({ ok: false, error: "Wrong or missing key." }, { status: 401 })
  }
  const query = mergeFields(queryFields(request), {}) as Record<string, string>
  if (Object.keys(query).length) return receive(query)
  await logAttempt({ ok: true, result: "test" })
  return Response.json({ ok: true, message: "Connected. New leads posted here appear on the Leads page." })
}
