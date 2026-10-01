"use client"

// Builds the evidence pack for an invalid-click refund claim, in three steps: pick the days,
// add the WP Engine (or any server's) access logs, then copy the summary into Google's form and
// attach the spreadsheet. Log files are read here in the browser and never uploaded.

import { useEffect, useMemo, useState, useTransition } from "react"
import { Download, FileText, Upload } from "lucide-react"

import { billedClicksAction } from "@/app/actions/fraud"
import CopyButton from "@/components/copy-button"
import { Pill } from "@/components/pill"
import { Button } from "@/components/ui/button"
import { claimText, dayInPacific, evidenceCsv, evidenceRows } from "@/lib/fraud/claim"
import type { AdClick, FraudDay } from "@/lib/fraud/clicks"
import { FLAG_LABELS } from "@/lib/fraud/flags"
import { logReader, type LogSummary } from "@/lib/fraud/logs"
import type { AdVisit } from "@/lib/fraud/visitors"
import { cn } from "@/lib/utils"

const ROWS_SHOWN = 50

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const shortDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
const pacific = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Reads plain or gzipped log files line by line.
async function readLogs(files: File[], onProgress: (done: number) => void): Promise<LogSummary> {
  const reader = logReader()
  let done = 0
  for (const file of files) {
    let stream: ReadableStream<BufferSource> = file.stream()
    if (/\.gz$/i.test(file.name)) stream = stream.pipeThrough(new DecompressionStream("gzip"))
    const text = stream.pipeThrough(new TextDecoderStream()).getReader()
    let rest = ""
    for (;;) {
      const { value, done: end } = await text.read()
      if (end) break
      const lines = (rest + value).split(/\r?\n/)
      rest = lines.pop() ?? ""
      for (const line of lines) reader.push(line)
    }
    if (rest) reader.push(rest)
    onProgress(++done)
  }
  return reader.result()
}

