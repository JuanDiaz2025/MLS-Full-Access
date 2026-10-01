import { NextResponse, type NextRequest } from "next/server"

import { isAdmin } from "@/lib/auth"
import { startConnect } from "@/lib/conversions/connect"
import { currentName } from "@/lib/people"

// GET /api/conversions/connect → Google, to give DealTrack permission to send conversions.
export async function GET(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.redirect(new URL("/login?admin=1&next=/leads/automation", request.url))
  return NextResponse.redirect(await startConnect(request.url, (await currentName()) || "An admin"))
}
