# MLS Full Access — navigation memory

Operational memory for reaching and driving the MLSListings Pro system headlessly
from Claude Code on the web, and for turning listings into "Property Review" leads.

## 🚫 HARD RULE #0 — NEVER surface already-renovated properties

Do **NOT** present, rank, comp, or recommend any home that is already
**renovated / remodeled / updated / refreshed / move-in-ready / turnkey / a
newer build**. We only want **genuine value-add fixers** (as-is, probate/estate,
dated/original, needs work, below-market $/sqft). Drop renovated listings on
sight — do not even include them in a list. This is non-negotiable, every market,
every search. (Detection cues + the full method: `docs/investigation-playbook.md`.)

## 🔑 HARD RULE #1 — always be logged in before doing anything

Session cookies expire mid-session. **Before any search/scrape/lookup, confirm
the MLS session is alive; if logged out, LOG IN FIRST** (re-run login →
`title = "MLSListings Pro Dashboard - <id>"`) and only then proceed. Never run a
search on a dead session. Log in + run the task in the **same browser context**
(the storageState can go stale), and re-save `.mls-state.json` right after the
dashboard loads. Re-login may hit a **2FA step** (`/auth/PreTFA`) needing a code
sent to the account owner. What to do then depends on the run:

- **Interactive session** (Bryan is here): stop and ask for the code.
- **Unattended hourly run** (§4b): **stop silently and retry next hour** — do not
  notify, do not ask. The saved cookie often outlives the block, so a later run
  usually reconnects on its own. Log the skip and exit cleanly; never leave a
  half-finished scan or a partially-written ledger behind.

## 🖼️ HARD RULE #2 — review ALL photos before judging a property

Do **NOT** decide fixer-vs-renovated (or recommend/drop) from the cover photo or
remarks alone. **Open the full photo gallery and look at EVERY picture** — kitchen,
bathrooms, flooring, and any interior shots — before making a call. The listing
detail's first image is usually the exterior and hides the real condition. Click
the **Photos** tab / gallery on each listing and review the full set every time.

**"Clean" is NOT a drop — only "renovated" is.** (Updated per Bryan; this
reverses the old rule.) The single question the photos must answer is: *has work
been done to this house?*

- **Drop — renovated:** new/refaced kitchen cabinets, quartz/granite counters,
  new stainless appliances, redone bathrooms (new tile/vanity/fixtures), new
  flooring throughout, recessed lighting, fresh whole-house paint over updated
  finishes, or a newer build. Work has been done → no value left to add.
- **KEEP — merely clean:** the house is tidy, empty, swept, staged, or
  well-photographed, but the **finishes are still original/dated** — old cabinets,
  tile counters, dated bath, worn or original flooring. Clean ≠ updated. **Add
  these to the list.** A well-kept dated house is still a fixer.

So: judge the *finishes*, not the housekeeping or the staging. When photos are
genuinely ambiguous between "clean but dated" and "lightly updated," keep it and
note the uncertainty on the lead rather than dropping it.

### ⚠️ "Renovation" cuts BOTH ways — the word alone means nothing

**Never drop on `/renovat/`.** The same root describes the deal we want and the
deal we don't:

- **KEEP — work still to do:** "Renovation **Opportunity**", "a chance **to
  renovate** this 1914 Edwardian", "**needs** a full renovation", "**never**
  renovated", "requires updating", "bring your imagination", "deferred
  maintenance", "ripe **for** renovation", "remodel **project**".
- **DROP — work already done:** "**beautifully** renovated", "**fully**
  remodeled", "renovated **top to bottom**", "turnkey", "move-in ready",
  "nothing to do but move in", "new construction", "**tastefully** updated".

**Real miss:** 21 College Terrace (SF426150277) — *"Exceptional Renovation
Opportunity… to renovate this 1914 Edwardian… significant deferred maintenance…
bring your imagination"* — was **dropped as renovated** by a bare `/renovat/`.
It is a deal Bryan wants. Needs-work context is now tested **first** and wins;
only unambiguous completed-work phrasing drops. Single finish brags (quartz,
stainless) drop **only** when no needs-work language is present anywhere.

**ONE finish is not a flip — TWO or more is.** A single mention (quartz counters,
a new roof, one updated bath) is a light-rehab line item and stays; two or more
distinct finishes redone, with no needs-work language anywhere, is a kitchen and
bath already done by someone else. Enforced by `FINISH_KW` needing 2+ hits.
Whole-house wording ("renovated", "remodeled", "updated throughout") drops on
its own via `DONE_HOUSE_KW`.

