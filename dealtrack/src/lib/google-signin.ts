// "Continue with Google": the OAuth 2.0 authorization code flow with PKCE (ported from One
// Marketing Command Center). Only the person's Google identity is asked for; DealTrack keeps
// reading Google Ads with its own connection.
import { createHash, randomBytes } from "node:crypto"
import { cookies } from "next/headers"

import { googleClient, secureCookies, signValue, unsignValue } from "@/lib/auth"

const STATE_COOKIE = "dt_oauth"

export type GoogleUser = { sub: string; email: string; email_verified?: boolean; name?: string }

// Where Google sends people back. Add it under "Authorized redirect URIs" in the Google client.
export function redirectUri(requestUrl: string) {
  const base = process.env.SITE_URL?.replace(/\/$/, "") || new URL(requestUrl).origin
  return `${base}/api/auth/google/callback`
}

// Only same-site paths, so a crafted ?next= can't send people to another website. Browsers drop
// tabs and newlines in addresses ("/\t/evil.com" becomes "//evil.com"), so the final check is where
// the address really leads (from One Marketing Command Center).
export function safeNext(next: string | null | undefined, fallback = "/overview") {
  if (!next || !next.startsWith("/") || /[\x00-\x1f\\]/.test(next)) return fallback
  try {
    const url = new URL(next, "http://app.invalid")
    return url.origin === "http://app.invalid" ? `${url.pathname}${url.search}${url.hash}` : fallback
  } catch {
    return fallback
  }
}

// Starts a sign-in: remembers the state and PKCE verifier for 10 minutes, returns Google's URL.
export async function startSignIn(requestUrl: string, next: string) {
  const state = randomBytes(16).toString("base64url")
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const saved = Buffer.from(JSON.stringify({ state, verifier, next: safeNext(next) })).toString("base64url")
  ;(await cookies()).set(STATE_COOKIE, signValue(saved), {
    httpOnly: true,
    secure: await secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  })
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.search = new URLSearchParams({
    client_id: googleClient().clientId,
    redirect_uri: redirectUri(requestUrl),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString()
  return url.toString()
}

// Finishes a sign-in: checks the state, trades the code for a token, and reads the profile.
export async function finishSignIn(requestUrl: string, state: string | null, code: string | null) {
  const jar = await cookies()
  const raw = unsignValue(jar.get(STATE_COOKIE)?.value)
  jar.delete(STATE_COOKIE)
  if (!raw) return { error: "expired" as const }
  const saved = JSON.parse(Buffer.from(raw, "base64url").toString()) as { state: string; verifier: string; next: string }
  if (!state || state !== saved.state || !code) return { error: "expired" as const, next: saved.next }

  const { clientId, clientSecret } = googleClient()
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(requestUrl),
      code_verifier: saved.verifier,
    }),
    cache: "no-store",
  })
  const token = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string }
  if (!res.ok || !token.access_token) {
    console.error("Google sign-in failed:", token.error_description ?? res.status)
    return { error: "failed" as const, next: saved.next }
  }
  const profile = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
    cache: "no-store",
  })
  if (!profile.ok) return { error: "failed" as const, next: saved.next }
  return { user: (await profile.json()) as GoogleUser, next: saved.next }
}
