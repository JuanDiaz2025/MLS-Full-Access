// The chat's tools (Google Ads queries, the leads list, DealTrack's records) as a small MCP server,
// for when the chat runs on Claude Code (ASSISTANT_PROVIDER=claude-code). Claude Code starts it for
// each question; it speaks MCP over stdin/stdout and reads the same .env.local and .data folder as
// DealTrack. DEALTRACK_ROOT is the app folder (scripts/run-ts.mjs moves there first).
import { existsSync, readFileSync, rmSync } from "node:fs"
import { createInterface } from "node:readline"

import { runTool, toolSpecs } from "@/lib/assistant/tools"

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]?.trim() && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1")
  }
}
// Started fine: clear any earlier start-up error the chat would otherwise show.
rmSync(`${process.env.DEALTRACK_DATA_DIR || ".data"}/assistant-tools-error.log`, { force: true })

type Message = { id?: number | string; method?: string; params?: Record<string, unknown> }
const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)

async function handle(msg: Message) {
  if (msg.id === undefined) return // a notification, e.g. notifications/initialized
  switch (msg.method) {
    case "initialize":
      return send({
        id: msg.id,
        result: {
          protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "dealtrack", version: "1.0.0" },
        },
      })
    case "ping":
      return send({ id: msg.id, result: {} })
    case "tools/list":
      return send({
        id: msg.id,
        result: {
          tools: toolSpecs.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        },
      })
    case "tools/call": {
      const name = String(msg.params?.name ?? "")
      const result = await runTool(name, msg.params?.arguments ?? {})
      return send({ id: msg.id, result: { content: [{ type: "text", text: result.content }], isError: Boolean(result.isError) } })
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } })
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  let msg: Message
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  handle(msg).catch((error) =>
    send({ id: msg.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
  )
})
