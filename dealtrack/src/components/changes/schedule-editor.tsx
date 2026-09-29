"use client"

import { useState } from "react"

import { setAdScheduleAction } from "@/app/actions/controls"
import { List, useChange, type CampaignOption } from "@/components/changes/shared"
import { Button } from "@/components/ui/button"

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const
type Day = (typeof DAYS)[number]
const dayLabel = (d: Day) => d.charAt(0) + d.slice(1, 3).toLowerCase()

export type EditorSlot = { day: Day; from: number; to: number; bidModifier: number | null }
type DayRow = { on: boolean; from: number; to: number } // hours, to can be 24

const hourLabel = (h: number) => (h === 0 || h === 24 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`)
const timeLabel = (m: number) => {
  const h = Math.floor(m / 60)
  const min = m % 60
  return min ? hourLabel(h).replace(" ", `:${String(min).padStart(2, "0")} `) : hourLabel(h)
}
const rangeLabel = (from: number, to: number) => (from === 0 && to === 1440 ? "all day" : `${timeLabel(from)} – ${timeLabel(to)}`)

// One row per day from Google's schedule. No schedule means ads can run all the time.
function rowsFrom(slots: EditorSlot[]): Record<Day, DayRow> {
  const rows = {} as Record<Day, DayRow>
  for (const day of DAYS) {
    const mine = slots.filter((s) => s.day === day)
    rows[day] = !slots.length
      ? { on: true, from: 0, to: 24 }
      : mine.length
        ? { on: true, from: Math.floor(Math.min(...mine.map((s) => s.from)) / 60), to: Math.ceil(Math.max(...mine.map((s) => s.to)) / 60) }
        : { on: false, from: 8, to: 20 }
  }
  return rows
}

// Pick a campaign, then set the hours its ads can run each day.
export default function ScheduleEditor({
  campaigns,
  schedules,
}: {
  campaigns: CampaignOption[]
  schedules: Record<string, EditorSlot[]>
}) {
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "")
  const change = useChange()
  if (!campaigns.length) return <p className="text-sm text-muted-foreground">There are no campaigns that can take an ad schedule.</p>

  const running = campaigns.filter((c) => c.status === "ENABLED")
  const paused = campaigns.filter((c) => c.status !== "ENABLED")
  const campaign = campaigns.find((c) => c.id === campaignId) ?? campaigns[0]

  return (
    <div className="flex flex-col gap-4">
      <label htmlFor="schedule-campaign" className="flex max-w-md flex-col gap-1 text-xs font-medium text-muted-foreground">
        Campaign
        <select
          id="schedule-campaign"
          value={campaign.id}
          onChange={(e) => setCampaignId(e.target.value)}
          className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
        >
          {running.length > 0 && (
            <optgroup label="Running">
              {running.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
          {paused.length > 0 && (
            <optgroup label="Paused">
              {paused.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {/* Keyed by campaign and its schedule, so the rows reset when either changes. */}
      <DayRows
        key={`${campaign.id}|${JSON.stringify(schedules[campaign.id] ?? [])}`}
        campaign={campaign}
        slots={schedules[campaign.id] ?? []}
        change={change}
      />
      {change.ui}
    </div>
  )
}

function DayRows({
  campaign,
  slots,
  change: { ask, busy },
}: {
  campaign: CampaignOption
  slots: EditorSlot[]
  change: ReturnType<typeof useChange>
}) {
  const [rows, setRows] = useState(() => rowsFrom(slots))

  const set = (day: Day, patch: Partial<DayRow>) => setRows({ ...rows, [day]: { ...rows[day], ...patch } })
  const onDays = DAYS.filter((d) => rows[d].on)
  const bad = onDays.find((d) => rows[d].from >= rows[d].to)
  const allDay = onDays.length === 7 && onDays.every((d) => rows[d].from === 0 && rows[d].to === 24)
  const combined = DAYS.filter((d) => slots.filter((s) => s.day === d).length > 1 || slots.some((s) => s.day === d && (s.from % 60 || s.to % 60)))
  const adjusted = slots.filter((s) => s.bidModifier !== null && s.bidModifier !== 1)

  function save() {
    // All day, every day is the same as having no schedule.
    const next = allDay ? [] : onDays.map((day) => ({ day, from: rows[day].from * 60, to: rows[day].to * 60 }))
    ask({
      title: allDay ? `Let ${campaign.name} run at any time?` : `Change when ${campaign.name} shows ads?`,
      details: (
        <>
          {allDay ? (
            <p>This removes the ad schedule, so ads can show 24 hours a day, 7 days a week.</p>
          ) : (
            <List items={DAYS.map((d) => `${dayLabel(d)}: ${rows[d].on ? rangeLabel(rows[d].from * 60, rows[d].to * 60) : "no ads"}`)} />
          )}
          <p className="mt-2">Times are Pacific, the account&apos;s time zone.</p>
          {adjusted.length > 0 && (
            <p className="mt-1 font-medium text-foreground">
              Some current time ranges have bid adjustments. Ranges that change lose them.
            </p>
          )}
        </>
      ),
      confirmLabel: "Save schedule",
      note: "You can undo it from the message that follows.",
      run: () => setAdScheduleAction({ campaignId: campaign.id, slots: next }),
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Now:{" "}
        {slots.length ? (
          DAYS.map((d) => {
            const mine = slots.filter((s) => s.day === d)
            return `${dayLabel(d)} ${mine.length ? mine.map((s) => rangeLabel(s.from, s.to)).join(", ") : "off"}`
          }).join(" · ")
        ) : (
          <span className="font-medium text-foreground">no schedule, ads can run at any time</span>
        )}
      </p>

      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="py-1 pr-4 text-left font-medium">
                Day
              </th>
              <th scope="col" className="py-1 pr-4 text-left font-medium">
                Show ads
              </th>
              <th scope="col" className="py-1 pr-2 text-left font-medium">
                From
              </th>
              <th scope="col" className="py-1 text-left font-medium">
                Until
              </th>
            </tr>
          </thead>
          <tbody>
            {DAYS.map((d) => {
              const r = rows[d]
              const select = (field: "from" | "to", hours: number[]) => (
                <select
                  aria-label={`${dayLabel(d)} ${field === "from" ? "start" : "end"}`}
                  value={r[field]}
                  disabled={!r.on}
                  onChange={(e) => set(d, { [field]: Number(e.target.value) })}
                  className="h-8 rounded-lg border border-input bg-background px-2 text-sm disabled:opacity-40"
                >
                  {hours.map((h) => (
                    <option key={h} value={h}>
                      {field === "to" && h === 24 ? "12 am (midnight)" : hourLabel(h)}
                    </option>
                  ))}
                </select>
              )
              return (
                <tr key={d}>
                  <th scope="row" className="py-1 pr-4 text-left font-medium">
                    {dayLabel(d)}
                  </th>
                  <td className="py-1 pr-4">
                    <input
                      type="checkbox"
                      aria-label={`Show ads on ${dayLabel(d)}`}
                      checked={r.on}
                      onChange={(e) => set(d, { on: e.target.checked })}
                      className="size-4 accent-[var(--primary)]"
                    />
                  </td>
                  <td className="py-1 pr-2">{select("from", Array.from({ length: 24 }, (_, h) => h))}</td>
                  <td className="py-1">{select("to", Array.from({ length: 24 }, (_, h) => h + 1))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {combined.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {combined.map(dayLabel).join(", ")} currently {combined.length === 1 ? "has" : "have"} split or part-hour times. Saving
          replaces them with the single range shown.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={save} disabled={busy || !onDays.length || !!bad}>
          Review schedule
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => setRows(Object.fromEntries(DAYS.map((d) => [d, { on: true, from: 0, to: 24 }])) as Record<Day, DayRow>)}
        >
          Set all day, every day
        </Button>
        {!onDays.length && <span className="text-xs text-destructive">Pick at least one day. To stop all ads, pause the campaign.</span>}
        {bad && <span className="text-xs text-destructive">{dayLabel(bad)} has to end after it starts.</span>}
      </div>
    </div>
  )
}
