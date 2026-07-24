# MLS Full Access — navigation memory

Operational memory for reaching and driving the MLSListings Pro system headlessly
from Claude Code on the web, and for turning listings into "Property Review" leads.

## 1. Browser access (do this first, every fresh session)

Browsing only works after fixing the egress proxy + TLS. Run once:

```bash
bash scripts/setup-browser.sh
```

It (a) installs the `playwright` npm package (browser binaries are pre-installed
at `/opt/pw-browsers`), (b) trusts the proxy CA in the NSS store, and (c) installs
a Chromium enterprise policy disabling the **post-quantum key share** and
**Encrypted Client Hello**. Without (c), every HTTPS request dies with
`ERR_CONNECTION_RESET` (the egress resets Chromium's oversized ClientHello) even
though `curl` works. Full write-up: `docs/browser-access.md`.

Always launch Chromium with:
- `executablePath: /opt/pw-browsers/chromium-1194/chrome-linux/chrome`
- `--no-sandbox` and `--proxy-server=$HTTPS_PROXY` (scheme stripped)

Helper: `scripts/mls-lib.js` (`launch()` + state path).

## 2. Login

- Entry URL: `https://prodashboard.mlslistings.com/` → redirects to Azure AD B2C
  sign-in at `mlslpro.b2clogin.com` (username/password; also Google/Facebook SSO).
- **Credentials come from env vars `MLS_USER` / `MLS_PASS` — never commit them.**
- `node scripts/mls-login.js` fills the form, signs in, and saves session cookies
  to `.mls-state.json` (gitignored). Post-login flow: `mlsllogin.mlslistings.com/auth/PostLogin`
  → dashboard. Success signal: page title `MLSListings Pro Dashboard - <agent id>`.
- Reuse the session by loading `storageState: .mls-state.json` — skips re-login and
  carries over to the Matrix domain.

## 3. Dashboard

- Top nav: Search · Listings · Products & Tools · Support · MLS Rules · Profile.
- Blue toolbar: **Matrix Search** · Matrix Dashboard · My Listings · Realist II ·
  Agent Search · Aculist · Pro Support.
- **Matrix Search opens CoreLogic Matrix in a NEW TAB** →
  `https://search.mlslistings.com/Matrix/Search/Residential/ResidentialSearch`.
  With a saved `storageState` you can navigate there directly (no click needed).

## 4. Matrix Residential Search — field IDs

Matrix uses dynamic `Fm9_CtrlNNNN` ids. Observed (re-introspect if a `<select>`
comes back empty — the form may have changed):

| Field | Selector | Notes |
|---|---|---|
| Status (multi) | `#Fm9_Ctrl1161_LB` | Active, Contingent, Pending, Sold, … |
| Property Type (multi) | `#Fm9_Ctrl65_LB` | Single Family Home, Condominium, Townhouse, … |
| County (multi) | `#Fm9_Ctrl1738_LB` | **San Francisco = the whole city** |
| City (multi) | `#Fm9_Ctrl1739_LB` | filter box `#Fm9_Ctrl1739_LB_TB` |
| Area (multi) | `#Fm9_Ctrl1740_LB` | |
| List Date | `#Fm9_Ctrl1162_TB` | range `MM/DD/YYYY-MM/DD/YYYY` |
| List Price | `#Fm9_Ctrl63_TB` | "(000s)" box is checked → enter thousands; max = `0-1500` ($1.5M) |
| Beds / SqFt / Age / Zip / MLS# | `#Fm9_Ctrl56_TB` / `#Fm9_Ctrl59_TB` / `#Fm9_Ctrl74_TB` / `#Fm9_Ctrl1780_TextBox` / `#Fm9_Ctrl75_TextBox` | |

- Match count updates live on change (`"N matches"`). Click the **Results** tab/button
  to load the grid (`Results.aspx`). Speed-bar shorthand for the SF example reads
  `RESI A $0-1500 San Francisco`.

Reusable runner:
```bash
COUNTY="San Francisco" STATUS=Active MAX_PRICE_K=1500 DAYS=45 \
  node scripts/mls-matrix-search.js
```
Screenshots land in `.mls-artifacts/`. Verified example: SF · Active · ≤$1.5M ·
listed last 45 days → **228 matches**.

## 5. Lead output → Google Sheet ("Property Review" / Layout B)

- Header order + value vocabulary: `docs/lead-format.md`.
- Recommendation vocab: `Strong Deal` / `Marginal`. Flip Quality: `Good Flip` /
  `Thin Flip` / `Flip W/ Caution` / `Negative`.
- Append investigated leads to the sheet
  (`10kBdkMqQ6_7xiLt8peF0WfU3R1Go8bOZnYiUmNFJSIA`, Property Review tab
  gid `1510205894`) via the Apps Script web app in `apps-script/append-lead.gs`:
  POST `{secret, lead}`. It auto-computes Total Cost / Gross Profit, stamps
  `First Added`, and de-dupes on Redfin Link.

## Notes

- Environment is ephemeral — re-run `setup-browser.sh` and `mls-login.js` each session.
- `.mls-state.json` holds live auth cookies; it is gitignored and must never be committed.
