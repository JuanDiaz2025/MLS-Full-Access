import { NextResponse, type NextRequest } from "next/server"

// Passes the requested path to the pages, so the sign-in screen can send people back to the
// report they asked for.
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers)
  headers.set("x-pathname", `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: ["/((?!_next/|icon.svg|favicon.ico).*)"],
}
