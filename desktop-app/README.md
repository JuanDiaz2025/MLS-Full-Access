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
2. **Start scan** — scans the full buy box (SF · whole Peninsula @ $2M · Sunnyvale
   · San Jose · Oakland · Berkeley · San Leandro · Hayward · Richmond; Active ·
   Single-Family · **45 days on market or less** · 25+ years old). After the first
   pass each run is incremental — listings already checked are skipped outright,
   so day two only costs you the new ones.
3. **Photo review** — for each candidate the MLS window shows the full photo
   gallery. Two ways to judge:
   - **Manual (default):** click **Keep** (genuine dated fixer) or **Drop**
     (renovated / multi-unit / exterior-only). Clean-but-dated = **Keep**;
     judge the finishes, not the staging. **Pause/Resume** anytime.
   - **Auto-verify (AI):** tick the box in step 2 and paste an Anthropic API key.
     Claude looks at each listing's photos, applies the buy-box rules (Rule #0
     renovated / Rule #2 review-every-photo / multi-unit / exterior-only), and
     decides Keep/Drop on its own — no clicking. Model defaults to
     `claude-opus-5`; switch to `claude-sonnet-5` or `claude-haiku-4-5` for lower
     cost. Your key and the listing photos are sent to Anthropic for this.
4. **Report** — kept candidates get size-matched sold comps → ARV (what it's worth
   after repair), Light/Heavy rehab, holding, days on market, and the dollar profit
   gate (Strong Deal / Marginal / Pass, with a Flip Quality label). **Export** to
   CSV or JSON.
5. **Your Google Sheet** — section 7. Sign in with your own Google account, paste
   your spreadsheet URL, and the app writes rows into it directly over the Sheets
   API as each city finishes. No Apps Script, no deployment, no shared secret,
   nothing to refresh. Three tabs are created if they don't exist:
   - **Leads** — the qualifying properties. **Address is one column with the whole
     thing** — `1326 Palou Avenue, San Francisco, CA 94124` — not split across
     City and Zip.
   - **Rejected** — everything dropped, with the reason and the stage it fell out at
   - **KPI** — one row per day, upserted

   Rows already on the sheet are **topped up, never overwritten** — a blank Zip
   gets filled in on the next pass, but a note you typed yourself stays put. On
   the KPI tab the app replaces its own counters and leaves the reviewer's
   columns alone.

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
