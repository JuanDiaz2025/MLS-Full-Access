// "Connect Google for conversions": a one-time Google sign-in by an admin that gives DealTrack the
// Data Manager permission, using DealTrack's own Google client (GOOGLE_ADS_CLIENT_ID), so it's
// the project Google checks for the Data Manager API. Google sends the admin back to the same
// address as the sign-in (/api/auth/google/callback); a separate cookie tells the two apart.
import { createHash, randomBytes } from "node:crypto"
import { cookies } from "next/headers"

import { signValue, unsignValue } from "@/lib/auth"
import { ADS_SCOPE, DATA_MANAGER_SCOPE, GMAIL_SCOPE, SHEETS_SCOPE, saveConnection } from "@/lib/conversions/google"
import { adsAccountConfig } from "@/lib/google-ads/client"
import { redirectUri } from "@/lib/google-signin"

const COOKIE = "dt_conv_oauth"

export async function startConnect(requestUrl: string, by: string) {
  const { clientId } = adsAccountConfig()
  const state = randomBytes(16).toString("base64url")
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const saved = Buffer.from(JSON.stringify({ state, verifier, by })).toString("base64url")
  ;(await cookies()).set(COOKIE, signValue(saved), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  })
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(requestUrl),
    response_type: "code",
    scope: ["openid", "email", ADS_SCOPE, DATA_MANAGER_SCOPE, SHEETS_SCOPE, GMAIL_SCOPE].join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  }).toString()
  return url.toString()
}

// True when this callback belongs to a conversions connect (its state matches our cookie).
export async function isConnectCallback(state: string | null) {
  const raw = unsignValue((await cookies()).get(COOKIE)?.value)
  if (!raw || !state) return false
  return (JSON.parse(Buffer.from(raw, "base64url").toString()) as { state: string }).state === state
}

// Trades Google's code for a key that can send conversions, and saves it. Returns "ok" or why not.
export async function finishConnect(requestUrl: string, state: string | null, code: string | null): Promise<string> {
  const jar = await cookies()
  const raw = unsignValue(jar.get(COOKIE)?.value)
  jar.delete(COOKIE)
  if (!raw) return "expired"
  const saved = JSON.parse(Buffer.from(raw, "base64url").toString()) as { state: string; verifier: string; by: string }
  if (!state || state !== saved.state || !code) return "expired"
  const { clientId, clientSecret } = adsAccountConfig()
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: saved.verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(requestUrl),
    }),
    cache: "no-store",
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; id_token?: string }
  if (!res.ok || !body.refresh_token) return "failed"
  const scopes = (body.scope ?? "").split(" ").filter(Boolean)
  if (!scopes.includes(DATA_MANAGER_SCOPE)) return "no_permission"
  let email = "unknown"
  try {
    const payload = JSON.parse(Buffer.from((body.id_token ?? "").split(".")[1] ?? "", "base64url").toString()) as { email?: string }
    email = payload.email ?? email
  } catch {}
  await saveConnection({ email, refreshToken: body.refresh_token, scopes, by: saved.by })
  return "ok"
}
