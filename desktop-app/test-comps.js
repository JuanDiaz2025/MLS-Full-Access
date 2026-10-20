/**
 * Offline test for the comps step (v1.73) — run with `node desktop-app/test-comps.js`.
 * Sold rows → size band → what each sold home's remarks say → the ARV and its
 * confidence → the sheet's Comps column → the board lead. The MLS-driving part
 * (the Sold search, the reports) lives in main.js and needs the live MLS.
 */
const fs = require('fs');
const path = require('path');
const core = require('./scan-core');

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.error('FAIL ' + m + '\n  got      ' + A + '\n  expected ' + B); }
  else console.log('ok   ' + m);
};
const year = new Date().getFullYear();

// ---- sold grid rows → comps ----
{
  const rows = [
    { mls: 'ML82050001', addr: ' 12  Oak  St ', price: '$1,100,000', sqft: '1,500', bds: '3', baths: '2', age: '70', sold: '09/15/2026' },
    { mls: 'ml82050002', addr: '14 Oak St', price: '$990,000', soldPrice: '$1,050,000', sqft: '1,400', bds: '3', baths: '1|0', yr: '1952', sold: '8/2/26' },
    { mls: 'ML82050001', addr: '12 Oak St (repeat)', price: '$1,100,000', sqft: '1,500' },
    { mls: 'SUBJ1', addr: 'the lead itself', price: '$900,000', sqft: '1,450' },
    { mls: 'ML82050003', addr: 'placeholder size', price: '$800,000', sqft: '1' },
    { mls: 'ML82050004', addr: 'a parking space', price: '$25,000', sqft: '1,200' },
    { mls: '', addr: 'no MLS #', price: '$900,000', sqft: '1,300' },
  ];
  const c = core.compRows(rows, 'subj1');
  eq(c.map(r => r.mls), ['ML82050001', 'ML82050002'], 'compRows: the lead, repeats, placeholder sizes and non-sales are left out');
  eq([c[0].addr, c[0].price, c[0].ppsf, c[0].yr, c[0].sold, c[0].gridSold], ['12 Oak St', 1100000, 733, year - 70, '2026-09-15', false],
    'compRows: price, $/sqft, year from the Age column, sold date as a day');
  eq([c[1].price, c[1].ppsf, c[1].yr, c[1].sold, c[1].gridSold, c[1].bd, c[1].ba], [1050000, 750, 1952, '2026-08-02', true, 3, 1],
    'compRows: a Sold Price column beats Price, and says the grid had it; a "1|0" baths cell is 1, not 10');
}

// ---- the size band ----
{
  const at = (mls, sqft) => ({ mls, sqft, ppsf: 700 });
  const near = [at('A', 1500), at('B', 1350), at('C', 1690), at('D', 2600)];
  let b = core.compBand(near, 1500);
  eq([b.band, b.widened, b.rows.map(r => r.mls)], ['±20%', false, ['A', 'B', 'C']], 'compBand: 3 sold homes inside ±20% → no widening, nearest first');
  b = core.compBand([at('A', 1500), at('B', 1900), at('C', 1050), at('D', 2600)], 1500);
  eq([b.band, b.widened, b.rows.map(r => r.mls)], ['±40%', true, ['A', 'B', 'C']], 'compBand: fewer than 3 inside ±20% → ±40%');
  b = core.compBand([at('A', 1500), at('B', 2350), at('C', 500)], 1500);
  eq([b.band, b.widened, b.rows.map(r => r.mls)], ['±60%', true, ['A', 'B']], 'compBand: still fewer than 3 → ±60%, and keeps what fits');
  b = core.compBand([at('A', 1500)], 0);
  eq([b.band, b.rows.length], ['', 0], 'compBand: no subject square feet → no band');
}

// ---- what a sold home's remarks say ----
{
  const k = (t, yr) => core.classifyComp(t, yr).k;
  eq(k('Beautifully renovated top to bottom, nothing to do but move in.'), 'reno', 'classifyComp: completed-work wording → renovated sale');
  eq(k('Fully remodeled in 2024 with a new kitchen and baths.'), 'reno', 'classifyComp: "fully remodeled" → renovated sale');
  eq(k('New quartz counters, new stainless appliances and new hardwood floors.'), 'reno', 'classifyComp: two or more finishes done → renovated sale');
  eq(k('Sold as-is. Needs work throughout, bring your contractor.'), 'fixer', 'classifyComp: an as-is sale is a fixer, not an after-repair price');
  eq(k('Exceptional Renovation Opportunity to renovate this 1914 Edwardian.'), 'fixer', 'classifyComp: "renovation opportunity" is work still to do (21 College Terrace)');
  eq(k('Brand new home, new construction by a local builder.'), 'new', 'classifyComp: new construction is a different product');
  eq(k('Charming home with a lovely garden.', year - 3), 'new', 'classifyComp: a house built in the last 10 years is a different product');
  eq(k('New quartz counters in the kitchen.'), 'unknown', 'classifyComp: ONE updated finish is not a finished house');
  eq(k('Close to parks and shopping.'), 'unknown', 'classifyComp: silent on condition → unknown');
  eq(core.classifyComp('', 1950), { k: 'unknown', why: 'no remarks' }, 'classifyComp: no remarks → unknown, with the reason');
}

