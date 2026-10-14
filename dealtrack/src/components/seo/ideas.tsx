"use client"

// New keyword ideas (searches that showed us in Search Console, "People also ask" and related
// searches from Google's results, and rising searches from Google Trends), to add to the Keyword
// explorer with where each came from.

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { LoaderCircle, Plus } from "lucide-react"

import { addIdeasAction, type SeoState } from "@/app/actions/seo"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import type { KeywordIdea } from "@/lib/seo/keywords"
import { cn } from "@/lib/utils"

const PAGE = 50

export default function Ideas({ ideas, signedIn }: { ideas: KeywordIdea[]; signedIn: boolean }) {
  const router = useRouter()
  const [from, setFrom] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState(PAGE)
  const [message, setMessage] = useState<SeoState | null>(null)
  const [busy, start] = useTransition()
  const sources = useMemo(() => [...new Set(ideas.map((i) => i.from))], [ideas])
  const list = ideas.filter((i) => !from || i.from === from)
  if (!ideas.length)
    return (
      <p className="text-sm text-muted-foreground">
        No new ideas yet. They come from Search Console (once connected), from Google&apos;s results in the weekly Competitor ads searches, and from Google Trends checks.
      </p>
    )
  const add = (rows: KeywordIdea[]) =>
    start(async () => {
      setMessage(null)
      setMessage(await addIdeasAction(rows.map((r) => ({ text: r.text, from: r.from }))))
      setPicked(new Set())
      router.refresh()
    })
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Where from" className="h-8 rounded-md border border-input bg-background px-2">
          <option value="">Every source ({ideas.length})</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s} ({ideas.filter((i) => i.from === s).length})
            </option>
          ))}
        </select>
        {signedIn && (
          <>
            <Button type="button" size="sm" disabled={busy || !picked.size} onClick={() => add(ideas.filter((i) => picked.has(i.text)))}>
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}
              Add {picked.size || ""} to the Keyword explorer
            </Button>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setPicked(new Set(list.slice(0, shown).map((i) => i.text)))}>
              Pick all shown
            </button>
            {picked.size > 0 && (
              <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setPicked(new Set())}>
                Clear
              </button>
            )}
          </>
        )}
      </div>
      {message && (
        <p role="status" className={cn("text-xs", message.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>
          {message.message}
        </p>
      )}
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm md:grid-cols-2">
        {list.slice(0, shown).map((i) => (
          <li key={i.text} className="flex items-start gap-2">
            {signedIn && (
              <input
                type="checkbox"
                className="mt-1"
                aria-label={`Pick ${i.text}`}
                checked={picked.has(i.text)}
                onChange={() =>
                  setPicked((p) => {
                    const next = new Set(p)
                    if (next.has(i.text)) next.delete(i.text)
                    else next.add(i.text)
                    return next
                  })
                }
              />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="font-medium break-words">{i.text}</span>
              <span className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                <Pill>{i.from}</Pill>
                {i.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {list.length > shown && (
        <Button type="button" variant="outline" size="sm" className="self-center" onClick={() => setShown(shown + PAGE)}>
          Show more ({list.length - shown} left)
        </Button>
      )}
    </div>
  )
}
