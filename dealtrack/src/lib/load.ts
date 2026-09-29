import { unstable_rethrow } from "next/navigation"

import { GoogleAdsError, MissingKeysError } from "@/lib/google-ads/client"

export type Problem =
  | { kind: "missing"; keys: string[] }
  | { kind: "error"; message: string; detail?: string }

export type Loaded<T> = { ok: true; data: T } | ({ ok: false } & Problem)

// Runs a report and turns failures into something a page can show instead of crashing.
export async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    // Let Next.js's own signals (redirects, dynamic rendering) through.
    unstable_rethrow(err)
    if (err instanceof MissingKeysError) return { ok: false, kind: "missing", keys: err.keys }
    if (err instanceof GoogleAdsError) return { ok: false, kind: "error", message: err.message, detail: err.detail }
    console.error(err)
    return {
      ok: false,
      kind: "error",
      message: "Couldn't reach Google Ads. Check the server's internet connection and try again.",
      detail: err instanceof Error ? err.message : undefined,
    }
  }
}
