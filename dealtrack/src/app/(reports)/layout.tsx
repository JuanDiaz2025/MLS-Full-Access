import { Suspense } from "react"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import AppHeader from "@/components/app-header"
import NavProgress from "@/components/nav-progress"
import AssistantLauncher from "@/components/assistant/assistant-launcher"
import { assistantProvider } from "@/lib/assistant/shared"
import { changesEnabled, isAdmin, isSignedIn, openWithoutPassword } from "@/lib/auth"
import { readData } from "@/lib/store"

// Every report page sits behind the team password.
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  if (!(await isSignedIn())) {
    const path = (await headers()).get("x-pathname") ?? "/overview"
    redirect(`/login?next=${encodeURIComponent(path)}`)
  }
  const admin = await isAdmin()
  const open = openWithoutPassword()
  // The red number on Monitor → Problems: open critical and high alerts from the last check (read
  // from this computer, no Google Ads request).
  const problems = await readData()
    .then((d) => d.alertLog.filter((r) => !r.resolvedAt && (r.severity === "critical" || r.severity === "high")).length)
    .catch(() => 0)

  return (
    <div className="flex flex-1 flex-col">
      <Suspense fallback={null}>
        <NavProgress />
      </Suspense>
      <Suspense fallback={<div className="h-28 border-b" />}>
        <AppHeader showSignOut={!open || admin} admin={admin} canSignInAsAdmin={changesEnabled()} problems={problems} />
      </Suspense>
      {open && (
        <p className="border-b bg-amber-50 px-4 py-2 text-center text-xs text-amber-900">
          No team password is set, so this dashboard is open. Set <code className="font-mono">APP_PASSWORD</code> before
          putting it online.
        </p>
      )}
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 pb-24 sm:px-6 lg:py-8">{children}</main>
      <div className="print:hidden">
        <AssistantLauncher enabled={assistantProvider() !== null} />
      </div>
    </div>
  )
}
