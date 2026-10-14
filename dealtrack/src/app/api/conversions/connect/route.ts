import { NextResponse, type NextRequest } from "next/server"

import { isAdmin } from "@/lib/auth"
import { startConnect } from "@/lib/conversions/connect"
import { currentName } from "@/lib/people"

// GET /api/conversions/connect → Google, to give DealTrack permission to send conversions (and to
// read Search Console, keep the backup sheet and email alerts). ?back=/competitors/seo returns there.
export async function GET(request: NextRequest) {
  const asked = request.nextUrl.searchParams.get("back") ?? ""
  const back = /^\/[a-z0-9/_-]*$/.test(asked) ? asked : "/leads/automation"
  if (!(await isAdmin())) return NextResponse.redirect(new URL(`/login?admin=1&next=${encodeURIComponent(back)}`, request.url))
  return NextResponse.redirect(await startConnect(request.url, (await currentName()) || "An admin", back))
}
