# Flip Scout Leads — Spreadsheet SOP

How the **Flip Scout Agent** Google Sheet works: where leads come from, what every
**Flip Scout** menu button does, what the columns mean, and the day-to-day routine.

---

## 1. The big picture — how a lead reaches this sheet

The sheet does **not** search for houses itself. It's the last stop in a pipeline:

```
Scanner agents (MLS full-buy-box scan + Redfin scan)
        │  photo-verify → comp → score → keep only qualifiers
        ▼
leads_for_sheets.json   ← a feed file on GitHub (the "inbox")
        │  Flip Scout menu → Refresh (or the hourly auto-refresh) pulls it
        ▼
"Flip Scout Leads" tab   ← this sheet, one row per lead
```

- **The feed is the source of truth for incoming leads.** The scanners write only
  genuine, gate-clearing fixers into `leads_for_sheets.json`.
- **The sheet pulls from that feed** — it never edits the feed. Refreshing appends
  new leads and (now) removes any the scanners have marked disqualified.
- **De-duplication is by Redfin link.** A still-active listing is never added twice,
  no matter how many times you refresh.

---

## 2. The tabs

| Tab | What it is |
|---|---|
| **Flip Scout Leads** | The working list — one row per qualifying lead. Row 1 is a frozen header. |
| **KPI** | Auto-updated scoreboard (kept / added / rejected / removed). Never edit by hand. |
| **Rejected (do not edit)** | Hidden. Stores the Redfin URLs you've rejected so they never come back. Managed by the script. |

---

## 3. The Flip Scout menu — what each button does

Open it from the menu bar: **Flip Scout ▾**

| Button | What it does | When to use it |
|---|---|---|
| **Refresh Now** | Pulls the latest feed and **appends new** qualifying leads (dedup by Redfin link). Removes any lead the scanner flagged *disqualified*. Emails you if anything new landed. | Any time you want the newest leads immediately. |
| **Resync Existing Leads** | Re-pulls the feed and **updates the numbers on rows you already have** — ARV, rehab, profit, recommendation, risks — without adding or reordering. Keeps each row's original "First Added" date. Rows no longer in the feed are left untouched. | After the model or a listing's price changes and you want existing rows refreshed. |
| **Reject Selected Lead(s)** | Select one or more rows first, then run this. **Deletes those rows and permanently excludes them** — their Redfin URLs go to the hidden Rejected tab so a future refresh never re-adds them. | A lead you've reviewed and don't want (bad location, seen it, not a real fixer). |
| **Clear All Leads** | Deletes **every** lead row (keeps the header). Does *not* touch the Rejected list. | Rare — start the list fresh, then Refresh to repopulate. |
| **Remove Non-Profitable Leads** | Deletes every row whose **Gross Profit (Light) ≤ 0**. Counts them in the KPI "removed" tally. | Quick cleanup of rows that no longer pencil. |
| **Show KPI Tab** | Recomputes and jumps to the KPI scoreboard. | Check totals at a glance. |
| **Send Test Notification** | Sends a sample lead email to the notify address, to confirm email works. | One-time, after setup. |
| **Enable Hourly Auto-Refresh** | Installs a time trigger that runs **Refresh Now every hour** on its own, and emails you when new leads land. | Set once for hands-off operation. |
| **Disable Auto-Refresh** | Removes that hourly trigger. | Pause automatic pulls. |

> **The one-time setup:** run **Enable Hourly Auto-Refresh** once. From then on the
> sheet fills itself every hour and emails you new leads — no clicking required.

---

## 4. The columns (and the deal model behind them)

Header order on the Flip Scout Leads tab:

`Score · Recommendation · Address · City · Zip · Beds · Baths · SqFt · Lot SqFt ·
Year Built · Purchase Price · Estimated ARV · Rehab Cost (Light) · Rehab Cost (Heavy) ·
Holding Costs (3mo) · Total Cost (Light) · Total Cost (Heavy) · Gross Profit (Light) ·
Gross Profit (Heavy) · Risks · Redfin Link · First Added · Flip Quality`

