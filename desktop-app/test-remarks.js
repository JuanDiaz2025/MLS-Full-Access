/**
 * Offline test for how a listing is READ — run with `node desktop-app/test-remarks.js`.
 *
 * Covers the remarks, the agent-only side of the listing, and offer deadlines.
 * The saved Client Full pages in fixtures/ are real; the Agent Full page below
 * is built on the same layout, because no real one had been captured when this
 * was written. Once the app has run, its saved pages (listing-pages/ in the
 * app's data folder) are the thing to check the agent parser against.
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
const fixture = id => fs.readFileSync(path.join(__dirname, 'fixtures', id + '.txt'), 'utf8');

// ---- the public remarks, read whole ----
{
  const d = core.parseDetail(fixture('SF426134156'), 'SF426134156');
  eq(d.remarks.length > 1200, true, '347 Faxon: the whole description is read, not a teaser');
  eq(/as is/i.test(d.remarks.slice(1000)), true, '347 Faxon: "as is" past character 1,000 is in what gets judged');
}

// ---- Prop Condition no longer runs into the next field ----
eq(core.parseDetail(fixture('ML82056071'), 'ML82056071').condition, '',
  'blank Prop Condition reads blank, not "Flooring: Roof: Other"');
eq(core.parseDetail(fixture('SF426150277'), 'SF426150277').condition, 'Fixer Upper',
  'filled Prop Condition still reads');

// ---- the agent-only side ----
const AGENT_FULL = [
  'Agent Full',
  'MLS #: ML82099999\tStatus:\tActive',
  '123 Test Street, San Francisco 94112\tList Price:\t$899,000',
  'Public:\tCharming original-condition home, sold as-is.',
  '',
  'Agent Remarks:\tTenant occupied through 11/30, please do not disturb.',
  'Offers due Tuesday 9/30 by 5pm, submit to agent@example.com.',
  '',
  'Showing Instructions:\tCall listing agent\tLockbox:\tSupra',
  'Offer Date:\t10/02/2026\tCOE:\t',
  '',
  'MLS #: ML82000000\tStatus:\tActive',
  'Agent Remarks:\tA DIFFERENT listing — must never be read for ML82099999.',
].join('\n');
{
  const a = core.parseAgentDetail(AGENT_FULL, 'ML82099999');
  eq(a.mismatch, false, 'agent report: finds the requested listing');
  eq(a.agentRemarks, 'Tenant occupied through 11/30, please do not disturb. Offers due Tuesday 9/30 by 5pm, submit to agent@example.com.',
    'agent remarks: read across lines, up to the blank line');
  eq(a.showing, 'Call listing agent', 'showing instructions: stop at the next tab-separated field');
  eq(a.offerDateField, '10/02/2026', 'an offer-date field is read when the report has one');
  eq(/DIFFERENT/.test(JSON.stringify(a)), false, 'never reads the neighbouring listing');
  eq(core.parseAgentDetail(AGENT_FULL, 'ML11111111').mismatch, true, 'a listing not on the page is a mismatch, not a guess');

  // Where the deadline comes from, in order of trust.
  const pulled = '2026-09-23';
  eq(core.findOfferDue({ offerDateField: a.offerDateField, agentRemarks: a.agentRemarks }, pulled),
    { due: '2026-10-02', from: 'offer date field', phrase: 'Offer date: 10/02/2026' },
    'a dedicated offer-date field wins');
  eq(core.findOfferDue({ agentRemarks: a.agentRemarks, remarks: 'Offers due 10/9.' }, pulled).from, 'agent remarks',
    'agent remarks beat the public remarks');
  eq(core.findOfferDue({ remarks: 'Great home.', pageText: 'Open house Sat. Offers due Mon 9/29 at noon.' }, pulled),
    { due: '2026-09-29', from: 'listing page', phrase: 'Offers due Mon 9/29 at noon.' },
    'falls back to anywhere on the page');
  eq(core.findOfferDue({ remarks: 'Great home, close of escrow 10/15.' }, pulled).due, '', 'no offer phrase, no deadline');

  // The rules now hear what the agent said.
  const v = core.rulesDecide({ addr: '123 Test St', photos: 20, remarks: 'Charming home.', agentRemarks: a.agentRemarks,
    propClass: 'Res. Single Family / Detached' });
  eq(v.decision, 'drop', 'tenant-occupied in the AGENT remarks is a drop');
}

// ---- offer deadlines: the same answers as build_data.py, and one fix ----
const CASES = [
  ['Offers due Tuesday 9/30 by 5pm. Seller reserves the right to accept preemptive offers.', '2026-09-23', '2026-09-30'],
  ['Offers due 10/2/26 at noon.', '2026-09-23', '2026-10-02'],
  ['Offers, if any, will be reviewed Oct 6th. Close of escrow 11/15.', '2026-09-23', ''],
  ['Offers will be reviewed on Monday.', '2026-09-23', '~2026-09-28'],
  ['Offers due Thursday at 3pm via email.', '2026-09-24', '~2026-10-01'],
  ['Offers reviewed as received. No offer deadline.', '2026-09-23', ''],
  ['Close of escrow 10/15. Open house Sat 9/27 1-4.', '2026-09-23', ''],
  ['Seller will review offers on 1/5.', '2026-12-28', '2027-01-05'],
  ['Offer deadline: September 30.', '2026-09-23', '2026-09-30'],
  ['Presenting offers Wed 10/1 at 6pm', '2026-09-23', '2026-10-01'],
  ['Offers due 2/30.', '2026-09-23', ''],
  ['Please submit offers to listing agent. Offers are due Friday.', '2026-09-26', '~2026-10-02'],
  ['offers to be presented sept 29th', '2026-09-23', '2026-09-29'],
  ['Deadline for offers is 10/03/2026 5pm', '2026-09-23', '2026-10-03'],
  ['No preemptive offers. Offers due 10/1.', '2026-09-23', '2026-10-01'],
  // build_data.py rolls this to 1 Sep NEXT year; an offer date that has passed is not eleven months away.
  ['Offers accepted 9/1', '2026-09-23', ''],
  // The first phrase has no date; the real one comes later.
  ['Offers reviewed upon receipt of disclosures. Offers due 10/6 at 5pm.', '2026-09-23', '2026-10-06'],
];
for (const [text, pulled, want] of CASES) eq(core.parseOfferDue(text, pulled).due, want, 'offer due: ' + text);

// ---- the exact Redfin page, only for the right house ----
{
  const body = '{}&&{"payload":{"sections":[{"rows":[' +
    '{"name":"210 College Ter","url":"/CA/San-Francisco/210-College-Ter-94112/home/111"},' +
    '{"name":"21 College Ter","url":"/CA/San-Francisco/21-College-Ter-94112/home/2345678"}]}]}}';
  eq(core.redfinUrlFrom(body, '21 College Terrace, San Francisco, CA 94112'),
    'https://www.redfin.com/CA/San-Francisco/21-College-Ter-94112/home/2345678', 'Redfin: picks the matching house, not 210');
  eq(core.redfinUrlFrom(body, '21 College Terrace, Daly City, CA 94014'), '', 'Redfin: wrong zip is no link');
  eq(core.redfinUrlFrom('{}&&{"payload":{}}', '21 College Terrace, San Francisco, CA 94112'), '', 'Redfin: nothing found is no link');
  eq(core.redfinUrlFrom(body, 'College Terrace'), '', 'Redfin: no street number, no guess');
}

// ---- the photo-grid key must survive being sent into the page ----
// 1.31.0 sent /Key=(d+)/ — a single backslash inside a template string is
// dropped — so the full photo grid was never found and every listing was judged
// on the 3-4 carousel photos. Pin the escaping.
{
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const m = src.match(/const JS_PHOTO_KEY = (`[\s\S]*?`);/);
  const cooked = m ? eval(m[1]) : '';
  eq(cooked.includes('/Key=(\\d+)/'), true, 'photo key regex reaches the page with its backslash');
  eq(cooked.includes('/TableID=(\\d+)/'), true, 'table id regex reaches the page with its backslash');
}

if (fails) { console.error(`\n${fails} failing`); process.exit(1); }
console.log('\nall remarks tests pass');
