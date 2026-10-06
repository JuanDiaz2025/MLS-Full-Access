"use client"

import { useEffect, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  Check,
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  History,
  LoaderCircle,
  LogIn,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Plus,
  SendHorizontal,
  Settings,
  Trash2,
  X,
} from "lucide-react"

import { ASK_EVENT } from "@/components/assistant/ask-button"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type Message = { role: "user" | "assistant"; content: string }
type ChatSummary = { id: string; title: string; updatedAt: string; pending: boolean }
type SavedChat = { id: string; messages: Message[]; pendingSince?: string }

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

const suggestions = [
  "What's wrong with our ads right now, and what should we fix first?",
  "Build a report for the last 7 days",
  "Which campaigns cost the most per conversion this month?",
  "What searches wasted the most money in the last 30 days?",
  "How many website leads and calls did we get this month?",
]

// Report styling for Markdown replies: readable tables that scroll on narrow screens.
const markdown: Components = {
  h1: (p) => <h3 className="mt-4 mb-2 text-lg font-semibold first:mt-0" {...p} />,
  h2: (p) => <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0" {...p} />,
  h3: (p) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0" {...p} />,
  p: (p) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
  ul: (p) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
  ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
  a: (p) => <a className="text-primary underline underline-offset-4" target="_blank" rel="noreferrer" {...p} />,
  code: (p) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...p} />,
  table: (p) => (
    <div className="my-3 overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" {...p} />
    </div>
  ),
  th: (p) => <th className="border-b bg-muted/60 px-3 py-2 text-left font-medium whitespace-nowrap" {...p} />,
  td: (p) => <td className="border-b px-3 py-2 align-top tabular-nums" {...p} />,
}

