"use client"

// Competitors → Keyword explorer: the keyword list with topic and place groups on the left (like
// Ahrefs' "By terms"), filters, a sortable table, and the panel for adding keywords. Files are read
// here in the browser, so only the keywords (and Keyword Planner's volumes) are sent to the app.

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Copy, FileUp, LoaderCircle, Search, Sparkles, Trash2 } from "lucide-react"

import {
  addKeywordsAction,
  importKeywordsAction,
  removeKeywordsAction,
  suggestAction,
  volumesAction,
  type ResearchState,
} from "@/app/actions/research"
import { Button } from "@/components/ui/button"
import Disclosure from "@/components/ui/disclosure"
import { decodeFile, parseKeywordFile } from "@/lib/research/parse"
import { cn } from "@/lib/utils"

export type ExplorerRow = {
  text: string
  topic: string
  place: string
  words: number
  volume: number | null
  cpcLow: number | null
  cpcHigh: number | null
  competition: string
  trend: number[]
  sources: string[]
}

type Props = {
  rows: ExplorerRow[]
  topics: { id: string; label: string }[]
  sourceLabels: Record<string, string>
  imports: { at: string; what: string; added: number; updated: number }[]
  volumesNote: string
  volumeAt: string
  // California first, then each city with its own Keyword Planner volumes, then the estimated ones.
  volumePlaces: { value: string; label: string }[]
  volumesFor: string
  estimateNote: string // set when the volumes shown are estimates
}

type SortKey = "text" | "volume" | "cpc" | "words" | "topic" | "place"
const PAGE = 100
const fmt = (n: number) => n.toLocaleString("en-US")
const money = (n: number) => `$${n.toFixed(2)}`
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

