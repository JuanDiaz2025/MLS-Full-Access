// Small helpers for showing leads.
import type { Lead } from "@/lib/leads/types"

// Server-rendered pages call this once per request, so reading the clock here is fine.
export function timeAgo(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

// How many leads came in during the last `days` days.
export function countSince(leads: Lead[], days: number, now = Date.now()) {
  return leads.filter((l) => now - Date.parse(l.createdAt) < days * 86_400_000).length
}
