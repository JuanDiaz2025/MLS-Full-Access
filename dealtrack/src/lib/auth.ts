// Two shared passwords keep the dashboard private:
//   APP_PASSWORD   views reports.
//   ADMIN_PASSWORD views reports and can change Google Ads (negative keywords, location
//                  exclusions). Without it, nobody can make changes.
// Signing in sets a signed cookie for 30 days. Without APP_PASSWORD the reports are open in
// local development (never in production); changes still need the admin password.

import { createHmac, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"

export const SESSION_COOKIE = "dt_session"
export const SESSION_DAYS = 30

export type Role = "viewer" | "admin"

export function passwordConfigured() {
  return !!process.env.APP_PASSWORD || !!process.env.ADMIN_PASSWORD
}

export function changesEnabled() {
  return !!process.env.ADMIN_PASSWORD
}

export function openWithoutPassword() {
  return !process.env.APP_PASSWORD && process.env.NODE_ENV !== "production"
}

function secret() {
  return process.env.SESSION_SECRET || `dealtrack:${process.env.APP_PASSWORD ?? ""}:${process.env.ADMIN_PASSWORD ?? ""}`
}

function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url")
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function matches(input: string, expected: string | undefined) {
  return !!expected && safeEqual(sign(input), sign(expected))
}

// The role a password signs in as, or null if it matches neither.
export function roleForPassword(input: string): Role | null {
  if (matches(input, process.env.ADMIN_PASSWORD)) return "admin"
  if (matches(input, process.env.APP_PASSWORD)) return "viewer"
  return null
}

export function newSessionToken(role: Role) {
  const expires = Date.now() + SESSION_DAYS * 86_400_000
  const payload = `${expires}.${role}`
  return `${payload}.${sign(payload)}`
}

async function sessionRole(): Promise<Role | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const [expires, role, signature] = token.split(".")
  if (!signature || Number(expires) <= Date.now()) return null
  if (role !== "viewer" && role !== "admin") return null
  if (!safeEqual(signature, sign(`${expires}.${role}`))) return null
  if (role === "admin" && !changesEnabled()) return "viewer"
  return role
}

export async function isSignedIn() {
  if (openWithoutPassword()) return true
  if (!passwordConfigured()) return false
  return (await sessionRole()) !== null
}

export async function isAdmin() {
  return changesEnabled() && (await sessionRole()) === "admin"
}
