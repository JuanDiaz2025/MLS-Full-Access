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

## Google Chat alerts ("FLIPSCOUT NEEDS JUAN")

`../alerts.py` picks the leads whose offer deadline is under a day away and
writes one Chat message; the checks run at **8:00, 11:15 (after the refresh)
and 15:00 Pacific**. Safety rules — a lead alerts only if it is an A lead,
still Active on the MLS, not passed / won / removed / muted on the board, and
has a real offer date (TBD and weekday guesses never alert). At most two alerts
per lead (inside 24h, then a final call inside 5h), at most 5 leads per
message, nothing sent when nothing is due.

1. Read the Test board's `edits` and `alerts` collections (ArtifactData) into
   `state.json` as `{"edits": {doc_id: data}, "alerts": {doc_id: data}}`.
2. `python3 flipscout-board/alerts.py flipscout-board/test/data.js state.json`
3. If `text` is not empty, POST `{"text": text}` to the webhook in
   `$FLIPSCOUT_CHAT_WEBHOOK`, then update `alerts/<MLS>` with
   `{<stage>: <now ISO>}` for every entry in `record`.

The webhook URL is a secret: it lives in the environment variable
`FLIPSCOUT_CHAT_WEBHOOK`, never in git or on the board. The board's
🔔 Mute alerts button writes `alerts/<MLS>.muted`.
