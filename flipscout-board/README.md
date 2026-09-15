# FlipScout Lead Board

A published board of every MLS lead in the acquisitions sheet, grouped by the
date it was pulled. The team works it directly: set a status, remove a lead,
restore one.

Two screens, switched in the header:

- **Leads** — the list for the selected pull date, in three parts: the working
  list on top, then **Passed**, then **Removed**. A lead marked Pass drops out
  of the working list the moment it is set, but stays visible below so it can
  be found and reopened; only Remove takes it out of the count of live leads
  alongside Pass.
- **KPI** — the pipeline counted by status, by pull date, and by teammate,
  plus every offer deadline soonest-first. Deep-links as `#kpi`, so it can be
  bookmarked and shared on its own.

### Offer deadlines

The sheet has no offer-due field, so the team sets one per lead in the **Offer
due** column on the Leads screen. It saves to the artifact database like a
status, so it is shared and survives every refresh. Chips read from the
viewer's own calendar — "2 days late", "due today", "in 6 days" — and the KPI
screen lists every dated lead soonest-first.

Passed and removed leads are left out of that list: neither has an offer left
to get out the door.

If an offer-due column is ever added to the Leads tab, add it to `FIELDS` in
`build_data.py` and carry it onto the row; the board should then prefer the
sheet's value and let a board-entered date override it.

Each screen keeps its own pull-date scope: Leads opens on the newest pull, KPI
on all dates (a single day's pull is always ~0% worked, which tells you
nothing).

- **Board:** https://claude.ai/code/artifact/864f77f8-9101-43d3-a7c8-c50e1872478c
- **Source sheet:** `1DAZ_FrU_I8Yh2cKpa10U05EueLl7ctrBlVi6eFErXGQ`, the **Leads** tab
- **Refreshed:** daily at 11:00 Pacific by the "FlipScout board — daily 11am refresh" Routine

## The one thing to get right

Lead data and team edits live in two different places, on purpose:

| | Lives in | Changed by |
|---|---|---|
| Leads (address, price, $/SqFt, DOM, notes) | `data.js`, rebuilt from the sheet | this refresh |
| Statuses and removals | the artifact's own database, keyed by pull date + MLS # | the team, in the board |

Every number on the KPI screen is counted live from those two sources at render
time. Nothing is precomputed, so the KPI screen cannot drift from the board.

The status colours in `--m-*` were checked for colour-blind separation; if you
restyle them, re-check rather than eyeball, and keep the labels — the pipeline
bar must never rely on colour alone.

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