// Saves a reply as a small web page, so it opens nicely in any browser and can be printed.
function downloadReport(html: string) {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Marketing report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#111}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#f4f4f5}h3,h4{margin:20px 0 8px}</style></head><body>
<p style="color:#666">Twin Home Buyer · ${new Date().toLocaleDateString("en-US", { dateStyle: "long" })}</p>
${html}</body></html>`
  const url = URL.createObjectURL(new Blob([page], { type: "text/html" }))
  const a = document.createElement("a")
  a.href = url
  a.download = `marketing-report-${new Date().toISOString().slice(0, 10)}.html`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Reply({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} className="text-sm leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown}>
          {content}
        </ReactMarkdown>
      </div>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(content)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => ref.current && downloadReport(ref.current.innerHTML)}>
          <Download data-icon="inline-start" />
          Download
        </Button>
      </div>
    </div>
  )
}

type AssistantProps = {
  enabled: boolean
  // What the page is showing (e.g. the dashboard's dates), passed to the assistant with each question.
  context?: string
  onClose?: () => void
  // The corner panel can grow to fill the screen; the /ask page is the chat on a page of its own.
  expanded?: boolean
  onExpand?: () => void
  fullPage?: boolean
}

// Shown when the chat runs on Claude Code and it isn't installed or signed in on this computer:
// one button opens the Claude sign-in, then this waits until it's done and asks again.
function ClaudeSignIn({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<"idle" | "waiting" | "done" | "failed">("idle")
  const [message, setMessage] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current)
    },
    [],
  )

  async function start() {
    setMessage(null)
    const res = await fetch("/api/assistant/claude", { method: "POST" }).catch(() => null)
    const body = res ? await res.json().catch(() => ({})) : {}
    if (!res?.ok) {
      setState("failed")
      setMessage(body.error ?? "Couldn't start the sign-in. Double-click setup-claude.bat in the app folder instead.")
      return
    }
    setState("waiting")
    const started = Date.now()
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(async () => {
      const status = await fetch("/api/assistant/claude")
        .then((r) => r.json())
        .catch(() => null)
      if (status?.loggedIn) {
        clearInterval(timer.current!)
        setState("done")
        onReady()
      } else if (Date.now() - started > 10 * 60_000) {
        clearInterval(timer.current!)
        setState("failed")
        setMessage("Still not signed in. Finish the steps in the window that opened, or double-click setup-claude.bat in the app folder.")
      }
    }, 3000)
  }

  if (state === "done") {
    return (
      <p className="flex items-center gap-2 rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-800">
        <CircleCheck className="size-4 shrink-0" /> Signed in to Claude. Asking your question now…
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border-2 border-primary/30 bg-primary/5 p-3 text-sm">
      <Button type="button" size="lg" className="h-11 text-base font-semibold" onClick={start} disabled={state === "waiting"}>
        {state === "waiting" ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <LogIn data-icon="inline-start" />}
        {state === "waiting" ? "Waiting for you to sign in…" : "Sign in with Claude"}
      </Button>
      {state === "waiting" ? (
        <p className="text-muted-foreground">
          A black window opened. If Claude isn&apos;t installed yet it installs it first (a minute or two), then your browser opens: sign in with your
          Claude account and click <strong>Authorize</strong>. This updates by itself when you&apos;re done.
        </p>
      ) : (
        <p className="text-muted-foreground">Uses your Claude plan (Pro, Max, Team or Enterprise). No API key needed.</p>
      )}
      {message && <p className="text-destructive">{message}</p>}
    </div>
  )
}

export default function Assistant({ enabled, context, onClose, expanded, onExpand, fullPage }: AssistantProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [chatId, setChatId] = useState<string | undefined>(undefined)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)
  // Set once the person asks something or starts a new chat, so the saved chat loading on
  // page open doesn't replace what they just did.
  const touched = useRef(false)
  // Changes whenever another chat is shown, so a reply only lands in the chat it belongs to.
  const view = useRef(0)
  const scrollDown = () => requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "nearest" }))

  const refreshList = () =>
    fetch("/api/chat/history")
      .then((r) => (r.ok ? r.json() : { chats: [] }))
      .then((b: { chats?: ChatSummary[] }) => {
        setChats(b.chats ?? [])
        return b.chats ?? []
      })
      .catch(() => [] as ChatSummary[])

  // Opens a saved chat. If it's still being answered (e.g. the page was refreshed while Claude
  // was working), keep checking until the reply is saved.
  async function openChat(id: string, auto = false) {
    if (poll.current) clearInterval(poll.current)
    const load = () =>
      fetch(`/api/chat/history?id=${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { chat?: SavedChat } | null) => b?.chat ?? null)
        .catch(() => null)
    const chat = await load()
    // Opened by itself on page load, but the person already started something: leave it be.
    if (!chat || (auto && touched.current)) return
    const mine = ++view.current
    setChatId(chat.id)
    setError(null)
    setErrorCode(null)
    setShowHistory(false)
    setPending(Boolean(chat.pendingSince))
    show(chat)
    if (chat.pendingSince) {
      poll.current = setInterval(async () => {
        if (view.current !== mine) return clearInterval(poll.current!)
        const fresh = await load()
        if (view.current !== mine) return
        if (!fresh) {
          // The question failed and its chat was removed: put the question back.
          clearInterval(poll.current!)
          setPending(false)
          setMessages(chat.messages.slice(0, -1))
          setInput(chat.messages.at(-1)?.content ?? "")
          setError("That answer didn't come through. Your question is back in the box: press Send to ask again.")
          return
        }
        if (!fresh.pendingSince) {
          clearInterval(poll.current!)
          setPending(false)
          if (!show(fresh) && fresh.messages.length <= chat.messages.length - 1) {
            setInput(chat.messages.at(-1)?.content ?? "")
            setError("That answer didn't come through. Your question is back in the box: press Send to ask again.")
          }
        }
      }, 3000)
    }
  }

  // Shows a saved chat. A question left without an answer (the app was closed while it was being
  // answered) goes back into the box to send again. Returns whether that happened.
  function show(chat: SavedChat) {
    const last = chat.messages.at(-1)
    const cutOff = !chat.pendingSince && last?.role === "user"
    setMessages(cutOff ? chat.messages.slice(0, -1) : chat.messages)
    if (cutOff) {
      setInput(last!.content)
      setError("The answer to your last question didn't come through. It's back in the box: press Send to ask again.")
    }
    scrollDown()
    return cutOff
  }

  function newChat() {
    touched.current = true
    view.current++
    if (poll.current) clearInterval(poll.current)
    setChatId(undefined)
    setMessages([])
    setPending(false)
    setError(null)
    setErrorCode(null)
    setShowHistory(false)
  }

  async function removeChat(id: string) {
    await fetch(`/api/chat/history?id=${id}`, { method: "DELETE" }).catch(() => null)
    if (id === chatId) newChat()
    refreshList()
  }

  // Pick up where you left off: the latest conversation opens when the page loads.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    refreshList().then((list) => {
      if (!cancelled && !touched.current && list[0]) openChat(list[0].id, true)
    })
    return () => {
      cancelled = true
      if (poll.current) clearInterval(poll.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  async function ask(question: string) {
    const text = question.trim()
    if (!text || pending || !enabled) return
    touched.current = true
    const next: Message[] = [...messages, { role: "user", content: text }]
    setMessages(next)
    setInput("")
    setError(null)
    setErrorCode(null)
    setPending(true)
    const mine = view.current
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }))
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The server saves the conversation (up to 200 messages) and answers from the last 40.
        body: JSON.stringify({ messages: next.slice(-200), context, chatId }),
      })
      const body = await res.json().catch(() => ({}))
      // Another chat was opened meanwhile: this reply is saved in its own chat (Past chats).
      if (view.current !== mine) {
        refreshList()
        return
      }
      if (typeof body.chatId === "string" && res.ok) setChatId(body.chatId)
      if (!res.ok || typeof body.reply !== "string") {
        setError(body.error ?? "Something went wrong. Please try again.")
        setErrorCode(typeof body.code === "string" ? body.code : null)
        setMessages(messages)
        setInput(text)
        return
      }
      setMessages([...next, { role: "assistant", content: body.reply }])
      refreshList()
    } catch {
      if (view.current !== mine) return
      setError("Couldn't reach the app. Is it still running?")
      setMessages(messages)
      setInput(text)
    } finally {
      if (view.current === mine) setPending(false)
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }))
    }
  }

  // "Ask how to fix" buttons elsewhere on the page send their question here.
  const askRef = useRef(ask)
  useEffect(() => {
    askRef.current = ask
  })
  useEffect(() => {
    const onAsk = (e: Event) => askRef.current(String((e as CustomEvent<string>).detail ?? ""))
    window.addEventListener(ASK_EVENT, onAsk)
    return () => window.removeEventListener(ASK_EVENT, onAsk)
  }, [])

  return (
    <section
      id="assistant"
      aria-label="Ask about your ads"
      className={cn("flex max-h-full min-h-0 flex-col rounded-2xl border bg-card", fullPage ? "h-full shadow-xs" : expanded ? "h-full shadow-2xl" : "shadow-2xl")}
    >
      <div className="flex items-start gap-3 px-5 pt-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MessageSquareText className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold">Ask about your ads</h2>
          <p className="text-sm text-muted-foreground">
            Ask what&apos;s wrong, ask a question, or ask for a report. It reads your Google Ads, website leads and calls.
          </p>
        </div>
        <span className="ml-auto flex shrink-0 items-center">
          {!fullPage && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Open in its own tab"
              title="Open in its own tab"
              onClick={() => window.open("/ask", "_blank", "noopener")}
            >
              <ExternalLink />
            </Button>
          )}
          {onExpand && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onExpand}
              aria-label={expanded ? "Make smaller" : "Full screen"}
              title={expanded ? "Make smaller" : "Full screen"}
              className="hidden sm:inline-flex"
            >
              {expanded ? <Minimize2 /> : <Maximize2 />}
            </Button>
          )}
          {onClose && (
            <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          )}
        </span>
      </div>
      {enabled && (
        <div className="flex gap-2 px-5 pt-3">
          <Button type="button" variant="outline" size="sm" onClick={newChat} disabled={!messages.length && !chatId}>
            <Plus data-icon="inline-start" />
            New chat
          </Button>
          <Button
            type="button"
            variant={showHistory ? "secondary" : "outline"}
            size="sm"
            onClick={() => {
              if (!showHistory) refreshList()
              setShowHistory(!showHistory)
            }}
            aria-expanded={showHistory}
          >
            <History data-icon="inline-start" />
            Past chats{chats.length ? ` (${chats.length})` : ""}
          </Button>
        </div>
      )}
      {enabled && showHistory && (
        <div className="mx-5 mt-3 max-h-64 overflow-y-auto rounded-xl border">
          {chats.length ? (
            <ul className="divide-y">
              {chats.map((c) => (
                <li key={c.id} className={cn("flex items-center gap-2 px-3 py-2", c.id === chatId && "bg-primary/5")}>
                  <button type="button" onClick={() => openChat(c.id)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium">{c.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {ago(c.updatedAt)}
                      {c.pending ? " · still answering…" : ""}
                    </span>
                  </button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Delete "${c.title}"`} onClick={() => removeChat(c.id)}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">No saved chats yet. Your conversations are saved here as you go.</p>
          )}
        </div>
      )}

      {!enabled ? (
        <div className="m-5 flex gap-2 rounded-xl bg-muted p-4 text-sm">
          <Settings className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-2">
            <p className="font-medium">The chat is off until it has an AI key.</p>
            <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
              <li>At platform.openai.com, add credit under Settings → Billing.</li>
              <li>Open API keys → Create new secret key, and copy it.</li>
              <li>
                Paste it after <code className="font-mono">OPENAI_API_KEY=</code> in <code className="font-mono">.env.local</code>, then restart the
                app.
              </li>
            </ol>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
          {messages.length > 0 && (
            <ol className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              {messages.map((m, i) => (
                <li
                  key={i}
                  className={cn(
                    "rounded-2xl px-4 py-3",
                    m.role === "user" ? "ml-auto max-w-[85%] bg-primary text-primary-foreground" : "bg-muted/50",
                  )}
                >
                  {m.role === "user" ? <p className="text-sm whitespace-pre-wrap">{m.content}</p> : <Reply content={m.content} />}
                </li>
              ))}
              {pending && (
                <li className="flex items-center gap-2 rounded-2xl bg-muted/50 px-4 py-3 text-sm text-muted-foreground" role="status">
                  <LoaderCircle className="size-4 animate-spin" />
                  Looking at your data… reports can take a minute.
                </li>
              )}
              <div ref={endRef} />
            </ol>
          )}

          {messages.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-full border bg-background px-3 py-1.5 text-left text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {error && (
            <p
              role="alert"
              className={cn(
                "rounded-xl p-3 text-sm",
                errorCode === "claude_setup" ? "bg-muted text-foreground" : "bg-destructive/10 text-destructive",
              )}
            >
              {error}
            </p>
          )}
          {errorCode === "claude_setup" && <ClaudeSignIn onReady={() => ask(input)} />}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              ask(input)
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  ask(input)
                }
              }}
              rows={2}
              maxLength={4000}
              placeholder="e.g. Which keywords brought the cheapest leads last month?"
              aria-label="Your question"
              className="min-h-12 flex-1 resize-y rounded-xl border bg-background px-4 py-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
            />
            <Button type="submit" size="lg" disabled={pending || !input.trim()} className="h-12 px-4" aria-label="Send">
              <SendHorizontal />
            </Button>
          </form>
        </div>
      )}
    </section>
  )
}
