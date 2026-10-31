/**
 * Offline test for MLS districts (v1.75.5) — run with `node desktop-app/test-lead-areas.js`.
 * Which leads get a lookup (San Francisco, none known yet, not tried this
 * week, newest first), each Lead Areas row, and the tab those rows make on a
 * stand-in spreadsheet: a later find replaces "not found", and nothing typed
 * by hand on the tab is lost. The lookup itself (main.js teamLeadArea) needs
 * the live MLS; it is the one Team comps already uses.
 */
const core = require('./scan-core');
const gs = require('./google-sheets');

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.error('FAIL ' + m + '\n  got      ' + A + '\n  expected ' + B); }
  else console.log('ok   ' + m);
};

// ---- which addresses are San Francisco ----
eq(core.isSanFrancisco('848 Foerster Street, San Francisco, CA 94127'), true, 'a San Francisco address');
eq(core.isSanFrancisco('84 Duval Drive, South San Francisco, CA 94080'), false, 'South San Francisco is its own city');
eq(core.isSanFrancisco('2150 35Th Ave, Oakland, CA 94601'), false, 'Oakland is not');
eq(core.isSanFrancisco('San Francisco'), false, 'a bare city name is no address');
eq([core.AREA_TAB, core.AREA_HEADERS[0], core.AREA_RETRY_DAYS], ['Lead Areas', 'MLS #', 7], 'its own tab, keyed on MLS #, retried weekly');

// ---- which leads get a lookup ----
const leads = [
  { mls: 'SF425054354', addr: '2240 Silver Avenue, San Francisco, CA 94124', row: 2 },   // Team comps knows it
  { mls: 'SF426170649', addr: '364 Madison Street, San Francisco, CA 94134', row: 3 },
  { mls: 'CC41152583', addr: '2150 35Th Ave, Oakland, CA 94601', row: 4 },                // not SF
  { mls: 'BE41152242', addr: '387 Staples Ave, San Francisco, CA 94112', row: 5 },
  { mls: 'ML82000001', addr: '1 Tried Ln, San Francisco, CA 94112', row: 6 },              // failed 2 days ago
  { mls: 'ML82000002', addr: '2 Tried Ln, San Francisco, CA 94112', row: 7 },              // failed 8 days ago
  { mls: 'sf426170649', addr: '364 Madison Street, San Francisco, CA 94134', row: 8 },     // the same lead twice
  { mls: 'not-an-mls', addr: '3 Odd St, San Francisco, CA 94110', row: 9 },
  { mls: 'ML82000003', addr: '4 Known Ln, San Francisco, CA 94110', row: 10 },             // Lead Areas knows it
];
const known = { SF425054354: 'District 10G - Silver Terrace', ML82000003: 'District 9C - Inner Mission' };
const tried = { ML82000001: '2026-10-29', ML82000002: '2026-10-23' };
eq(core.areaTodo(leads, known, tried, '2026-10-31').map(l => l.mls), ['ML82000002', 'BE41152242', 'SF426170649'],
  'SF leads with no district yet, newest row first; a failed one waits a week; each lead once');
eq(core.areaTodo(leads, {}, {}, '2026-10-31').length, 6, 'with nothing known, every SF lead with a real MLS # (once each)');
eq(core.areaTodo([], known, tried, '2026-10-31'), [], 'an empty sheet has nothing to do');

// ---- each row ----
eq(core.areaRecord({ mls: 'sf426170649', addr: '364 Madison Street, San Francisco, CA 94134' }, 'District 10H - Portola', '', '2026-10-31'),
  { 'MLS #': 'SF426170649', 'Address': '364 Madison Street, San Francisco, CA 94134', 'Lead Area': 'District 10H - Portola', 'Looked Up On': '2026-10-31', 'Note': '', __clear: ['Note'] },
  'a found district, and an old note cleared');
eq(core.areaRecord({ mls: 'BE41152242', addr: '387 Staples Ave, San Francisco, CA 94112' }, '', 'its MLS # alone counts 0 match(es), not 1', '2026-10-31').Note,
  'not found: its MLS # alone counts 0 match(es), not 1', 'a miss says why');

