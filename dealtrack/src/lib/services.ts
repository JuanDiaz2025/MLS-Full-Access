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

// Kept on globalThis so the startup warm-up (instrumentation.ts) and the pages share one cache.
type Entry = { at: number; value: Promise<unknown>; done: boolean }
const shared = globalThis as typeof globalThis & { __dealtrackCache?: { store: Map<string, Entry>; pending: Map<string, Promise<unknown>> } }
const { store, pending } = (shared.__dealtrackCache ??= { store: new Map(), pending: new Map() })

// Runs `fn` at most once per `ms` for the same key; concurrent callers share one request.
// With `staleMs`, an older result (up to that age) is returned at once while a fresh one is
// fetched in the background. Failures aren't kept, so the next page view tries again.
export function cached<T>(key: string, ms: number, fn: () => Promise<T>, { staleMs = 0 }: { staleMs?: number } = {}): Promise<T> {
  const hit = store.get(key)
  const age = hit ? Date.now() - hit.at : Infinity
  if (hit && age < ms) return hit.value as Promise<T>
  if (hit?.done && age < staleMs) {
    refresh(key, fn)
    return hit.value as Promise<T>
  }
  return refresh(key, fn)
}

function refresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = pending.get(key)
  if (running) return running as Promise<T>
  const value = fn()
  pending.set(key, value)
  // The first request is shared through the store; a refresh leaves the older result there.
  if (!store.get(key)?.done) store.set(key, { at: Date.now(), value, done: false })
  value.then(
    () => {
      pending.delete(key)
      store.set(key, { at: Date.now(), value, done: true })
    },
    () => {
      pending.delete(key)
      if (store.get(key)?.value === value) store.delete(key)
    },
  )
  return value
}

export function clearCache() {
  store.clear()
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