function Trend({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-muted-foreground">–</span>
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 60},${18 - (v / max) * 16}`).join(" ")
  return (
    <svg width="60" height="20" viewBox="0 0 60 20" aria-label="Monthly searches over the last year" role="img" className="text-primary">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

export default function KeywordExplorer({
  rows,
  topics,
  sourceLabels,
  imports,
  volumesNote,
  volumeAt,
  volumePlaces,
  volumesFor,
  estimateNote,
}: Props) {
  const router = useRouter()
  const [group, setGroup] = useState<"topic" | "place">("topic")
  const [picked, setPicked] = useState("")
  const [search, setSearch] = useState("")
  const [source, setSource] = useState("")
  const [minVolume, setMinVolume] = useState("")
  const [words, setWords] = useState("")
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "volume", desc: true })
  const [shown, setShown] = useState(PAGE)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<ResearchState | null>(null)
  const [busy, start] = useTransition()

  const topicLabel = useMemo(() => Object.fromEntries(topics.map((t) => [t.id, t.label])), [topics])

  // Everything but the left-hand group, so the group counts follow the other filters.
  const filtered = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
    return rows.filter(
      (r) =>
        terms.every((t) => r.text.includes(t)) &&
        (!source || r.sources.includes(source)) &&
        (!minVolume || (minVolume === "has" ? r.volume !== null : (r.volume ?? 0) >= Number(minVolume))) &&
        (!words || (words === "5" ? r.words >= 5 : words === "3" ? r.words >= 3 && r.words <= 4 : r.words <= 2)),
    )
  }, [rows, search, source, minVolume, words])

  const groups = useMemo(() => {
    const m = new Map<string, { count: number; volume: number }>()
    for (const r of filtered) {
      const k = group === "topic" ? r.topic : r.place || "No city"
      const g = m.get(k) ?? { count: 0, volume: 0 }
      g.count++
      g.volume += r.volume ?? 0
      m.set(k, g)
    }
    const list = [...m.entries()].map(([id, g]) => ({ id, label: group === "topic" ? (topicLabel[id] ?? id) : id, ...g }))
    return group === "topic"
      ? topics.map((t) => list.find((g) => g.id === t.id)).filter((g): g is NonNullable<typeof g> => !!g)
      : list.sort((a, b) => b.volume - a.volume || b.count - a.count)
  }, [filtered, group, topics, topicLabel])

  const visible = useMemo(() => {
    const list = filtered.filter((r) => !picked || (group === "topic" ? r.topic === picked : (r.place || "No city") === picked))
    const dir = sort.desc ? -1 : 1
    const val = (r: ExplorerRow) =>
      sort.key === "volume"
        ? (r.volume ?? -1)
        : sort.key === "cpc"
          ? (r.cpcHigh ?? -1)
          : sort.key === "words"
            ? r.words
            : sort.key === "topic"
              ? (topicLabel[r.topic] ?? "")
              : sort.key === "place"
                ? r.place
                : r.text
    return list.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir || a.text.localeCompare(b.text)
    })
  }, [filtered, picked, group, sort, topicLabel])

  const totalVolume = visible.reduce((s, r) => s + (r.volume ?? 0), 0)
  const withVolume = rows.filter((r) => r.volume !== null).length
  const noVolume = rows.filter((r) => r.volume === null).map((r) => r.text)

  const run = (fn: () => Promise<ResearchState>) =>
    start(async () => {
      setMessage(null)
      setMessage(await fn())
    })

  // Several files at once (e.g. one Keyword Planner export per city): read and saved one after
  // another, so each lands in the store before the next, with one line per file in the message.
  function onFiles(list: FileList | null) {
    const files = [...(list ?? [])]
    if (!files.length) return
    run(async () => {
      const results: ResearchState[] = []
      for (const f of files) {
        try {
          results.push(await importKeywordsAction({ ...parseKeywordFile(decodeFile(await f.arrayBuffer())), name: f.name }))
        } catch {
          results.push({ ok: false, message: "Couldn't be read." })
        }
      }
      if (files.length === 1) return results[0]
      const ok = results.filter((r) => r.ok).length
      return {
        ok: ok === files.length,
        message: `${ok} of ${files.length} files added.`,
        lines: results.map((r, i) => `${files[i].name}: ${r.message ?? ""}`),
      }
    })
  }

  const header = (key: SortKey, label: string, right = false) => (
    <th className={cn("px-3 py-2 font-medium whitespace-nowrap", right && "text-right")}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === "volume" || key === "cpc" }))}
        className="hover:text-foreground"
        aria-label={`Sort by ${label}`}
      >
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  )

  return (
    <div className="flex flex-col gap-5">
      <AddPanel
        empty={!rows.length}
        busy={busy}
        onFiles={onFiles}
        run={run}
        noVolume={noVolume}
        imports={imports}
        volumesNote={volumesNote}
        message={message}
      />

      {rows.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="flex flex-col gap-2 self-start rounded-2xl border bg-card p-3 shadow-xs">
            <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs font-medium">
              {(["topic", "place"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => {
                    setGroup(g)
                    setPicked("")
                  }}
                  className={cn("flex-1 rounded-md px-2 py-1", group === g ? "bg-background shadow-xs" : "text-muted-foreground")}
                >
                  By {g === "topic" ? "topic" : "city"}
                </button>
              ))}
            </div>
            <ul className="flex max-h-[34rem] flex-col overflow-y-auto text-sm">
              <li>
                <GroupButton
                  label="All keywords"
                  count={filtered.length}
                  volume={filtered.reduce((s, r) => s + (r.volume ?? 0), 0)}
                  active={!picked}
                  onClick={() => setPicked("")}
                />
              </li>
              {groups.map((g) => (
                <li key={g.id}>
                  <GroupButton
                    label={g.label}
                    count={g.count}
                    volume={g.volume}
                    active={picked === g.id}
                    onClick={() => setPicked(picked === g.id ? "" : g.id)}
                  />
                </li>
              ))}
            </ul>
          </aside>

          <section className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-4 shadow-xs">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex h-9 min-w-56 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-2.5 text-sm">
                <Search className="size-4 text-muted-foreground" aria-hidden />
                <input
                  value={search}
                  onChange={(e) => (setSearch(e.target.value), setShown(PAGE))}
                  placeholder="Search keywords…"
                  aria-label="Search keywords"
                  className="w-full bg-transparent outline-none"
                />
              </label>
              <Select
                label="Volume"
                value={minVolume}
                onChange={setMinVolume}
                options={[
                  ["", "Any"],
                  ["has", "Has volume"],
                  ["10", "10+"],
                  ["100", "100+"],
                  ["1000", "1,000+"],
                ]}
              />
              <Select
                label="Words"
                value={words}
                onChange={setWords}
                options={[
                  ["", "Any"],
                  ["2", "1–2"],
                  ["3", "3–4"],
                  ["5", "5+"],
                ]}
              />
              <Select label="Source" value={source} onChange={setSource} options={[["", "All"], ...Object.entries(sourceLabels)]} />
              {volumePlaces.length > 1 && (
                <Select
                  label="Volumes for"
                  value={volumesFor}
                  onChange={(v) =>
                    router.push(v === volumePlaces[0].value ? "/competitors/keywords" : `/competitors/keywords?vol=${encodeURIComponent(v)}`)
                  }
                  options={volumePlaces.map((p) => [p.value, p.label])}
                />
              )}
            </div>

            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <p>
                <b className="tabular-nums">{fmt(visible.length)}</b> keywords
                <span className="text-muted-foreground"> · Total volume: </span>
                <b className="tabular-nums">{withVolume ? fmt(totalVolume) : "–"}</b>
                <span className="text-muted-foreground">
                  {withVolume
                    ? ` · volumes for ${fmt(withVolume)} of ${fmt(rows.length)}${volumeAt ? `, updated ${when(volumeAt)}` : ""}`
                    : " · no volumes yet: add them with Keyword Planner (above)"}
                </span>
                {estimateNote && <span className="block text-xs text-amber-800">{estimateNote}</span>}
              </p>
              {selected.size > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const res = await removeKeywordsAction([...selected])
                      setSelected(new Set())
                      return res
                    })
                  }
                >
                  <Trash2 data-icon="inline-start" /> Remove {selected.size}
                </Button>
              )}
            </div>

            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all shown"
                        checked={visible.length > 0 && visible.slice(0, shown).every((r) => selected.has(r.text))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(visible.slice(0, shown).map((r) => r.text)) : new Set())}
                      />
                    </th>
                    {header("text", "Keyword")}
                    {header("topic", "Topic")}
                    {header("place", "City")}
                    {header("volume", "Volume", true)}
                    <th className="px-3 py-2 font-medium">Trend</th>
                    {header("cpc", "CPC (top of page)", true)}
                    <th className="px-3 py-2 font-medium">Competition</th>
                    {header("words", "Words", true)}
                    <th className="px-3 py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, shown).map((r) => (
                    <tr key={r.text} className="border-t align-middle">
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.text}`}
                          checked={selected.has(r.text)}
                          onChange={(e) =>
                            setSelected((s) => {
                              const n = new Set(s)
                              if (e.target.checked) n.add(r.text)
                              else n.delete(r.text)
                              return n
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-1.5 font-medium">{r.text}</td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{topicLabel[r.topic] ?? r.topic}</td>
                      <td className="px-3 py-1.5 text-xs">{r.place || <span className="text-muted-foreground">–</span>}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {r.volume === null ? <span className="text-muted-foreground">–</span> : fmt(r.volume)}
                      </td>
                      <td className="px-3 py-1.5">
                        <Trend values={r.trend} />
                      </td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                        {r.cpcHigh === null ? (
                          <span className="text-muted-foreground">–</span>
                        ) : (
                          `${r.cpcLow !== null ? `${money(r.cpcLow)} – ` : ""}${money(r.cpcHigh)}`
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-xs">{r.competition || <span className="text-muted-foreground">–</span>}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{r.words}</td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.sources.map((s) => sourceLabels[s] ?? s).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visible.length > shown ? (
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, visible.length - shown)} more (of {fmt(visible.length - shown)})
              </Button>
            ) : null}
          </section>
        </div>
      )}
    </div>
  )
}

