# Lead output formats

Two sheets are in play. **The Flip Scout Agent sheet is the one the desktop app
writes to** and is where new work goes; Property Review (Layout B) is the older
sheet, kept for the existing headless pipeline.

## A. "Flip Scout Agent" sheet (current — app target)

Spreadsheet `1u7YXGGUp_TeJUP3nYDqTJDJgu5IjLtkX0KPlSkI4TE4`, tab `Leads`.
Endpoint: `apps-script/flip-scout-agent-sheet.gs` (Web App; POST `{secret, leads:[…]}`
or `{secret, lead:{…}}`). Column order:

```
Score · Recommendation · Flip Quality · MLS # · Address · City · Zip ·
Beds · Baths · SqFt · Lot SqFt · Year Built · DOM ·
Purchase Price · Estimated ARV (After Repair) ·
Rehab Cost (Light) · Rehab Cost (Heavy) · Holding Costs (3mo) ·
Total Cost (Light) · Total Cost (Heavy) ·
Gross Profit (Light) · Gross Profit (Heavy) · Max Offer ·
ARV Basis · Risks · MLS Link · First Added
```

New vs Layout B: **`DOM`** (days on market — a flag now, never a drop) and
**`Estimated ARV (After Repair)`** (what the property is worth once repaired),
plus `MLS #`, `Max Offer`, and `ARV Basis` (which comp band produced the ARV, so
a number can be audited without re-running comps).

- **De-dupes on `MLS #`**, falling back to Address+City. Safe to re-send a scan.
- **Auto-computed:** Total Cost (Light/Heavy), Gross Profit (Light/Heavy),
  Max Offer (`ARV − light rehab − holding − profit gate`), First Added. Send them
  only to override.
- **Accepts camelCase or literal header keys** — `dom`/`DOM`, `arv`/
  `Estimated ARV (After Repair)`, `price`/`Purchase Price`, etc. Money may be a
  string (`"$695,000"`); it is stored as a number.
- Run `setupSheet()` once to create and format the tab. An append onto a tab that
  has never been set up now builds the header automatically rather than failing.
- **In-sheet menu** (`⚡ Flip Scout`, appears after saving the script and reloading
  the sheet): Set up / repair sheet · Add a test lead · Remove test rows · Sort by
  profit · Remove duplicates · Remove unprofitable leads · Lead count ·
  Connection info (shows the deployed web app URL + whether the secret is still
  the placeholder) · Clear ALL leads. Destructive items confirm first, and any
  failure surfaces as a dialog with the real error text.

## B. "Property Review" (Layout B — legacy)

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
