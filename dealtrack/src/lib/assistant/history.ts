// Chat conversations (ported from One Marketing Command Center), saved in .data/chats.json per person, so a conversation is still
// there after a refresh, on another page, or after restarting the app. The server saves each
// question as soon as it's asked and the reply when it's ready, so even a refresh while Claude
// is still answering doesn't lose it.
import { randomBytes } from "node:crypto"

import { signedInEmail } from "@/lib/auth"
import { jsonFileStore } from "@/lib/json-file-store"
import { currentName } from "@/lib/people"

export type ChatMessage = { role: "user" | "assistant"; content: string }
export type Chat = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
  // Set while a question is being answered: when it was asked.
  pendingSince?: string
}
export type ChatSummary = Pick<Chat, "id" | "title" | "updatedAt"> & { pending: boolean }

const file = jsonFileStore<Record<string, Chat[]>>("chats.json", () => ({}))
const KEEP_CHATS = 50
const KEEP_MESSAGES = 200
// A question still "pending" after this long was cut off (e.g. the app restarted): stop waiting.
const PENDING_MAX_MS = 15 * 60_000

// The chats being answered right now, by this running app. After a restart (e.g. an update) the
// set starts empty, so a question cut off by the restart isn't waited for.
const g = globalThis as typeof globalThis & { __omccAnswering?: Set<string> }
const answering = (g.__omccAnswering ??= new Set<string>())
const isPending = (c: Chat) =>
  Boolean(c.pendingSince && answering.has(c.id) && Date.now() - Date.parse(c.pendingSince) < PENDING_MAX_MS)
const titleOf = (messages: ChatMessage[]) => {
  const first = messages.find((m) => m.role === "user")?.content.trim().replace(/\s+/g, " ") ?? "New chat"
  return first.length > 70 ? `${first.slice(0, 67)}…` : first
}

// Whose chats these are: the Google email when someone signed in with Google, otherwise the name
// they type for reviews and approvals. With a shared password and no name, the team shares one list.
export async function chatUser() {
  return (await signedInEmail()) ?? ((await currentName()) ? `name:${(await currentName()).toLowerCase()}` : "team")
}

export async function listChats(user: string): Promise<ChatSummary[]> {
  const chats = (await file.read())[user] ?? []
  return [...chats]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, pending: isPending(c) }))
}

export async function getChat(user: string, id: string) {
  const chat = (await file.read())[user]?.find((c) => c.id === id)
  return chat ? { ...chat, pendingSince: isPending(chat) ? chat.pendingSince : undefined } : null
}

// Saves the conversation up to the new question, starting a new chat when `id` is unknown.
export async function saveQuestion(user: string, id: string | undefined, messages: ChatMessage[]) {
  return file.update((db) => {
    const chats = (db[user] ??= [])
    const now = new Date().toISOString()
    let chat = id ? chats.find((c) => c.id === id) : undefined
    if (!chat) {
      chat = { id: randomBytes(8).toString("hex"), title: "", createdAt: now, updatedAt: now, messages: [] }
      chats.push(chat)
    }
    chat.messages = messages.slice(-KEEP_MESSAGES)
    chat.title = titleOf(chat.messages)
    chat.updatedAt = now
    chat.pendingSince = now
    answering.add(chat.id)
    // Drop the oldest chats beyond the limit.
    chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).splice(KEEP_CHATS)
    return chat.id
  })
}

export async function saveReply(user: string, id: string, reply: string) {
  await file.update((db) => {
    const chat = db[user]?.find((c) => c.id === id)
    if (!chat) return
    chat.messages = [...chat.messages, { role: "assistant" as const, content: reply }].slice(-KEEP_MESSAGES)
    chat.updatedAt = new Date().toISOString()
    delete chat.pendingSince
  })
  // Only after the reply is saved, so nobody sees the question as cut off in between.
  answering.delete(id)
}

// The question couldn't be answered: take it back out (the page puts it back in the box to retry).
export async function dropQuestion(user: string, id: string) {
  await file.update((db) => {
    const chats = db[user]
    const chat = chats?.find((c) => c.id === id)
    if (!chat) return
    if (chat.messages.at(-1)?.role === "user") chat.messages = chat.messages.slice(0, -1)
    delete chat.pendingSince
    if (!chat.messages.length) db[user] = chats!.filter((c) => c.id !== id)
  })
  answering.delete(id)
}

export async function deleteChat(user: string, id: string) {
  await file.update((db) => {
    if (db[user]) db[user] = db[user].filter((c) => c.id !== id)
  })
}
