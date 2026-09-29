import type { Metadata } from "next"
import { redirect } from "next/navigation"

import BrandLogo from "@/components/brand-logo"
import LoginForm from "@/app/login/login-form"
import { isSignedIn, passwordConfigured } from "@/lib/auth"

export const metadata: Metadata = { title: "Sign in · DealTrack" }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const next = typeof params.next === "string" ? params.next : "/overview"
  if (await isSignedIn()) redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/overview")

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <BrandLogo />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to DealTrack</h1>
          <p className="text-sm text-muted-foreground">
            Google Ads results for Twin Home Buyer. Enter the team password to continue.
          </p>
        </div>
        {passwordConfigured() ? (
          <LoginForm next={next} />
        ) : (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            No team password is set. Add <code className="font-mono">APP_PASSWORD</code> to the server&apos;s
            environment variables, then reload this page.
          </p>
        )}
      </div>
    </main>
  )
}
