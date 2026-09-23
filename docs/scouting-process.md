# Fixer-Scouting Process

Rules live in `CLAUDE.md` / `docs/flip-scout-SOP.md`. This is the 9-step run order.
Steps 1-3a and 6-7 are Node scripts; steps 4-5 need Claude's own vision/reading
(a plain script can't judge renovated-vs-fixer), so the pipeline runs in two
script stages with the agent doing the photo/profile calls in between.

**Runs hourly and incremental.** San Francisco is scanned FIRST (it leads
`DEFAULT_CITIES`), then the rest of the buy box. Step 3a drops every MLS # the
ledger has already seen, so each run only pays for genuinely new listings — a
property checked yesterday or earlier is never checked again.

1. **Login** — `bash scripts/setup-browser.sh`, then `MLS_USER=… MLS_PASS=… node scripts/mls-login.js`. Re-login if the session dies (saves `.mls-state.json`).
2. **Scan** — `CITIES="Alameda:Oakland;Contra Costa:Richmond;…" node scripts/mls-multi-scan.js` → `multi-scan.json`. Matrix: Active · SFR · ≤ cap ($2.0M Peninsula, else $1.5M) · **any DOM** (no List Date filter; set `DAYS=45` to restore the old window).
3. **Filter** — `MODE=filter node scripts/mls-flipscout.js` → `.mls-artifacts/candidates.json` (below-market $/sf + old; drops new builds and large-home $/sf traps — the DOM>45 drop is removed for now).
3a. **Skip already-checked (do this BEFORE any photo work)** — `node scripts/mls-ledger.js filter .mls-artifacts/candidates.json` rewrites the file with only MLS #s absent from `data/scanned-ledger.json`. Everything seen on an earlier run is dropped here so steps 4-7 never re-do work. If this leaves 0 rows, the run is done — say "no new listings" and stop.
4. **Photo-verify (Rule #2)** — `MLS_LIST="mls1,mls2,…" node scripts/mls-photo-sheet.js` renders a full-gallery contact sheet per listing to `.mls-artifacts/sheets/<MLS>.png` (pulls EVERY photo from the results-row `ImageViewerLightbox()` call, not the lazy report thumbnails). **The agent then opens each sheet and judges** — drop renovated/multi-unit/exterior-only. **Clean-but-dated is a KEEP, not a drop** (judge the finishes, not the housekeeping — see CLAUDE.md Rule #2). Survivors → `.mls-artifacts/keepers.json` (`[{mls,addr,city,price,sqft,bds,age,dom}]`).
5. **Profile-verify** — `MLS_LIST="…" node scripts/mls-profile.js` → `.mls-artifacts/profiles-out.json` (zip + remarks + tenant/fire/multi-unit/probate flags). Drop: renovated · tenant-occupied · multi-unit/duplex/2nd-unit · vacant lot · fire-damaged. (DOM is no longer a drop — flag a long one instead.)
6. **Comp/math** — build `.mls-artifacts/comp-jobs.json` (`[{mls,zip,sf}]`) from keepers+profiles, then `node scripts/mls-comps.js` → `comps-out.json`. ARV = median $/sf of SOLD SFR in the ZIP, listed last ~14mo, within ±20% sqft (widen ±40/±60 if <3) × sqft. (The List-Date range is REQUIRED — without it a Sold search hits MLS's 2500+ cap and the zip filter silently fails.)
7. **Score/Label** — `MODE=score node scripts/mls-flipscout.js` → `.mls-artifacts/leads.json`. Rehab Light $70/sf, Heavy $145/sf; holding = financing + insurance + tax + $400; gate (Light): ≥$1M→$100k, $500k–1M→$70k, <$500k→$50k. Clears Light = Marginal, clears Heavy too = Strong Deal. Flags loss-profile (premium + heavy rehab).
8. **Output — spreadsheet FIRST** — only leads that clear the gate. Append to the Property Review sheet before writing any summary: POST `{secret, lead}` to the Property Review Apps Script (or the Flip Scout feed `leads_for_sheets.json`, which the sheet's Apps Script pulls + de-dupes by Redfin URL). Every lead carries a concrete "verify X before offering."
9. **Record + commit the ledger** — `node scripts/mls-ledger.js record .mls-artifacts/candidates.json checked`, then `git add data/scanned-ledger.json && git commit && git push`. **Not optional:** the container is ephemeral, so an uncommitted ledger is lost and the next hourly run re-checks every listing from scratch. Record all candidates that reached step 4, dropped ones included — a dropped listing must not come back either.
