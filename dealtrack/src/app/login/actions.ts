"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { SESSION_COOKIE, SESSION_DAYS, newSessionToken, roleForPassword } from "@/lib/auth"
import { safeNext } from "@/lib/google-signin"

export type LoginState = { error?: string }


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
  const next = form.get("next")
  redirect(safeNext(typeof next === "string" ? next : null))
}

export async function signOut() {
  ;(await cookies()).delete(SESSION_COOKIE)
  redirect("/login")
}
