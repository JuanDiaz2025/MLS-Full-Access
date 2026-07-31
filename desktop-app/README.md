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
   Single-Family · any days on market), then filters to below-market fixers.
3. **Photo review** — for each candidate the MLS window shows the full photo
   gallery. Two ways to judge:
   - **Manual (default):** click **Keep** (genuine dated fixer) or **Drop**
     (renovated / staged / multi-unit / exterior-only). **Pause/Resume** anytime.
   - **Auto-verify (AI):** tick the box in step 2 and paste an Anthropic API key.
     Claude looks at each listing's photos, applies the buy-box rules (Rule #0
     renovated / Rule #2 review-every-photo / multi-unit / exterior-only), and
     decides Keep/Drop on its own — no clicking. Model defaults to
     `claude-opus-5`; switch to `claude-sonnet-5` or `claude-haiku-4-5` for lower
     cost. Your key and the listing photos are sent to Anthropic for this.
4. **Report** — kept candidates get size-matched sold comps → ARV, Light/Heavy
   rehab, holding, and the dollar profit gate (Strong Deal / Marginal / Pass, with
   a Flip Quality label). **Export** to CSV or JSON.

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
