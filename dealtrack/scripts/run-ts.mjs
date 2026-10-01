// Runs a TypeScript script with the app's "@/..." imports, e.g. node scripts/run-ts.mjs scripts/daily-check.ts
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [script, ...args] = process.argv.slice(2)
process.argv = [process.argv[0], script, ...args]
const target = path.resolve(script)
// The chat's tool server is started by Claude Code from another folder; the app's data files are
// found relative to the working folder, so move to the app folder before anything loads.
if (process.env.DEALTRACK_ROOT) process.chdir(process.env.DEALTRACK_ROOT)

try {
  // Loaded here rather than at the top, so a missing package is reported below too.
  const { createJiti } = await import("jiti")
  const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src") } })
  await jiti.import(target)
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error(message)
  // Leave the reason where the app can show it in the chat.
  if (process.env.DEALTRACK_ROOT) {
    try {
      mkdirSync(path.join(process.env.DEALTRACK_ROOT, ".data"), { recursive: true })
      writeFileSync(path.join(process.env.DEALTRACK_ROOT, ".data", "assistant-tools-error.log"), `${new Date().toISOString()}\n${message}\n`)
    } catch {
      // Nothing more to do.
    }
  }
  process.exit(1)
}
