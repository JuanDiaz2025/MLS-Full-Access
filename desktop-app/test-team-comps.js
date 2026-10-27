/**
 * Offline test for team comps (v1.75) — run with `node desktop-app/test-team-comps.js`.
 * The market, the sold grid's rows, which sales fit on size, beds, age and
 * days on market, the Team Comps tab's row, the lead's MLS area found by
 * halving the Area list, and the weekly skip. The searches themselves
 * (main.js teamLeadArea, teamSoldSearch) need the live MLS.
 */
const core = require('./scan-core');

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.error('FAIL ' + m + '\n  got      ' + A + '\n  expected ' + B); }
  else console.log('ok   ' + m);
};
const year = new Date().getFullYear();

// ---- market (the board widens SF 1/2 -> 1 -> 2, cities 1 -> 2, the rest 1 -> 5 mi) ----
eq(core.teamMarket('848 Foerster Street, San Francisco, CA 94127'), 'sf', 'San Francisco');
eq(core.teamMarket('1408 Royal Avenue, San Mateo, CA 94401'), 'city', 'San Mateo County is a Bay Area city market');
eq(core.teamMarket('685 Rosal Ave, Oakland, CA 94610'), 'city', 'Alameda County too');
eq(core.teamMarket('123 Horn Ave, Santa Rosa, CA 95407'), 'thin', 'Sonoma is thin');
eq(core.teamMarket('no city here'), 'thin', 'an address with no city reads as thin');
eq(core.TEAM_HEADERS[0], 'MLS #', 'the Team Comps tab is keyed on MLS #');
eq([core.TEAM_SOLD_MONTHS, core.FIELDS.saleDate, core.FIELDS.area], [6, '#Fm9_Ctrl1164_TB', '#Fm9_Ctrl1740_LB'], 'sold in the last 6 months, on the form\'s Sale Date and Area boxes');

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
const rec = core.teamRecord({ mls: 'ML82063768', addr: '549 6th Avenue, Menlo Park, CA 94025' }, 'city', 'zip 94025', rows, '', '2026-10-27');
eq(Object.keys(rec), core.TEAM_HEADERS, 'the record has exactly the tab\'s columns');
eq([rec['Searched'], rec['Sales Found'], rec['Team Comps Run On'], rec['Market'], rec['Area Sales']], ['zip 94025', 4, '2026-10-27', 'city', ''],
  'what was searched, count, date, market; a zip search lists no area sales');
eq(JSON.parse(rec['Team Comps']).map(r => r.mls), ['SF426153172', 'ML82054264', 'ML82049328', 'BE41146343'], 'sales are nearest first, no distance last');
const failed = core.teamRecord({ mls: 'L', addr: 'a' }, 'thin', '', [], 'search failed: x', '');
eq([failed['Searched'], failed['Team Comps'], failed['Team Comps Run On'], failed['Note']], ['', '', '', 'search failed: x'],
  'a failed search is not stamped, so the next run tries it again');
// an area search keeps the sales that fit, and lists every MLS # it found
const inArea = core.teamRecord({ mls: 'L', addr: 'a', area: '330 - Dumbarton Etc.' }, 'city', 'MLS area', rows.slice(0, 1), '', '2026-10-27', rows);
eq([inArea['Sales Found'], JSON.parse(inArea['Team Comps']).length, inArea['Area Sales']], [4, 1, 'ML82054264,ML82049328,SF426153172,BE41146343'],
  'Sales Found counts the area\'s sales; Team Comps keeps the fits; Area Sales lists them all');
const many = Array.from({ length: 400 }, (_, i) => ({ mls: 'ML8' + String(i).padStart(7, '0'), addr: 'Some Long Street Name ' + i, price: 1000000, sqft: 1500,
  bd: 3, ba: 2, yr: 1960, sold: '2026-09-01', dom: 10, mi: i / 100, area: '330 - Dumbarton Etc.', city: 'Redwood City' }));
const big = core.teamRecord({ mls: 'L', addr: 'a' }, 'thin', 'MLS area', many, '', '2026-10-27');
eq(big['Team Comps'].length <= 45000 && JSON.parse(big['Team Comps']).length > 100, true, 'a big result is trimmed (farthest first) to fit a cell');
eq(big['Sales Found'], 400, 'the count says how many were found before trimming');

// ---- v1.75.1: the lead's MLS area, same-area marks, the weekly skip ----
eq(core.TEAM_HEADERS.slice(-2), ['Lead Area', 'Area Sales'], 'the area columns come last');
eq(core.teamRecord({ mls: 'L', addr: 'a', area: '330 - Dumbarton Etc.' }, 'city', 'MLS area', [], '', '2026-10-27')['Lead Area'], '330 - Dumbarton Etc.', 'the record carries the lead\'s area');
eq(rec['Lead Area'], '', 'no area found -> blank');
eq(core.teamFresh('2026-10-27', '2026-10-27'), true, 'searched today: skipped');
eq(core.teamFresh('2026-10-21', '2026-10-27'), true, 'searched 6 days ago: skipped');
eq(core.teamFresh('2026-10-20', '2026-10-27'), false, 'searched 7 days ago: due again');
eq([core.teamFresh('', '2026-10-27'), core.teamFresh('junk', '2026-10-27'), core.teamFresh('2026-10-28', '2026-10-27')], [false, false, false],
  'no date, a bad date or a future date: searched again');

// the Area list, halved: a mock form whose lead sits in option `at` of `n`
const form = (n, at, also) => {
  const asked = [];
  return { asked, countOf: async (lo, hi) => { asked.push([lo, hi]); return also ? also(lo, hi) : (at >= lo && at < hi ? '1' : '0'); } };
};
(async () => {
  for (const [n, at] of [[1, 0], [2, 1], [7, 0], [7, 6], [600, 331], [601, 600]]) {
    const f = form(n, at);
    eq(await core.teamFindArea(n, f.countOf), at, `finds area ${at} of ${n}`);
    if (n === 600) eq(f.asked.length <= Math.ceil(Math.log2(n)) + 2, true, `in ${f.asked.length} counts (600 areas)`);
  }
  eq(await core.teamFindArea(0, form(0, 0).countOf), -1, 'an empty list finds nothing');
  eq(await core.teamFindArea(8, form(8, 3, () => '?').countOf), -1, 'a count that will not read: no area, never a guess');
  eq(await core.teamFindArea(8, form(8, 3, () => '0').countOf), -1, 'a lead in none of the areas: the last one does not check out');
  eq(await core.teamFindArea(8, form(8, 3, () => '1').countOf), -1, 'a list that filters nothing (always 1): the other areas do not count 0, so no area');
  eq(await core.teamFindArea(1, form(1, 0, () => '1').countOf), 0, 'a one-area list that counts 1 is that area');

  const marked = core.teamSameArea([{ mls: 'ML1' }, { mls: 'ML2' }, { mls: 'ML3' }], ['ml2', 'ML3']);
  eq(marked.map(r => r.sa), [0, 1, 1], 'sales are marked in the area (1) or not (0)');

  console.log(fails ? `\n${fails} FAILED` : '\nall team comps tests pass');
  process.exit(fails ? 1 : 0);
})();
