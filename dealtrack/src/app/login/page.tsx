import type { Metadata } from "next"
import { redirect } from "next/navigation"

import BrandLogo from "@/components/brand-logo"
import GoogleButton from "@/components/google-button"
import LoginForm from "@/app/login/login-form"
import { changesEnabled, googleSignInEnabled, isAdmin, isSignedIn, passwordConfigured } from "@/lib/auth"
import { safeNext } from "@/lib/google-signin"

const ERRORS: Record<string, string> = {
  not_allowed: "That Google account isn't on DealTrack's list. Ask your admin to add it to ALLOWED_EMAILS.",
  cancelled: "Google sign-in was cancelled.",
  expired: "The sign-in took too long or was opened twice. Try again.",
  failed: "Google couldn't sign you in. Try again, or use the team password.",
  google_off: "Google sign-in isn't set up. Add ALLOWED_EMAILS to .env.local and restart DealTrack.",
}

export const metadata: Metadata = { title: "Sign in · DealTrack" }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = typeof params.next === "string" ? params.next : "/overview"
  const next = safeNext(raw)
  // ?admin=1 lets someone who can already see the reports sign in again as an admin.
  const wantsAdmin = params.admin === "1"
  if ((await isSignedIn()) && !(wantsAdmin && !(await isAdmin()))) redirect(next)

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <BrandLogo large />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {wantsAdmin ? "Sign in as an admin" : "Sign in to DealTrack"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {wantsAdmin
              ? "Admins can make changes in Google Ads: negative keywords, location exclusions, and pausing."
              : "Google Ads results and leads for Twin Home Buyer."}
          </p>
        </div>
        {typeof params.error === "string" && ERRORS[params.error] && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm">
            {ERRORS[params.error]}
          </p>
        )}
        {googleSignInEnabled() && (
          <div className="flex flex-col gap-2">
            <GoogleButton href={`/api/auth/google?next=${encodeURIComponent(next)}`}>Continue with Google</GoogleButton>
            <p className="text-xs text-muted-foreground">
              {wantsAdmin ? "Admin emails get admin access automatically." : "For the team's allowed Google accounts."}
            </p>
          </div>
        )}
        {googleSignInEnabled() && passwordConfigured() && (!wantsAdmin || changesEnabled()) && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
            <span className="h-px flex-1 bg-border" />
            or use the {wantsAdmin ? "admin" : "team"} password
            <span className="h-px flex-1 bg-border" />
          </div>
        )}
        {passwordConfigured() && (!wantsAdmin || !!process.env.ADMIN_PASSWORD) ? (
          <LoginForm next={next} />
        ) : (
          !googleSignInEnabled() && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
              {wantsAdmin ? (
                <>
                  No admin password is set. Add <code className="font-mono">ADMIN_PASSWORD</code> (or{" "}
                  <code className="font-mono">ADMIN_EMAILS</code> for Google sign-in) to the server&apos;s environment variables, then
                  restart the app.
                </>
              ) : (
                <>
                  No sign-in is set up. Add <code className="font-mono">APP_PASSWORD</code>, or{" "}
                  <code className="font-mono">ALLOWED_EMAILS</code> for Google sign-in, to the server&apos;s environment variables,
                  then reload this page.
                </>
              )}
            </p>
          )
        )}
      </div>
    </main>
  )
}
