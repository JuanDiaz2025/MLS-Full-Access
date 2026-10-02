// State that must be one and the same everywhere in the running app. Next.js builds pages and API
// routes into separate bundles, each with its own copy of every module, so a plain module-level
// variable (a write queue, "a sync is running") would exist twice and the two copies wouldn't see
// each other. Kept on globalThis instead, one per key.
const g = globalThis as typeof globalThis & { __omccShared?: Map<string, unknown> }
const all = (g.__omccShared ??= new Map<string, unknown>())

export function shared<T extends object>(key: string, init: () => T): T {
  if (!all.has(key)) all.set(key, init())
  return all.get(key) as T
}
