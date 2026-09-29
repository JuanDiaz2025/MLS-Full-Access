// A shared team password keeps the dashboard private. Set APP_PASSWORD (and ideally
// SESSION_SECRET) in the server environment. Signing in sets a signed cookie for 30 days.
//
// Without APP_PASSWORD the dashboard is open in local development and locked in production.

import { createHmac, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"

export const SESSION_COOKIE = "dt_session"
export const SESSION_DAYS = 30

export function passwordConfigured() {
  return !!process.env.APP_PASSWORD
}

export function openWithoutPassword() {
  return !passwordConfigured() && process.env.NODE_ENV !== "production"
}

function secret() {
  return process.env.SESSION_SECRET || `dealtrack:${process.env.APP_PASSWORD ?? ""}`
}

function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url")
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function checkPassword(input: string) {
  const expected = process.env.APP_PASSWORD
  return !!expected && safeEqual(sign(input), sign(expected))
}

export function newSessionToken() {
  const expires = Date.now() + SESSION_DAYS * 86_400_000
  return `${expires}.${sign(String(expires))}`
}

export async function isSignedIn() {
  if (openWithoutPassword()) return true
  if (!passwordConfigured()) return false
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return false
  const [expires, signature] = token.split(".")
  return !!signature && Number(expires) > Date.now() && safeEqual(signature, sign(expires))
}
