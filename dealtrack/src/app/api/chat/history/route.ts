import { chatUser, deleteChat, getChat, listChats } from "@/lib/assistant/history"
import { isSignedIn } from "@/lib/auth"

const ID = /^[a-f0-9]{16}$/

// GET → { chats: [{ id, title, updatedAt, pending }] }, newest first
// GET ?id=… → { chat: { id, title, messages, pendingSince? } }
export async function GET(request: Request) {
  if (!(await isSignedIn())) return Response.json({ error: "Sign in first." }, { status: 401 })
  const user = await chatUser()
  const id = new URL(request.url).searchParams.get("id")
  if (id === null) return Response.json({ chats: await listChats(user) })
  const chat = ID.test(id) ? await getChat(user, id) : null
  return chat ? Response.json({ chat }) : Response.json({ error: "That chat is gone." }, { status: 404 })
}

// DELETE ?id=… → removes that chat.
export async function DELETE(request: Request) {
  if (!(await isSignedIn())) return Response.json({ error: "Sign in first." }, { status: 401 })
  const user = await chatUser()
  const id = new URL(request.url).searchParams.get("id") ?? ""
  if (!ID.test(id)) return Response.json({ error: "No chat given." }, { status: 400 })
  await deleteChat(user, id)
  return Response.json({ ok: true })
}