function GroupButton({
  label,
  count,
  volume,
  active,
  onClick,
}: {
  label: string
  count: number
  volume: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted",
        active && "bg-primary/10 font-medium text-primary",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {volume ? fmt(volume) : fmt(count)}
        <span className="sr-only">{volume ? " searches" : " keywords"}</span>
      </span>
    </button>
  )
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}

function AddPanel({
  empty,
  busy,
  onFiles,
  run,
  noVolume,
  imports,
  volumesNote,
  message,
}: {
  empty: boolean
  busy: boolean
  onFiles: (files: FileList | null) => void
  run: (fn: () => Promise<ResearchState>) => void
  noVolume: string[]
  imports: Props["imports"]
  volumesNote: string
  message: ResearchState | null
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Disclosure className="group rounded-2xl border bg-card shadow-xs" initialOpen={empty}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 sm:px-5">
        <span className="flex flex-col">
          <span className="font-semibold">Add keywords and volumes</span>
          <span className="text-sm text-muted-foreground">
            Upload a Google Ads keyword report or a Keyword Planner export, type keywords, or pull ideas from Google’s suggestions.
          </span>
        </span>
        <span className="text-sm text-primary group-open:hidden">Open</span>
      </summary>
      <div className="grid gap-5 border-t p-4 text-sm sm:px-5 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">1. Upload a file</h3>
          <p className="text-muted-foreground">
            A Google Ads keyword or search terms report (only the keywords are kept, never its clicks, cost or dates), a Keyword Planner export (adds
            volume, bids and competition), or any list with a “Keyword” column.
          </p>
          <label
            className={cn(
              "flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2 font-medium hover:border-primary hover:text-primary",
              busy && "pointer-events-none opacity-60",
            )}
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <FileUp className="size-4" aria-hidden />}
            Choose CSV files
            <input
              type="file"
              multiple
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="sr-only"
              onChange={(e) => (onFiles(e.target.files), (e.target.value = ""))}
            />
          </label>
          <p className="text-xs text-muted-foreground">Pick several at once (hold Ctrl or Shift), e.g. one Keyword Planner file per city.</p>

          <h3 className="mt-3 font-semibold">2. Get search volumes</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => run(() => volumesAction())}>
              Get volumes from Keyword Planner
            </Button>
            <span className="text-xs text-muted-foreground">Needs Basic API access. Uses one API operation per 10,000 keywords.</span>
          </div>
          {volumesNote && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{volumesNote}</p>}
          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-primary">Or use a Keyword Planner CSV (works now, free)</summary>
            <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
              <li>
                Copy the keywords that have no volume yet:{" "}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(noVolume.join("\n"))
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false))
                  }
                >
                  <Copy className="size-3" aria-hidden /> copy {noVolume.length.toLocaleString("en-US")} keywords
                </button>
                {copied && <span className="text-emerald-700"> Copied.</span>}
              </li>
              <li>Google Ads → Tools → Keyword Planner → “Get search volume and forecasts”. Paste them (up to 10,000).</li>
              <li>Set the location to California and language English, pick the last 12 months, and save the keywords to a plan.</li>
              <li>On the plan’s “Saved keywords” page, click the download icon (↓) → “.csv”, and upload that file here under 1.</li>
              <li>
                For one city’s own numbers, do it again with only that city as the location (one city per file: Google adds several together). Each
                city keeps its own volumes; pick it under “Volumes for”.
              </li>
            </ol>
          </details>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">3. Type keywords</h3>
          <form action={(fd) => run(() => addKeywordsAction({}, fd))} className="flex flex-col gap-2">
            <textarea
              name="keywords"
              rows={3}
              placeholder={"sell my house fast oakland\nwe buy houses san jose"}
              aria-label="Keywords to add"
              className="resize-y rounded-lg border border-input bg-background px-2.5 py-2"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy} className="self-start">
              Add keywords
            </Button>
          </form>

          <h3 className="mt-3 font-semibold">4. Find more from Google suggestions</h3>
          <p className="text-muted-foreground">
            Starts from a keyword and collects what Google suggests as people type it (a–z), keeping home-selling ones.
          </p>
          <form action={(fd) => run(() => suggestAction({}, fd))} className="flex flex-wrap gap-2">
            <input
              name="seed"
              placeholder="sell my house fast"
              aria-label="Keyword to start from"
              className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              <Sparkles data-icon="inline-start" /> Find ideas
            </Button>
          </form>
        </div>

        <div className="flex flex-col gap-1 lg:col-span-2">
          {busy && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> Working…
            </p>
          )}
          {message?.message && <p className={cn("font-medium", message.ok ? "text-emerald-700" : "text-destructive")}>{message.message}</p>}
          {message?.lines && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
              {message.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {imports.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Recent additions</summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {imports.map((i) => (
                  <li key={i.at}>
                    {when(i.at)} · {i.what} · {i.added.toLocaleString("en-US")} new{i.updated ? `, ${i.updated.toLocaleString("en-US")} updated` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </Disclosure>
  )
}
