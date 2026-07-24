# Lead output format — "Property Review" (Layout B)

Investigated leads are written to the Google Sheet
`10kBdkMqQ6_7xiLt8peF0WfU3R1Go8bOZnYiUmNFJSIA` (Property Review tab, gid `1510205894`)
using this header order:

```
Score · Recommendation · Address · City · Zip · Beds · Baths · SqFt · Lot SqFt ·
Year Built · Purchase Price · Estimated ARV · Rehab Cost (Light) · Rehab Cost (Heavy) ·
Holding Costs (3mo) · Total Cost (Light) · Total Cost (Heavy) · Gross Profit (Light) ·
Gross Profit (Heavy) · Risks · Redfin Link · First Added · Flip Quality
```

## Value conventions

- **Score** — numeric (e.g. `10`, `8`, `5`).
- **Recommendation** — `Strong Deal` / `Marginal`.
- **Flip Quality** — `Good Flip` / `Thin Flip` / `Flip W/ Caution` / `Negative`.
- **Money columns** — `$695,000` style (no cents): Purchase Price, Estimated ARV,
  Rehab Cost (Light/Heavy), Holding Costs (3mo), Total Cost (Light/Heavy),
  Gross Profit (Light/Heavy).
- **Risks** — free text; `None` when clean.
- **First Added** — full JS timestamp, e.g.
  `Fri Jul 24 2026 10:51:18 GMT-0700 (Pacific Daylight Time)`.

## Auto-computed (do not send unless overriding)

- `Total Cost (Light)`  = Purchase Price + Rehab (Light) + Holding Costs (3mo)
- `Total Cost (Heavy)`  = Purchase Price + Rehab (Heavy) + Holding Costs (3mo)
- `Gross Profit (Light)` = Estimated ARV − Total Cost (Light)
- `Gross Profit (Heavy)` = Estimated ARV − Total Cost (Heavy)
- `First Added` — stamped at append time.

The appender (`apps-script/append-lead.gs`) fills these and de-dupes on Redfin Link.

## Inputs to supply per lead

`Score, Recommendation, Address, City, Zip, Beds, Baths, SqFt, Lot SqFt, Year Built,
Purchase Price, Estimated ARV, Rehab Cost (Light), Rehab Cost (Heavy),
Holding Costs (3mo), Risks, Redfin Link, Flip Quality`
