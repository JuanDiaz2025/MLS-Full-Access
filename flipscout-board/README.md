# FlipScout Lead Board

A published board of every MLS lead in the acquisitions sheet, grouped by the
date it was pulled. The team works it directly: set a status, remove a lead,
restore one.

- **Board:** https://claude.ai/code/artifact/864f77f8-9101-43d3-a7c8-c50e1872478c
- **Source sheet:** `1DAZ_FrU_I8Yh2cKpa10U05EueLl7ctrBlVi6eFErXGQ`, the **Leads** tab
- **Refreshed:** daily at 11:00 Pacific by the "FlipScout board — daily 11am refresh" Routine

## The one thing to get right

Lead data and team edits live in two different places, on purpose:

| | Lives in | Changed by |
|---|---|---|
| Leads (address, price, $/SqFt, DOM, notes) | `data.js`, rebuilt from the sheet | this refresh |
| Statuses and removals | the artifact's own database, keyed by pull date + MLS # | the team, in the board |

Rebuilding `data.js` therefore **cannot** disturb the team's work. That
separation is the whole point — an earlier version kept edits in the browser
and lost them on every update.

## Refreshing it

1. Export the sheet as xlsx (`download_file_content` with mime type
   `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
   Export the workbook, not a CSV — CSV only carries the first tab.
2. `python3 flipscout-board/build_data.py leads.xlsx flipscout-board/data.js`
3. Publish `flipscout-board/index.html` with `data.js` alongside it, passing the
   board URL above so it updates in place instead of creating a second board.

`build_data.py` stops rather than guessing if the Leads tab's columns change,
so a reshaped sheet fails loudly instead of publishing a board built from the
wrong fields.

## Before publishing, diff it

Compare the new build against the published `data.js` and say what moved:
leads added, leads that vanished from the sheet, fields edited on existing
leads. A refresh is normally purely additive — anything else is worth a look
before it reaches the team.
