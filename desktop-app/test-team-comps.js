/**
 * Offline test for team comps (v1.75) — run with `node desktop-app/test-team-comps.js`.
 * The market's radius steps, the sold grid's rows with Distance / DOM / Area,
 * which sales fit on size, beds and age, and the Team Comps tab's row. The
 * radius search itself (main.js teamSoldSearch) needs the live MLS.
 */
const core = require('./scan-core');

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.error('FAIL ' + m + '\n  got      ' + A + '\n  expected ' + B); }
  else console.log('ok   ' + m);
};
const year = new Date().getFullYear();

// ---- market -> radius steps ----
eq(core.teamMarket('848 Foerster Street, San Francisco, CA 94127'), 'sf', 'San Francisco starts at 1/2 mile');
eq(core.teamMarket('1408 Royal Avenue, San Mateo, CA 94401'), 'city', 'San Mateo County is a Bay Area city market');
eq(core.teamMarket('685 Rosal Ave, Oakland, CA 94610'), 'city', 'Alameda County too');
eq(core.teamMarket('123 Horn Ave, Santa Rosa, CA 95407'), 'thin', 'Sonoma widens to 5 miles');
eq(core.teamMarket('no city here'), 'thin', 'an address with no city reads as thin');
eq(core.TEAM_STEPS.sf, [0.5, 1, 2], 'SF steps');
eq(core.TEAM_STEPS.city, [1, 2], 'city steps');
eq(core.TEAM_STEPS.thin, [1, 2, 3, 5], 'thin steps');
eq(core.TEAM_HEADERS[0], 'MLS #', 'the Team Comps tab is keyed on MLS #');

// ---- grid rows -> team rows ----
const grid = [
  { mls: 'ML82054264', addr: '750 6th Avenue', price: '$1,270,000', dom: '7', sqft: '885', bds: '2', baths: '1|0', age: '71', dist: '0.3 mi', area: '330 - Dumbarton Etc.', city: 'Redwood City', sold: '' },
  { mls: 'ML82049328', addr: '528 Macarthur Avenue', price: '$928,000', dom: '34', sqft: '740', bds: '3', baths: '1|0', age: '85', dist: '0.5', city: 'Redwood City' },
  { mls: 'SF426153172', addr: '525 6th Avenue', price: '$1,225,000', dom: '0', sqft: '1,050', bds: '2', baths: '1|0', age: '90', dist: '0.0 mi' },
  { mls: 'ML82063768', addr: 'the lead itself', price: '$925,000', sqft: '760' },
  { mls: 'ML82054264', addr: '750 6th Avenue (repeat)', price: '$1,270,000', sqft: '885' },
  { mls: 'BE41146343', addr: 'no distance column', price: '$2,760,000', dom: '', sqft: '1,600', bds: '3', baths: '2|0', age: '71' },
];
const rows = core.teamRows(grid, 'ml82063768');
eq(rows.map(r => r.mls), ['ML82054264', 'ML82049328', 'SF426153172', 'BE41146343'], 'the lead and repeats are left out');
eq(rows[0], { mls: 'ML82054264', addr: '750 6th Avenue', price: 1270000, sqft: 885, bd: 2, ba: 1, yr: year - 71, sold: '', dom: 7,
  mi: 0.3, area: '330 - Dumbarton Etc.', city: 'Redwood City' }, 'a row keeps distance, DOM, area and city');
eq(rows[2].dom, 0, '0 days on market is kept as 0, not blank');
eq(rows[3].mi, '', 'no Distance column -> no miles');
eq(rows[3].dom, '', 'no DOM -> blank');

// ---- which fit on size, beds and age ----
const lead = { mls: 'ML82063768', sqft: 760, beds: 2, year: 1957 };
eq(core.teamFits(rows, lead).map(r => r.mls), ['ML82054264', 'ML82049328'],
  '750 6th (+16%, built 1955) and 528 Macarthur (3 bd) fit; 525 6th (+38%, 0 DOM) and the 1,600 sqft sale do not');
eq(core.teamFits([{ mls: 'X', sqft: 760, bd: 2, yr: 1957, dom: 0 }], lead).length, 0, 'a 0-days-on-market sale never fits');
eq(core.teamFits([{ mls: 'X', sqft: 760, bd: 2, yr: 1957, dom: '' }], lead).length, 1, 'a blank DOM is not a 0');

// ---- the Team Comps tab's row ----
const rec = core.teamRecord({ mls: 'ML82063768', addr: '549 6th Avenue, Menlo Park, CA 94025' }, 'city', 2, rows, '', '2026-10-27');
eq(Object.keys(rec), core.TEAM_HEADERS, 'the record has exactly the tab\'s columns');
eq([rec['Radius Searched'], rec['Sales Found'], rec['Team Comps Run On'], rec['Market']], ['2 mi', 4, '2026-10-27', 'city'], 'radius, count, date, market');
eq(JSON.parse(rec['Team Comps']).map(r => r.mls), ['SF426153172', 'ML82054264', 'ML82049328', 'BE41146343'], 'sales are nearest first, no distance last');
const failed = core.teamRecord({ mls: 'L', addr: 'a' }, 'thin', 0, [], 'search failed: x', '');
eq([failed['Radius Searched'], failed['Team Comps'], failed['Team Comps Run On'], failed['Note']], ['', '', '', 'search failed: x'],
  'a failed search is not stamped, so the next run tries it again');
const many = Array.from({ length: 400 }, (_, i) => ({ mls: 'ML8' + String(i).padStart(7, '0'), addr: 'Some Long Street Name ' + i, price: 1000000, sqft: 1500,
  bd: 3, ba: 2, yr: 1960, sold: '2026-09-01', dom: 10, mi: i / 100, area: '330 - Dumbarton Etc.', city: 'Redwood City' }));
const big = core.teamRecord({ mls: 'L', addr: 'a' }, 'thin', 5, many, '', '2026-10-27');
eq(big['Team Comps'].length <= 45000 && JSON.parse(big['Team Comps']).length > 100, true, 'a big result is trimmed (farthest first) to fit a cell');
eq(big['Sales Found'], 400, 'the count says how many were found before trimming');

console.log(fails ? `\n${fails} FAILED` : '\nall team comps tests pass');
process.exit(fails ? 1 : 0);
