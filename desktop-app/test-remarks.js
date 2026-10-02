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

// ---- listing-type label for the board's coloured chip ----
{
  const L = core.listingLabel;
  eq(L({ status: 'Active' }), 'Active', 'label: Active');
  eq(L({ status: '' }), 'Active', 'label: blank status from the Active search reads Active, never blank');
  eq(L({ status: '', comingSoon: true }), 'Coming Soon', 'label: Coming Soon pass');
  eq(L({ status: 'Coming Soon-No Show' }), 'Coming Soon', 'label: Coming Soon however the MLS spells it');
  eq(L({ status: 'Active', privateRemarks: 'Office exclusive — call listing agent.' }), 'Private Listing', 'label: office exclusive in private remarks');
  eq(L({ status: 'Private Listing' }), 'Private Listing', 'label: private status');
  eq(L({ status: 'Active', remarks: 'Private yard and private remarks; private showings only.' }), 'Active',
    'label: "private yard / remarks / showings" is not a private listing');
  eq(L({ status: 'Pending', privateRemarks: 'office exclusive' }), 'Pending', 'label: pending stays pending');
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

// ---- Redfin: Coming Soon / Early Access ----
{
  const ac = '{}&&{"payload":{"sections":[{"rows":[{"name":"San Francisco","url":"/city/17151/CA/San-Francisco"},'
    + '{"name":"San Francisco County","url":"/county/343/CA/San-Francisco-County"}]}]}}';
  eq(core.redfinCountyPath(ac, 'San Francisco'), '/county/343/CA/San-Francisco-County', 'Redfin: county page from the lookup, not the city');
  eq(core.redfinCountyPath(ac, 'Marin'), '', 'Redfin: wrong county is no page');
  eq(core.redfinSearchUrl('/county/343/CA/San-Francisco-County', 1500, 1),
    'https://www.redfin.com/county/343/CA/San-Francisco-County/filter/property-type=house,max-price=1.5M,sort=lo-days', 'Redfin: search URL');
  eq(core.redfinSearchUrl('/county/1/CA/San-Mateo-County', 2000, 3).endsWith('max-price=2M,sort=lo-days/page-3'), true, 'Redfin: $2M cap and page 3');
  const card = core.redfinCard({ href: 'https://www.redfin.com/CA/San-Francisco/21-College-Ter-94112/home/809328?x=1',
    text: 'COMING SOON\n$995,000\n3 beds\n2 baths\n2,185 sq ft\n21 College Ter, San Francisco, CA 94112\nListing by Coldwell Banker' });
  eq([card.homeId, card.early, card.badge, card.price, card.beds, card.baths, card.sqft, card.addr],
    ['809328', true, 'COMING SOON', 995000, 3, 2, 2185, '21 College Ter, San Francisco, CA 94112'], 'Redfin: a Coming Soon card read');
  const plain = core.redfinCard({ href: 'https://www.redfin.com/CA/Oakland/1-A-St-94601/home/5',
    text: 'NEW 3 HRS AGO\n$700,000\n2 beds\n1 bath\n900 sq ft\n1 A St, Oakland, CA 94601\nNew roof coming soon per seller' });
  eq(plain.early, false, 'Redfin: an Active card is not kept, even when the description says "coming soon"');
  eq(core.redfinCard({ href: 'https://www.redfin.com/CA/Oakland/1-A-St-94601/home/5', text: 'EARLY ACCESS\n$700,000\n2 beds' }).early, true, 'Redfin: Early Access badge');
  eq(core.redfinCard({ href: 'https://www.redfin.com/CA/Oakland/12-B-Ave-94601/home/6', text: 'COMING SOON\n$700,000' }).addr,
    '12 B Ave, Oakland, CA 94601', 'Redfin: address from the link when the card has none');
  eq(core.redfinCard({ href: 'https://www.redfin.com/city/1/CA/Oakland', text: '' }), null, 'Redfin: not a home link');
  const h = core.parseRedfinHome('COMING SOON\n21 College Ter\nAbout this home\nExceptional Renovation Opportunity. Bring your imagination. Offers due Tuesday 10/6/26 by 5pm.\nShow more\n'
    + 'Listed by Karyn Kambur • Coldwell Banker\nBuilt in 1914\nLot Size: 2,500 sq ft\nProperty Type: Single Family Residential\n3 days on Redfin\nSource: San Francisco MLS #426150277');
  eq([h.year, h.dom, h.agent, h.mls, h.lotSqft, h.propClass, /Renovation Opportunity/.test(h.remarks), /COMING SOON/i.test(h.status)],
    [1914, 3, 'Karyn Kambur', 'SF426150277', 2500, 'Res. Single Family', true, true], 'Redfin: home page facts, SFAR number gets SF');
  eq(core.redfinMlsId('ML82063204', 'MLSListings'), 'ML82063204', 'Redfin: MLSListings number kept as is');
  eq([core.redfinLabel('COMING SOON'), core.redfinLabel('Early Access'), core.redfinLabel('Compass Exclusive')],
    ['Coming Soon', 'Coming Soon · Early Access', 'Private Listing'], 'Redfin: board label is coloured Coming Soon / Private');
  eq(core.redfinPhotoUrls('<img src="https://ssl.cdn-redfin.com/photo/1/bigphoto/277/426150277_0.jpg"> "https://ssl.cdn-redfin.com/photo/1/bigphoto/277/426150277_1_0.jpg" https://ssl.cdn-redfin.com/photo/1/bigphoto/277/426150277_0.jpg').length,
    2, 'Redfin: photo URLs deduplicated');
  const bl = core.boardLead({ mls: 'RF809328', address: '21 College Ter, San Francisco, CA 94112', city: 'San Francisco', zip: '94112',
    mlsStatus: core.redfinLabel('COMING SOON'), redfin: card.url });
  eq([bl.mls, bl.addr, bl.mlsStatus, bl.redfin], ['RF809328', '21 College Ter, San Francisco, CA 94112', 'Coming Soon',
    'https://www.redfin.com/CA/San-Francisco/21-College-Ter-94112/home/809328'], 'Redfin: board lead keeps one address and its Redfin page');
}

// ---- the page-reading snippets must reach the page with their backslashes ----
{
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  eq(/Key=\(\\\\d\+\)/.test(src), true, 'photo key regex is double-escaped in its template string');
}

if (fails) { console.error(`\n${fails} failing`); process.exit(1); }
console.log('\nall board hand-off tests pass');