**There is deliberately NO "nice house" keyword rule.** One was added and
removed: it dropped on "immaculate", "pristine", "pride of ownership",
"meticulously maintained" — every one of which describes **housekeeping**, which
HARD RULE #2 says in as many words not to judge on. A spotless house with a
1950s kitchen is the target, not a disqualification.

### ⚠️ "in-law" / "ADU" is POTENTIAL, not a second unit

**The MLS's own `Class:` outranks any word in the remarks.** Every search asks
for Property Type = Single Family Home and the Client Full report repeats it
(`Class: Res. Single Family / Attached, Single Family`). Dropping such a listing
as multi-unit because the remarks contain "in-law" or "ADU" is overruling the
MLS with a keyword — and SF remarks mention those constantly, as *potential*.

**Real miss:** 347 Faxon Avenue (SF426134156), a 1924 single-family — *"bonus
room and bath down… could serve as a 3rd bedroom, home office, family room,
studio and/or **in-law setup**"* and *"room to make a nice garden or **add an
ADU**"* — dropped as multi-unit. Neither unit exists. It is a genuine fixer:
*"1st time on the market in 50 years… sold in its present 'as is' condition."*
Bryan: *"there's a lot of leads you mentioned it as multi family this is
wrong."*

`MULTI_KW` now matches only an **existing** second dwelling (duplex / triplex /
fourplex / "two separate units" / "two full kitchens" / "legal second unit"),
never fires when `Class` says Single Family, and is suppressed by
`POTENTIAL_RE` ("could serve as", "room to add", "potential for", "possible").
Same lesson as `/renovat/`: **the word alone means nothing — the framing does.**

### ⚠️ Calibration — ONE updated surface is not a flip (learned the hard way)

The drop list above is a list of **cues, not triggers**. Spotting a single item
from it does NOT end the analysis. The real question is always:
**has the value already been extracted from this house?**

- **KEEP — partially updated:** an older house where *one* element was redone at
  some point (granite counters on 20-year-old cherry cabinets, a re-tiled tub
  surround, a replaced water heater) while everything else is original — carpet
  in the bedrooms, dated paint, original bath fittings, occupied and cluttered.
  That is a **light-rehab line item**, not a completed flip. There is still a
  full renovation's worth of value to add.
- **DROP — actually flipped:** the *whole* kitchen is new (cabinets AND counters
  AND appliances), the bathrooms are new end to end, flooring is new throughout,
  and the place is professionally staged and empty. Several systems redone at
  once, recently, together.

Ask: *would a flipper still have a full job here?* If yes → KEEP.

**Real miss to learn from:** 844 Brunswick St (ML82056071), $999k / 1,883 sqft /
$531 per sqft = 65% of the SF median. Dropped as "granite counters, updated
baths". Wrong. The house is a 1904 original with wall-to-wall carpet, dated
paint, an old tiled tub surround, a cluttered occupied garage and a basic
secondary kitchenette. One 2000s kitchen update on an otherwise untouched
house. **Should have been a KEEP.** A below-market $/sqft on a large old house
is strong evidence the value is still there — weigh that against the finish
cues rather than dropping on the cue alone.

### 📷 Pulling the photos so they can actually be looked at

`node scripts/mls-photos.js <MLS#> [...]` (`MAX_PHOTOS=n`) saves a listing's
photos to `.mls-artifacts/photos/<MLS#>/NN.jpg`, ready to open and judge.

The route matters. The Client Full report shows a **carousel** — one frame, three
or four preloaded — so scraping it yields ~4 of 26. The `Open All` control
(`font.print.icon[title="Open All"]`) opens **PhotoPopup.aspx … &View=G**, a grid
of *every* photo, in a new tab. Read `document.images` there; `JS_PHOTOS` buckets
by `Size=` and the popup serves a different size, so it finds nothing. Photo 1 is
the exterior, so the download skips it and spreads across the rest.

**Proof this matters — 21 College Terrace:** the living-room shot is staged with
new flooring, fresh paint and good furniture and reads as a "nice house"; the
kitchen two frames later is dark original cabinets and **red tile counters**,
untouched since the 1950s. Judging on the staging would have discarded Bryan's
own confirmed deal. **Furniture is not a finish.**

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
COUNTY="San Francisco" STATUS=Active MAX_PRICE_K=1500 \
  node scripts/mls-matrix-search.js
