/**
 * Flip Scout filter + deal math (canonical CLAUDE.md / flip-scout-SOP.md).
 *
 * Two modes:
 *   filter  — read .mls-artifacts/multi-scan.json (from mls-multi-scan.js) → rank
 *             below-market $/sqft + older SFR, drop large-home $/sqft traps
 *             → .mls-artifacts/candidates.json  (Stage 3). No DOM cap.
 *   score   — read .mls-artifacts/keepers.json (photo-verified survivors, each
 *             {mls,addr,city,price,sqft,bds,age,dom}) + comps-out.json + profiles-out.json
 *             → Light/Heavy rehab, holding, dollar profit gate, labels →
 *             .mls-artifacts/leads.json  (Stages 6-7). Also emits feed-ready rows.
 *
 * Rehab: Light $70/sf, Heavy $145/sf. Holding (3mo) = 10%/yr financing prorated
 * + insurance ($2,000/$1M) + property tax (1.25%/yr prorated) + $400 utilities.
 * Gate (on Gross under LIGHT): ARV>=$1M→$100k, $500k-1M→$70k, <$500k→$50k.
 * Clears Light only = Marginal; clears Heavy too = Strong Deal.
 *
 * Usage: MODE=filter node scripts/mls-flipscout.js
 *        MODE=score  node scripts/mls-flipscout.js
 */
const fs = require('fs');
const path = require('path');
const { OUT } = require('./mls-lib');

