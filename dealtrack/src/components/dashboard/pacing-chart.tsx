// Month-to-date spend against the budget: actual spend so far (solid), where the recent pace
// lands by month end (dashed), the budget as a straight line from zero, and the alert and pause
// lines. Server-rendered SVG; no interaction needed.

import { formatUsd } from "@/components/dashboard/format"

const W = 640
const H = 220
const PAD = { left: 56, right: 12, top: 12, bottom: 24 }

export default function PacingChart({
  cumulative,
  daysInMonth,
  projected,
  monthly,
  alertLine,
  pauseLine,
}: {
  cumulative: { date: string; spent: number }[]
  daysInMonth: number
  projected: number
  monthly: number | null
  alertLine: number | null
  pauseLine: number | null
}) {
  const spent = cumulative.at(-1)?.spent ?? 0
  const top = Math.max(spent, projected, monthly ?? 0, alertLine ?? 0, pauseLine ?? 0, 100) * 1.08
  const x = (day: number) => PAD.left + ((day - 1) / Math.max(daysInMonth - 1, 1)) * (W - PAD.left - PAD.right)
  const y = (v: number) => H - PAD.bottom - (v / top) * (H - PAD.top - PAD.bottom)
  const today = cumulative.length

  const actual = cumulative.map((p, i) => `${i ? "L" : "M"}${x(i + 1)} ${y(p.spent)}`).join(" ")
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * top)
  const hline = (v: number | null, color: string, label: string) =>
    v ? (
      <g>
        <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={color} strokeWidth={1.5} strokeDasharray="2 3" />
        <text x={W - PAD.right} y={y(v) - 4} textAnchor="end" fontSize={11} fill={color}>
          {label} {formatUsd(v)}
        </text>
      </g>
    ) : null

  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spend this month against the budget" className="h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted-foreground)">
              {formatUsd(t)}
            </text>
          </g>
        ))}
        {[1, Math.ceil(daysInMonth / 2), daysInMonth].map((d) => (
          <text key={d} x={x(d)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">
            Day {d}
          </text>
        ))}
        {monthly && (
          <line x1={x(1)} y1={y(0)} x2={x(daysInMonth)} y2={y(monthly)} stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray="6 4" />
        )}
        {hline(alertLine, "#d97706", "Alert line")}
        {hline(pauseLine, "#dc2626", "Pause line")}
        {today > 0 && (
          <line x1={x(today)} y1={y(spent)} x2={x(daysInMonth)} y2={y(projected)} stroke="var(--primary)" strokeWidth={2} strokeDasharray="4 4" opacity={0.6} />
        )}
        <path d={actual} fill="none" stroke="var(--primary)" strokeWidth={2.5} />
        {today > 0 && <circle cx={x(today)} cy={y(spent)} r={4} fill="var(--primary)" />}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 bg-primary align-middle" /> Spent so far
        </span>
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 border-t-2 border-dashed border-primary align-middle opacity-60" /> At the last 7 days&apos; pace
        </span>
        {monthly && (
          <span>
            <span className="mr-1 inline-block h-0.5 w-4 border-t-2 border-dashed border-muted-foreground align-middle" /> Budget, spread evenly
          </span>
        )}
      </figcaption>
    </figure>
  )
}