```
`DAYS` is optional and now **unset by default** — no List Date filter is applied,
so the scan sees all Active listings regardless of age. Set `DAYS=45` to restore
a rolling window. Screenshots land in `.mls-artifacts/`. Earlier verified example
(SF · Active · ≤$1.5M · listed last 45 days) returned **228 matches**; with no
date filter the count will be higher.

## 4b. Recurring scan — order, cadence, and the seen-ledger

**Scan order: San Francisco FIRST, always.** SF is the priority market — run it
before anything else so its new listings reach the sheet first, then continue
through the rest of the buy box (Peninsula → Sunnyvale → San Jose → Oakland →
Berkeley → San Leandro → Hayward → Richmond). `DEFAULT_CITIES` in
`scripts/mls-multi-scan.js` is already in this order — keep SF at the top.

**Ledger cleared 1 Aug 2026** at Bryan's request — every verdict before that was
made with the truncated-remarks bug (judging on the Open House teaser), the bare
`/renovat/` drop that lost 21 College Terrace, and before the tenant and
quick-flip screens existed. Those calls were not trustworthy, so the slate was
wiped and the buy box is being re-reviewed from scratch. Bryan cleared the
spreadsheet at the same time.

**Cadence: hourly.** Each run looks for listings that are new *since the last
run*. Runs are incremental, not full re-reviews. Requires `MLS_USER` / `MLS_PASS`
in the environment's variables. If login is blocked by 2FA, the run stops
silently and retries the next hour (Rule #1) — no notification.

**🧠 Never re-check a listing you have already checked.** A persistent ledger at
`data/scanned-ledger.json` (tracked in git, so it survives the ephemeral
container) records every MLS # ever scanned, with the date and the verdict.
Anything already in the ledger — from yesterday or any earlier run — is **skipped
outright**: no photo pull, no comps, no scoring. Only genuinely new MLS #s cost
any time. This is the whole point: the expensive stages (photo review, comps)
must never run twice on the same property.

Headless SF run (the same pipeline as the app — it imports `scan-core.js`, so
the two cannot disagree about what qualifies): `node scripts/mls-sf-scan.js`
(`MAX_LISTINGS=n` to sample). Writes `.mls-artifacts/sf-scan.json` and records
its verdicts in the ledger.

```bash
node scripts/mls-ledger.js filter .mls-artifacts/candidates.json   # → new only
node scripts/mls-ledger.js record .mls-artifacts/candidates.json kept
node scripts/mls-ledger.js stats
```

Run `filter` immediately after the scan/filter stage and before photo review;
run `record` after judging so the verdict is remembered. **Commit
`data/scanned-ledger.json` at the end of every run** — an uncommitted ledger is
lost when the container is reclaimed, and the next run re-checks everything.

**Output goes to the spreadsheet first.** New qualifying leads are appended to
the Property Review sheet (§6) as the primary deliverable — do that before
writing up any summary.

## 5. Lead investigation — Flip Scout methodology (CANONICAL)

**`docs/flip-scout-SOP.md` is the governing SOP — follow it exactly.** Summary of
what binds every analysis (see also `docs/investigation-playbook.md` for the
headless-scrape workflow):

- **Buy box (max price is a RULE):** **Peninsula (San Mateo County) = $2.0M max;
  ALL other areas = $1.5M max.** SFR, **no price floor** (a `SANITY_MIN_PRICE`
  data floor only guards against garbled prices). Areas: SF · full
  San Mateo/Peninsula · Sunnyvale · Oakland · Richmond · Berkeley · San Leandro ·
  San Jose. Never change the buy box without Bryan's explicit instruction.
- **🚫 REMOVED screens — do not reinstate without Bryan's say-so:**
  - the **"≤85% of city median $/sqft"** cut, and
  - the **"oversized for the area"** cut (sqft > 1.5× the city median).

  Both are gone. The oversize rule was provably wrong: 21 College Terrace was
  **$455/sqft — 56% of the SF median, genuinely cheap** — and was discarded only
  for being 2,185 sqft against a 1,333 median. A big cheap house is an
  opportunity, not a trap.

  **The only pre-photo screen left is age (25+ years, when the MLS reports it).**
  $/sqft is still computed, still shown, and still sorts the output — it just
  never excludes anything. Consequence to expect: almost every old SFR in the
  buy box now reaches photo review, so photo review is the real filter and the
  volume is far higher.
- **Hard exclusions (drop outright, not flag):** already-renovated / turnkey (Rule #0),
  **tenant-occupied**, multi-unit, vacant lot, **fire-damaged** (any listing noting a
  past fire / fire damage / fire-gutted interior — drop even if it reads as a genuine
  as-is fixer).
- **⚡ QUICK FLIPS ONLY** (Bryan, 1 Aug). A quick flip is a **cosmetic** job — paint,
  floors, kitchen, bath, done in one pass without drawings or engineers. **Drop**
  anything structural or permit-heavy even when it is a genuine fixer: foundation
  issues, structural damage, visible settlement, red-tagged / uninhabitable,
  unpermitted work, permits or plans pending, entitlement plays, tear-down /
  land-value listings, stripped-to-the-studs shells, extensive water damage or mould.
  A dated house needing everything *cosmetically* is exactly the target; a house
  needing an engineer is not. Enforced in `SLOW_KW` (`scan-core.js`) and in the vision
  prompt, which returns a `quickFlip: cosmetic | structural` field.
  Note `tear-down` was previously in KEEP_KW — it is the opposite of a quick flip.
- **Days on market: 45 days or less. BACK ON** (Bryan, 1 Aug — the removal was
  temporary). Anything with DOM > 45 is dropped, with the reason logged. Applied
  to the MLS's own DOM field rather than a List Date search window, so a relisted
  property is judged on the DOM the sheet will actually show. A **blank** DOM is
  not grounds to drop — missing is not stale.

  After the first pass, each run is **incremental**: the seen-ledger means only
  MLS #s never checked before cost any time, so day two surfaces the newest
  listings and nothing else.
- **ARV = size-matched sold comps:** median $/sqft of comps within **±20%** of
  subject sqft (widen to ±40%, then ±60% only if <3 comps), × subject sqft. Never a
  flat zip-wide median. Watch large-home / location-pocket / wrong-zip traps.
- **Rehab (always both):** Light **$70/sqft** (cosmetic), Heavy **$140–150/sqft**
  (full) + itemized add-ons for called-out issues (foundation, knob-and-tube, roof).
- **Holding (3 mo):** 10%/yr financing prorated + insurance ($2,000 per $1M price) +
  property tax (1.25%/yr prorated) + $400 flat utilities. (NOT a flat 3%.)
- **Profit gate (dollars, under LIGHT):** ARV ≥ $1M → **$100k** min · $500k–$1M →
  **$70k** · < $500k → **$50k**. Clears only under Light = **"Marginal"**; clears
  under Heavy too = **"Strong Deal."** (Do not use an arbitrary $200k bar.)
- **Equity ≠ profit.** The model's gross is a *screen* (step 1 of ~13), never the
  decision — real profit must still absorb closing, commissions, permits, surprises.
  Every surfaced lead carries a concrete "verify X before offering" next action.
- **Loss profile to flag (from `DEAL_HISTORY.md`):** East Bay sub-$1M flips with
  rehab < ~17% of purchase are the reliable engine; every historical loss was a
  high-price **Peninsula/premium** buy with **heavy rehab (>25–30% of purchase, or
  price > $1.5M** in Redwood City / Menlo Park / Foster City / San Carlos / Walnut
  Creek). Flag any lead matching this even if it clears the dollar gate.
- **Do NOT use:** ADU Potential, "Reno Budget" label, or seismic/pre-1940 wiring
  risk flags (all removed per standing instruction).
- **User-rejected (do not resurface):** 183 Victoria St, 1430 Shafter Ave (SF);
  322 1st Ave (Redwood City) — plus the sheet's Rejected Redfin list.
- **✅ CONFIRMED DEALS — never drop these, whatever a rule says:**
  **21 College Terrace, San Francisco, CA 94112** (SF426150277 · 2,185 sqft ·
  $455/sqft · built 1914). Bryan: *"THIS IS SOMETHING WE CAN DEAL."* Enforced by
  `CONFIRMED_ADDR` / `core.isConfirmed()` in `scan-core.js`, which short-circuits
  every screen *and* the vision model — the mirror of `REJECTED_ADDR`. Add to it
  whenever Bryan names a property he wants; a rule that can silently swallow a
  live deal needs a backstop that doesn't depend on the rule being right.

## 6. Lead output → Google Sheets

Header order + value vocabulary for both sheets: `docs/lead-format.md`.
Recommendation vocab: `Strong Deal` / `Marginal`. Flip Quality: `Good Flip` /
`Thin Flip` / `Flip W/ Caution` / `Negative`.

**Primary — "Flip Scout Agent"** (`1u7YXGGUp_TeJUP3nYDqTJDJgu5IjLtkX0KPlSkI4TE4`).
The desktop app writes here **directly over the Sheets API** (§7) — there is no
web app, no deployment and no shared secret any more. Three tabs:

- **`Leads`** — `Status · MLS # · Address · Beds · Baths · SqFt · Lot SqFt ·
  Year Built · DOM · Purchase Price · $/SqFt · Notes · MLS Link · First Added`.
  Keyed on `MLS #`; rows are append-or-backfill.
