/**
 * Offline test for the Lead Board hand-off and Redfin links — run with
 * `node desktop-app/test-remarks.js`. (Remarks, offer due, private remarks and
 * the agent's phone/email are covered by test-google-sheets.js, against saved
 * live report pages.)
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

// ---- a lead as the Lead Board stores it ----
{
  const l = core.boardLead({
    mls: 'sf426150277', address: '21 College Terrace, San Francisco 94112', city: 'San Francisco', zip: '94112',
    price: 995000, ppsf: 455, sqft: 2185, beds: '3', yearBuilt: 1914, dom: '',
    remarks: 'Exceptional Renovation   Opportunity.', privateRemarks: 'Probate, no court confirmation.',
    showing: 'Go direct', offerDue: '2026-09-30 (Wed) 12:00 PM',
    listedBy: 'Karyn Kambur, Coldwell Banker Realty', agentPhone: '(415) 555-0142', agentEmail: 'karyn@cb.com',
    bucketLabel: 'A — Work Now', oppScore: 78, why: 'probate · 44% below median', mlsStatus: 'Active',
    redfin: 'https://www.redfin.com/CA/San-Francisco/21-College-Ter-94112/home/809328',
  });
  eq([l.mls, l.addr], ['SF426150277', '21 College Terrace, San Francisco, CA 94112'], 'board lead: MLS # and one full address');
  eq([l.offerDue, l.offerTime], ['2026-09-30', '12:00 PM'], 'board lead: offer due split into date and time for the board');
  eq([l.agentName, l.agentPhone, l.agentEmail], ['Karyn Kambur', '(415) 555-0142', 'karyn@cb.com'], 'board lead: listing agent name, phone, email');
  eq(l.agentRemarks, 'Probate, no court confirmation.', 'board lead: private remarks travel as the agent remarks');
  eq(l.remarks, 'Exceptional Renovation Opportunity.', 'board lead: public remarks, whitespace tidied');
  eq(l.why, 'A — Work Now · score 78 · probate · 44% below median', 'board lead: bucket and score in the why');
  eq([l.dom, l.beds], [null, 3], 'board lead: blank DOM stays blank, numbers are numbers');

  const bad = core.boardLead({ mls: 'ML1', offerDue: 'TBD', agentPhone: 'call me', agentEmail: 'nope',
    redfin: 'https://www.zillow.com/x', listedBy: '' });
  eq([bad.offerDue, bad.offerPhrase], ['', 'Offer date TBD'], 'board lead: TBD is not a date, but is said');
  eq([bad.agentPhone, bad.agentEmail, bad.redfin], ['', '', ''], 'board lead: junk phone, email and non-Redfin link are dropped');
}

// ---- Coming Soon listings ----
{
  eq([core.isComingSoon('Coming Soon'), core.isComingSoon('COMING-SOON'), core.isComingSoon('Active')], [true, true, false],
    'Coming Soon status recognised however the MLS spells it');
  const base = { addr: '1 Test St', remarks: 'Charming home near parks and shopping.', photos: 2, photosReliable: true,
    price: 800000, dom: '', yearBuilt: 1950, propClass: 'Res. Single Family / Detached', whenUnsure: 'keep' };
  eq(core.qualify(base).bucket, 'C', 'an Active listing with 2 photos is still an auto-pass');
  const cs = core.qualify({ ...base, comingSoon: true });
  eq(cs.bucket, 'B', 'a Coming Soon listing with only its first photos posted is kept for review, not dropped');
  eq(/Coming Soon/.test(cs.why), true, 'and its Why says Coming Soon');
  eq(core.qualify({ ...base, comingSoon: true, remarks: 'Fully remodeled, turnkey.' }).bucket, 'C',
    'a renovated Coming Soon listing is still dropped (Rule #0)');
  const l = core.boardLead({ mls: 'ML1234567', address: '1 Test St, Oakland 94601', mlsStatus: 'Coming Soon' });
  eq(l.mlsStatus, 'Coming Soon', 'the board lead carries the Coming Soon status');
}

// ---- the exact Redfin page, only for the right house ----
{
  const body = '{}&&{"payload":{"sections":[{"rows":[' +
    '{"name":"210 College Ter","url":"/CA/San-Francisco/210-College-Ter-94112/home/111"},' +
    '{"name":"21 College Ter","url":"/CA/San-Francisco/21-College-Ter-94112/home/809328"}]}]}}';
  eq(core.redfinUrlFrom(body, '21 College Terrace, San Francisco, CA 94112'),
    'https://www.redfin.com/CA/San-Francisco/21-College-Ter-94112/home/809328', 'Redfin: picks the matching house, not 210');
  eq(core.redfinUrlFrom(body, '21 College Terrace, Daly City, CA 94014'), '', 'Redfin: wrong zip is no link');
  eq(core.redfinUrlFrom('{}&&{"payload":{}}', '21 College Terrace, San Francisco, CA 94112'), '', 'Redfin: nothing found is no link');
  eq(core.redfinUrlFrom(body, 'College Terrace'), '', 'Redfin: no street number, no guess');
}

// ---- the page-reading snippets must reach the page with their backslashes ----
{
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  eq(/Key=\(\\\\d\+\)/.test(src), true, 'photo key regex is double-escaped in its template string');
}

if (fails) { console.error(`\n${fails} failing`); process.exit(1); }
console.log('\nall board hand-off tests pass');