const MODE = process.env.MODE || 'filter';
const num = s => parseFloat(String(s || '').replace(/[^0-9.]/g, '')) || 0;
const median = arr => { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const rd = f => {
  for (const dir of [OUT, process.cwd()]) {
    const fp = path.join(dir, f);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  }
  throw new Error('not found in .mls-artifacts or cwd: ' + f);
};

function filter() {
  const data = rd('multi-scan.json');
  let all = [];
  for (const city of Object.keys(data)) {
    for (const r of data[city].rows || []) {
      const price = num(r.price), sqft = num(r.sqft), age = num(r.age), dom = num(r.dom);
      if (!price || !sqft) continue;
      all.push({ ...r, _price: price, _sqft: sqft, _age: age, _dom: dom, _ppsf: Math.round(price / sqft), _cityKey: r.city || city });
    }
  }
  const byCity = {}; for (const r of all) (byCity[r._cityKey] = byCity[r._cityKey] || []).push(r._ppsf);
  const med = {}; for (const c of Object.keys(byCity)) med[c] = median(byCity[c]);
  const bySqft = {}; for (const r of all) (bySqft[r._cityKey] = bySqft[r._cityKey] || []).push(r._sqft);
  const medSqft = {}; for (const c of Object.keys(bySqft)) medSqft[c] = median(bySqft[c]);
  const candidates = all.filter(r => {
    // No days-on-market exclusion — the 45-day cap is lifted for now; DOM is
    // reported on each candidate so a stale listing can be flagged, not dropped.
    if (r._sqft > medSqft[r._cityKey] * 1.5) return false;  // large-home $/sqft trap
    if (r._age < 25) return false;                          // too new to be a dated fixer
    return r._ppsf <= med[r._cityKey] * 0.85;               // below-market $/sqft
  }).sort((a, b) => (a._ppsf / med[a._cityKey]) - (b._ppsf / med[b._cityKey]));
  fs.writeFileSync(path.join(OUT, 'candidates.json'), JSON.stringify(candidates, null, 1));
  console.log(`FILTER: ${all.length} scanned -> ${candidates.length} fixer candidates`);
  console.log('city medians $/sqft:', JSON.stringify(med));
  candidates.slice(0, 60).forEach((r, i) => console.log(String(i + 1).padStart(2), r.mls.padEnd(11), (r._cityKey || '').padEnd(12), ('$' + r._price.toLocaleString()).padEnd(11), (r._sqft + 'sf').padEnd(7), 'age' + r._age, 'dom' + r._dom, ('$' + r._ppsf + '/sf').padEnd(9), Math.round(r._ppsf / med[r._cityKey] * 100) + '%', r.addr));
}

const LIGHT = 70, HEAVY = 145;
const holding = price => 0.025 * price + 2000 * (price / 1e6) + 0.003125 * price + 400;
const gate = arv => arv >= 1e6 ? 100000 : arv >= 500000 ? 70000 : 50000;
const money = n => '$' + Math.round(n).toLocaleString();

function score() {
  const keepers = rd('keepers.json');
  const comps = rd('comps-out.json').reduce((a, r) => { a[r.mls] = r; return a; }, {});
  const zips = (() => { try { return rd('profiles-out.json').reduce((a, r) => { a[r.mls] = r.zip; return a; }, {}); } catch { return {}; } })();
  const out = [];
  for (const k of keepers) {
    const c = comps[k.mls] || {}; const arv = c.arv || 0;
    const price = num(k.price), sf = num(k.sqft);
    const rehabL = LIGHT * sf, rehabH = HEAVY * sf, hold = holding(price);
    const totL = price + rehabL + hold, totH = price + rehabH + hold;
    const grossL = arv - totL, grossH = arv - totH;
    const g = gate(arv), clearsL = grossL >= g, clearsH = grossH >= g;
    const rec = clearsL ? (clearsH ? 'Strong Deal' : 'Marginal') : 'PASS';
    const lossProfile = (price > 1e6 && rehabH / price > 0.25) || price > 1.5e6;
    let quality = grossL <= 0 || !clearsL ? 'Negative' : lossProfile ? 'Flip W/ Caution' : (clearsH && grossL >= 1.5 * g) ? 'Good Flip' : 'Thin Flip';
    let sc = clearsL ? Math.max(4, Math.min(10, Math.round(4 + 6 * (grossL - g) / (2 * g)))) : Math.min(3, grossL > 0 ? 2 : 1);
    const maxOffer = arv ? Math.round(arv - rehabL - hold - g) : 0;
    out.push({
      mls: k.mls, surface: clearsL, Score: sc, Recommendation: rec, 'Flip Quality': quality,
      Address: k.addr, City: k.city, Zip: zips[k.mls] || k.zip || '', Beds: k.bds, SqFt: sf, 'Year Built': 2026 - num(k.age), dom: num(k.dom),
      'Purchase Price': price, 'Estimated ARV': arv, arv_ppsf: c.medianPpsf || null, comp_band: c.band, comp_n: c.nMatched,
      'Rehab Cost (Light)': Math.round(rehabL), 'Rehab Cost (Heavy)': Math.round(rehabH), 'Holding Costs (3mo)': Math.round(hold),
      'Total Cost (Light)': Math.round(totL), 'Total Cost (Heavy)': Math.round(totH),
      'Gross Profit (Light)': Math.round(grossL), 'Gross Profit (Heavy)': Math.round(grossH),
      gate: g, recommended_max_offer: maxOffer, lossProfile,
    });
  }
  out.sort((a, b) => b['Gross Profit (Light)'] - a['Gross Profit (Light)']);
  fs.writeFileSync(path.join(OUT, 'leads.json'), JSON.stringify(out, null, 1));
  out.forEach(r => console.log((r.Recommendation || '').padEnd(11), (r['Flip Quality'] || '').padEnd(14), 'Sc' + r.Score, money(r['Purchase Price']).padEnd(10), 'ARV', (r['Estimated ARV'] ? money(r['Estimated ARV']) : 'NO-COMP').padEnd(10), 'GrossL', money(r['Gross Profit (Light)']).padEnd(10), r.Address, r.City));
  const surf = out.filter(r => r.surface);
  console.log(`\nSURFACE (clears Light gate): ${surf.length} of ${out.length}`);
}

if (MODE === 'filter') filter();
else if (MODE === 'score') score();
else { console.error('MODE must be "filter" or "score"'); process.exit(1); }