- **`Rejected`** — `Rejected On · MLS # · Address · Price · $/SqFt · SqFt · DOM ·
  Reason · Stage · By · MLS Link`. Everything dropped lands here with the reason
  and the stage it fell out at.

  **`Address` is ONE column holding the whole thing** — `1326 Palou Avenue, San
  Francisco, CA 94124`. Separate City/Zip columns are gone.

### Where the listing facts actually come from

Verified against live Matrix, not assumed. The **results grid has no zip column
at all** (headers are `MLS # · Street Address · Price · DOM · Bds · Bths · SqFt ·
Lot Size · Postal City · Class · Age`) and its `Street Address` is street-only.
So the full address, the zip, the year built and the real remarks are read off
the **Client Full report** during photo review, by `core.parseDetail(text, mls)`:

- Address line — `844 Brunswick Street, San Francisco 94112`
- `Age/Yr Blt: 122/1904` → year built. Beats `2026 - Age`, which reads **2026**
  whenever the grid's Age cell is blank.
- Remarks are labelled **`Public:`**, not "Public Remarks:". A bare `/Remarks:/`
  matched the *truncated Open House teaser* instead — so the rules engine was
  judging condition on the wrong text.

**🚨 Matrix sometimes ignores the MLS # filter and leaves a DIFFERENT listing on
screen.** Caught in testing: asking for `SF426146279` served `CRPW26161101`
(220 Saddlehorn Loop, **Lincoln**). `parseDetail` is therefore anchored to the
MLS # asked for and returns `{mismatch:true, showing:'<other id>'}` rather than
reading whatever is displayed; the app skips that listing **without a ledger
entry**, so the next run retries instead of writing it off. Never read "the
first address on the page."