| Column | Meaning |
|---|---|
| **Score** | 1–10 quick rank (higher = stronger spread). |
| **Recommendation** | `Strong Deal` (clears the profit gate even under a *heavy* rehab) or `Marginal` (clears only under a *light* rehab). |
| **Estimated ARV** | After-repair value = median $/sqft of size-matched recent **sold** comps in the ZIP × the home's sqft. |
| **Rehab Cost (Light / Heavy)** | Light = **$70/sqft** (cosmetic). Heavy = **$145/sqft** (full gut) + itemized add-ons. |
| **Holding Costs (3mo)** | Financing (10%/yr prorated) + insurance ($2k per $1M) + property tax (1.25%/yr prorated) + $400 utilities. |
| **Total Cost (Light / Heavy)** | Purchase + that rehab + holding. |
| **Gross Profit (Light / Heavy)** | ARV − Total Cost. **A screen, not final profit** — it still has to absorb closing, commissions, permits, and surprises. |
| **Risks** | Free-text cautions (e.g. "verify tenant occupancy," "multi-unit — verify permits"). `None` when clean. |
| **Redfin Link** | The listing; also the de-dup key. |
| **First Added** | When the sheet first saw this lead (stays fixed on resync). |
| **Flip Quality** | `Good Flip` / `Thin Flip` / `Flip W/ Caution` / `Negative`. |

**The profit gate (applied under the Light rehab):** ARV ≥ $1M needs ≥ **$100k**;
$500k–$1M needs ≥ **$70k**; under $500k needs ≥ **$50k**. Clears under Light =
*Marginal*; clears under Heavy too = *Strong Deal*. Only gate-clearing leads reach
the feed, so everything in the sheet has already passed step one.

> **Row colors are yours, not the script's.** The Apps Script never colors rows —
> any green/yellow highlighting is your own manual status marking (e.g. green = actively
> pursuing, yellow = contacted / offer out). Adopt one convention and keep it consistent.

---

## 5. Recommended day-to-day routine

1. **Once:** Flip Scout → **Enable Hourly Auto-Refresh**, then **Send Test Notification**
   to confirm email works.
2. **Each morning (or when an email lands):** open the sheet. New leads are already
   appended and highlighted by their `First Added` date.
3. **Triage each new lead:** open the Redfin link, sanity-check the ARV comps and the
   `Risks` note. Do NOT treat Gross Profit as final — it's a screen.
4. **Reject what you don't want:** select the row(s) → Flip Scout → **Reject Selected
   Lead(s)**. They're gone for good and won't resurface.
5. **Mark what you're pursuing** with your color convention and add the agent/offer
   notes in the trailing columns.
6. **Occasionally:** **Remove Non-Profitable Leads** to clear rows that slipped below
   $0, and **Show KPI Tab** to see totals.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Refresh says "Could not fetch leads feed (HTTP …)" | The feed URL's branch/file moved. Update `FEED_URL` at the top of the Apps Script (Extensions → Apps Script). |
| Refresh runs but adds nothing | Normal — no *new* qualifying leads since last pull. Existing rows and the Rejected list are respected. |
| A rejected lead came back | It shouldn't — rejection stores the Redfin URL permanently. If it reappears, its Redfin URL changed; reject the new row too. |
| Numbers look stale on old rows | Run **Resync Existing Leads** to pull the latest ARV/profit/risks onto existing rows. |
| A lead is really multi-unit / renovated | Reject it here, and it's also excluded upstream once the scanner marks it disqualified in the feed. |
| No emails | Check the notify address in the Apps Script (`NOTIFY_EMAIL`) and run **Send Test Notification**. |

---

## 7. What feeds the sheet (the upstream, for reference)

- **MLS full-buy-box scan** (this repo): logs into MLS hourly, scans SF · the whole
  San Mateo/Peninsula · Sunnyvale · San Jose · Oakland · Berkeley · San Leandro ·
  Hayward · Richmond (Active · SFR · any days on market; Peninsula ≤ $2.0M, else ≤ $1.5M),
  photo-verifies every candidate, comps + scores, and writes qualifiers to the feed.
- **Redfin scan** (the Flip Scout Agent repo): independent scan across the same buy
  box, also writing to the feed.
- Both write to the **same `leads_for_sheets.json`**, deduped by Redfin link — so the
  sheet is the merged, de-duplicated view of everything both pipelines found.

The sheet is the human surface; the scanners + this menu do the rest.
