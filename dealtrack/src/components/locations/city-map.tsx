"use client"

// The Locations map: a bubble per city, sized by the chosen metric and colored by cost per
// conversion against the average. Hover a bubble for its numbers and the campaigns that showed
// ads there; search a city to fly to it. Leaflet loads in the browser only.

import "leaflet/dist/leaflet.css"

import { useEffect, useMemo, useRef, useState } from "react"
import type { CircleMarker, GeoJSON as GeoJSONLayer, LayerGroup, Map as LeafletMap } from "leaflet"

import { formatConversions, formatNumber, formatUsd } from "@/components/dashboard/format"
import { Segmented } from "@/components/negatives/parts"
import type { MapCity } from "@/lib/locations"
import { cn } from "@/lib/utils"

type Metric = "impressions" | "cost" | "clicks" | "conversions"
const METRICS: { id: Metric; label: string }[] = [
  { id: "impressions", label: "Impressions" },
  { id: "cost", label: "Spend" },
  { id: "clicks", label: "Clicks" },
  { id: "conversions", label: "Conversions" },
]

const CALIFORNIA: [[number, number], [number, number]] = [
  [32.4, -124.6],
  [42.1, -114.0],
]

const COLORS = {
  cheap: "#059669",
  average: "#6366f1",
  pricey: "#dc2626",
  noConversion: "#d97706",
  noSpend: "#94a3b8",
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

function colorOf(c: MapCity, avg: number | null) {
  if (!c.cost) return COLORS.noSpend
  if (!c.conversions) return COLORS.noConversion
  if (!avg) return COLORS.average
  const ratio = c.cost / c.conversions / avg
  return ratio <= 0.85 ? COLORS.cheap : ratio >= 1.15 ? COLORS.pricey : COLORS.average
}

function details(c: MapCity) {
  const cpa = c.conversions ? formatUsd(c.cost / c.conversions) : "—"
  const campaigns = c.campaigns.length
    ? c.campaigns
        .map(
          (k) =>
            `<li><span style="font-weight:500">${esc(k.name)}</span>${k.running ? ' <span style="color:#059669">(running)</span>' : ""}<br/><span style="color:#6b7280">${formatNumber(k.impressions)} impr · ${formatUsd(k.cost)} · ${formatConversions(k.conversions)} conv</span></li>`,
        )
        .join("")
    : "<li>—</li>"
  return `<div style="min-width:220px;font-size:12px;line-height:1.4">
    <div style="font-weight:600;font-size:13px">${esc(c.city)}</div>
    <div style="color:#6b7280;margin-bottom:6px">${esc(c.region)}${c.inside ? "" : ' · <span style="color:#dc2626">outside California</span>'}</div>
    <table style="width:100%;border-collapse:collapse">
      <tr><td>Impressions</td><td style="text-align:right">${formatNumber(c.impressions)}</td></tr>
      <tr><td>Clicks</td><td style="text-align:right">${formatNumber(c.clicks)}</td></tr>
      <tr><td>Spend</td><td style="text-align:right">${formatUsd(c.cost)}</td></tr>
      <tr><td>Conversions</td><td style="text-align:right">${formatConversions(c.conversions)}</td></tr>
      <tr><td>Cost / conv.</td><td style="text-align:right">${cpa}</td></tr>
    </table>
    <div style="margin-top:6px;font-weight:500">Campaigns here</div>
    <ul style="margin:2px 0 0;padding-left:14px">${campaigns}</ul>
  </div>`
}

type Mode = "areas" | "bubbles"

export default function CityMap({
  cities,
  averageCpa,
  missing,
  level,
}: {
  cities: MapCity[]
  averageCpa: number | null
  missing: number
  level: "city" | "county"
}) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<LeafletMap | null>(null)
  const markers = useRef<Map<string, CircleMarker>>(new Map())
  const shapes = useRef<Map<string, GeoJSONLayer>>(new Map())
  const layers = useRef<{ bubbles?: LayerGroup; areas?: LayerGroup }>({})
  const [ready, setReady] = useState(false)
  const [metric, setMetric] = useState<Metric>("impressions")
  const hasAreas = cities.some((c) => c.geometry)
  const [mode, setMode] = useState<Mode>(hasAreas ? "areas" : "bubbles")
  const shown: Mode = hasAreas ? mode : "bubbles"
  const noun = level === "county" ? "county" : "city"
  const [query, setQuery] = useState("")
  const [notFound, setNotFound] = useState(false)

  const max = useMemo(() => Math.max(1, ...cities.map((c) => c[metric])), [cities, metric])
  const radius = (c: MapCity) => (c[metric] > 0 ? 4 + 22 * Math.sqrt(c[metric] / max) : 3)
  // Areas: darker for more of the chosen metric.
  const shade = (c: MapCity) => (c[metric] > 0 ? 0.18 + 0.6 * Math.sqrt(c[metric] / max) : 0.08)

  // Create the map once.
  useEffect(() => {
    let cancelled = false
    const made = markers.current
    const madeShapes = shapes.current
    ;(async () => {
      const L = (await import("leaflet")).default
      if (cancelled || !box.current || map.current) return
      const m = L.map(box.current, { preferCanvas: true, scrollWheelZoom: false, zoomControl: true, zoomSnap: 0.25, zoomDelta: 0.5 })
      // OpenStreetMap's standard tiles (no key), shown softened so the bubbles stand out.
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
        className: "dt-map-tiles",
      }).addTo(m)
      m.fitBounds(CALIFORNIA)
      const bubbles = L.layerGroup()
      const areas = L.layerGroup()
      // County outlines, shaded by the chosen metric and colored by cost per conversion.
      for (const c of cities) {
        if (!c.geometry) continue
        const color = colorOf(c, averageCpa)
        const shape = L.geoJSON(c.geometry, {
          style: { color: c.inside ? "#475569" : "#7f1d1d", weight: c.inside ? 0.8 : 1.6, fillColor: color, fillOpacity: 0.3 },
        })
        shape.bindTooltip(details(c), { direction: "top", sticky: true, opacity: 1 }).bindPopup(details(c))
        shape.on("mouseover", () => shape.setStyle({ weight: 2.5 }))
        shape.on("mouseout", () => shape.setStyle({ weight: c.inside ? 0.8 : 1.6 }))
        shape.addTo(areas)
        madeShapes.set(c.key, shape)
      }
      // Biggest first, so small bubbles stay on top and can be hovered.
      for (const c of [...cities].sort((a, b) => b.impressions - a.impressions)) {
        const color = colorOf(c, averageCpa)
        const marker = L.circleMarker([c.lat, c.lng], {
          radius: 4,
          color: c.inside ? color : "#7f1d1d",
          weight: c.inside ? 1 : 2,
          fillColor: color,
          fillOpacity: 0.55,
        })
          .bindTooltip(details(c), { direction: "top", sticky: true, opacity: 1 })
          .bindPopup(details(c))
          .addTo(bubbles)
        made.set(c.key, marker)
      }
      layers.current = { bubbles, areas }
      map.current = m
      // The box may still be settling into the page; measure again, then frame California.
      requestAnimationFrame(() => {
        m.invalidateSize()
        m.fitBounds(CALIFORNIA)
      })
      setReady(true)
    })()
    return () => {
      cancelled = true
      map.current?.remove()
      map.current = null
      made.clear()
      madeShapes.clear()
    }
  }, [cities, averageCpa])

  // Show the chosen layer.
  useEffect(() => {
    const m = map.current
    const { bubbles, areas } = layers.current
    if (!ready || !m || !bubbles || !areas) return
    const [on, off] = shown === "areas" ? [areas, bubbles] : [bubbles, areas]
    off.remove()
    on.addTo(m)
  }, [ready, shown])

  // Resize bubbles and reshade areas when the metric changes.
  useEffect(() => {
    if (!ready) return
    for (const c of cities) {
      markers.current.get(c.key)?.setRadius(radius(c))
      shapes.current.get(c.key)?.setStyle({ fillOpacity: shade(c) })
    }
    // radius depends on metric and max, which the deps cover
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, metric, max, cities])

  const flyTo = (c: MapCity) => {
    if (!map.current) return
    const shape = shown === "areas" ? shapes.current.get(c.key) : undefined
    if (shape) {
      map.current.flyToBounds(shape.getBounds(), { maxZoom: 10, duration: 0.6 })
      window.setTimeout(() => shape.openPopup(shape.getBounds().getCenter()), 650)
    } else {
      map.current.flyTo([c.lat, c.lng], Math.max(map.current.getZoom(), level === "county" ? 8 : 10), { duration: 0.6 })
      window.setTimeout(() => markers.current.get(c.key)?.openPopup(), 650)
    }
  }
  const search = (text: string) => {
    const t = text.trim().toLowerCase()
    if (!t) return
    const hit =
      cities.find((c) => `${c.city}, ${c.region}`.toLowerCase() === t) ??
      cities.find((c) => c.city.toLowerCase() === t) ??
      cities.find((c) => c.city.toLowerCase().startsWith(t))
    setNotFound(!hit)
    if (hit) flyTo(hit)
  }

  const total = cities.reduce((s, c) => s + c.impressions, 0)
  const top = (f: (c: MapCity) => number) => [...cities].sort((a, b) => f(b) - f(a))[0]
  const facts: { label: string; value: string; city?: MapCity }[] = [
    { label: level === "county" ? "Counties on the map" : "Cities on the map", value: formatNumber(cities.length) },
    { label: `Average impressions per ${noun}`, value: formatNumber(Math.round(cities.length ? total / cities.length : 0)) },
    { label: "Most impressions", value: top((c) => c.impressions) ? `${formatNumber(top((c) => c.impressions).impressions)}` : "—", city: top((c) => c.impressions) },
    { label: "Most spend", value: top((c) => c.cost)?.cost ? formatUsd(top((c) => c.cost).cost) : "—", city: top((c) => c.cost)?.cost ? top((c) => c.cost) : undefined },
    {
      label: "Most conversions",
      value: top((c) => c.conversions)?.conversions ? formatConversions(top((c) => c.conversions).conversions) : "—",
      city: top((c) => c.conversions)?.conversions ? top((c) => c.conversions) : undefined,
    },
  ]
  const cheapest = cities.filter((c) => c.conversions >= 2).sort((a, b) => a.cost / a.conversions - b.cost / b.conversions)[0]
  if (cheapest) facts.push({ label: "Cheapest conversions (2+)", value: `${formatUsd(cheapest.cost / cheapest.conversions)}/conv`, city: cheapest })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {hasAreas && <Segmented<Mode> label="Show as" value={shown} onChange={setMode} options={[{ id: "areas", label: "Shaded areas" }, { id: "bubbles", label: "Bubbles" }]} />}
        <span className="text-xs font-medium text-muted-foreground">{shown === "areas" ? "Shade by:" : "Bubble size:"}</span>
        <Segmented<Metric> label={shown === "areas" ? "Shade by" : "Bubble size"} value={metric} onChange={setMetric} options={METRICS} />
        <form
          className="flex w-full items-center gap-1.5 sm:ml-auto sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault()
            search(query)
          }}
        >
          <input
            type="search"
            list="map-cities"
            aria-label={`Find a ${noun} on the map`}
            placeholder={level === "county" ? "Find a county, e.g. Alameda" : "Find a city, e.g. Oakland"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setNotFound(false)
              // Picking from the suggestions jumps right away.
              if (cities.some((c) => `${c.city}, ${c.region}` === e.target.value)) search(e.target.value)
            }}
            className={cn("h-8 w-full rounded-lg border bg-background px-2 text-sm sm:w-64", notFound ? "border-destructive" : "border-input")}
          />
          <datalist id="map-cities">
            {cities.slice(0, 1500).map((c) => (
              <option key={c.key} value={`${c.city}, ${c.region}`} />
            ))}
          </datalist>
          <button type="submit" className="h-8 rounded-lg border bg-background px-2.5 text-xs font-medium hover:bg-muted">
            Find
          </button>
        </form>
      </div>
      {notFound && <p className="text-xs text-destructive">No {noun} by that name on the map for this period.</p>}
      {!hasAreas && (
        <p className="text-xs text-muted-foreground">Shaded areas are drawn by county: switch the place level to Counties at the top to see them.</p>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="relative overflow-hidden rounded-xl border">
          <div ref={box} className="h-[520px] w-full bg-muted/30 [&_.dt-map-tiles]:[filter:grayscale(1)_brightness(1.06)_contrast(0.9)]" role="region" aria-label="Map of cities where ads showed" />
          <div className="absolute top-2 right-2 z-[400] flex gap-1">
            <button
              type="button"
              onClick={() => map.current?.fitBounds(CALIFORNIA)}
              className="rounded-md border bg-card/95 px-2 py-1 text-xs font-medium shadow-sm hover:bg-muted"
            >
              California
            </button>
            <button
              type="button"
              onClick={() => map.current?.setView([39.5, -98.35], 4)}
              className="rounded-md border bg-card/95 px-2 py-1 text-xs font-medium shadow-sm hover:bg-muted"
            >
              Whole US
            </button>
          </div>
          {!ready && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Loading the map…</p>}
        </div>

        <dl className="grid grid-cols-2 gap-2 lg:grid-cols-1">
          {facts.map((f) => (
            <div key={f.label} className="rounded-xl border bg-card p-3">
              <dt className="text-xs text-muted-foreground">{f.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{f.value}</dd>
              {f.city && (
                <button type="button" onClick={() => flyTo(f.city!)} className="text-xs font-medium text-primary hover:underline">
                  {f.city.city} →
                </button>
              )}
            </div>
          ))}
        </dl>
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Colors">
        {[
          [COLORS.cheap, "Cheaper per conversion than average"],
          [COLORS.average, "About average"],
          [COLORS.pricey, "More expensive than average"],
          [COLORS.noConversion, "Spent, no conversions"],
          [COLORS.noSpend, "Impressions only"],
        ].map(([color, label]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-full" style={{ background: color, opacity: 0.8 }} />
            {label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-full border-2" style={{ borderColor: "#7f1d1d" }} />
          Dark ring: outside California
        </li>
      </ul>
      {missing > 0 && <p className="text-xs text-muted-foreground">{formatNumber(missing)} smaller places Google names aren&apos;t on the map (no known center).</p>}
    </div>
  )
}
