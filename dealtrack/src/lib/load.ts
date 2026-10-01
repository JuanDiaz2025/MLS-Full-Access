import { unstable_rethrow } from "next/navigation"

import { GoogleAdsError, GoogleAdsTimeoutError, MissingKeysError } from "@/lib/google-ads/client"
import { MissingSettingsError, ServiceError } from "@/lib/services"

// `service` names who is missing a setting or returned the error (Google Ads when omitted).
export type Problem =
  | { kind: "missing"; keys: string[]; service?: string }
  | { kind: "error"; message: string; detail?: string; service?: string }

export type Loaded<T> = { ok: true; data: T } | ({ ok: false } & Problem)

// Runs a report and turns failures into something a page can show instead of crashing.
export async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    // Let Next.js's own signals (redirects, dynamic rendering) through.
    unstable_rethrow(err)
    if (err instanceof MissingKeysError) return { ok: false, kind: "missing", keys: err.keys }
    if (err instanceof GoogleAdsTimeoutError) {
      return {
        ok: false,
        kind: "error",
        message: "Google Ads took too long to answer (it tried twice). This is usually Google being slow for a moment: reload the page in a minute.",
      }
    }
    if (err instanceof GoogleAdsError) return { ok: false, kind: "error", message: err.message, detail: err.detail }
    if (err instanceof MissingSettingsError) return { ok: false, kind: "missing", keys: err.keys, service: err.service }
    if (err instanceof ServiceError) {
      return { ok: false, kind: "error", message: err.message, detail: err.detail, service: err.service }
    }
    console.error(err)
    return {
      ok: false,
      kind: "error",
      message: "Couldn't load this report. Check the server's internet connection and try again.",
      detail: err instanceof Error ? err.message : undefined,
    }
  }
}
