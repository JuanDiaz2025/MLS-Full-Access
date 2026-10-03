import { isSignedIn } from "@/lib/auth"
import { getUsage } from "@/lib/google-ads/usage"

export const dynamic = "force-dynamic"

// The header's "API used today" meter asks this every minute and on each page change.
export async function GET() {
  if (!(await isSignedIn())) return Response.json({ error: "Sign in first." }, { status: 401 })
  return Response.json(await getUsage(), { headers: { "Cache-Control": "no-store" } })
}
