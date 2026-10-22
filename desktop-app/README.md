# FlipScout Desktop

A Windows desktop app to run the MLS fixer-flip scan yourself: sign in, scan your
buy box, photo-verify each candidate (Keep/Drop with Pause/Resume), and get a
priced deal report you can export.

It's an **Electron** app — Electron *is* Chromium, so the app drives MLS in its
own window. No separate browser download, and on a normal home/office network
none of the cloud-sandbox proxy/TLS workarounds are needed.

## Requirements
- Windows 10/11
- [Node.js 18+](https://nodejs.org) (LTS) — includes npm

## Run it (development)
```bash
cd desktop-app
npm install
npm start
```

## Build the .exe
```bash
cd desktop-app
npm install          # first time only
npm run dist         # -> dist/FlipScout-1.0.0.exe  (installer)
# or a no-install single file:
npm run dist:portable
```
The finished installer/portable exe lands in `desktop-app/dist/`. Double-click to
install (creates a desktop shortcut) or run the portable exe directly.

## Using it
1. **Sign in** — type your MLS username/password, click **Open MLS sign-in**. The
   MLS window opens; finish sign-in and any 2FA there yourself, then click
   **Check session** (it confirms you reached the dashboard).
2. **Pick your areas, then Start scan** — tick only the areas you want in
   section 3 (All / None / San Francisco only shortcuts are there, and the choice
   is remembered). The full box is the whole Bay Area — San Francisco · San Mateo
   @ $2.5M · Santa Clara · Alameda · Contra Costa · Marin · Sonoma · Napa · Solano,
   every city in each; Active ·
   Single-Family · **45 days on market or less** · 25+ years old). After the first
   pass each run is incremental — listings already checked are skipped outright,
   so day two only costs you the new ones.
