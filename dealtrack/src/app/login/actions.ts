"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { SESSION_COOKIE, SESSION_DAYS, newSessionToken, roleForPassword } from "@/lib/auth"

export type LoginState = { error?: string }

// Only allow redirects back into this app.
function safeNext(value: FormDataEntryValue | null) {
  const next = typeof value === "string" ? value : ""
  return next.startsWith("/") && !next.startsWith("//") ? next : "/overview"
}

export async function signIn(_prev: LoginState, form: FormData): Promise<LoginState> {
  const role = roleForPassword(String(form.get("password") ?? ""))
  if (!role) return { error: "That password isn't right. Ask your admin for the team password." }

  ;(await cookies()).set(SESSION_COOKIE, newSessionToken(role), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  })
  redirect(safeNext(form.get("next")))
}

export async function signOut() {
  ;(await cookies()).delete(SESSION_COOKIE)
  redirect("/login")
}
