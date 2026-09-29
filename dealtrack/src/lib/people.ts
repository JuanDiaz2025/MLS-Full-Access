// Who is using DealTrack right now. Everyone shares one password per role, so steps that need a
// name on them (proving waste, approving, pushing, budget settings) use the name each person
// types once; it's kept in a cookie on their browser for a year.

import { cookies } from "next/headers"

export const NAME_COOKIE = "dt_name"

export function cleanName(value: unknown): string {
  return String(value ?? "")
    .replace(/[^\p{L}\p{N} .'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
}

export async function currentName(): Promise<string> {
  return cleanName((await cookies()).get(NAME_COOKIE)?.value)
}

// Saves the name someone typed, for next time. Call from server actions only (it sets a cookie).
export async function rememberName(value: unknown): Promise<string | null> {
  const name = cleanName(value)
  if (!name) return null
  ;(await cookies()).set(NAME_COOKIE, name, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 86_400 })
  return name
}
