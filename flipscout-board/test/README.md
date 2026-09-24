# FlipScout Board — Test copy

The team's sandbox for the Lead Board. The real board (see `../README.md`) is
left as it is, as the backup; changes are tried here first.

- **Page:** https://claude.ai/artifact/76sa8TSBhyMMiECccwQax9 — this folder's `index.html`
- **Data:** the same `data.js` the real board uses, built by `../build_data.py`
  from the prod sheet's **Leads** tab (`1DAZ_FrU_I8Yh2cKpa10U05EueLl7ctrBlVi6eFErXGQ`)
- **Refreshed:** daily at 11:00 Pacific by the "FlipScout Test board — daily
  11am refresh" Routine

## What this page adds over the real board

- Agent phone and email with Copy buttons, the listing agent's name
- MLS ↗ link (`https://www.mlslistings.com/Property/<MLS#>`) and the MLS status tag
- Offer due with its time and the sentence it was read from; "offer date TBD"
- "read from agent remarks ›" opens a side panel with the full agent remarks,
  the offer sentence highlighted, showing instructions, bucket and score
- Bucket and score (A / B / C) from the app's qualification gate; A first
- **Show** quick views: Work now · Offers due in 3 days · To review (B) ·
  Pending · Sold / off market · Everything
- **Area** filter: all areas, each county, each city
- **Pass with a reason**: picking Pass asks for an optional reason, saved with
  the pass in the board database and shown under the status and in the side panel

All of it comes from columns the FlipScout app writes at the end of the Leads
tab. `build_data.py` appends them after the eleven columns the real board
reads, so the real board ignores them and a rebuild cannot change it.

## Refreshing it by hand

1. Export the prod sheet as xlsx (Google Drive `download_file_content`,
   `exportMimeType` = the xlsx type). Export the workbook, not a CSV.
2. `python3 flipscout-board/build_data.py leads.xlsx flipscout-board/test/data.js`
3. Diff against the published `data.js` (leads added / gone / changed), then
   publish `flipscout-board/test/index.html` with `data.js` alongside it to the
   page URL above, so it updates in place.

## Refresh from sheet (the Board's own button)

"↻ Refresh from sheet" reads the prod sheet through the viewer's own Google
Drive connector (the page declares `mcp: Google Drive · download_file_content`),
rebuilds the rows exactly as `build_data.py` does (checked identical on all 896
leads, 24 Sep) and saves them under `sheet/` (`c0…cN` chunks of 40, then
`meta`) so every viewer switches to the same list. The newer of data.js
(`built`) and `sheet/meta.at` wins. Same safety stop as the daily build: more
than 20 leads gone, or the columns changed, and nothing is replaced.

## Passes

- A Board status always wins. With none, a lead whose sheet Notes start with
  PASS / passing / rejected shows as Passed (the app's own rule).
- "Pass ↗" in the Pass box opens the Apps Script web app, which writes
  `PASS (Board) — who, date: why` at the front of the lead's Notes. Moving it
  off Pass offers "Take it off ↗" (action=unpass). "Board only" skips the sheet.
- Every Board change says "Saving…" and then "✓ … saved" only once the shared
  board confirms it. A lead with no First Added date cannot hold a status
  (edits are keyed by pull date) and says so.

## Google Chat alerts — Apps Script in the prod sheet

`../apps-script/flipscout-alerts.gs`, pasted into the prod sheet next to the
rejections script. It runs on Google's servers, needs no Claude session:

| Pacific | Chat message |
|---|---|
| 8:00 | 📅 OFFERS DUE IN 3 DAYS (same list as the Board button), then 🚨/🔴 alerts |
| 11:15, 15:00 | 🚨 NEEDS JUAN (under 24h) · 🔴 FINAL CALL (under 5h) — only when due |

Alert rules: A lead, MLS Status Active, Notes not PASS and no "no alerts", a
real offer date, at most two alerts per lead, five leads per message.
The webhook lives in Script Properties (`CHAT_WEBHOOK`), never in git.
Menu "🚨 FlipScout Alerts": Check now · Preview · Send morning summary now ·
Send test message. Trigger code runs as saved ("Head"); only a change to
`doGet` needs Deploy → Manage deployments → Edit → New version (same URL).

To stop the alerts for one lead, put "no alerts" in its Notes on the sheet
(or pass it). The board's old 🔔 Mute button was removed on 24 Sep: it saved
in the board database, which the Apps Script cannot read.
