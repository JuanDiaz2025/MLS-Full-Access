// The chat on Claude Code, the Claude app installed on this computer, signed in with the
// company's Claude account (ported from One Marketing Command Center): no API key, and usage counts against that Claude plan.
// Chosen with ASSISTANT_PROVIDER=claude-code. Each question runs `claude -p` with its built-in
// tools turned off and the chat's own tools (Google Ads queries, leads) served over MCP by
// scripts/assistant-mcp.ts.
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { AssistantError, INSTRUCTIONS, type AskInput } from "@/lib/assistant/shared"
import { buildSnapshot } from "@/lib/assistant/snapshot"
import { DATA_DIR } from "@/lib/store"

const TIMEOUT_MS = 4 * 60_000
const TOOLS = ["mcp__dealtrack__google_ads_query", "mcp__dealtrack__list_leads", "mcp__dealtrack__dealtrack_status", "mcp__dealtrack__fraud_check", "mcp__dealtrack__dealtrack_page", "mcp__dealtrack__campaign_detail"]

const NOT_INSTALLED = "The chat needs Claude on this computer. Click Sign in with Claude below: it sets it up and signs you in with your Claude account."
const NOT_SIGNED_IN = "Claude isn't signed in on this computer yet. Click Sign in with Claude below and sign in with your Claude account."
export const SETUP = "claude_setup"
// What Claude replies when the app's tools didn't reach it, so the chat can say why.
const NO_TOOLS = "DEALTRACK_TOOLS_UNAVAILABLE"

// The tool server's start-up error, if it left one (scripts/run-ts.mjs writes it).
function toolsError() {
  try {
    const log = readFileSync(path.join(DATA_DIR, "assistant-tools-error.log"), "utf8")
    return log.split("\n").slice(1, 4).join(" ").trim().slice(0, 300)
  } catch {
    return ""
  }
}

// A short, readable reason from Claude Code's own output, for the chat's error message.
const detail = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 250)

// Where Claude Code is: CLAUDE_CODE_PATH, the usual install folders (a freshly installed copy may
// not be on the app's PATH yet), or plain "claude".
export function claudeCommand() {
  const configured = process.env.CLAUDE_CODE_PATH?.trim()
  if (configured) return configured
  const home = homedir()
  const candidates =
    process.platform === "win32"
      ? [
          path.join(home, ".local", "bin", "claude.exe"),
          process.env.APPDATA && path.join(process.env.APPDATA, "npm", "claude.cmd"),
        ]
      : [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude"]
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!)) ?? "claude"
}

// Claude Code signs in with the Claude account, never an API key the app happens to have.
function claudeEnv() {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

// On Windows, `claude` is usually a .cmd file, which only runs through the shell; quote anything
// with spaces for it.
const quote = (arg: string) => (arg === "" ? '""' : /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)

function run(args: string[], stdin: string, cwd: string, env: NodeJS.ProcessEnv) {
  const command = claudeCommand()
  // A .exe runs directly; "claude" or a .cmd needs the Windows shell.
  const windows = process.platform === "win32" && !/\.exe$/i.test(command)
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(windows ? quote(command) : command, windows ? args.map(quote) : args, {
      cwd,
      env,
      shell: windows,
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // Through the Windows shell, child is cmd.exe: end Claude Code under it too, not only the shell.
      if (windows && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => child.kill())
      else child.kill()
    }, TIMEOUT_MS)
    // Decode as one stream, so a character split between two reads isn't garbled.
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.stdin.end(stdin)
  })
}

// Settings the tool server needs to start on Windows even if Claude Code passes it only the
// environment written in its config (Node needs SystemRoot, TEMP and friends). No secrets: the
// tool server reads those from .env.local itself.
const PASS_THROUGH = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "ComSpec", "PATHEXT"]

function toolServer(root: string) {
  const env: Record<string, string> = {}
  for (const name of PASS_THROUGH) if (process.env[name]) env[name] = process.env[name]!
  Object.assign(env, { DEALTRACK_ROOT: root })
  return {
    command: process.execPath,
    args: [path.join(root, "scripts", "run-ts.mjs"), path.join(root, "scripts", "assistant-mcp.ts")],
    env,
  }
}

