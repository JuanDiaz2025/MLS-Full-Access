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
    if (rest === '/values:batchUpdate') {                // write many rows at once
      body.data.forEach(d => {
        const [tab, range] = d.range.split('!');
        const row = parseInt(range.match(/\d+/)[0], 10) - 1;
        const grid = tabs[tab] = tabs[tab] || [];
        while (grid.length <= row) grid.push([]);
        grid[row] = d.values[0].slice();
      });
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
      if (range === 'A1:ZZ') return json({ values: grid.map(r => r.slice()) });   // whole tab
      // read a range: a column slice (B2:B / A1:A1) or a whole row (A5:5)
      const col = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d*)$/);
      if (col && col[1] === col[3]) {
        const ci = colIndex(col[1]);
        const from = parseInt(col[2], 10) - 1;
        const to = col[4] ? parseInt(col[4], 10) : grid.length;
        return json({ values: grid.slice(from, to).map(r => [r[ci] === undefined ? '' : r[ci]]) });
      }
      const wholeRow = range.match(/^(\d+):(\d+)$/);
      if (wholeRow) {
        const r = grid[parseInt(wholeRow[1], 10) - 1];
        return json({ values: r && r.length ? [r] : [] });
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

  // 8. Reading a listing's facts off its Client Full report. The fixtures are
  //    real report text saved from Matrix, so a layout change breaks a test
  //    here instead of quietly writing blanks to the sheet.
  const { parseDetail } = require('./scan-core');
  const fixture = n => require('fs').readFileSync(require('path').join(__dirname, 'fixtures', n + '.txt'), 'utf8');

  const d1 = parseDetail(fixture('ML82056071'), 'ML82056071');
  eq(d1.address, '844 Brunswick Street, San Francisco 94112', 'full address off the report');
  eq(d1.zip, '94112', 'zip — the grid has no zip column at all');
  eq(d1.yearBuilt, '1904', 'year built, even though the grid Age cell is blank');
  eq(/^Welcome to this bright and versatile 4-bedroom/.test(d1.remarks), true,
    'the real Public: remarks, not the Open House teaser');

  const d2 = parseDetail(fixture('SF426150277'), 'SF426150277');
  eq(d2.address, '21 College Terrace, San Francisco 94112', 'second listing parses too');
  eq(d2.yearBuilt, '1914', 'second year built');

  // The one that matters: this page was served while the app had asked for
  // SF426146279, and it is showing a house in Lincoln instead. Reading "the
  // first address on the page" would have put that address on the lead.
  const d3 = parseDetail(fixture('SF426146279'), 'SF426146279');
  eq(d3.mismatch, true, 'a wrong-listing page is refused, not parsed');
  eq(d3.showing, 'CRPW26161101', 'and it names what was actually on screen');
  eq(parseDetail(fixture('SF426146279'), 'CRPW26161101').address,
    '220 Saddlehorn Loop, Lincoln 95648', 'the same page parses fine for its own MLS #');

  // 9. Quick flips only: cosmetic work in, engineer-and-permit work out. These
  //    are the calls the run makes unattended, so they get pinned down here.
  const rules = r => require('./scan-core').rulesDecide({ remarks: r, photos: 20 }).decision;
  eq(rules('Charming 1920s home, needs work throughout, sold as-is.'), 'keep', 'cosmetic fixer kept');
  eq(rules('Estate sale, original condition, first time on market in 60 years.'), 'keep', 'estate original kept');
  eq(rules('Beautiful crown moldings and original hardwood, needs updating.'), 'keep', '"moldings" is not mould');
  eq(rules('Contractor special. Foundation repair needed per inspection.'), 'drop', 'foundation work dropped');
  eq(rules('Great potential! Structural damage in the rear addition.'), 'drop', 'structural damage dropped');
  eq(rules('Tear-down opportunity, value is in the land.'), 'drop', 'tear-down dropped');
  eq(rules('Probate sale. Property is red-tagged and uninhabitable.'), 'drop', 'red-tagged dropped');
  eq(rules('Bring your contractor \u2014 needs a full gut.'), 'drop', 'full gut dropped');
  // Tenant-occupied is a drop again (Seth, 26 Sep: Juan won't take them), unless delivered vacant at close.
  eq(rules('Fixer upper. This level is currently tenant-occupied.'), 'drop', 'tenant-occupied is dropped');
  eq(rules('Fixer upper. Property is currently occupied by one tenant; tenant is expected to vacate prior to Close of Escrow.'), 'keep',
    'tenant leaving before close of escrow is kept');
  eq(rules('Fixer upper. Tenant occupied, to be delivered vacant.'), 'keep', '"delivered vacant" is kept');
  eq(require('./scan-core').rulesDecide({ remarks: 'Fixer upper. Please do not disturb occupant.', occupiedBy: 'Tenant', photos: 20 }).decision,
    'drop', 'Occupied By: Tenant drops even when the remarks never say "tenant"');
  eq(require('./scan-core').rulesDecide({ remarks: 'Fixer upper.', occupiedBy: 'Owner', photos: 20 }).decision,
    'keep', 'owner-occupied is not affected');
  eq(require('./scan-core').rulesDecide({ remarks: 'Tenant occupied.', addr: '21 College Terrace, San Francisco, CA 94112', photos: 20 }).decision,
    'keep', 'a confirmed deal is never dropped for a tenant');
  eq(rules('Beautifully updated with quartz counters and stainless appliances.'), 'drop', 'renovated dropped');
  eq(rules('Lovely garden, three bedrooms, close to transit.'), 'manual', 'silent remarks go to the fallback');

  // 10. "Renovation" cuts both ways, and getting it backwards cost us a live
  //     deal. 21 College Terrace reads "Exceptional Renovation Opportunity ...
  //     to renovate this 1914 Edwardian ... significant deferred maintenance"
  //     and a bare /renovat/ dropped it as already-renovated.
  eq(rules(parseDetail(fixture('SF426150277'), 'SF426150277').remarks), 'keep',
    '21 College Terrace is a KEEP (the miss that prompted this)');
  eq(rules('Exceptional Renovation Opportunity for contractors and investors.'), 'keep', 'renovation OPPORTUNITY kept');
  eq(rules('A rare chance to renovate this 1914 Edwardian to your taste.'), 'keep', 'chance TO renovate kept');
  eq(rules('Never renovated — original 1940s kitchen and bath.'), 'keep', 'NEVER renovated kept');
  eq(rules('Home requires extensive updating throughout.'), 'keep', 'requires updating kept');
  eq(rules('Beautifully renovated top to bottom in 2024.'), 'drop', 'actually renovated dropped');
  eq(rules('Turnkey home, nothing to do but move in.'), 'drop', 'turnkey dropped');
  eq(rules('Tastefully updated throughout.'), 'drop', 'updated throughout dropped');
  eq(rules('Recently updated with quartz counters and stainless steel appliances.'), 'drop', 'finish brags dropped');

  //     ONE finish redone is a light-rehab line item, not a flip. This is the
  //     844 Brunswick calibration, and it has to be enforced, not just written
  //     down — a bare /quartz/ was dropping exactly the houses we want.
  eq(rules('Charming 1904 home with granite counters in the kitchen.'), 'manual', 'one finish is not a flip');
  eq(rules('New roof installed 2023. Original kitchen and bath.'), 'manual', 'a new roof is not a flip');
  eq(rules('Quartz counters, new cabinets and stainless steel appliances.'), 'drop', 'three finishes IS a flip');
  eq(rules('Updated kitchen and updated bath with new flooring.'), 'drop', 'kitchen + bath + floors is a flip');

  //     Housekeeping words must NEVER drop a listing — HARD RULE #2 says judge
  //     the finishes, not the housekeeping. A spotless 1950s kitchen is the
  //     target, not a disqualification.
  eq(rules('Immaculate home showing pride of ownership throughout.'), 'manual', 'immaculate is housekeeping, not a drop');
  eq(rules('Pristine and impeccable, a true dream home.'), 'manual', 'pristine is housekeeping, not a drop');
  eq(rules('Meticulously maintained, lovingly cared for over 40 years.'), 'manual', 'well-kept is not renovated');
  eq(rules('Immaculate garden, but the house needs work throughout.'), 'keep', 'needs-work still wins');

  //     A confirmed deal outranks every screen, including its own remarks.
  const { rulesDecide, isConfirmed } = require('./scan-core');
  eq(isConfirmed('21 College Terrace'), true, 'confirmed list matches');
  eq(rulesDecide({ addr: '21 College Ter', remarks: 'Beautifully renovated turnkey dream home.', photos: 20 }).decision,
    'keep', 'a confirmed deal cannot be dropped by any keyword');
  eq(filterCandidates({ SF: { rows: [{ mls: 'X', addr: '21 College Terrace', price: '995000', sqft: '2185', age: '112', dom: '400' }] } })
    .candidates.length, 1, 'a confirmed deal survives even the DOM cap');

  // 11. Multi-unit vs multi-unit POTENTIAL. 347 Faxon Avenue is classed by the
  //     MLS as "Res. Single Family / Attached, Single Family"; its remarks only
  //     say a bonus room "could serve as ... an in-law setup" and the yard has
  //     room to "add an ADU". Neither exists, and the old rule dropped it.
  const faxon = parseDetail(fixture('SF426134156'), 'SF426134156');
  eq(/single family/i.test(faxon.propClass), true, 'the MLS class is read off the report');
  eq(rulesDecide({ addr: '347 Faxon Avenue', photos: 17, remarks: faxon.remarks,
    propClass: faxon.propClass }).decision, 'keep', '347 Faxon is a KEEP, not multi-unit');
  eq(rules('Bonus room down could serve as an in-law setup.'), 'manual', 'in-law POTENTIAL is not a drop');
  eq(rules('Large yard with room to add an ADU.'), 'manual', 'ADU potential is not a drop');
  eq(rulesDecide({ remarks: 'Rare duplex, two separate units, each with a full kitchen.', photos: 20 }).decision,
    'drop', 'an actual duplex still drops');
  eq(rulesDecide({ remarks: 'Rare duplex with two units.', photos: 20, propClass: 'Res. Single Family' }).decision,
    'manual', 'but the MLS class outranks the remarks');
  eq(rules('1st time on the market in 50 years, sold in present "as is" condition.'),
    'keep', '"1st time on the market" reads the same as "first time"');

  // 12. A tab left over from an OLD column layout must be corrected, not
  //     written into blindly. Checking only cell A1 meant a 23-column KPI tab
  //     kept its headers while the app wrote five values into the first five
  //     columns — "Leads Added" landed in a cell headed "Runs".
  const NEWK = ['Date', 'Leads Added', 'Auto-Dropped', 'Manually Removed', 'On List'];
  tabs = fakeSheets({ KPI: [['Date', 'Runs', 'Scanned', 'Candidates', 'Reviewed', 'Kept', 'Last Run']] });
  await gs.ensureTab('tok', 'ID', 'KPI', NEWK);
  eq(tabs.KPI[0].slice(0, 5), NEWK, 'a stale header row is rewritten');
  eq(tabs.KPI[0].slice(5), ['', ''], 'and the extra old headings are blanked');

  tabs = fakeSheets({ KPI: [NEWK.slice()] });
  await gs.ensureTab('tok', 'ID', 'KPI', NEWK);
  eq(tabs.KPI[0], NEWK, 'a correct header row is left alone');

  // 13. The qualification gate — Opportunity Score and A / B / C bucket.
  const { qualify } = require('./scan-core');
  const Q = (m) => qualify(Object.assign({ photos: 20, photosReliable: true }, m));
  eq(Q({ remarks: 'Beautifully renovated turnkey home.' }).bucket, 'C', 'renovated is C — auto-pass');
  eq(Q({ remarks: 'Beautifully renovated turnkey home.' }).score <= 15, true, 'and scores low');
  eq(Q({ remarks: 'Fixer. Foundation repair needed.' }).bucket, 'C', 'structural work is still C');
  eq(Q({ remarks: 'Rare duplex, two separate units, each with a full kitchen.' }).bucket, 'C', 'an actual duplex is still C');
  eq(Q({ remarks: 'Fixer upper, sold as-is. Tenant occupied, do not disturb.' }).bucket, 'C',
    'tenant-occupied is C');
  eq(Q({ remarks: 'Fixer upper, sold as-is. Tenant occupied, do not disturb.' }).hard, true,
    'as a hard exclusion (the AI is not asked)');
  eq(Q({ remarks: 'Fixer upper, sold as-is. Tenant to vacate prior to COE.', occupiedBy: 'Tenant' }).decision, 'keep',
    'tenant leaving before COE is kept');
  eq(/delivered vacant at close — confirm with the agent/.test(Q({ remarks: 'Fixer upper, sold as-is. Tenant to vacate prior to COE.', occupiedBy: 'Tenant' }).why),
    true, 'and the Why says to confirm it');
  eq(Q({ remarks: 'Fixer upper, sold as-is.', origPrice: 1000000, price: 900000, ppsfRatio: 0.7 }).bucket, 'A',
    'fixer + 10% price cut + cheap $/sqft is A — work now');
  eq(Q({ remarks: 'Fixer upper, sold as-is.' }).bucket, 'B', 'fixer language alone is B — needs a deeper look');
  eq(Q({ remarks: 'Lovely garden, three bedrooms, close to transit.' }).bucket, 'B', 'silent remarks are B, not dropped');
  eq(Q({ remarks: 'Lovely garden, three bedrooms, close to transit.', whenUnsure: 'drop' }).bucket, 'C',
    'unless "when unsure" is set to drop');
  eq(Q({ remarks: 'Professionally staged, quartz counters.', ppsfRatio: 1.3 }).bucket, 'C',
    'staged + a finish + priced above the area is C');
  eq(Q({ remarks: 'Charming 1904 home with granite counters in the kitchen.' }).bucket, 'B',
    'one updated finish alone is not an auto-pass (844 Brunswick)');
  eq(Q({ remarks: 'Nice home.', privateRemarks: 'Probate sale, cash only, sold as-is.' }).score >= 70, true,
    'private remarks count toward the score');
  eq(Q({ addr: '21 College Terrace', remarks: 'Beautifully renovated.' }).bucket, 'A', 'a confirmed deal is always A');
  eq(Q({ remarks: 'Lovely home.', photos: 4, photosReliable: true }).bucket, 'C', '4 photos off the full grid is C');
  eq(Q({ remarks: 'Lovely home.', photos: 4, photosReliable: false }).bucket, 'B',
    'but 4 carousel photos (grid failed) prove nothing');
  //     Real reports: the original price and the listing agent are read off
  //     them, and Faxon's $99k cut plus its as-is remarks make it an A.
  const fx = parseDetail(fixture('SF426134156'), 'SF426134156');
  eq([fx.origPrice, fx.listPrice], [998000, 899000], 'original and list price read off the report');
  eq(fx.listedBy, 'Jonathan Crossley, eXp Realty of California, Inc', 'listing agent read off the report');
  eq(Q({ addr: '347 Faxon Avenue', remarks: fx.remarks, propClass: fx.propClass, price: fx.listPrice,
    origPrice: fx.origPrice, yearBuilt: fx.yearBuilt }).bucket, 'A', '347 Faxon is an A');
  eq(require('./scan-core').privateRemarks('Public:\tNice.\nPrivate:\tTenant pays $2,400. Cash only.\n\nFeatures'),
    'Tenant pays $2,400. Cash only.', 'a "Private:" block is read');
  eq(require('./scan-core').privateRemarks('Listing Agent:\tJane Doe\nPublic:\tNice.'), '',
    'a contact line is not mistaken for remarks');

  //     Found on the first live run (23 Sep): "their" is not an heir, a blank
  //     condition field must not swallow the next one, and the MLS's own
  //     "Occupied By" field counts.
  eq(Q({ remarks: 'Fixer, ready for buyers to add their personal touch.' }).why.includes('probate'), false,
    '"their" is not an heir');
  eq(Q({ remarks: 'Fixer. Heirs are motivated.' }).why.includes('probate'), true, 'but "heirs" still is');
  const agentPage = 'MLS #:\tSF1234567\n10 Test St, San Francisco 94112\tStatus:\tActive\n'
    + 'Public:\tFixer.\nPrivate:\tSeller makes no warranty as to property condition, and dimensions.\n\n'
    + 'Showing Information\nOccupied By:\tVacant\tOwner:\t\n'
    + 'Fireplace:\t\tProp Condition:\t\nFamily Room:\t\tRoof:\t\n';
  const ap = parseDetail(agentPage, 'SF1234567');
  eq(ap.condition, '', 'a blank Prop Condition stays blank');
  eq(ap.occupiedBy, 'Vacant', '"Occupied By" is read off Agent Full');
  eq(ap.privateRemarks.startsWith('Seller makes'), true, 'the private remarks are read');
  eq(parseDetail(agentPage.replace('Prop Condition:\t', 'Prop Condition:\tFixer Upper'), 'SF1234567').condition,
    'Fixer Upper', 'a filled Prop Condition is read');
  eq(Q({ remarks: 'Nice.', occupiedBy: 'Tenant' }).bucket, 'C', 'Occupied By: Tenant is a C');

  //     Offer deadline — the MLS has no field for it, agents write it into
  //     the remarks. Shapes seen on live Agent Full pages (23 Sep).
  const { offerDue } = require('./scan-core');
  const OD = t => offerDue(t, '2026-09-23T09:00:00');
  eq(OD('No inspections done. All offers due Monday 9/21/26 6:00 PM. Disclosures online.'),
    '2026-09-21 (Mon) 6:00 PM', '"All offers due Monday 9/21/26 6:00 PM"');
  eq(OD('Go direct. Offers welcome on Wednesday, September 23rd by 10:00 am to the agent.'),
    '2026-09-23 (Wed) 10:00 AM', '"Offers welcome on Wednesday, September 23rd by 10:00 am"');
  eq(OD('Sold as-is. Offer date: 9/30/26 by Noon - please email offers.'), '2026-09-30 (Wed) 12:00 PM',
    '"Offer date: 9/30/26 by Noon"');
  eq(OD('Trust sale. Offers welcome Wednesday, 9/23, at 12 pm.'), '2026-09-23 (Wed) 12:00 PM',
    'a date with no year takes this year');
  eq(OD('Offers are due by Wed 9/23/26 at 4:00 pm.'), '2026-09-23 (Wed) 4:00 PM', '"Offers are due by … at 4:00 pm"');
  eq(OD('Call agent with questions. Offer Date TBD. Disclosure link to follow.'), 'TBD', '"Offer Date TBD"');
  eq(OD('Offer to include a copy of the 10% deposit check. Buyer to sign addenda w/ offer.'), '',
    'an offer instruction is not a deadline');
  eq(OD('Seller reserves the right to accept, counter or reject any offer.'), '', 'boilerplate is not a deadline');
  eq(OD('OFFERS to be submitted through the online portal.'), '', 'how to submit is not when');
  eq(OD('Offers due January 5th at 5pm.'), '2027-01-05 (Tue) 5:00 PM', 'a January date in September is next year');
  //     Seth's live examples, 23 Sep — two the reader missed, two it must leave alone.
  eq(OD('Please read: Offers will be accepted Monday Sept 28th. I do not have a foundation inspection.'),
    '2026-09-28 (Mon)', '"Offers will be accepted Monday Sept 28th"');
  eq(OD('Offers Due Wednesday the 23rd at 1:00 pm. Text seller time you will be coming.'),
    '2026-09-23 (Wed) 1:00 PM', '"Offers Due Wednesday the 23rd" — no month written');
  eq(OD('SOH 9/26 & 9/27 2-4pm. Discl. Avail Shortly. Offer date tbd. SQFT not verified.'), 'TBD',
    '"Offer date tbd" after open-house dates is TBD, not the open house');
  eq(OD('OH Sat/Sun Sept. 19/20 1 – 4pm, BT Tues. 9/22 10:30 – 1:30 Pre-escrow opened with Chicago Title.'), '',
    'open house and broker tour dates are not an offer deadline');
  eq(OD('7534 Adrian Dr. in Rohnert Park offers a compelling opportunity for buyers.'), '',
    '"offers a compelling opportunity" is not about offers');

  // 14. The Board — work order and the numbers on top.
  const { buildBoard } = require('./scan-core');
  const BH = ['MLS #', 'Address', 'Notes', 'Bucket', 'Opportunity Score', 'Offer Due'];
  const board = buildBoard([BH,
    ['M1', '1 Late Due', '', 'A — Work Now', '80', '2026-09-30 (Wed) 12:00 PM'],
    ['M2', '2 No Date', '', 'A — Work Now', '95', ''],
    ['M3', '3 Due Tomorrow', '', 'A — Work Now', '70', '2026-09-24 (Thu) 4:00 PM'],
    ['M4', '4 Passed', 'PASS-APPEARS WELL MAINTAINED', 'A — Work Now', '90', ''],
    ['M5', '5 B Tbd', 'OFFER SENT', 'B — AI Review', '60', 'TBD'],
    ['M6', '6 Unscored', '', '', '', ''],
  ], { scanned: 86, bucketA: 10, bucketB: 5, bucketC: 0 }, '2026-09-23T14:00:00');
  const listed = board.slice(9).map(r => r[5]);
  eq(listed, ['3 Due Tomorrow', '1 Late Due', '2 No Date', '5 B Tbd', '6 Unscored'],
    'Board order: A first, soonest offer deadline first, unscored last');
  eq(listed.includes('4 Passed'), false, 'a lead passed in Notes is not on the Board');
  eq(board[6].slice(1), [3, 1, 1, 1, 0, 0, 0, 1], 'Board counts: A, B, due in 48h, TBD, pending, closed, C, passed in Notes');
  eq(board[3].slice(1, 5), [86, 0, 5, 10], "today's funnel: scanned, C, B, A");
  eq(board[9][2], '9/24/2026 4:00 PM', 'the offer date is written as a real date');
  eq(/^=IF\(ISNUMBER\(C10\)/.test(board[9][3]), true, 'Time Left is a live formula on its own row');

  //     Closed listings come off the Board; pending ones sink to the bottom.
  const SH = ['MLS #', 'Address', 'Notes', 'Bucket', 'Opportunity Score', 'Offer Due', 'MLS Status', 'MLS Link'];
  const sb = buildBoard([SH,
    ['S1', '1 Sold', '', 'A — Work Now', '95', '', 'Sold', ''],
    ['S2', '2 Pending', '', 'A — Work Now', '90', '2026-09-24 (Thu) 4:00 PM', 'Pending', ''],
    ['S3', '3 Active B', '', 'B — AI Review', '50', '', 'Active', ''],
    ['S4', '4 Withdrawn', '', 'B — AI Review', '60', '', 'Withdrawn', ''],
    ['S5', '5 Active A', '', 'A — Work Now', '70', '', 'Active',
      'https://search.mlslistings.com/Matrix/Public/Portal.aspx?ID=SF426159646'],
  ], {}, '2026-09-23T14:00:00');
  eq(sb.slice(9).map(r => r[5]), ['5 Active A', '3 Active B', '2 Pending'],
    'sold and withdrawn are off the Board; pending goes after every active lead');
  eq(sb[6].slice(1), [1, 1, 0, 0, 1, 2, 0, 0], 'pending and closed are counted, and a pending deadline is not "due in 48h"');
  const linkCol = sb[8].indexOf('MLS Link');
  eq(sb[9][linkCol], 'https://www.mlslistings.com/Property/SF426159646', 'an old broken Portal link is rewritten on the Board');
  eq(sb[8].slice(5, 8), ['Address', 'Agent Phone', 'Showing'], 'the number to call sits right next to the address');
  const cb = buildBoard([SH, ['C1', '1 Auto Pass', '', 'C — Auto-Pass', '15', '', 'Active', ''],
    ['C2', '2 Live', '', 'B — AI Review', '50', '', 'Active', '']], {}, '2026-09-23T14:00:00');
  eq(cb.slice(9).map(r => r[5]), ['2 Live'], 'a C lead is off the Board');
  eq(cb[6][7], 1, 'and counted as Auto-Pass (C)');
  const { mlsUrl, fixLink } = require('./scan-core');
  eq(mlsUrl('CROC26191070'), 'https://www.mlslistings.com/Property/CROC26191070', 'the listing link is the public page');
  eq(fixLink('', 'ML82056071'), 'https://www.mlslistings.com/Property/ML82056071', 'a blank link is built from the MLS #');

  //     Agent contact, showing and disclosures off the Agent Full report.
  const agentFull = 'MLS #:\tSF7654321\n9 Test St, San Francisco 94112\tStatus:\tActive\n'
    + 'Public:\tFixer. Disclosures: https://app.glide.com/share/abc123.\nPrivate:\tCall first.\n\n'
    + 'Showing Information\nOccupied By:\t\tOwner:\t\nShow Contact:\t\tShow type:\t\tGt.Code:\t\n'
    + 'Instructions:\tLockbox - Supra iBox, Go Directly, Leave Card\n'
    + 'Disclosures URL:\t\nLA:\tJane Agent\tLA Ph:\t(415) 555-0142\t\nLA Lic#:\t0123\tLA Em:\tjane@example.com \n';
  const af = parseDetail(agentFull, 'SF7654321');
  eq(af.agentPhone, '(415) 555-0142', 'agent phone is read');
  eq(af.agentEmail, 'jane@example.com', 'agent email is read');
  eq(af.showing, 'Lockbox - Supra iBox, Go Directly, Leave Card', 'showing instructions are read, and a blank Show Contact adds nothing');
  eq(af.occupiedBy, '', 'a blank Occupied By does not swallow the next label');
  eq(require('./scan-core').disclosuresLink(af.disclosuresField, af.remarks), 'https://app.glide.com/share/abc123',
    'a blank Disclosures URL falls back to the link in the remarks');
  eq(require('./scan-core').rulesDecide({ remarks: 'A full set of plans approved by the City is at property. This is not a cosmetic remodel.', photos: 20 }).decision,
    'drop', '"not a cosmetic remodel" is not a quick flip');

  // 15. Google's limit is ~60 reads a minute. Refreshing ~90 rows used to
  //     cost two calls per row and was refused; it must be a handful now.
  {
    const H = ['MLS #', 'Address', 'Notes', 'MLS Link'];
    const grid = [H.slice()];
    for (let i = 0; i < 90; i++) grid.push(['M' + i, i + ' Test St', i === 3 ? 'my note' : '', 'old']);
    tabs = fakeSheets({ Leads: grid });
    let calls = 0; const real = global.fetch;
    global.fetch = (u, o) => { calls++; return real(u, o); };
    const recs = [];
    for (let i = 0; i < 90; i++) recs.push({ 'MLS #': 'M' + i, 'Notes': 'app text', 'MLS Link': 'new' });
    await gs.syncRows('tok', 'ID', 'Leads', H, 'MLS #', recs, { overwrite: ['MLS Link'] });
    eq(calls <= 6, true, `90 rows updated in ${calls} API calls (was ~180)`);
    eq(tabs.Leads[4][2], 'my note', 'a note typed by hand still survives the batched write');
    eq(tabs.Leads[50][3], 'new', 'an app-owned column is replaced in the batched write');
  }
  {
    // A quota refusal is waited out and retried, not thrown.
    tabs = fakeSheets({ Leads: [['MLS #']] });
    gs._setQuotaSleep(() => Promise.resolve());
    let refused = 0; const real = global.fetch;
    global.fetch = (u, o) => {
      if (refused < 2) { refused++; return Promise.resolve({ ok: false, status: 429,
        json: async () => ({ error: { message: "Quota exceeded for quota metric 'Read requests'" } }) }); }
      return real(u, o);
    };
    const info = await gs.listTabs('tok', 'ID');
    eq(info.tabs, ['Leads'], 'two "quota exceeded" answers in a row are retried, then it works');
  }

  // 16. The composed sheet value, end to end.
  eq(fa(d1.address, 'San Francisco', d1.zip), '844 Brunswick Street, San Francisco, CA 94112',
    'report address + zip compose without doubling the city');

  console.log(fails ? `\n${fails} failure(s)` : '\nall good');
  process.exit(fails ? 1 : 0);
})();
