"use client"

// Two metrics on one chart, each on its own scale (left axis for the first, right for the
// second), so e.g. spend and leads can be read against each other. Hover or tap for values.

import { useState } from "react"

import { formatUnit, type Unit } from "@/lib/overview-metrics"

export type Series = { label: string; unit: Unit; values: (number | null)[] }

const W = 600
const H = 180
const COLORS = ["var(--primary)", "var(--chart-2)"]

function niceMax(n: number, unit: Unit) {
  if (unit === "percent") {
    if (n <= 0) return 1
    const step = n <= 0.5 ? 0.05 : 0.1
    return Math.min(1, Math.ceil(n / step) * step)
  }
  if (n <= 2) return 2
  const step = 10 ** Math.floor(Math.log10(n)) / 2
  return Math.ceil(n / step) * step
}

function pathFor(values: (number | null)[], max: number) {
  const last = Math.max(values.length - 1, 1)
  let d = ""
  let pen = false
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false
      return
    }
    d += `${pen ? "L" : "M"}${(i / last) * W} ${H - (v / max) * H} `
    pen = true
  })
  return d
}

export default function CompareChart({ labels, series }: { labels: string[]; series: Series[] }) {
  const [active, setActive] = useState<number | null>(null)
  const last = Math.max(labels.length - 1, 1)
  const maxes = series.map((s) => niceMax(Math.max(0, ...s.values.filter((v): v is number => v !== null && Number.isFinite(v))), s.unit))
  const shown = active ?? labels.length - 1

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    setActive(Math.round(ratio * (labels.length - 1)))
  }

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          {series.map((s, i) => (
            <span key={s.label} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: COLORS[i] }} aria-hidden />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="font-medium tabular-nums">{formatUnit(s.unit, s.values[shown] ?? null)}</span>
            </span>
          ))}
        </span>
        <span className="text-xs text-muted-foreground">{labels[shown]}</span>
      </figcaption>
      <div className="flex gap-2">
        <Axis max={maxes[0]} unit={series[0].unit} color={COLORS[0]} align="right" />
        <div
          className="relative h-44 flex-1 touch-none"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setActive(null)}
          role="img"
          aria-label={`${series.map((s) => s.label).join(" and ")}, ${labels[0]} to ${labels[labels.length - 1]}`}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
            {[0, 0.5, 1].map((t) => (
              <line key={t} x1={0} x2={W} y1={H * t} y2={H * t} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {series.map((s, i) => (
              <path
                key={s.label}
                d={pathFor(s.values, maxes[i])}
                fill="none"
                stroke={COLORS[i]}
                strokeWidth={2}
                strokeDasharray={i ? "5 3" : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {active !== null && (
              <line x1={(active / last) * W} x2={(active / last) * W} y1={0} y2={H} stroke="var(--muted-foreground)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {series.map((s, i) => {
            const v = s.values[shown]
            if (v === null || v === undefined || !Number.isFinite(v)) return null
            return (
              <span
                key={s.label}
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
                style={{ left: `${(shown / last) * 100}%`, top: `${(1 - v / maxes[i]) * 100}%`, background: COLORS[i] }}
              />
            )
          })}
        </div>
        {series[1] && <Axis max={maxes[1]} unit={series[1].unit} color={COLORS[1]} align="left" />}
      </div>
      <div className="flex justify-between pl-14 text-[11px] text-muted-foreground" style={{ paddingRight: series[1] ? "3.5rem" : 0 }}>
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </figure>
  )
}

function Axis({ max, unit, color, align }: { max: number; unit: Unit; color: string; align: "left" | "right" }) {
  return (
    <div
      className="flex h-44 w-12 shrink-0 flex-col justify-between text-[11px] leading-none tabular-nums"
      style={{ color, textAlign: align }}
      aria-hidden
    >
      <span>{formatUnit(unit, max)}</span>
      <span>{formatUnit(unit, max / 2)}</span>
      <span>{formatUnit(unit, 0)}</span>
    </div>
  )
}