3. **Qualification gate** — each candidate's report (public + private remarks,
   original vs list price, listing agent) and full photo gallery are read, and it
   gets an **Opportunity Score (0–100)** and a bucket:
   - **A — Work Now** (70+): strong distress / value-add signals
   - **B — AI Review** (35–69): plausible, not obvious — worth a deeper look
   - **C — Auto-Pass** (under 35, or renovated / multi-unit / fire / structural /
     too few photos): never reaches the board; logged on **Rejected** with the
     score and the reason.
   Tenant-occupied is a **drop** (Juan doesn't buy them), unless the listing says it
   is delivered vacant at close — then it stays, with "confirm with the agent" in
   the Why. The run never
   stops to ask. With an API key and **Use AI vision** ticked, the AI also judges
   the photos and can turn a keep into a C. **Claude only**: a Claude key
   (`sk-ant-…`, from console.anthropic.com → API Keys; default model
   `claude-opus-5-5`, `claude-sonnet-5-5` is cheaper). ChatGPT keys are refused. Press
   **Test key** before a scan. The key is saved on this computer only. A failed
   AI call never drops a listing: the text rules decide and the log says why,
   and after 3 failures in a row the run carries on without AI.
4. **Comps** (v1.73, section 3's **Run comps on A/B leads**, on by default) —
   for every A/B lead the app searches the MLS for **Sold** single-family homes
   in its zip listed in the last ~14 months, takes the ones within ±20% of its
   square feet (±40%, then ±60%, only while fewer than 3 fit), reads the remarks
   of the 8 nearest in size and sets the **ARV** = median $/sqft of the ones
   whose remarks say the work was done (renovated / remodeled / 2+ finishes) ×
   the lead's square feet. Confidence: **High** = 5+ renovated sales inside ±20%
   · **Medium** = 3–4, or the band had to widen · **Low** = fewer than 3
   renovated, so every sale that is not a fixer or a new build was used. No
   sold homes → no ARV, and Comp Confidence says why. About a minute per lead;
   sold homes already read are cached (`comps-cache.json`, 180 days). The
   **Lead Board** does rehab, holding, selling costs and profit from its own
   Settings, so the app no longer filters leads on a profit gate. **Export** to
   CSV or JSON.
4b. **Second look** (v1.74) — a listing the gate scores **C on a low score**
   is not dropped when we bought a house in the **same city**, within **40%** of
   its price, and **made money** on it: it goes to the sheet as **B**, its Why
   starting `SECOND LOOK — we made +$127k on 1202 Via Lucas, San Lorenzo …`,
   and gets the AI photo check like any other B (which can still drop it). A
   loss among those deals means no second look. Hard exclusions — renovated,
   fire, tenant, multi-unit, structural, too new, too few photos — and the buy
   box are never overruled. The deals come from a **`Past Deals`** tab on your
   sheet: `Address · City · Bought · Sold · Net` (+ optional `Bought On · Sold
   On · Status · Notes`), one row per house we bought and sold. Only rows with
   Bought, Sold and Net all filled in count, bought at $1.5M or less; a Status
   other than Sold, or a note saying the status is unresolved, leaves a row
   out. No tab = no second look, and the log says so at the start of the scan.
4c. **Refresh re-checks passed leads and comps older ones** (v1.74.1) — **↻ Refresh
   leads on the board** now also re-reads every lead **passed in Notes** that is
   still on the market and was added in the last 120 days (price and status
   only, right after the A leads). A price **10% or more under the sheet's
   Purchase Price**, or a lead passed as sold / pending / off-market that the MLS
   shows **Active** again, puts `PRICE CUT AFTER PASS — $1.40M → $1.00M (−29%),
   now Pending: look again` (or `BACK ON THE MARKET AFTER PASS …`) in front of its
   Why, and the end of the Refresh lists them. Notes are never touched. It also
   **comps up to 25 live A/B leads that have no ARV yet**, A first (the same
   comps as a scan, the same "Run comps" box); a lead that found no comps is
   tried again after 14 days, and comps cut short by Stop are not saved.
4d. **Empty private remarks stay empty** (v1.74.2) — when the Agent Full report's
   **Private:** field was empty, the old reader took the next line, the section
   heading **"Showing & Location"**, and saved it as the remark (51 rows by 21
   Oct). It now reads the remark from the label's own line, and an empty field
   stays empty. **↻ Refresh** clears that heading from the rows: the ones it
   re-reads get their real remark (and any offer date in it), the rest are
   emptied without an MLS lookup.
4e. **Cover photos for leads the public site does not show** (v1.74.3) — the
   boards take each house photo from the public mlslistings.com page, and about
   50 live leads have none there (the seller kept the listing off the public
   site, or it was pulled). For exactly those, the scan and **↻ Refresh** save
   the listing's cover photo from the MLS in a new **Photo** column at the end
   of the Leads tab: a small copy (about 480 px, under a cell's 50,000
   characters). Leads whose public page has a photo get nothing in that column.
   (v1.74.4: v1.74.3 saved the photo's address when it opened without the MLS
   sign-in, but it opens only on the computer that saved it — the boards could
   not use it. A Refresh swaps those for a copy, or empties them when the public
   page has the photo.)
5. **Your Google Sheet** — section 7. Sign in with your own Google account, paste
   your spreadsheet URL, and the app writes rows into it directly over the Sheets
   API as each city finishes. No Apps Script, no deployment, no shared secret,
   nothing to refresh. Three tabs are created if they don't exist:
   - **Leads** — the A and B properties, A first, with **Bucket · Opportunity Score ·
     Why · Price Cut · Listing Agent** at the end of each row. **Address is one column with the whole
     thing** — `1326 Palou Avenue, San Francisco, CA 94124` — not split across
     City and Zip. The comps columns come last: **ARV · ARV $/SqFt · Comp
     Confidence · Comps · Comps Run On**. *Comps* is the sold homes as compact
     JSON (`[{mls, addr, price, sqft, ppsf, sold, bd, ba, yr, use, why}]`, at
     most 16, `use: 1` = counted in the ARV) — the board reads it; nobody types
     in it. **Public Remarks** follows (the listing's own "Public:" text,
     replaced on a re-review or a Refresh, like Private Remarks). An older
     27-column tab is widened by the app on its first write.
   - **Rejected** — everything dropped, with the reason and the stage it fell out at
   - **KPI** — one row per day, upserted

   Rows already on the sheet are **topped up, never overwritten** — a blank Zip
   gets filled in on the next pass, but a note you typed yourself stays put. On
   the KPI tab the app replaces its own counters and leaves the reviewer's
   columns alone.

## The Board tab and "Refresh leads on the board"

After every scan the app rebuilds a **Board** tab in your sheet: today's numbers
on top (scanned → auto-passed → B → A), then the A and B leads in work order —
**soonest offer deadline first**, with a live *Time Left* countdown. Leads you
passed on in the Notes column ("PASS-…", "we're passing…") are counted but left
off. Don't type on the Board; it is rebuilt each time — notes go on **Leads**.

Leads already on your sheet are **not** re-reviewed by a scan. To bring them up
to date, click **↻ Refresh leads on the board** (section 3, signed in to MLS):
it re-reads just those listings — no photos, a few seconds each — and updates
Offer Due (TBD → a real date), Price Cut, Private Remarks, Occupied By and MLS
Status (Active / Pending). Your Notes are never changed. It goes **newest lead
first** and skips listings that are sold, withdrawn or expired, so you can stop
it once today's leads are done. Sold / withdrawn listings come off the Board;
pending ones stay at the bottom. Listing links open the public MLSListings page. **▦ Update Board tab**
rebuilds the Board without touching MLS.

**If the internet drops** (v1.74.5): the app waits and tries again (5 s, 15 s,
30 s) before giving up on a save, and a save that still fails no longer ends the
Refresh — the leads go with the next save. Only three failed saves in a row stop
it. **Pressing ↻ Refresh again the same day picks up where it stopped**: the
leads it already saved are skipped (kept in `refresh-progress.json` in the app's
data folder). A Refresh that finishes, or a new day, starts the list over.

## One-time Google setup

Google won't let any app touch your spreadsheets unless it's registered to a
Google Cloud project **you own** — this can't be shipped inside the app.

1. [console.cloud.google.com](https://console.cloud.google.com) → create or pick a project
2. APIs & Services → Library → enable **Google Sheets API**
3. OAuth consent screen → **External** → add your own Google address under **Test users**
4. Credentials → Create credentials → OAuth client ID → **Desktop app**
5. Paste the Client ID and secret into section 7 → **Sign in with Google**

Sign-in opens your normal browser and comes back to the app on its own
(loopback + PKCE — nothing is copied by hand). The app asks for one scope,
`spreadsheets`; it cannot read your mail or your other files. Credentials and
the refresh token live in `%APPDATA%/FlipScout/google-account.json`.

If the check says the account "cannot edit that spreadsheet", either share the
sheet with the address you signed in as, or sign in as the owner.

## Rejecting a lead (the reviewer's side)

`apps-script/flip-scout-reject.gs` is the only script left, and it does one job:
when someone takes a **qualified** lead off the Leads tab, record the **date** and
the **reason**.

Paste it into the sheet (Extensions → Apps Script → Save → reload the sheet).
Nothing to deploy. Then:

- **⚡ Flip Scout → 🚫 Reject selected lead(s)** — select the row(s), it asks why,
  and moves them to **Rejected** stamped with the date, the reason and who did it.
- **⚡ Flip Scout → ▶ Turn on delete tracking** (once) — if a row is deleted by
  hand instead, it still gets logged, as *removed with no reason given*. Nothing
  disappears from the list without a trace.
- **⚡ Flip Scout → 📋 Rejections today** — the day's count and the reasons given.

A rejected MLS # never comes back: every scan pulls the Rejected tab into the
app's ledger first, and the writer re-checks that tab before it appends anything.

## Local backup

Every reviewed city is saved to `flipscout-leads.json` under the app's data
folder before anything else can fail, so a dropped connection never loses work
you have already paid for. If the sheet was offline during a scan, reconnect and
hit **Send this run's leads**.

## The deal model (matches flip-scout-SOP.md)
- Rehab: Light $70/sf, Heavy $145/sf. Holding (3mo) = 10%/yr financing prorated +
  insurance ($2k/$1M) + property tax (1.25%/yr prorated) + $400.
- ARV = median $/sf of sold SFR in the subject ZIP, listed last ~14 months, within
  ±20% of subject sqft (widen ±40/±60 if <3) × sqft.
- Profit gate (Gross under Light): ARV ≥ $1M → $100k, $500k–$1M → $70k, < $500k →
  $50k. Clears Light = Marginal; clears Heavy too = Strong Deal.

## If a scan comes back empty
Matrix uses dynamic field IDs (`Fm9_CtrlNNNN`). If they change, update `FIELDS` at
the top of `scan-core.js` (see the field table in the repo's `CLAUDE.md`).

## Keep/Drop: manual or AI
By default the Keep/Drop call is yours (Rule #2 is a judgment call). Turn on
**Auto-verify** to have Claude make that call from the photos using your buy-box
rules — useful for running the whole buy box hands-off. Either way, the app scans,
filters, comps, scores, and reports; auto-verify just automates the gallery
decision.

## The FlipScout Lead Board (v1.40)
Section 7. Every A and B lead also goes into `Documents/FlipScout/FlipScout-scan-<date>.json`
with its public and private remarks, offer deadline, listing agent (name, phone, email), bucket and
score, and its exact Redfin page (looked up from this computer). When a run finishes the leads are
already copied: open the Lead Board, click **Add scan**, paste. The Google Sheet (section 8) is optional.
Each report is scrolled top to bottom before it is read — "Scroll pause per screen" in section 3.

## Coming Soon listings (v1.48)
Section 3 → "Also scan Coming Soon listings" (on by default). Each area gets a second, small search for
Coming Soon homes, reviewed like any other. A Coming Soon home with only its first few photos posted is kept
for review (B) instead of being dropped, and its Why says "Coming Soon".

## Redfin — Coming Soon & Early Access (v1.50)
Section 3 → **🏠 Scan Redfin — Coming Soon & Early Access**. No MLS sign-in. A Redfin window opens and goes
through each ticked area (houses under the area's price cap, newest first), keeps only the homes whose card is
badged Coming Soon / Early Access / private exclusive, reads each one's page slowly and judges it with the same
rules (renovated still drops; the AI photo check runs on Redfin's photos when it is on). Kept homes go to the
Lead Board file and the sheet with their own Redfin link and a coloured Coming Soon / Private Listing label.
Homes an MLS scan already checked are skipped. If an area reads 0 homes, the page is saved under
`grid-debug/redfin-*` in the app's data folder — send those two files.
**v1.51:** each Redfin home is opened one at a time and scrolled down to its **Listed by** section; the listing
agent's name, brokerage, phone and email are read from that section only (never Redfin's own "Contact agent"
card) and go to the sheet's Listing Agent / Agent Phone / Agent Email columns and to the Lead Board.
**v1.52:** the county's homes now come from Redfin's own search data (status + badges such as "Early Access
Redfin Coming Soon"), not from guessing at the page. Each Coming Soon / Early Access home is opened one at a
time: the page is scrolled, every photo is stepped through in Redfin's photo viewer, the listing agent is read,
then it is judged. **Sign in to Redfin** (section 3) once to let the scan see Early Access homes.
**v1.57:** Coming Soon / Early Access homes are often seen before their photos go up. A verdict made without a
photo check is now a first look only: the home is opened again 2 days later (up to 7 times, about two weeks), so a
quiet listing whose worn interior is posted later is not lost, and one kept on its first few photos gets its
photo check. Photo verdicts, renovated/fire/tenant/structural wording and buy-box drops are final straight away.
**v1.58:** the Redfin scan only ever adds a home that is **confirmed single-family** (Redfin's data or the page's own
"Property type" — an unknown type, or a unit address like "#3", is skipped) and that the **photos show is a fixer**
(heavy wear, or some wear on original finishes). Tidy "dated but fine" homes, 2000s refreshes and new finishes are
dropped on the photos whatever the description says; a home whose photos could not be judged is held and rechecked,
never added. The Redfin scan needs the AI photo check on (section 2) and will say so if it is off.
**v1.61:** section 3 has **🧹 Clear cache & clean up** — clears stored pages (sign-ins kept), lets Redfin homes be
judged again by today's rules, and moves Redfin leads an older version put on the sheet (over the cap, a unit, too
new, never photo-checked) to C with the reason. Browser caches are also cleared the first time a new version starts.
"↻ Refresh leads on the board" now finds Pending / Contingent / Sold leads by their MLS # again (v1.48–1.60 stamped
them "Not found") and skips Redfin-only leads.
