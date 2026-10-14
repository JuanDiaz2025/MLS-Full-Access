import { isSignedIn } from "@/lib/auth"
import { brightReady } from "@/lib/competitors/brightdata"
import { freeSearches } from "@/lib/competitors/free-searches"

export const dynamic = "force-dynamic"

// The header's Bright Data meter asks this every minute and on each page change. Nothing to show
// on a computer without Bright Data's keys.
export async function GET() {
  if (!(await isSignedIn())) return Response.json({ error: "Sign in first." }, { status: 401 })
  if (!brightReady()) return Response.json({ ready: false }, { headers: { "Cache-Control": "no-store" } })
  return Response.json({ ready: true, ...(await freeSearches()) }, { headers: { "Cache-Control": "no-store" } })
}
