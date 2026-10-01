// Two ways in, and both can be on at once:
//   Google sign-in   anyone whose Google email is in ALLOWED_EMAILS (addresses or @domains) can
//                    view; ADMIN_EMAILS can also make changes. Needs the Google client below.
//   Shared passwords APP_PASSWORD views reports; ADMIN_PASSWORD also changes Google Ads
//                    (negative keywords, location exclusions, pausing).
// Without an admin email or password, nobody can make changes. Signing in sets a signed cookie for
// 30 days. With no sign-in set up at all, the reports are open in local development (never in
// production, and never while go-online.bat has put DealTrack on a public address).
import { createHmac, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { cookies } from "next/headers"

export const SESSION_COOKIE = "dt_session"
export const SESSION_DAYS = 30

export type Role = "viewer" | "admin"

const emailList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

const listed = (list: string[], email: string) => {
  const address = email.trim().toLowerCase()
  return list.some((entry) => (entry.startsWith("@") ? address.endsWith(entry) : address === entry))
}

// The Google client used for sign-in: GOOGLE_CLIENT_ID/SECRET, or the Google Ads web client.
export function googleClient() {
  return {
    clientId: (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID || "").trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET || "").trim(),
  }
}

// Google sign-in is on once there's a client and a list of who may sign in. Without the list it
// stays off, so a Gmail account can never get in by accident.
export function googleSignInEnabled() {
  const { clientId, clientSecret } = googleClient()
  return !!clientId && !!clientSecret && emailList(process.env.ALLOWED_EMAILS).length + emailList(process.env.ADMIN_EMAILS).length > 0
}

export function roleForEmail(email: string): Role | null {
  if (listed(emailList(process.env.ADMIN_EMAILS), email)) return "admin"
  if (listed(emailList(process.env.ALLOWED_EMAILS), email)) return "viewer"
  return null
}

export function passwordConfigured() {
  return !!process.env.APP_PASSWORD || !!process.env.ADMIN_PASSWORD
}

export function signInConfigured() {
  return passwordConfigured() || googleSignInEnabled()
}

export function changesEnabled() {
  return !!process.env.ADMIN_PASSWORD || (googleSignInEnabled() && emailList(process.env.ADMIN_EMAILS).length > 0)
}

// go-online.bat leaves the public address in .data/public-url while DealTrack is reachable from
// the internet; the open no-password mode is never allowed then.
function publicTunnel() {
  return existsSync(path.join(process.env.DEALTRACK_DATA_DIR || path.join(process.cwd(), ".data"), "public-url"))
}

export function openWithoutPassword() {
  return !signInConfigured() && process.env.NODE_ENV !== "production" && !publicTunnel()
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

// `email` is set for Google sign-ins, so pages can show who is signed in.
export function newSessionToken(role: Role, email?: string) {
  const expires = Date.now() + SESSION_DAYS * 86_400_000
  const payload = email ? `${expires}.${role}.${Buffer.from(email).toString("base64url")}` : `${expires}.${role}`
  return `${payload}.${sign(payload)}`
}

// Signed values for short-lived cookies (the Google sign-in state).
export const signValue = (value: string) => `${value}.${sign(value)}`
export function unsignValue(signed: string | undefined): string | null {
  if (!signed) return null
  const i = signed.lastIndexOf(".")
  if (i < 0) return null
  const value = signed.slice(0, i)
  return safeEqual(signed.slice(i + 1), sign(value)) ? value : null
}

async function session(): Promise<{ role: Role; email?: string } | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const parts = token.split(".")
  if (parts.length !== 3 && parts.length !== 4) return null
  const signature = parts.pop()!
  const [expires, role, email] = parts
  if (!signature || Number(expires) <= Date.now()) return null
  if (role !== "viewer" && role !== "admin") return null
  if (!safeEqual(signature, sign(parts.join(".")))) return null
  const address = email ? Buffer.from(email, "base64url").toString() : undefined
  // A Google sign-in follows the lists as they are now: taken off, signed out; moved, new role.
  const current: Role | null = address ? (googleSignInEnabled() ? roleForEmail(address) : null) : role
  if (!current) return null
  return { role: current === "admin" && !changesEnabled() ? "viewer" : current, email: address }
}

const sessionRole = async () => (await session())?.role ?? null

// The Google email someone signed in with, if they used Google.
export async function signedInEmail() {
  return (await session())?.email ?? null
}

export async function isSignedIn() {
  if (openWithoutPassword()) return true
  if (!signInConfigured()) return false
  return (await sessionRole()) !== null
}

export async function isAdmin() {
  return changesEnabled() && (await sessionRole()) === "admin"
}
