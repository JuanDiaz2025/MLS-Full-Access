import type { Metadata } from "next"
import { redirect } from "next/navigation"

import BrandLogo from "@/components/brand-logo"
import LoginForm from "@/app/login/login-form"
import { changesEnabled, isAdmin, isSignedIn, passwordConfigured } from "@/lib/auth"

export const metadata: Metadata = { title: "Sign in · DealTrack" }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = typeof params.next === "string" ? params.next : "/overview"
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/overview"
  // ?admin=1 lets someone who can already see the reports sign in again as an admin.
  const wantsAdmin = params.admin === "1"
  if ((await isSignedIn()) && !(wantsAdmin && !(await isAdmin()))) redirect(next)

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <BrandLogo />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {wantsAdmin ? "Sign in as an admin" : "Sign in to DealTrack"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {wantsAdmin
              ? "Admins can add negative keywords and exclude locations in Google Ads. Enter the admin password."
              : "Google Ads results for Twin Home Buyer. Enter the team password to continue."}
          </p>
        </div>
        {passwordConfigured() && (!wantsAdmin || changesEnabled()) ? (
          <LoginForm next={next} />
        ) : (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            {wantsAdmin ? (
              <>
                No admin password is set. Add <code className="font-mono">ADMIN_PASSWORD</code> to the server&apos;s
                environment variables, then restart the app.
              </>
            ) : (
              <>
                No team password is set. Add <code className="font-mono">APP_PASSWORD</code> to the server&apos;s
                environment variables, then reload this page.
              </>
            )}
          </p>
        )}
      </div>
    </main>
  )
}
