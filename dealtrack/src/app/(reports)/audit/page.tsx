import type { Metadata } from "next"
import Link from "next/link"

import ManualChecks from "@/components/manual-checks"
import { PageHeader, Pill, ReportProblem, Section } from "@/components/report"
import type { PillTone } from "@/components/pill"
import { runAudit, type Area, type Audit, type Check, type CheckStatus } from "@/lib/audit"
import { load } from "@/lib/load"
import { currentName } from "@/lib/people"
import { readData } from "@/lib/store"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Go-live audit · DealTrack" }

const statusPill: Record<CheckStatus, { tone: PillTone; label: string }> = {
  pass: { tone: "green", label: "Pass" },
  warn: { tone: "amber", label: "Warning" },
  fail: { tone: "red", label: "Fix" },
  info: { tone: "gray", label: "Not yet" },
  manual: { tone: "violet", label: "To check" },
}

const gradeTone: Record<string, string> = {
  A: "bg-emerald-100 text-emerald-800",
  B: "bg-emerald-50 text-emerald-700",
  C: "bg-amber-100 text-amber-800",
  D: "bg-orange-100 text-orange-800",
  F: "bg-red-100 text-red-800",
}

// Where each area's problems get fixed in DealTrack.
const areaLink: Record<string, { href: string; label: string }> = {
  "Conversion tracking": { href: "/conversions", label: "Conversions" },
  "Location targeting": { href: "/locations", label: "Locations" },
  "Keywords and negatives": { href: "/search-terms", label: "Search terms" },
  "Ads and landing pages": { href: "/ads", label: "Ads & creatives" },
  "Budget and alerts": { href: "/budget", label: "Budget & pacing" },
  "Campaign setup": { href: "/campaigns", label: "Campaigns" },
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z]+/g, "-")
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })

export default async function AuditPage() {
  const result = await load(async () => {
    const data = await readData()
    return runAudit(data.budget, data.audit)
  })
  return (
    <>
      <PageHeader
        title="Go-live audit"
        description="Grades the account against the go-live checklist (d6) and PPC basics, in six areas plus the checks only a person can confirm. Every check reads the live account each time this page opens. Grades: pass counts fully, a warning counts half, and anything to fix or still unchecked counts zero."
      />
      {!result.ok ? <ReportProblem problem={result} /> : <Body audit={result.data} personName={await currentName()} />}
    </>
  )
}

function Body({ audit, personName }: { audit: Audit; personName: string }) {
  const all = audit.areas.flatMap((a) => a.checks)
  const count = (s: CheckStatus) => all.filter((c) => c.status === s).length
  const manual = audit.areas.find((a) => a.manual)
  const toFix = all.filter((c) => c.status === "fail")

  return (
    <>
      <section aria-label="Grades" className="grid gap-3 lg:grid-cols-[auto_1fr]">
        <div className="flex items-center gap-4 rounded-2xl border bg-card p-5 shadow-xs">
          <Grade grade={audit.grade} size="lg" />
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">Overall</p>
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{audit.score === null ? "—" : `${Math.round(audit.score * 100)} / 100`}</p>
            <p className="text-xs text-muted-foreground">
              {count("pass")} passed · {count("warn")} warnings · {count("fail")} to fix · {count("manual")} to check
            </p>
          </div>
        </div>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
          {audit.areas.map((a) => (
            <li key={a.title}>
              <a href={`#${slug(a.title)}`} className="flex h-full flex-col gap-2 rounded-2xl border bg-card p-3 shadow-xs hover:border-primary/40">
                <Grade grade={a.grade} />
                <span className="text-xs font-medium leading-snug">{a.title}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      {toFix.length > 0 && (
        <Section title={`Fix first (${toFix.length})`} description="The checks that failed, in the order of the checklist.">
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
            {toFix.map((c) => (
              <li key={c.id}>
                <span className="font-medium">{c.title}.</span> <span className="text-muted-foreground">{c.fix ?? c.detail}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {audit.areas
        .filter((a) => a !== manual)
        .map((a) => (
          <AreaSection key={a.title} area={a} />
        ))}

      {manual && (
        <Section
          id={slug(manual.title)}
          title={manual.title}
          description="Google Ads can't see these. Once someone has checked one, tick it with your name. Ticks are saved on this computer."
          actions={<Grade grade={manual.grade} />}
        >
          <ManualChecks
            personName={personName}
            items={manual.checks.map((c) => ({
              id: c.id,
              title: c.title,
              plan: c.plan,
              done: c.status === "pass",
              by: c.manual?.by,
              when: c.manual?.at ? when(c.manual.at) : undefined,
            }))}
          />
        </Section>
      )}
    </>
  )
}

function AreaSection({ area }: { area: Area }) {
  const link = areaLink[area.title]
  return (
    <Section
      id={slug(area.title)}
      title={area.title}
      description={
        link ? (
          <>
            Details on the{" "}
            <Link href={link.href} className="font-medium text-primary hover:underline">
              {link.label}
            </Link>{" "}
            page.
          </>
        ) : undefined
      }
      actions={<Grade grade={area.grade} />}
    >
      <ul className="flex flex-col divide-y divide-border/60">
        {area.checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </ul>
    </Section>
  )
}

function CheckRow({ check: c }: { check: Check }) {
  const pill = statusPill[c.status]
  return (
    <li className="flex flex-col gap-1 py-2.5 sm:flex-row sm:gap-3">
      <span className="w-20 shrink-0">
        <Pill tone={pill.tone}>{pill.label}</Pill>
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <span className="font-medium">{c.title}</span>
        <span className="text-muted-foreground">{c.detail}</span>
        {c.fix && (
          <span>
            <span className="font-medium">How to fix: </span>
            {c.fix}
          </span>
        )}
        {c.plan && <span className="text-xs text-muted-foreground">Plan: {c.plan}</span>}
      </div>
    </li>
  )
}

function Grade({ grade, size = "md" }: { grade: string; size?: "md" | "lg" }) {
  return (
    <span
      aria-label={`Grade ${grade}`}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl font-semibold tabular-nums",
        size === "lg" ? "size-16 text-4xl" : "size-9 text-lg",
        gradeTone[grade] ?? "bg-muted text-muted-foreground",
      )}
    >
      {grade}
    </span>
  )
}
