export const formatNumber = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 })

export const formatCompact = (n: number) =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)

export const formatUsd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

// Clicks and small amounts, to the cent.
export const formatUsdCents = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)

// Google can report fractional conversions (e.g. data-driven attribution), so show one decimal
// only when there is one.
export const formatConversions = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(n) ? 0 : 1 })

export const formatPercent = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`

export function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}
