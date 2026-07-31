# Lead investigation playbook (flip / value-add)

How to turn a Matrix search into a ranked, trustworthy deal shortlist. Learned
across live sweeps of SF, San Mateo (Peninsula), Oakland, San Jose, Morgan Hill.

## Buy box (per area)

| Area | Max buy | Notes |
|---|---|---|
| Default (SF, Oakland, San Jose, South County) | **$1.5M** | Active · SFR · any list date |
| **Peninsula (San Mateo County)** | **$2.0M** | higher ceiling for this area |

Always: Status = Active, Property Type = Single Family Home. **No List Date
filter** — the 45-day window and the DOM > 45 drop are both lifted for now, so
older listings are in scope. Long DOM is flagged on the lead, not excluded.

## Rule #1 — exclude already-renovated

Only keep genuine value-add fixers. Judge from photos + agent/public remarks:
- **Exclude (renovated/turnkey):** "remodeled / renovated / updated throughout /
  move-in ready / turnkey / reimagined / refreshed / quartz / stainless / designer /
  luxury vinyl", freshly staged, or **newer builds** (age < ~30).
- **Keep (fixer/value-add):** "fixer / as-is / TLC / contractor or handyman special /
  estate / probate / first time on market / potential / bring your vision / needs
  updating / no HVAC", dated/original interiors, below-market $/sqft.

## Deal model (matches the Property Review sheet)

- Rehab **Light = $70/sqft**, **Heavy = $145/sqft** (of living area).
- Holding (3mo) ≈ **3.05% of purchase**.
- Total Cost = Purchase + Rehab + Holding. Gross Profit = ARV − Total Cost.
- Score/Recommendation: gross (light) **≥ $200K = Strong Deal / Good Flip**;
  $100–200K = Marginal; < $100K or negative = pass.

## ARV — the part that makes or breaks it

ARV = **size-matched local sold comps** (last 12 mo), NOT a blended/citywide $/sqft.
Three traps that produce fictional profit (all seen live):
1. **Large-home discount** — big homes sell at lower $/sqft; match comps to subject
   sqft (±35%). (Bayview 2,240 sqft → $580/sqft, not the $700 zip median.)
2. **Location pocket** — a zip spans cheap + pricey micro-markets. Use comps on the
   subject's actual streets (Ingleside Heights vs Lakeshore in 94132; North Fair
   Oaks vs downtown Redwood City in 94063).
3. **Wrong property type / wrong zip** — a listed zip can be wrong (913 France was
   mislabeled Sunset 94122 but is Crocker-Amazon → ARV collapsed); multi-unit /
   TIC / flat comps don't equal SFR $/sqft (595 Minor, 3-unit Victorian).
**If list $/sqft already ≈ local renovated comp $/sqft → no spread → pass.** Many
"fixers" are priced too high to flip.

## Automatic disqualifiers (pass regardless of spread)

Tenant-occupied with no interior access (esp. Oakland just-cause), TIC / fractional /
BMR (deed-restricted), in-contract / multiple-offers, unpermitted-use uncertainty.

## Workflow (scripts)

1. `scrape-county.js` (or `sj.js`/`mh.js`/`oak.js`) — County/City search → `results-*.json` + grid screenshot.
2. Rank by `$/sqft` ascending; drop already-rejected (sheet Rejected tab) & renovated language.
3. `extract-all.js` (env `TODO=<list>.json`) — open each candidate, pull zip + full remarks.
4. `comps.js` (env `ZIP=`, `MONTHS=12`) — sold SFR comps per zip → size-match for ARV.
5. Photo-verify the top candidates with `one.js` (env `MLS=`, `NAME=`) before recommending.
6. Output as Property Review rows (`docs/lead-format.md`) and/or an Artifact deal board.

## Findings log (as of Jul 2026 sweep)

- **SF** (228 Active ≤$1.5M/45d): top fixers 183 Victoria, 1430 Shafter — **user REJECTED both** (plus 322 1st Ave, Redwood City). Rest renovated/overpriced.
- **Peninsula ≤$1.5M** (94): thin; 322 1st Ave (RWC) rejected. Mostly already-flipped.
- **Oakland** (181): best spreads found — **2968 Madeline St** (Dimond 94602, probate livable fixer + legal unit, ~$424–579K gross); 2309 83rd Ave (tenant-occupied, high risk).
- **San Jose** (182): only clean fixer = **526 Madera Ave** (95112, as-is, big lot); rest renovated/newer/rejected. 595 Minor = updated 3-unit (comp trap, dropped).
- **Morgan Hill** (17): no fixers — turnkey/newer market.

## Access note

Session cookies (`.mls-state.json`) expire; re-login can trigger a **2FA step**
(`mlsllogin.mlslistings.com/auth/PreTFA`) that needs a code sent to the account
owner — cannot be completed headlessly without that code.
