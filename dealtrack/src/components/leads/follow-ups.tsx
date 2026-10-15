// The Overview's follow-up reminders: leads someone set a follow-up date on (the lead panel), due
// today or overdue, and how many are coming up this week. Each opens the lead's panel.
import Link from "next/link"
import { after } from "next/server"
import { ArrowRight, CalendarClock } from "lucide-react"

import { Section } from "@/components/report"
import { pacificDay } from "@/lib/leads/notes"
import { dayLabel, followUpDue } from "@/lib/leads/panel"
import { listLeads } from "@/lib/leads/store"
import { leadStatuses } from "@/lib/leads/types"
import { syncWordPress } from "@/lib/leads/wordpress"
import { cn } from "@/lib/utils"

const SHOWN = 8

export default async function FollowUpsDue() {
  // Dates set on the team's other computers come in with the website check, which otherwise only
  // runs while the Leads page is open: start one (at most every 30 seconds) for the next visit.
  after(() => syncWordPress().catch(() => undefined))
  const today = pacificDay()
  const weekOut = pacificDay(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000)
  // A lead marked Not interested needs no call back.
  const dated = (await listLeads().catch(() => [])).filter((l) => l.followUp?.on && l.status !== "not_interested")
  const due = dated.filter((l) => l.followUp!.on! <= today).sort((a, b) => a.followUp!.on!.localeCompare(b.followUp!.on!) || a.name.localeCompare(b.name))
  const soon = dated.filter((l) => l.followUp!.on! > today && l.followUp!.on! <= weekOut).sort((a, b) => a.followUp!.on!.localeCompare(b.followUp!.on!))
  if (!due.length && !soon.length) return null
  const overdue = due.filter((l) => l.followUp!.on! < today).length
  return (
    <Section
      title={due.length ? `Follow up today: ${due.length} lead${due.length === 1 ? "" : "s"}` : "Follow-ups this week"}
      description={
        due.length
          ? `${overdue ? `${overdue} overdue. ` : ""}Dates set in each lead's panel on the Leads page. Click Done there once you've reached them.`
          : "Nothing due today. Dates set in each lead's panel on the Leads page."
      }
      actions={
        <Link href="/leads" className="text-sm font-medium text-primary hover:underline">
          All leads
        </Link>
      }
    >
      {due.length > 0 && (
        <ol className="flex flex-col divide-y">
          {due.slice(0, SHOWN).map((l) => {
            const f = l.followUp!
            const { due: when, label } = followUpDue(f.on!, today)
            return (
              <li key={l.id}>
                <Link href={`/leads?lead=${encodeURIComponent(l.id)}`} className="group flex items-start gap-3 py-3">
                  <CalendarClock className={cn("mt-0.5 size-5 shrink-0", when === "overdue" ? "text-destructive" : "text-amber-600")} aria-hidden />
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="font-medium">{l.name}</span>
                    <span className="text-sm text-muted-foreground">
                      <span className={cn("font-medium", when === "overdue" ? "text-destructive" : "text-amber-700 dark:text-amber-300")}>{label}</span>
                      {" · "}
                      {leadStatuses.find((s) => s.id === (l.status ?? "new"))?.label ?? "New"}
                      {f.note ? ` · ${f.note}` : ""}
                      {f.by ? ` · set by ${f.by}` : ""}
                    </span>
                  </span>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
                </Link>
              </li>
            )
          })}
        </ol>
      )}
      {due.length > SHOWN && (
        <p className="text-sm text-muted-foreground">
          And {due.length - SHOWN} more: on the Leads page, click <strong>Follow-ups due</strong> above the table.
        </p>
      )}
      {soon.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Coming up this week:{" "}
          {soon.slice(0, 5).map((l, i) => (
            <span key={l.id}>
              {i > 0 && ", "}
              <Link href={`/leads?lead=${encodeURIComponent(l.id)}`} className="text-primary hover:underline">
                {l.name}
              </Link>{" "}
              ({dayLabel(l.followUp!.on!)})
            </span>
          ))}
          {soon.length > 5 ? ` and ${soon.length - 5} more` : ""}.
        </p>
      )}
    </Section>
  )
}