// ---- the tab, on a stand-in spreadsheet ----
function fakeSheets(initial) {
  const tabs = JSON.parse(JSON.stringify(initial));
  const json = o => ({ ok: true, status: 200, json: async () => o });
  global.fetch = async (url, opts) => {
    opts = opts || {};
    const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : null;
    const rest = u.pathname.replace(/^\/v4\/spreadsheets\/[^/:]+/, '');
    if (rest === '' || rest === '/') return json({ properties: { title: 'Twin Network — Leads' }, sheets: Object.keys(tabs).map(t => ({ properties: { title: t } })) });
    if (rest === ':batchUpdate') { body.requests.forEach(r => { if (r.addSheet) tabs[r.addSheet.properties.title] = []; }); return json({}); }
    if (rest === '/values:batchUpdate') {
      body.data.forEach(d => { const [tab, range] = d.range.split('!'); const row = parseInt(range.match(/\d+/)[0], 10) - 1; const g = tabs[tab]; while (g.length <= row) g.push([]); g[row] = d.values[0].slice(); });
      return json({});
    }
    const mVal = rest.match(/^\/values\/(.+?)(:append)?$/);
    if (mVal) {
      const [tab, range] = decodeURIComponent(mVal[1]).split('!'), g = tabs[tab] = tabs[tab] || [];
      if (mVal[2] === ':append') { body.values.forEach(r => g.push(r.slice())); return json({}); }
      if (opts.method === 'PUT') { const row = parseInt(range.match(/\d+/)[0], 10) - 1; while (g.length <= row) g.push([]); g[row] = body.values[0].slice(); return json({}); }
      if (range === 'A1:ZZ') return json({ values: g.map(r => r.slice()) });
      const oneRow = range.match(/^A?(\d+):(\d+)$/);
      if (oneRow) { const r = g[parseInt(oneRow[1], 10) - 1]; return json({ values: r && r.length ? [r] : [] }); }
      throw new Error('fake: unhandled range ' + range);
    }
    throw new Error('fake: unhandled path ' + u.pathname);
  };
  return tabs;
}

(async () => {
  const H = core.AREA_HEADERS, opt = { overwrite: H };
  const tabs = fakeSheets({ Leads: [['MLS #', 'Address']] });
  // first run: one found, one not
  await gs.syncRows('tok', 'ID', core.AREA_TAB, H, 'MLS #', [
    core.areaRecord(leads[1], 'District 10H - Portola', '', '2026-10-31'),
    core.areaRecord(leads[3], '', 'the Area list did not narrow to one', '2026-10-31'),
  ], opt);
  eq(tabs[core.AREA_TAB], [H,
    ['SF426170649', '364 Madison Street, San Francisco, CA 94134', 'District 10H - Portola', '2026-10-31', ''],
    ['BE41152242', '387 Staples Ave, San Francisco, CA 94112', '', '2026-10-31', 'not found: the Area list did not narrow to one']],
    'the Lead Areas tab is made with its header, a found row and a missed one');
  eq(tabs.Leads, [['MLS #', 'Address']], 'the Leads tab is not touched');
  // a person types a district by hand on another row; a week later the miss is found
  tabs[core.AREA_TAB].push(['ML82000009', '9 Hand St, San Francisco, CA 94110', 'District 9A - Mission', '', 'typed by Cherry']);
  await gs.syncRows('tok', 'ID', core.AREA_TAB, H, 'MLS #', [core.areaRecord(leads[3], 'District 10D - Outer Mission', '', '2026-11-07')], opt);
  eq(tabs[core.AREA_TAB][2], ['BE41152242', '387 Staples Ave, San Francisco, CA 94112', 'District 10D - Outer Mission', '2026-11-07', ''],
    'a later find fills the district and clears "not found"');
  eq(tabs[core.AREA_TAB][3], ['ML82000009', '9 Hand St, San Francisco, CA 94110', 'District 9A - Mission', '', 'typed by Cherry'], 'a row typed by hand stays as it was');
  // a found district is never blanked by a later miss
  await gs.syncRows('tok', 'ID', core.AREA_TAB, H, 'MLS #', [core.areaRecord(leads[1], '', 'its MLS # alone counts 2 match(es), not 1', '2026-11-08')], opt);
  eq(tabs[core.AREA_TAB][1][2], 'District 10H - Portola', 'a later miss never wipes a found district');
  // what the next run reads back
  const back = {}, retry = {};
  tabs[core.AREA_TAB].slice(1).forEach(r => { if (r[2]) back[r[0]] = r[2]; else if (r[3]) retry[r[0]] = r[3]; });
  eq(core.areaTodo(leads, back, retry, '2026-11-08').map(l => l.mls), ['ML82000003', 'ML82000002', 'ML82000001', 'SF425054354'],
    'the next run skips what the tab has, and retries week-old misses (Team comps\' areas are added in main.js)');

  console.log(fails ? `\n${fails} FAILED` : '\nall MLS district tests pass');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
