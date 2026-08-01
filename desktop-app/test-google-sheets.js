/**
 * Offline test for google-sheets.js — run with `node desktop-app/test-google-sheets.js`.
 *
 * Stubs global.fetch with a tiny in-memory spreadsheet so the append/backfill
 * contract can be checked without a Google account. The rules being pinned down
 * here are the ones that have bitten us before: a duplicate MLS # must top up
 * the blank cells on the row that already exists instead of being skipped, and
 * a push must never overwrite something a human typed.
 */
const gs = require('./google-sheets');

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.error('FAIL ' + m + '\n  got      ' + A + '\n  expected ' + B); }
  else console.log('ok   ' + m);
};

/** An in-memory stand-in for one spreadsheet, wired to the endpoints the
 *  module actually calls. Anything else throws, so a silent API change in the
 *  module shows up here as a loud failure. */
function fakeSheets(initial) {
  const tabs = JSON.parse(JSON.stringify(initial));
  global.fetch = async (url, opts) => {
    opts = opts || {};
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const json = (o, ok) => ({ ok: ok !== false, status: ok === false ? 400 : 200, json: async () => o });

    // /v4/spreadsheets/<id>...
    const rest = u.pathname.replace(/^\/v4\/spreadsheets\/[^/]+/, '');

    if (rest === '' || rest === '/') {
      return json({ properties: { title: 'Flip Scout Agent' },
        sheets: Object.keys(tabs).map(t => ({ properties: { title: t } })) });
    }
    if (rest === ':batchUpdate') {
      body.requests.forEach(r => { if (r.addSheet) tabs[r.addSheet.properties.title] = []; });
      return json({});
    }
    const mVal = rest.match(/^\/values\/(.+?)(:append)?$/);
    if (mVal) {
      const a1 = decodeURIComponent(mVal[1]);
      const [tab, range] = a1.split('!');
      if (!tabs[tab]) tabs[tab] = [];
      const grid = tabs[tab];

      if (mVal[2] === ':append') {                       // append rows
        body.values.forEach(r => grid.push(r.slice()));
        return json({});
      }
      if (opts.method === 'PUT') {                       // write one row
        const row = parseInt(range.match(/\d+/)[0], 10) - 1;
        while (grid.length <= row) grid.push([]);
        grid[row] = body.values[0].slice();
        return json({});
      }
      // read a range: a column slice (B2:B / A1:A1) or a whole row (A5:5)
      const col = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d*)$/);
      if (col && col[1] === col[3]) {
        const ci = colIndex(col[1]);
        const from = parseInt(col[2], 10) - 1;
        const to = col[4] ? parseInt(col[4], 10) : grid.length;
        return json({ values: grid.slice(from, to).map(r => [r[ci] === undefined ? '' : r[ci]]) });
      }
      const oneRow = range.match(/^A(\d+):(\d+)$/);
      if (oneRow) {
        const r = grid[parseInt(oneRow[1], 10) - 1];
        return json({ values: r ? [r] : [] });
      }
      throw new Error('fake: unhandled range ' + range);
    }
    throw new Error('fake: unhandled path ' + u.pathname);
  };
  return tabs;
}
const colIndex = s => s.split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

// --------------------------------------------------------------------------
const HEADERS = ['Status', 'MLS #', 'Address', 'City', 'Zip', 'SqFt', 'Notes'];