export default function ClaimBuilder({
  account,
  accountLabel,
  days,
  flagged,
  initialClicks,
  loadedDays,
  visits,
  campaignId,
  today,
  oldestClaimable,
  oldestDetail,
  formUrl,
}: {
  account: { id: string; name: string }
  accountLabel: string
  days: FraudDay[]
  flagged: string[]
  initialClicks: AdClick[]
  loadedDays: string[]
  visits: AdVisit[]
  campaignId?: string
  today: string
  oldestClaimable: string
  oldestDetail: string
  formUrl: string
}) {
  const flaggedSet = useMemo(() => new Set(flagged), [flagged])
  const [showAll, setShowAll] = useState(flagged.length === 0)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(flagged.filter((d) => d >= oldestClaimable)))
  const [clicks, setClicks] = useState<AdClick[]>(initialClicks)
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set(loadedDays))
  const [clickError, setClickError] = useState("")
  const [loading, startLoading] = useTransition()
  const [note, setNote] = useState("")
  const [log, setLog] = useState<LogSummary | null>(null)
  const [logFiles, setLogFiles] = useState<string[]>([])
  const [logState, setLogState] = useState<{ reading: boolean; done: number; total: number; error: string }>({
    reading: false,
    done: 0,
    total: 0,
    error: "",
  })
  const [dragging, setDragging] = useState(false)

  const listed = showAll ? days : days.filter((d) => flaggedSet.has(d.date))
  const chosen = days.filter((d) => selected.has(d.date))

  // Google's clicks for chosen days that aren't loaded yet (only the last 90 days exist).
  const missing = chosen.map((d) => d.date).filter((d) => d >= oldestDetail && !loaded.has(d))
  const missingKey = missing.join(",")
  useEffect(() => {
    if (!missingKey) return
    const dates = missingKey.split(",").slice(0, 31)
    startLoading(async () => {
      const r = await billedClicksAction(dates, campaignId)
      if (!r.ok) {
        setClickError(r.message)
        return
      }
      setClickError("")
      setClicks((c) => [...c.filter((x) => !dates.includes(x.date)), ...r.clicks])
      setLoaded((l) => new Set([...l, ...dates]))
    })
  }, [missingKey, campaignId])

  const input = useMemo(
    () => ({
      account,
      days: chosen,
      clicks,
      visits: visits.filter((v) => selected.has(dayInPacific(v.startedAt))),
      logHits: (log?.adHits ?? []).filter((h) => selected.has(dayInPacific(h.time))),
      note,
    }),
    [account, chosen, clicks, visits, selected, log, note],
  )
  const rows = useMemo(() => evidenceRows(input, today), [input, today])
  const text = useMemo(() => claimText(input, rows), [input, rows])
  const withIp = rows.filter((r) => r.siteIp || r.logIp).length

  const toggle = (date: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })

  async function addLogs(files: File[]) {
    if (!files.length) return
    setLogState({ reading: true, done: 0, total: files.length, error: "" })
    try {
      const summary = await readLogs(files, (done) => setLogState((s) => ({ ...s, done })))
      setLog(summary)
      setLogFiles(files.map((f) => f.name))
      setLogState({
        reading: false,
        done: files.length,
        total: files.length,
        error: summary.read ? "" : "No log lines found in these files. Use the access logs (not error logs).",
      })
    } catch (e) {
      setLogState({ reading: false, done: 0, total: files.length, error: e instanceof Error ? e.message : "Couldn't read these files." })
    }
  }

  const fileStem = chosen.length
    ? `invalid-clicks-${chosen[0].date}${chosen.length > 1 ? `-to-${chosen[chosen.length - 1].date}` : ""}`
    : "invalid-clicks"
  const step = "flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:p-5"
  const stepTitle = (n: number, title: string, hint: string) => (
    <div className="flex items-start gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {n}
      </span>
      <div className="flex flex-col gap-0.5">
        <h2 className="font-semibold">{title}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <section className={step}>
        {stepTitle(
          1,
          "Pick the days to claim",
          "The suspicious days are ticked if they're recent enough to claim. Add any other day the attack ran: Google looks at the clicks of every day you list.",
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show every day with clicks, not only suspicious ones
          </label>
          <span className="text-muted-foreground">
            {chosen.length} {chosen.length === 1 ? "day" : "days"} picked
          </span>
          {selected.size > 0 && (
            <button type="button" className="text-primary hover:underline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
        </div>
        {listed.length ? (
          <ul className="grid max-h-80 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
            {[...listed].reverse().map((d) => {
              const old = d.date < oldestClaimable
              return (
                <li key={d.date}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 text-sm hover:bg-muted/40",
                      selected.has(d.date) && "border-primary bg-primary/5",
                    )}
                  >
                    <input type="checkbox" className="mt-0.5" checked={selected.has(d.date)} onChange={() => toggle(d.date)} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-1.5 font-medium">
                        {shortDay(d.date)}
                        {d.flags.map((f) => (
                          <Pill key={f} tone="amber">
                            {FLAG_LABELS[f]}
                          </Pill>
                        ))}
                        {old && <Pill tone="gray">Over 60 days</Pill>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {d.clicks} clicks (normal {Math.round(d.normalClicks)}) · {d.invalid} invalid · {usd(d.cost)}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No suspicious days in this period. Tick &quot;Show every day&quot; to claim a day anyway, or pick another date range above.
          </p>
        )}
        {loading && <p className="text-xs text-muted-foreground">Getting Google&apos;s click list for the new days…</p>}
        {clickError && <p className="text-xs text-destructive">{clickError}</p>}
        {chosen.some((d) => d.date < oldestDetail) && (
          <p className="text-xs text-muted-foreground">
            Google keeps single clicks for 90 days, so older days are claimed with the daily numbers plus whatever your logs show.
          </p>
        )}
      </section>

      <section className={step}>
        {stepTitle(
          2,
          "Add your server logs (optional, but they win claims)",
          "The logs show each click's IP address, exact time, and browser: the proof that one person or bot clicked again and again. In the WP Engine User Portal, open the site's environment → Logs → Access logs and download the days of the attack (.log or .gz). The files are read on this computer and never uploaded.",
        )}
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            addLogs([...e.dataTransfer.files])
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center text-sm text-muted-foreground hover:bg-muted/40",
            dragging && "border-primary bg-primary/5",
          )}
        >
          <Upload className="size-5" aria-hidden />
          <span>
            <span className="font-medium text-foreground">Drop access log files here</span> or click to choose them
          </span>
          <input type="file" multiple accept=".log,.gz,.txt,text/plain" className="sr-only" onChange={(e) => addLogs([...(e.target.files ?? [])])} />
        </label>
        {logState.reading && (
          <p className="text-sm text-muted-foreground">
            Reading file {Math.min(logState.done + 1, logState.total)} of {logState.total}…
          </p>
        )}
        {logState.error && <p className="text-sm text-destructive">{logState.error}</p>}
        {log && log.read > 0 && (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              <span className="font-medium">{logFiles.join(", ")}</span>: {log.lines.toLocaleString()} lines
              {log.first && log.last && (
                <>
                  , {pacific(log.first)} to {pacific(log.last)}
                </>
              )}
              . {log.adHits.length.toLocaleString()} ad clicks found
              {log.googleChecks ? `, plus ${log.googleChecks} visits from Google's own checks (left out)` : ""}.
            </p>
            {log.networks.filter((n) => n.adClicks >= 2).length > 0 ? (
              <ul className="flex flex-col divide-y rounded-xl border">
                {log.networks
                  .filter((n) => n.adClicks >= 2)
                  .slice(0, 8)
                  .map((n) => (
                    <li key={n.network} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="flex flex-col">
                        <span className="font-mono text-xs break-all">{n.ips.length === 1 ? n.ips[0] : n.network}</span>
                        <span className="text-xs text-muted-foreground">
                          {pacific(n.first)} to {pacific(n.last)}
                          {n.fastestGapS !== null && n.fastestGapS < 120 && ` · two clicks ${Math.round(n.fastestGapS)}s apart`}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        {n.bot && <Pill tone="red">Automated browser</Pill>}
                        <Pill tone={n.adClicks >= 3 ? "red" : "amber"}>{n.adClicks} ad clicks</Pill>
                      </span>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No connection clicked the ads more than once in these logs.</p>
            )}
          </div>
        )}
      </section>

      <section className={step}>
        {stepTitle(
          3,
          "Send it to Google",
          "Add what you know (who you think it is and why), then paste the summary into Google's invalid-click form and attach the spreadsheet.",
        )}
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">What you know</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            autoComplete="off"
            placeholder="e.g. We believe a competitor (John Buys Houses) clicked our ads repeatedly on these days to use up our budget."
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
          />
        </label>
        {chosen.length === 0 ? (
          <p className="text-sm text-muted-foreground">Pick at least one day in step 1.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Pill tone="violet">{rows.length} clicks in the spreadsheet</Pill>
              <Pill tone={withIp ? "green" : "gray"}>{withIp} with an IP address</Pill>
              {accountLabel && <Pill>Account {accountLabel}</Pill>}
            </div>
            <textarea
              readOnly
              value={text}
              rows={14}
              className="rounded-lg border border-input bg-muted/30 px-3 py-2 font-mono text-xs"
              aria-label="Claim summary"
            />
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={text} label="Copy summary" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => download(`${fileStem}.csv`, evidenceCsv(rows), "text/csv")}
                disabled={!rows.length}
              >
                <Download data-icon="inline-start" /> Spreadsheet (.csv)
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => download(`${fileStem}.txt`, text, "text/plain")}>
                <FileText data-icon="inline-start" /> Summary (.txt)
              </Button>
              <a href={formUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-primary hover:underline">
                Open Google&apos;s invalid-click form ↗
              </a>
            </div>
            {rows.length > 0 && (
              <div className="-mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[760px] text-xs">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      {["Day", "Click ID", "Billed", "Campaign / keyword", "Google location", "Site visit", "Server log"].map((h) => (
                        <th key={h} scope="col" className="px-4 py-2 text-left font-medium first:pl-4 sm:first:pl-5">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, ROWS_SHOWN).map((r) => (
                      <tr key={`${r.date}|${r.gclid}`} className="border-b border-border/60 align-top last:border-0">
                        <td className="px-4 py-1.5 whitespace-nowrap first:pl-4 sm:first:pl-5">{shortDay(r.date)}</td>
                        <td className="max-w-40 truncate px-4 py-1.5 font-mono" title={r.gclid}>
                          {r.gclid}
                        </td>
                        <td className="px-4 py-1.5">{r.billed === "yes" ? "Yes" : r.billed}</td>
                        <td className="px-4 py-1.5">
                          {r.campaign}
                          {r.keyword && <span className="block text-muted-foreground">{r.keyword}</span>}
                        </td>
                        <td className="px-4 py-1.5">{r.googleLocation}</td>
                        <td className="px-4 py-1.5">
                          {r.siteIp ? (
                            <>
                              <span className="font-mono">{r.siteIp}</span>
                              <span className="block text-muted-foreground">
                                {r.siteTime} · {r.secondsOnSite}s{r.formSent === "yes" ? " · sent a form" : ""}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-1.5">
                          {r.logIp ? (
                            <>
                              <span className="font-mono">{r.logIp}</span>
                              <span className="block max-w-56 truncate text-muted-foreground" title={r.logUserAgent}>
                                {r.logTime} · {r.logUserAgent}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > ROWS_SHOWN && (
                  <p className="px-4 pt-2 text-xs text-muted-foreground sm:px-5">
                    Showing {ROWS_SHOWN} of {rows.length}; the spreadsheet has all of them.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
