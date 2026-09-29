// Shared plumbing for the services beyond Google Ads (Sheets, PostHog, Clarity, PageSpeed):
// settings checks, errors a page can show, and a small in-memory cache.

// A service isn't set up: `keys` are the environment variables to add.
export class MissingSettingsError extends Error {
  constructor(
    public service: string,
    public keys: string[],
  ) {
    super(`${service} settings are missing: ${keys.join(", ")}`)
  }
}

// `message` is written for the person using the dashboard; `detail` is the service's own wording.
export class ServiceError extends Error {
  constructor(
    public service: string,
    message: string,
    public detail?: string,
  ) {
    super(message)
  }
}

// Reads the named environment variables, or throws MissingSettingsError listing the empty ones.
export function settings<K extends string>(service: string, keys: readonly K[]): Record<K, string> {
  const missing = keys.filter((k) => !process.env[k]?.trim())
  if (missing.length) throw new MissingSettingsError(service, missing)
  return Object.fromEntries(keys.map((k) => [k, process.env[k]!.trim()])) as Record<K, string>
}

const store = new Map<string, { at: number; value: Promise<unknown> }>()

// Runs `fn` at most once per `ms` for the same key; concurrent callers share one request.
// Failures aren't kept, so the next page view tries again.
export function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.value as Promise<T>
  const value = fn().catch((err) => {
    store.delete(key)
    throw err
  })
  store.set(key, { at: Date.now(), value })
  return value
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
