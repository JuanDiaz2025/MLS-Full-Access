"use client"

import { useState } from "react"

import { formatDate, formatNumber, formatUsd } from "@/components/dashboard/format"

type Point = { date: string; value: number }

const W = 600
const H = 160

// Round the axis max up to a clean number (e.g. 237 -> 250).
function niceMax(n: number) {
  if (n <= 1) return 1
  const step = 10 ** Math.floor(Math.log10(n)) / 2
  return Math.ceil(n / step) * step
}

export default function TrendChart({
  data,
  color,
  label,
  unit = "number",
}: {
  data: Point[]
  color: string
  label: string
  unit?: "number" | "usd"
}) {
  const fmt = unit === "usd" ? formatUsd : formatNumber
  const [active, setActive] = useState<number | null>(null)
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)))
  const span = Math.max(data.length - 1, 1)
  const x = (i: number) => (i / span) * W
  const y = (v: number) => H - (v / max) * H
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i)} ${y(d.value)}`).join(" ")
  const area = `${line} L${W} ${H} L0 ${H} Z`
  const last = data.length - 1
  const shown = active ?? last
  const point = data[shown]

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    setActive(Math.round(ratio * last))
  }

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatDate(point.date)}: <span className="font-medium text-foreground">{fmt(point.value)}</span>
        </span>
      </figcaption>
      <div className="flex gap-2">
        {/* Y-axis ticks */}
        <div className="flex h-36 flex-col justify-between py-0 text-right text-[11px] leading-none text-muted-foreground tabular-nums">
          <span>{fmt(max)}</span>
          <span>{fmt(max / 2)}</span>
          <span>0</span>
        </div>
        <div
          className="relative h-36 flex-1 touch-none"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setActive(null)}
          role="img"
          aria-label={`${label}, ${formatDate(data[0].date)} to ${formatDate(data[last].date)}`}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
            {[0, 0.5, 1].map((t) => (
              <line key={t} x1={0} x2={W} y1={H * t} y2={H * t} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            <path d={area} fill={color} fillOpacity={0.1} />
            <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {active !== null && (
              <line x1={x(active)} x2={x(active)} y1={0} y2={H} stroke="var(--muted-foreground)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {/* Marker as HTML so it stays round in a stretched SVG */}
          <span
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
            style={{ left: `${(shown / span) * 100}%`, top: `${(y(point.value) / H) * 100}%`, background: color }}
          />
        </div>
      </div>
      <div className="flex justify-between pl-8 text-[11px] text-muted-foreground">
        <span>{formatDate(data[0].date)}</span>
        <span>{formatDate(data[last].date)}</span>
      </div>
    </figure>
  )
}