`core.fullAddress()` composes the sheet value, stripping a trailing zip/state
off the street line before recomposing — appending blindly gave
"…San Francisco 94112, CA". Fixtures of real report text live in
`desktop-app/fixtures/`; `node desktop-app/test-google-sheets.js` covers all of
the above.

Also: **"All San Francisco" is a log heading, never a city.** Data rows use the
listing's own `Postal City` (the only right answer on a county-wide scan), with
the `All ` prefix stripped as the fallback.
- **`KPI`** — **four columns, numbers, no chart**:
  `Date · Rejected · On List · Scan Rejected`.
  - `Rejected` — taken off the list by a **person** that day (Rejected rows whose
    Stage is *Reviewer* or *Deleted by hand*; scan drops are not manual)
  - `On List` — qualified leads still on the `Leads` tab (a live count, so only
    today's row carries it)
  - `Scan Rejected` — thrown out by the scan itself that day

  **The Apps Script builds the whole tab** from the `Rejected` and `Leads` tabs —
  the app writes none of it. Both rejection figures come off `Rejected`, split by
  **who did it**: an **email address in `By`** (`bryan@twinhomebuyer.com`) means a
  person, `FlipScout` means the scan. `Stage` is checked too — a row deleted by
  hand has a stage but no email — but an email is enough on its own, whatever
  the stage says. One source, so the two numbers
  cannot disagree, and nothing accumulates — a corrected row shows up at once.

  Splitting ownership (app writes some columns, script others) was tried and
  produced a tab reading **`Scan Rejected: 0`** after a scan that had rejected
  hundreds: the app's figures were wiped when the header row got corrected and
  nothing rewrote them until the next run.

  **Every buy-box rejection is logged**, not a sample. The old 25-per-city cap
  made `Scan Rejected` an undercount, and a number that quietly means "some of
  them" is worse than no number.

  **Header rows are compared in FULL, never just cell A1.** A tab from an older
  layout still began with "Date", so the old headings survived and values landed
  under the wrong ones — the 23-column KPI tab kept its headers while the app
  wrote into the first few columns, and a chart titled "Manually removed per
  day" plotted *Runs* and *Candidates*. `ensureTab()` (app) and `kpiSheet_()`
  (script) both rewrite a mismatched header row and blank the stale extras, so
  an old tab heals itself instead of needing to be deleted by hand.

The only Apps Script left is **`apps-script/flip-scout-reject.gs`**, and it does
one job: when a reviewer takes a QUALIFIED lead off `Leads`, record the date and
the reason. `⚡ Flip Scout → 🚫 Reject selected lead(s)` prompts for the reason
and moves the row; an installable `onChange` trigger ("Turn on delete tracking")
catches rows deleted by hand and logs them as *removed with no reason given*, so
nothing vanishes silently. It also owns the KPI tab (above). Paste-and-save only
— nothing to deploy.

**Legacy — "Property Review"** (`10kBdkMqQ6_7xiLt8peF0WfU3R1Go8bOZnYiUmNFJSIA`,
gid `1510205894`) via `apps-script/append-lead.gs`, POST `{secret, lead}`.
De-dupes on Redfin Link. Kept for the existing headless pipeline.

## 7. FlipScout desktop app

`desktop-app/` (Electron). Sign in → scan the buy box → photo-review with
pause/resume → deal report → the leads land in the spreadsheet. Sections in the
control window: 1 login · 2 how listings are judged · 3 scan · 4 now reviewing ·
5 report · 6 daily KPI · 7 Google Sheet. Renovated properties never reach the
sheet — they are dropped at photo review (Rule #0/#2).

**You pick the areas.** Section 3 has a checkbox per buy-box area (plus All /
None / San Francisco only), remembered between runs; only ticked areas are
scanned. The renderer sends **indexes**, not area objects, so `DEFAULT_BUYBOX`
stays the single definition of the buy box. San Francisco alone takes minutes;
the whole box takes hours.

**And it stops by itself.** When the last city is done the app closes the MLS
window, clears "Now reviewing", resets the buttons and prints
`Scan COMPLETE — N scanned · N skipped · N reviewed · N kept · N dropped · N
written to the sheet`. Nothing is left running. A run that never started (not
signed in) leaves the browser window alone, so it cannot shut the window you are
about to log in through. `finishRun()` in `main.js`.

**The run never stops to ask.** There is no Keep/Drop approval step — it was
removed per Bryan. AI vision decides when an API key is set, otherwise the text
rules do, and `whenUnsure` (keep/drop) settles the cases the rules cannot read.
Section 4 is a live read-out, not a prompt. The sheet reviewer is the backstop,
and every rejection she makes flows back into the ledger.

**Sheet writing is direct (`desktop-app/google-sheets.js`).** Bryan signs in with
his own Google account inside the app (OAuth loopback + PKCE, scope
`spreadsheets` only) and pastes the spreadsheet URL; as each city finishes, the
app writes to the **Leads**, **Rejected** (with reason + stage) and **KPI** tabs
over the Sheets API. Rows are append-or-backfill — a blank cell gets filled on a
later pass, a non-empty one is never overwritten, so hand edits survive. On KPI
the app replaces only its own counters and leaves the reviewer's columns alone.
Needs a one-time **OAuth Client ID (Desktop app type)** from the user's own
Google Cloud project — that cannot be shipped in the app or created for them;
the five console steps are in the app UI and `desktop-app/README.md`.
Credentials persist in `google-account.json` under userData.

**A rejected lead never comes back.** Two guards, because the ledger alone is
not enough: every scan starts by pulling the `Rejected` tab into the seen-ledger,
and the writer re-checks that tab before appending. The second guard is the one
that matters — a lead reviewed *before* it was rejected is still in the batch,
and once the reviewer deletes the `Leads` row there is no duplicate left for the
`MLS #` key to catch, so it would append clean.

Local backup (written every run, before anything can fail):
`flipscout-leads.json` under userData — the app's own safety net, not a
hand-off. Contract tests for the writer: `node desktop-app/test-google-sheets.js`.

## Notes

- Environment is ephemeral — re-run `setup-browser.sh` and `mls-login.js` each session.
- `.mls-state.json` holds live auth cookies; it is gitignored and must never be committed.
