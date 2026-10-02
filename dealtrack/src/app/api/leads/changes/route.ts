import { after } from "next/server"

import { isSignedIn } from "@/lib/auth"
import { catchUp, leadsVersion } from "@/lib/leads/background"

export const dynamic = "force-dynamic"

// Asked every few seconds by an open Leads page: starts the background work and says whether
// anything changed, so the page reloads only then.
export async function GET() {
  if (!(await isSignedIn())) return Response.json({ error: "Sign in first." }, { status: 401 })
  after(() => catchUp())
  return Response.json({ version: await leadsVersion() }, { headers: { "Cache-Control": "no-store" } })
}
