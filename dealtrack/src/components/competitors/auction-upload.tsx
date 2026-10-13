"use client"

// Competitors → Auction insights: pick the downloaded file; it's read here in the browser and only
// its numbers are saved.

import { useRef, useState, useTransition } from "react"
import { LoaderCircle, Trash2, Upload } from "lucide-react"

import { deleteAuctionAction, saveAuctionAction, type AuctionResult } from "@/app/actions/auction-insights"
import { Button } from "@/components/ui/button"
import { parseAuctionInsights } from "@/lib/competitors/auction-parse"
import { decodeFile } from "@/lib/research/parse"

export function AuctionUpload() {
  const input = useRef<HTMLInputElement>(null)
  const [busy, start] = useTransition()
  const [message, setMessage] = useState<AuctionResult | null>(null)
  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0]
          e.target.value = ""
          if (!picked) return
          setMessage(null)
          start(async () => {
            const report = parseAuctionInsights(decodeFile(await picked.arrayBuffer()))
            if ("error" in report) {
              setMessage({ ok: false, message: report.error })
              return
            }
            setMessage(await saveAuctionAction(report, picked.name))
          })
        }}
      />
      <Button type="button" size="lg" className="h-11 self-start px-5" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Upload data-icon="inline-start" />}
        {busy ? "Reading…" : "Upload an Auction insights file"}
      </Button>
      {message && <p className={message.ok ? "text-sm font-medium text-emerald-700" : "text-sm font-medium text-destructive"}>{message.message}</p>}
    </div>
  )
}

export function DeleteAuctionUpload({ id }: { id: string }) {
  const [busy, start] = useTransition()
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => start(async () => void (await deleteAuctionAction(id)))}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
      aria-label="Remove this upload"
      title="Remove this upload"
    >
      {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
    </button>
  )
}