// Starts the tool server the way Claude Code will and checks it answers with its tools, so a
// broken one is noticed before asking Claude (and the reason can be shown). A working check is
// remembered for ten minutes.
let toolsOkUntil = 0
function checkToolServer(server: ReturnType<typeof toolServer>, cwd: string): Promise<string | null> {
  if (Date.now() < toolsOkUntil) return Promise.resolve(null)
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let done = false
    const child = spawn(server.command, server.args, { cwd, env: { ...process.env, ...server.env }, windowsHide: true })
    const finish = (problem: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      if (!problem) toolsOkUntil = Date.now() + 10 * 60_000
      resolve(problem)
    }
    const timer = setTimeout(() => finish(`the tool server didn't answer within 45 seconds. ${detail(err)}`), 45_000)
    child.on("error", (e) => finish(`the tool server couldn't start: ${e.message}`))
    child.on("exit", (code) => finish(`the tool server stopped (exit code ${code}): ${detail(err || out) || toolsError()}`))
    child.stderr.on("data", (d) => (err += d))
    child.stdout.on("data", (d) => {
      out += d
      if (/"name":"list_leads"/.test(out)) finish(null)
    })
    child.stdin.on("error", () => {})
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } } })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    )
  })
}

// Keeps the last problem with the chat's tools in .data/chat-problem.log, for troubleshooting.
async function noteProblem(root: string, lines: string[]) {
  await writeFile(path.join(DATA_DIR, "chat-problem.log"), `${new Date().toISOString()}\n${lines.join("\n")}\n`).catch(() => {})
}

// The MCP lines of Claude Code's debug log: why it couldn't connect to the tool server.
function mcpLog(file: string) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /MCP server "dealtrack"|\[MCP\]/.test(l))
      .slice(-12)
  } catch {
    return []
  }
}

export async function askClaudeCode({ turns, situation }: AskInput): Promise<string> {
  // An empty folder to run in, so Claude Code sees no project files, plus its settings files.
  const dir = await mkdtemp(path.join(tmpdir(), "dealtrack-chat-"))
  try {
    const root = process.cwd()
    const server = toolServer(root)
    const mcp = path.join(dir, "mcp.json")
    await writeFile(mcp, JSON.stringify({ mcpServers: { dealtrack: server } }))

    // Earlier turns go in as text; the last one is the question.
    const earlier = turns.slice(0, -1)
    const prompt = [
      earlier.length
        ? `Conversation so far:\n${earlier.map((t) => `${t.role === "user" ? "Them" : "You"}: ${t.content}`).join("\n\n")}\n\n`
        : "",
      `Question: ${turns.at(-1)?.content ?? ""}`,
    ].join("")

    // The tool server compiles the app's code when it starts, which can take a while on a slow
    // computer; give it a minute instead of Claude Code's default, and wait for it before answering.
    const env = {
      ...claudeEnv(),
      MCP_TIMEOUT: process.env.MCP_TIMEOUT || "60000",
      MCP_CONNECT_TIMEOUT_MS: process.env.MCP_CONNECT_TIMEOUT_MS || "60000",
      MCP_CONNECTION_NONBLOCKING: "0",
    }
    const common = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      ...(process.env.CLAUDE_CODE_MODEL?.trim() ? ["--model", process.env.CLAUDE_CODE_MODEL.trim()] : []),
    ]

    // Plan A: Claude looks things up itself with the tool server. Plan B, when the tool server
    // doesn't work here: the app looks up the key numbers and hands them over with the question.
    const problem = await checkToolServer(server, dir)
    let answer: string | null = null
    if (!problem) {
      const system = path.join(dir, "system.txt")
      await writeFile(
        system,
        `${INSTRUCTIONS}\n\n${situation}\n\nUse the dealtrack_page, campaign_detail, google_ads_query, list_leads, dealtrack_status and fraud_check tools for real numbers. Answer in Markdown.\n\nIf the google_ads_query and list_leads tools are not available to you, reply with exactly ${NO_TOOLS} and nothing else.`,
      )
      const debug = path.join(dir, "claude-debug.log")
      const text = await runClaude(
        [...common, "--mcp-config", mcp, "--strict-mcp-config", "--allowedTools", TOOLS.join(","), "--system-prompt-file", system, "--debug-file", debug],
        prompt,
        dir,
        env,
      )
      // Without the tools Claude sometimes writes its tool calls out as text (<invoke name=...>)
      // instead of saying so; treat that the same way.
      if (text.includes(NO_TOOLS) || /<\/?(function_calls|invoke)\b|<parameter name=/.test(text)) {
        console.error("Claude Code didn't get the chat's tools; answering from a snapshot instead.")
        await noteProblem(root, ["Claude Code answered without the chat's tools.", ...mcpLog(debug)])
      } else {
        answer = text
      }
    } else {
      console.error("The chat's tool server doesn't work here; answering from a snapshot instead:", problem)
      await noteProblem(root, [`Tool server check failed: ${problem}`])
    }
    if (answer) return answer

    let snapshot: string
    try {
      snapshot = await buildSnapshot()
    } catch (error) {
      throw new AssistantError(
        `Couldn't look up your Google Ads data for Claude: ${error instanceof Error ? detail(error.message) : "unknown error"}`,
        502,
      )
    }
    const system = path.join(dir, "system-snapshot.txt")
    await writeFile(
      system,
      `${INSTRUCTIONS}\n\n${situation}\n\nYou have no tools this time. Instead, here is the account's data, looked up just now (JSON; money in dollars; the last 30 days unless it says otherwise). Answer only from it, and if the question needs something that isn't in it, say what's missing. Answer in Markdown.\n\n${snapshot}`,
    )
    return await runClaude([...common, "--system-prompt-file", system], prompt, dir, env)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// Runs one `claude -p` question and returns the answer text, or throws a message for the chat.
async function runClaude(args: string[], prompt: string, dir: string, env: NodeJS.ProcessEnv): Promise<string> {
  let result: Awaited<ReturnType<typeof run>>
  try {
    result = await run(args, prompt, dir, env)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AssistantError(NOT_INSTALLED, 503, SETUP)
    throw error
  }

  if (result.timedOut) {
    throw new AssistantError("That question took Claude Code too long. Try asking something narrower.", 504)
  }

  let parsed: { result?: string; is_error?: boolean; subtype?: string } | null = null
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")
  } catch {
    parsed = null
  }
  const text = parsed?.result?.trim() ?? ""
  const problem = `${text}\n${result.stderr}`
  if (/not recognized as an internal or external command|command not found/i.test(result.stderr)) {
    throw new AssistantError(NOT_INSTALLED, 503, SETUP)
  }
  if (/\/login|not logged in|invalid api key|authentication|oauth token/i.test(problem) && (parsed?.is_error || !text)) {
    throw new AssistantError(NOT_SIGNED_IN, 503, SETUP)
  }
  if (/usage limit|rate limit|limit reached/i.test(problem) && (parsed?.is_error || !text)) {
    throw new AssistantError("Your Claude plan's usage limit is reached for now. Try again later.", 429)
  }
  if (!parsed || parsed.is_error || !text) {
    console.error("Claude Code chat failed:", result.code, result.stderr.slice(0, 500), text.slice(0, 500), result.stdout.slice(0, 500))
    const why = detail(text || result.stderr || result.stdout)
    throw new AssistantError(
      why ? `Claude Code couldn't answer. What it said: ${why}` : "Claude Code didn't answer anything. Try again.",
      502,
    )
  }
  return text
}