(async () => {
  // 1. A brand-new tab gets its header row and the leads appended.
  let tabs = fakeSheets({ Sheet1: [] });
  let r = await gs.syncRows('tok', 'ID', 'Leads', HEADERS, 'MLS #', [
    { 'Status': 'Marginal', 'MLS #': 'SF1', 'Address': '1 A St', 'City': 'San Francisco', 'Zip': '94110', 'SqFt': 1200, 'Notes': '' },
    { 'Status': 'Marginal', 'MLS #': 'SF2', 'Address': '2 B St', 'City': 'San Francisco', 'Zip': '', 'SqFt': '', 'Notes': '' },
  ]);
  eq(tabs.Leads[0], HEADERS, 'header row written on a fresh tab');
  eq(tabs.Leads.length, 3, 'two leads appended');
  eq({ added: r.added, updated: r.updated }, { added: 2, updated: 0 }, 'reported 2 added');

  // 2. The same MLS # again, now carrying the zip and sqft that were missing.
  //    This is the case that used to be skipped outright.
  r = await gs.syncRows('tok', 'ID', 'Leads', HEADERS, 'MLS #', [
    { 'Status': 'Marginal', 'MLS #': 'SF2', 'Address': '2 B St', 'City': 'San Francisco', 'Zip': '94124', 'SqFt': 980, 'Notes': '' },
  ]);
  eq(tabs.Leads.length, 3, 'no duplicate row for a known MLS #');
  eq(tabs.Leads[2][4], '94124', 'blank Zip backfilled');
  eq(tabs.Leads[2][5], 980, 'blank SqFt backfilled');
  eq({ added: r.added, updated: r.updated, filled: r.filled }, { added: 1 - 1, updated: 1, filled: 2 }, 'reported 1 updated, 2 cells filled');

  // 3. A human edit must survive a later push of different data.
  tabs.Leads[2][6] = 'called the agent — probate';
  await gs.syncRows('tok', 'ID', 'Leads', HEADERS, 'MLS #', [
    { 'Status': 'Marginal', 'MLS #': 'SF2', 'Address': '2 B St', 'City': 'San Francisco', 'Zip': '94124', 'SqFt': 980, 'Notes': 'auto note' },
  ]);
  eq(tabs.Leads[2][6], 'called the agent — probate', "a reviewer's note is not overwritten");

  // 4. KPI-style upsert: the app's own counters DO get replaced, the
  //    reviewer's column beside them does not.
  const K = ['Date', 'Runs', 'Kept', 'Reviewer Removed'];
  tabs = fakeSheets({ KPI: [K, ['2026-08-01', 1, 3, 2]] });
  await gs.syncRows('tok', 'ID', 'KPI', K, 'Date',
    [{ 'Date': '2026-08-01', 'Runs': 4, 'Kept': 11, 'Reviewer Removed': '' }],
    { overwrite: ['Date', 'Runs', 'Kept'] });
  eq(tabs.KPI[1], ['2026-08-01', 4, 11, 2], 'app counters replaced, reviewer column kept');

  // 5. A key column that is not in the headers is a mistake worth shouting about.
  await gs.syncRows('tok', 'ID', 'KPI', K, 'Nope', [])
    .then(() => { fails++; console.error('FAIL a missing key column should throw'); })
    .catch(() => console.log('ok   a missing key column throws'));

  // 6. One address column, assembled from the pieces the MLS returns separately.
  const { fullAddress: fa, filterCandidates } = require('./scan-core');
  eq(fa('1326 Palou Avenue', 'San Francisco', '94124'), '1326 Palou Avenue, San Francisco, CA 94124', 'full address');
  eq(fa('844 Brunswick St', 'San Francisco', ''), '844 Brunswick St, San Francisco, CA', 'no zip yet');
  eq(fa('21 College Terrace, San Francisco', 'San Francisco', '94112'), '21 College Terrace, San Francisco, CA 94112', 'city not doubled');
  eq(fa('100 Main St, Oakland, CA 94601', 'Oakland', '94601'), '100 Main St, Oakland, CA 94601', 'already complete');
  eq(fa('', '', ''), '', 'nothing in, nothing out');

  // 7. The 45-day cap, and the blank-DOM case that must NOT be read as stale.
  const row = (mls, dom, age) => ({ mls: mls, addr: mls + ' Test St', price: '900000', sqft: '1000', age: String(age), dom: String(dom) });
  const f = filterCandidates({ SF: { rows: [
    row('A', 12, 60), row('B', 45, 60), row('C', 46, 60), row('D', 400, 60), row('E', '', 60),
  ] } });
  eq(f.candidates.map(c => c.mls).sort(), ['A', 'B', 'E'], '<=45 days kept, blank DOM kept');
  eq(f.rejected.map(c => c.mls).sort(), ['C', 'D'], '46 and 400 days dropped');
  eq(/over the 45-day limit/.test(f.rejected[0]._reason), true, 'the DOM drop says why');

  console.log(fails ? `\n${fails} failure(s)` : '\nall good');
  process.exit(fails ? 1 : 0);
})();
