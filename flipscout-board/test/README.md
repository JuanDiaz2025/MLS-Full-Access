# FlipScout Test board — house photos

The Test board (https://claude.ai/artifact/76sa8TSBhyMMiECccwQax9) shows each
lead's cover photo in its row, in the View panel and in the Acquisitions
detail. Clicking a photo opens the public MLS listing with every photo.

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

## Daily refresh

1. Read the live Test board's `thumbs/index.js` (Artifact read, path
   `thumbs/index.js`) into `<out>/thumbs/index.js`.
2. Run `python3 -I thumbs.py <new data.js> <out>`. It fetches only the leads
   that are not in the index yet, then writes the new sheet(s) and a new
   `index.js`.
3. Publish the live page with `data.js`, `thumbs/index.js` and the new sheets.
   Files left out of a publish are kept, so earlier sheets stay.

The photos are listing photos. Keep them on the private board only: never in
git, and never on a shared page.
