# FlipScout boards — house photos and agent cards

The Test board (https://claude.ai/artifact/76sa8TSBhyMMiECccwQax9) shows each
lead's cover photo in its row, in the View panel and in the Acquisitions
detail. Clicking a photo zooms in on the board: the same photo about 960 px
wide, with the address and a link to every photo on the MLS listing (Seth,
20 Oct: zoom rather than leave the board).

Since 20 Oct the real board (https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1)
has the same photos, zoom, agent cards and agent photos (Seth: "put the
changes on the test artifact towards the real board"). Everything below
applies to both, with one difference: each board has its own asset store, so
each keeps its own `thumbs/index.js` (its `z` ids point into that board's
store). `agents.js` and `agphotos/` are the same files on both.

## Where the photos come from

`thumbs.py` reads the lead list out of the board's `data.js`. For each MLS #
it opens `https://www.mlslistings.com/Property/<MLS #>`, takes the cover photo
named in the page's `og:image` tag, and cuts it to a 112x96 tile. It asks the
host for a small copy where one exists (MLSListings, Paragon), so most
downloads are 4–15 KB.

- The page must be for the MLS # that was asked for. A redirect to the home
  page means the listing is gone and there is no photo.
- The page's street number must match the lead's. When it does not, the MLS #
  on the sheet is wrong, and the photo would show another house.
- An 8-digit bridgeMLS number with no board prefix is tried as BE, then EB,
  then CC. The page that matches the street number is recorded in `pg`. The
  board's MLS link for that lead uses it.
- Redfin-only leads (`RF…` and Redfin's own listing ids) have no MLS page and
  keep the house icon.

## What gets published

The tiles for one pull date go into one JPEG sheet, `thumbs/<date>.jpg`, 12
tiles per row. A board showing one day therefore downloads one picture.
`thumbs/index.js` maps each MLS # to its sheet and slot:
`window.__THUMBS__ = {w, h, cols, sheets: [[file, count]], at: {MLS: [sheet, slot]}, pg, miss, ph}`.

`miss` records leads with no photo: tries, last day tried, and why. A lead
with no MLS page is tried on 3 days, then left alone. A lead showing MLS's
"photos coming soon" picture is tried on 7 days, because its photos usually
follow within a week. A network error does not count as a try. `ph` lists
pictures seen on three or more listings: stand-ins, never the house.

## The zoomed photo

The large copy is not a published file: a version holds at most 511 files.
Each one is an asset in the board's asset store instead (5,000 files, 1 GB),
and `index.js` maps the MLS # to its asset id in `z`. The page shows it from
`/_blob/<id>`. A lead with a tile and no `z` entry shows its tile blown up,
and says so. `zmiss` records zoomed photos that failed, as `miss` does for
tiles.

`thumbs.py --zoom DIR` saves a zoomed photo (at most 960x640) as
`DIR/<MLS #>.jpg` for every new lead, and for every lead with a tile and no
`z` entry yet. DIR must be inside the working directory: files outside it
upload one per call. Upload them 25 a call with Artifact publish
(`asset: true`, `file_paths`). Then write each result line as
`<MLS #> <asset id> <bytes>` in a text file, and run
`python3 -I zoom_ids.py <out>/thumbs/index.js <ids.txt> --zoom DIR --delete`.
The byte count must match the file, so a line copied against the wrong file
is refused. `--delete` removes the recorded files, so whatever is left in
DIR still needs uploading.

At about 25 new leads a day, the 5,000-file limit is reached around March
2027. Before then, delete the assets of leads that are gone from `data.js`
(Artifact delete with `path` = the asset id) and drop them from `z`.

## Agent cards

The left menu's **Agent Relationships** (and each lead's View panel, and the
Agent box in Acquisitions) shows one card per listing agent: listings to us
(and how many are still active), in discussion (Juan interested, visit booked
or done, offer out), closed deals (Won), last contacted, follow-up, and a
history window with every listing and contact (Seth, 20 Oct).

- The page groups the leads into agents itself: same email, or same phone AND
  same name (an office line is shared by many agents), or a name alone when no
  other agent has it. A placeholder in the name column ("REDFIN") is not a
  person and makes no card. Two cards with the same name and a different
  email, phone and brokerage stay apart: nothing proves they are one person
  (20 Oct: only Michael Bardales, Twin Oaks and Compass).
- "Last contacted" is an email sent from the board, or a call, text or
  meeting logged on the card. Agent replies and REI BlackBook tags are left
  out on purpose until that is worked out (Seth, 20 Oct).
- Hot = a lead of theirs in discussion, or won. Warm = contacted in the last
  14 days. Cold = contacted before that. Not contacted = never.
- Follow-up dates and logged contacts are saved in the board's database
  under `agents/<id>` (`e-<email>`, `p-<phone>` or `n-<name>`). That is the
  team's own record: the refresh never touches it.
- The brokerage comes from `agents.js`, which `agents.py` writes from the
  sheet's "Listing Agent" column ("Name, Brokerage" — `data.js` keeps only
  the name): `window.__AGENTS__ = {v, built, bk: {MLS: brokerage}}`.
  "↻ Refresh from sheet" on the board also reads it for the person who
  pressed it.

## Agent photos

`agentphotos.py` takes each agent's photo from the "Listing Agent" box of the
public MLS page of their newest listing (up to 3 listings, until one has the
box): name, brokerage, license number and, when the agent has put one on
MLSListings, a photo. The box must name the same agent as the sheet (same
last name, or the same phone). The photo is cut to a 96x96 tile; tiles go into
`agphotos/a<day>.jpg` sheets of up to 120, and `agphotos/index.js` maps
`lic` (MLS # -> license) and `at` (license -> [sheet, slot]).

- Only MLSListings (ML) board agents have photos there: 130 of 1,331 agents on
  20 Oct (129 of 209 ML agents, none on BA, CC, EB, BE or SF). The rest keep
  their initials.
- The same license on two cards makes them one card (20 Oct: Michael
  Bardales, at Twin Oaks and then Compass). The card shows the license, and
  the newest listing's brokerage.
- A license with no photo is checked again after 30 days; a lead with no
  usable box is tried on 3 days. A flat grey silhouette is not a photo.
- Gravatar was tried and left out: 2 agents in 100 have one, and many are a
  pet, a flower or a logo.
- They are the agents' public MLS photos: private board only, never in git.

## Comps

The FlipScout app (v1.73+) values every A/B lead from sold homes on the MLS
and writes five columns at the end of the sheet's Leads tab: **ARV · ARV
$/SqFt · Comp Confidence · Comps · Comps Run On**. `comps.py` turns them into
`comps.js` for the board's comps table:

    python3 -I comps.py <prod sheet .xlsx> <out>/comps.js

`window.__COMPS__ = {v, built, by: {MLS: {arv, ppsf, conf, at, list}}}`, where
`list` holds up to 16 sold homes `{mls, addr, price, sqft, ppsf, sold, bd, ba,
yr, use, why}`, and `use: 1` marks the ones the ARV was taken from.

- **ARV** is the median $/sqft of the sold homes whose own remarks say the
  work was done (renovated, remodeled, 2+ finishes), multiplied by the lead's
  square feet. The sold homes must be in the same zip, listed in the last ~14
  months, and within ±20% of its size (widened to ±40% / ±60% only while
  fewer than 3 fit).
- **Confidence:** High = 5+ renovated sales inside ±20%. Medium = 3–4, or the
  band had to widen. Low = fewer than 3 renovated sales, so the ARV is the
  median of every sale that is not a fixer or a new build (rough: check it by
  hand).
- Leads without an ARV are left out of the file; the sheet's Comp Confidence
  says why ("None — no sold home within 60% of its size").
- Rehab, holding, selling costs and profit are **not** in this file. The board
  works them out from its own Settings (rehab $/sqft per county, light 70 /
  heavy 145 by default; selling costs blank until set, so profit reads
  "before selling costs").
- Every field is checked again here, as the app does: a hand-typed or
  cut-short Comps cell only ever reaches the page as numbers, dates and plain
  text.

## Public remarks and photo sheets (both boards)

The sheet has no public remarks, so the board only ever showed the agent-only
remarks (Seth, 20 Oct: the Contrarian read "no remarks" as a warning sign).
`listing.py` reads them off the same public MLS page `thumbs.py` uses:

    python3 -I listing.py <data.js> <out>/shared --thumbs <out>/<board>/thumbs/index.js --sheets <repo>/.sheets-upload-<board> [--since YYYY-MM-DD]

`remarks.js` is the same file on both boards; the photo sheets are not (each
board's asset ids differ). So run it once per board with the same
`<out>/shared`: the second run finds every remark on file and only makes that
board's sheets.

- `<out>/remarks.js` = `window.__REMARKS__ = {v, built, by: {MLS: text}, miss}`:
  the "About this Property" paragraph, for every lead with an MLS page. The
  board fills a lead's **Public remarks** from it when no scan brought them.
  Leads already in the file are not read again; a lead with no page or no
  remarks is tried on 3 days. 20 Oct: 1,567 of 1,821 leads (193 have no MLS
  page, 4 a page with no remarks, 57 are Redfin-only).
- `--sheets DIR` also makes one **photo sheet** per A/B lead still on the
  market that was pulled on or after `--since` (default: the 1st of this
  month — Seth, 20 Oct: every upload batch is a prompt for him, so only this
  month's leads get one): up to 12 of the listing's own gallery photos, 4 to
  a row, each numbered with its place in the gallery (`3/26`), photo 1 = the
  cover. It is the board's **All photos** button and what the Contrarian
  shows Claude. Upload DIR to THAT board's asset store 25 a call and
  record the ids with
  `python3 -I zoom_ids.py <out>/<board>/thumbs/index.js <ids.txt> --zoom DIR --delete --key cs`
  (same `<MLS #> <asset id> <bytes>` lines and byte check as the zoomed
  photos). `index.js` keeps them in `cs` (MLS # -> asset id), `csn`
  (MLS # -> [photos on the sheet, photos in the gallery]) and `csmiss`
  (sheets that could not be made: no MLS page, no gallery). 20 Oct, Test
  board: 479 sheets (345 for October leads; 134 older ones uploaded before
  the this-month rule). 21 Oct, real board: 337 sheets, October leads only.
- Run it after `thumbs.py`: both rewrite `thumbs/index.js`, and each keeps the
  other's keys.

## Permit history (both boards)

`permits.py` reads each A/B lead's own Redfin page (Redfin's location lookup,
kept only when the page's house number and zip are the lead's) and every permit
card on it; `permits.js` is the same file on both boards:

    python3 -I permits.py <data.js> <out>/shared [--gap 1.5]

`<out>/permits.js` = `window.__PERMITS__ = {v, built, by: {MLS: {u, at, p: [{d, st, w, t, g}]}}, miss}`.
The board shows them as **Permits** in the lead's panel, marks "past fire" and
"not final", and the Contrarian turns them into points (a past fire is a point
for Seth and Bryan, never a drop — 6225 Tevis St had one in 2014). A house is
looked up again after 30 days; one with no Redfin page is tried on 3 days. One
request at a time, `--gap` seconds apart; after 2 refusals in a row (403/429 or
a captcha page) it stops and saves, and the next run carries on. 20 Oct: 761
of 790 checked in 51 minutes, 501 with permits, 260 with none, Redfin never
refused.

## Daily refresh

Steps 1–3 run once per board, each in its own out dir and its own upload
folder (`<repo>/.zoom-upload-real`, `<repo>/.zoom-upload-test`); steps 4–5
run once; steps 6–8 cover both boards (since 21 Oct the real board has the
Contrarian too).

1. Read that board's live `thumbs/index.js` (Artifact read, path
   `thumbs/index.js`) into `<out>/<board>/thumbs/index.js`.
2. Run `python3 -I thumbs.py <new data.js> <out>/<board> --zoom <repo>/.zoom-upload-<board>`.
   It fetches only the leads that are not in the index yet, plus zoomed
   photos still missing. Then it writes the new sheet(s) and a new
   `index.js`.
3. Upload the zoomed photos to THAT board's asset store and record their ids
   (above).
4. Run `python3 -I agents.py <prod sheet .xlsx> <out>/agents.js` and
   `python3 -I comps.py <prod sheet .xlsx> <out>/comps.js`.
5. Read the Test board's `agphotos/index.js` into `<out>/agphotos/index.js`,
   then run `python3 -I agentphotos.py <new data.js> <out>`. It looks up only
   agents it has not settled yet, and prints NEW FILES.
6. Read the Test board's live `remarks.js` and `permits.js` into
   `<out>/shared/` (a first run starts without them). Then, after step 2, run
   `python3 -I listing.py <new data.js> <out>/shared --thumbs <out>/<board>/thumbs/index.js --sheets <repo>/.sheets-upload-<board>`
   once per board (only this month's leads get a sheet), and
   `python3 -I permits.py <new data.js> <out>/shared` once.
7. Upload each `<repo>/.sheets-upload-<board>/*.jpg` to that board's asset
   store, 25 a call, and record them with `zoom_ids.py … --key cs --delete`
   (above). At about 15 new October-style sheets a day on top of the zoomed
   photos, watch the 5,000-file limit.
8. Publish each board's live page with `data.js`, `agents.js`, `comps.js`,
   `remarks.js`, `permits.js`, its own `thumbs/index.js` and new sheets, and
   the agentphotos NEW FILES. Files left out of a publish are kept, so earlier
   sheets stay.

The photos are listing photos. Keep them on the private board only: never in
git, and never on a shared page.
