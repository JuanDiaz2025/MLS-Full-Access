import { NextResponse, type NextRequest } from "next/server"

import { googleSignInEnabled } from "@/lib/auth"
import { startSignIn } from "@/lib/google-signin"

// GET /api/auth/google?next=/overview → Google's account picker.
export async function GET(request: NextRequest) {
  if (!googleSignInEnabled()) return NextResponse.redirect(new URL("/login?error=google_off", request.url))
  return NextResponse.redirect(await startSignIn(request.url, request.nextUrl.searchParams.get("next") ?? "/overview"))
}
