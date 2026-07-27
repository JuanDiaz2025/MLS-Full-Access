# Fixer-Scouting Process

Rules live in `CLAUDE.md` / `docs/flip-scout-SOP.md`. This is the 8-step run order.

1. **Login** — `setup-browser.sh`, then `mls-login.js`. Re-login if the session dies.
2. **Scan** — Matrix: Active · SFR · ≤ cap ($2.0M Peninsula, else $1.5M) · ≤45 DOM. (`mls-multi-scan.js`)
3. **Filter** — keep below-market $/sf + old; drop new builds & large-home $/sf traps.
4. **Photo-verify (Rule #2)** — MLS# → "Client Full - All Photos" → parse all GetMedia photo URLs (with `exk`) from the page script → grid → screenshot. Review EVERY photo. Drop renovated/clean/staged.
5. **Profile-verify** — read full Agent profile. Drop: renovated · DOM>45 · tenant-occupied · multi-unit/duplex/2nd-unit · vacant lot · fire-damaged.
6. **Comp/math** — ARV = median $/sf of ±20% sqft solds × sqft. Rehab: Light $70/sf, Heavy $140–150/sf + add-ons. Holding 3mo: financing + insurance + tax + $400. Gate (Light): ≥$1M→$100k, $500k–1M→$70k, <$500k→$50k.
7. **Label** — clears Light = Marginal, clears Heavy too = Strong Deal. Add "verify X before offering." Flag loss-profile (premium + heavy rehab).
8. **Output** — Redfin link → POST `{secret, lead}` to the Apps Script sheet.
