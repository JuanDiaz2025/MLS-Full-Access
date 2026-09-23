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

Deadlines are also read out of listing remarks automatically. `build_data.py`
scans the Notes column (and an `Agent Remarks` column, if the pull ever adds
one) and puts what it finds on the row, where the board shows it labelled
"read from MLS remarks". Typing a date on the board replaces it; clearing a box
that had a read date records "no deadline" rather than falling back to the
remarks again.

Two rules keep the parser from inventing deadlines, and they are the part to
preserve if you touch it:

- a date counts only when it FOLLOWS a phrase about offers, so a closing date
  or an open-house time in the same remarks is never mistaken for one;
- a weekday with no date ("offers due Thursday") is resolved against the pull
  date and returned with a leading `~`, which the board renders as `≈ confirm`.
  It is a reading, not a fact, and it is labelled as one.

Anything ambiguous returns empty. An empty cell someone fills in beats a
confident wrong date somebody plans around. `python3 -c` the module and feed
`parse_offer_due` new phrasings before trusting it on a new remark style.

**As of now this yields nothing**, because the pull does not carry listing
remarks into the sheet. The parser is the half that cannot be done later;
getting remarks into the Notes column is the half that unlocks it.

And that half is nearly done already. `scripts/mls-profile.js` on branch
`claude/navigation-link-training-l0d5a3` — run hourly by the "Hourly
full-buy-box fixer scan" Routine, against a live MLS session — already scrapes
both Public Remarks and Agent Remarks off each listing detail page:

    const pub   = grab(/(?:Public Remarks?|Marketing Remarks?|...)/i);
    const agent = grab(/(?:Agent Remarks?|Confidential Remarks?|...)/i);

It then uses them only for keyword flags (TENANT?, FIRE, MULTIUNIT?) and drops
the text. Carrying `agent` (falling back to `pub`) through to the sheet's Notes
column is the entire remaining step: no new login automation, no new
credentials, and deadlines start appearing on the board the next morning.

That change belongs on the branch that owns the scraper, not this one.

### Refresh timing

The 11:00 refresh is a snapshot. The hourly scan keeps adding leads through the
day, so anything added after 11:00 waits for the next morning — on 2026-09-16
the run at 11:07 correctly found nothing and the day's 11 leads landed later.
A second run in the late afternoon would close most of that gap.

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

## Leads from the FlipScout app ("Add scan")

The Google Sheet is no longer the source of new leads. The FlipScout desktop app
(1.32.0+) writes each day's kept leads — address, price, both sets of remarks,
the offer deadline and the phrase it was read from — to
`Documents/FlipScout/FlipScout-scan-<date>.json` and copies it when a run ends.
**Add scan** on the board takes that text or file, previews what is new, and
stores it in the artifact's database under `scans/`, 40 leads per document
(each document stays well under the 256 KB limit).

- An MLS # appears on the board once: `data.js` history first, then the
  earliest scan. Pasting the same scan twice adds nothing.
- Scan leads carry `offerDue` from the app, shown as "read from agent
  remarks" (or wherever it was read) with the phrase on hover; a weekday-only
  reading is marked ≈ as before.
- Every field of a stored scan is re-checked on read — the database is written
  by whoever pastes, so it is data, not trusted input.
- `data.js` is now frozen history. The daily refresh routine can keep running
  (it only rebuilds `data.js`), but nothing new reaches the sheet.