// ---- the ARV and its confidence ----
const row = (mls, sqft, ppsf, kind) => ({ mls, addr: mls + ' Main St', price: sqft * ppsf, sqft, ppsf, sold: '2026-09-01',
  bd: 3, ba: 2, yr: 1950, k: kind, why: kind ? kind + ' because' : '' });
{
  const band = { band: '±20%', widened: false, rows: [
    row('R1', 1500, 800, 'reno'), row('R2', 1480, 820, 'reno'), row('R3', 1520, 780, 'reno'), row('R4', 1450, 840, 'reno'),
    row('R5', 1560, 760, 'reno'), row('F1', 1500, 500, 'fixer'), row('U1', 1510, 650, 'unknown') ] };
  const a = core.compArv(1500, band, 40);
  eq([a.arv, a.ppsf, a.conf, a.basis, a.nReno, a.nUsed, a.nBand, a.total], [1200000, 800, 'High', 'renovated', 5, 5, 7, 40],
    'compArv: 5 renovated sales inside ±20% → High, median $/sqft of the renovated only');
  eq(a.list.map(r => [r.mls, r.use]), [['R1', 1], ['R2', 1], ['R3', 1], ['R4', 1], ['R5', 1], ['F1', 0], ['U1', 0]],
    'compArv: the homes it rests on come first, flagged use 1');
  eq(core.compSummary(a), 'ARV $1,200,000 · $800/sqft · 5 of 7 sold homes (±20%, renovated sales) · High confidence', 'compSummary: one line for the log');

  const wide = core.compArv(1500, Object.assign({}, band, { band: '±40%', widened: true }), 40);
  eq(wide.conf, 'Medium', 'compArv: 5 renovated sales but the band had to widen → Medium');

  const three = core.compArv(1500, { band: '±20%', widened: false, rows: band.rows.slice(2) }, 40);
  eq([three.conf, three.basis, three.ppsf], ['Medium', 'renovated', 780], 'compArv: 3 renovated sales → Medium');

  const few = core.compArv(1000, { band: '±20%', widened: false, rows: [
    row('R1', 1000, 900, 'reno'), row('U1', 1000, 700, 'unknown'), row('U2', 1000, 720, 'unknown'),
    row('F1', 1000, 400, 'fixer'), row('N1', 1000, 1200, 'new') ] }, 9);
  eq([few.conf, few.basis, few.ppsf, few.arv], ['Low', 'all', 720, 720000],
    'compArv: fewer than 3 renovated → Low, all sales that are not a fixer or a new build');
  eq(core.compSummary(few).includes('not enough renovated sales — all sales'), true, 'compSummary: says when it fell back to all sales');

  const allFixers = core.compArv(1000, { band: '±60%', widened: true, rows: [
    row('F1', 1000, 400, 'fixer'), row('F2', 1000, 420, 'fixer'), row('U1', 1000, 600, 'unknown') ] }, 3);
  eq([allFixers.conf, allFixers.nUsed, allFixers.ppsf], ['Low', 3, 420], 'compArv: too few plain sales → every sale in the band, Low');

  const unread = core.compArv(1000, { band: '±20%', widened: false, rows: [row('X1', 1000, 700), row('X2', 1000, 710), row('X3', 1000, 690)] }, 3);
  eq(unread.list.map(r => r.why), ['remarks not read', 'remarks not read', 'remarks not read'], 'compArv: a sold home past the first 8 says its remarks were not read');

  const many = Array.from({ length: 22 }, (_, i) => row('M' + i, 1000, 700 + i, i % 2 ? 'reno' : 'unknown'));
  const capped = core.compArv(1000, { band: '±20%', widened: false, rows: many }, 22);
  eq([capped.list.length, capped.list.slice(0, 11).every(r => r.use === 1)], [16, true], 'compArv: at most 16 in the list, the counted ones first');

  eq(core.compArv(1000, { band: '±60%', widened: true, rows: [] }, 12).reason, 'no sold home within 60% of its size',
    'compArv: sold homes in the zip but none near its size → blank ARV with the reason');
  eq(core.compArv(1000, { band: '', rows: [] }, 0).reason, 'no sold single-family homes in its zip in the last 14 months',
    'compArv: no sold homes at all → blank ARV with the reason');
  eq([core.compArv(0, band, 40).arv, core.compArv(0, band, 40).reason], [0, 'no square feet on the listing'], 'compArv: no square feet → no ARV');
  eq(core.compSummary(core.compArv(0, band, 40)), 'no ARV — no square feet on the listing', 'compSummary: no ARV says why');
  eq(core.compSummary(null), 'no ARV — comps not run', 'compSummary: comps not run');
}