// Whether Claude Code is installed and signed in, for the chat's "Sign in with Claude" button.
export async function claudeStatus(): Promise<{ installed: boolean; loggedIn: boolean }> {
  try {
    const { stdout, stderr } = await run(["auth", "status", "--json"], "", tmpdir(), claudeEnv())
    if (/not recognized as an internal or external command|command not found/i.test(stderr)) {
      return { installed: false, loggedIn: false }
    }
    const status = JSON.parse(stdout.trim() || "{}") as { loggedIn?: boolean }
    return { installed: true, loggedIn: status.loggedIn === true }
  } catch (error) {
    return { installed: (error as NodeJS.ErrnoException).code !== "ENOENT", loggedIn: false }
  }
}

// Opens the sign-in: on Windows, setup-claude.bat in its own window (it installs Claude Code
// first if needed); elsewhere, Claude Code's own sign-in, which opens the browser.
export function startClaudeLogin() {
  const root = process.cwd()
  if (process.platform === "win32") {
    const bat = path.join(root, "setup-claude.bat")
    spawn("cmd.exe", ["/c", "start", '"Sign in to Claude"', `"${bat}"`], {
      cwd: root,
      env: claudeEnv(),
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    })
      .on("error", (error) => console.error("Couldn't open the Claude sign-in:", error.message))
      .unref()
    return
  }
  spawn(claudeCommand(), ["auth", "login", "--claudeai"], { env: claudeEnv(), detached: true, stdio: "ignore" })
    .on("error", (error) => console.error("Couldn't open the Claude sign-in:", error.message))
    .unref()
}
