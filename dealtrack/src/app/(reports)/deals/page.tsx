import type { Metadata } from "next"
import Link from "next/link"
import { ExternalLink } from "lucide-react"

import { PageHeader, Section } from "@/components/report"
import SheetSync from "@/components/sheets/sheet-sync"
import { buttonVariants } from "@/components/ui/button"
import { activeAccount } from "@/lib/conversions/google"
import { getSheetSync, readCombined, syncSheetIfDue, type CombinedView } from "@/lib/sheets/sync"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Deal History · DealTrack" }

// The deals in your Google Sheet (2024–2026, all in one list) and what Google Ads cost per deal,
// read live from the "2024–2026 Combined" tab DealTrack keeps up to date. From One Marketing
// Command Center.
const SHOWN = ["Year", "Lead Name", "Address", "Campaign", "Lead Source", "Marketing Fee", "Contract Signed", "Status"]

async function load(): Promise<{ view: CombinedView | null; error?: string }> {
  try {
    const active = await activeAccount()
    if (!active) return { view: null, error: "Google Ads isn't connected. Check the Google Ads keys in .env.local." }
    // Catches up first if the last update was more than 6 hours ago (or never ran).
    await syncSheetIfDue(active.connection, active.account)
    return { view: await readCombined(active.connection) }
  } catch (e) {
    return { view: null, error: e instanceof Error ? e.message : String(e) }
  }
}

const money = (n: string) => Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" })

function Table({ header, rows, wide }: { header: string[]; rows: string[][]; wide?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className={cn("w-full text-sm", wide && "min-w-[900px]")}>
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            {header.map((h, i) => (
              <th key={i} className={cn("px-3 py-2 font-medium whitespace-nowrap", i > 0 && !wide && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn("border-t", /^all years$/i.test(r[0] ?? "") && "bg-muted/30 font-semibold")}>
              {header.map((_, j) => (
                <td
                  key={j}
                  className={cn(
                    "px-3 py-2 align-top",
                    j > 0 && !wide && "text-right whitespace-nowrap tabular-nums",
                    j === 0 && "font-medium",
                    j === 0 && !wide && rows.some((x) => (x[0] ?? "").length > 14) && "min-w-56",
                  )}
                >
                  {r[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function DealsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { year } = await searchParams
  const [{ view, error }, sheet] = await Promise.all([load(), getSheetSync()])
  const link = sheet.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit` : undefined

  const cols = view ? SHOWN.map((h) => view.header.findIndex((x) => x.trim().toLowerCase() === h.toLowerCase())).filter((i) => i >= 0) : []
  const years = view ? [...new Set(view.deals.map((d) => d[0]).filter(Boolean))].sort().reverse() : []
  // Newest year first, in the sheet's order within a year; fees as dollars if the sheet shows plain numbers.
  const fee = view ? view.header.findIndex((h) => /marketing fee/i.test(h)) : -1
  const deals = view
    ? view.deals
        .filter((d) => !year || d[0] === year)
        .map((d, i) => ({ d: fee >= 0 && /^-?\d+(\.\d+)?$/.test(d[fee] ?? "") ? d.map((c, j) => (j === fee ? money(c) : c)) : d, i }))
        .sort((a, b) => (b.d[0] ?? "").localeCompare(a.d[0] ?? "") || a.i - b.i)
        .map((x) => x.d)
    : []

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="Deal History"
          description={`Your 2024–2026 deals in one list, next to what Google Ads cost, from ${sheet.title ? `“${sheet.title}”` : "your spreadsheet"}.`}
        />
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
            <ExternalLink data-icon="inline-start" />
            Open in Google Sheets
          </a>
        )}
      </div>

      {view &&
        view.tables.map((t, i) => {
          // The first header cell is the table's title; columns with no header are spacers.
          const keep = t.header.map((_, j) => j).filter((j) => j === 0 || t.header[j])
          return (
            <Section key={i} title={t.header[0] || "Summary"}>
              <Table header={keep.map((j) => (j === 0 ? "" : t.header[j]))} rows={t.rows.map((r) => keep.map((j) => r[j] ?? ""))} />
            </Section>
          )
        })}

      {view && (
        <Section
          title={`Deals (${deals.length})`}
          actions={
            years.length > 1 ? (
              <nav aria-label="Year" className="flex flex-wrap gap-1.5">
                {["", ...years].map((y) => (
                  <Link
                    key={y || "all"}
                    href={y ? `/deals?year=${y}` : "/deals"}
                    aria-current={(year ?? "") === y ? "page" : undefined}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground",
                      (year ?? "") === y && "border-primary bg-primary text-primary-foreground hover:text-primary-foreground",
                    )}
                  >
                    {y || "All years"}
                  </Link>
                ))}
              </nav>
            ) : undefined
          }
        >
          {deals.length ? (
            <Table wide header={cols.map((i) => view.header[i])} rows={deals.map((d) => cols.map((i) => d[i] ?? ""))} />
          ) : (
            <p className="text-sm text-muted-foreground">No deals yet. Click Sync now below to bring them in from your year tabs.</p>
          )}
          {view.notes.length > 0 && <p className="text-xs text-muted-foreground">{view.notes.join(" · ")}</p>}
        </Section>
      )}

      {error && sheet.spreadsheetId && <p className="text-sm font-medium text-destructive">Couldn&apos;t read your sheet: {error}</p>}

      <SheetSync open={!view || Boolean(sheet.lastError)} {...sheet} />
    </>
  )
}