// ---- the sheet's Comps column ----
{
  eq(core.compsJson([]), '', 'compsJson: no comps → a blank cell, never "[]"');
  const long = Array.from({ length: 30 }, (_, i) => ({ mls: 'ML' + (82050000 + i), addr: 'x'.repeat(100), why: 'y'.repeat(80) }));
  const s = core.compsJson(long);
  eq([JSON.parse(s).length, s.length < 50000], [16, true], 'compsJson: capped at 16 entries, well under a cell\'s limit');
}

// ---- a sold home's Client Full report ----
{
  const fixture = id => fs.readFileSync(path.join(__dirname, 'fixtures', id + '.txt'), 'utf8');
  // The live 844 Brunswick report, as it would read once sold.
  const sold = fixture('ML82056071').replace('Status:\tActive', 'Status:\tSold')
    .replace(/Sale Price:\t\tSale:\t/, 'Sale Price:\t$1,250,000\tSale:\t10/02/2026')
    .replace(/COE:\t/, 'COE:\t10/02/2026');
  const r = core.parseCompReport(sold, 'ML82056071');
  eq([r.mismatch, r.yearBuilt, r.soldPrice, r.soldDate], [false, '1904', 1250000, '2026-10-02'], 'parseCompReport: year, sale price and close date off the report');
  eq(r.remarks.startsWith('Welcome to this bright and versatile'), true, 'parseCompReport: the Public remarks, not the teaser');
  const active = core.parseCompReport(fixture('ML82056071'), 'ML82056071');
  eq([active.soldPrice, active.soldDate], ['', ''], 'parseCompReport: blank Sale Price / COE fields stay blank (never the next field)');
  eq(core.parseCompReport(fixture('SF426146279'), 'SF426146279').mismatch, true,
    'parseCompReport: a different listing left on screen is never read as this one');
}

// ---- the board lead carries the comps ----
{
  const comps = core.compArv(1500, { band: '±20%', widened: false, rows: [
    row('ML1000001', 1500, 800, 'reno'), row('ML1000002', 1480, 820, 'reno'), row('ML1000003', 1520, 780, 'reno') ] }, 3);
  const json = core.compsJson(comps.list);
  const l = core.boardLead({ mls: 'ML82056071', address: '844 Brunswick Street, San Francisco 94112', zip: '94112',
    arv: comps.arv, arvPpsf: comps.ppsf, compConf: comps.conf, comps: json });
  eq([l.arv, l.arvPpsf, l.compConf, l.comps.length, l.comps[0].mls, l.comps[0].use], [1200000, 800, 'Medium', 3, 'ML1000001', 1],
    'boardLead: ARV, $/sqft, confidence and the sold homes');
  eq(Object.keys(l.comps[0]), ['mls', 'addr', 'price', 'sqft', 'ppsf', 'sold', 'bd', 'ba', 'yr', 'use', 'why'], 'boardLead: each sold home has the board\'s fields');
  const junk = core.boardLead({ mls: 'ML82056071', comps: '[{"mls":"<img src=x>","price":"1"},{"mls":"ML1000009","sold":"yesterday","price":"lots"},7]' });
  eq(junk.comps.map(c => [c.mls, c.sold, c.price]), [['ML1000009', '', null]], 'boardLead: a bad MLS #, date or number in the Comps cell never reaches the board');
  eq(core.boardLead({ mls: 'ML82056071', comps: 'not json' }).comps, [], 'boardLead: an unreadable Comps cell is no comps');
  eq([core.boardLead({ mls: 'ML82056071' }).arv, core.boardLead({ mls: 'ML82056071' }).comps], [null, []], 'boardLead: a lead without comps has none');
}

if (fails) { console.error('\n' + fails + ' comps test(s) FAILED'); process.exit(1); }
console.log('\nall comps tests pass');
