# Fixer-Scouting Process — end to end

The repeatable workflow for turning MLS inventory into "Property Review" leads.
Governed by the rules in `CLAUDE.md` and `docs/flip-scout-SOP.md`; this file is the
step-by-step operating procedure.

## 1. Session setup
- Run the browser setup (proxy/TLS fix): `bash scripts/setup-browser.sh`.
- Log in to MLS: `node scripts/mls-login.js` — confirm the dashboard title
  (`MLSListings Pro Dashboard - <id>`). Re-login any time the session dies
  (cookies expire mid-session).

## 2. Scan (per city)
- Matrix search: **Active · Single Family · ≤ price cap · listed ≤ 45 days**.
- Price cap: **$2.0M Peninsula / San Mateo County, $1.5M everywhere else.**
- Scrape the results grid (address, price, sqft, beds, age, DOM).
- Reusable: `scripts/mls-multi-scan.js` (set `CITIES="County:City;..."`).

## 3. Filter to fixer candidates
- Keep **below-market $/sf, older stock**.
- Drop newer builds and large-home $/sf traps (low $/sf driven by size, not condition).

## 4. Photo-verify every candidate (HARD RULE #2)
- Open the **full photo gallery** and look at EVERY photo — never judge from the
  cover photo or remarks alone.
- DROP if renovated / remodeled / refreshed / clean / staged / move-in-ready.
- KEEP only genuinely dated / distressed / original / needs-real-work.

## 5. Profile-verify the keepers (full Agent Full detail)
- Read the complete listing profile. DROP on any hard exclusion:
  - already-renovated / turnkey · DOM > 45 · **tenant-occupied** ·
    **multi-unit / 2-houses-on-lot / duplex / legal 2nd unit** · vacant lot ·
    **fire-damaged**.
- The profile catches exclusions photos can't (tenancy, land-use/duplex, unit count).

## 6. Comp + Flip Scout math (per survivor)
- **ARV** = median $/sf of size-matched SOLD comps (within ±20% of subject sqft;
  widen to ±40%, then ±60% only if < 3 comps) × subject sqft. Never a flat zip-wide
  median. Watch large-home / location-pocket / wrong-zip traps.
- **Rehab (both)**: Light **$70/sf** (cosmetic), Heavy **$140–150/sf** (full) +
  itemized add-ons for called-out issues (foundation, knob-and-tube, roof).
- **Holding (3 mo)**: 10%/yr financing prorated + insurance ($2,000 per $1M price) +
  property tax (1.25%/yr prorated) + $400 flat utilities.
- **Profit gate (dollars, under LIGHT)**: ARV ≥ $1M → $100k · $500k–$1M → $70k ·
  < $500k → $50k.

## 7. Label + next action
- Clears under Light = **Marginal**; clears under Heavy too = **Strong Deal**;
  else drop.
- Flip Quality: `Good Flip` / `Thin Flip` / `Flip W/ Caution` / `Negative`.
- Flag loss-profile risks (premium-area + heavy rehab). Every lead carries a
  concrete "**verify X before offering**."

## 8. Output
- Get the Redfin link for each qualifier (sheet de-dupes on Redfin Link).
- Append to the Property Review sheet via the Apps Script web app
  (`apps-script/append-lead.gs`): POST `{secret, lead}`. It auto-computes
  Total Cost / Gross Profit, stamps First Added, and de-dupes.
