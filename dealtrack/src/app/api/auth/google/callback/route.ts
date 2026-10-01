import { cookies } from "next/headers"
import { NextResponse, type NextRequest } from "next/server"

import { SESSION_COOKIE, SESSION_DAYS, isAdmin, newSessionToken, roleForEmail } from "@/lib/auth"
import { finishConnect, isConnectCallback } from "@/lib/conversions/connect"
import { finishSignIn } from "@/lib/google-signin"
import { NAME_COOKIE, cleanName } from "@/lib/people"

// Google sends people back here after they pick an account (or cancel).
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const back = (path: string) => NextResponse.redirect(new URL(path, request.url))
  const login = (error: string, next = "/overview") => back(`/login?error=${error}&next=${encodeURIComponent(next)}`)
  // "Connect Google for conversions" comes back here too (lib/conversions/connect.ts).
  if (await isConnectCallback(params.get("state"))) {
    const done = params.get("error") || !(await isAdmin()) ? "cancelled" : await finishConnect(request.url, params.get("state"), params.get("code"))
    return back(`/leads/automation?connect=${done}`)
  }
  if (params.get("error")) return login("cancelled")

  const result = await finishSignIn(request.url, params.get("state"), params.get("code"))
  if ("error" in result) return login(result.error ?? "failed", result.next)
  const { user, next } = result
  const role = user.email_verified === false ? null : roleForEmail(user.email)
  if (!role) return login("not_allowed", next)

  const jar = await cookies()
  const options = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" }
  jar.set(SESSION_COOKIE, newSessionToken(role, user.email), { ...options, maxAge: SESSION_DAYS * 86_400 })
  // Steps that record a name (reviews, approvals, budget lines) use the Google name.
  const name = cleanName(user.name || user.email.split("@")[0])
  if (name) jar.set(NAME_COOKIE, name, { ...options, maxAge: 365 * 86_400 })
  return back(next)
}
