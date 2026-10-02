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
  eq(core.parseRedfinHome('About this home Beautifully remodeled top to bottom, turnkey, new kitchen. Show more Built in 1951 4 days on Redfin').remarks,
    'Beautifully remodeled top to bottom, turnkey, new kitchen.', 'Redfin: description read when it runs on one line');
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

// ---- Redfin's own listing data (gis JSON + the download CSV) ----
{
  const body = '{}&&' + JSON.stringify({ payload: { homes: [
    { url: '/CA/San-Francisco/21-College-Ter-94112/home/809328', streetLine: { value: '21 College Ter' }, city: 'San Francisco', state: 'CA',
      zip: '94112', price: { value: 995000 }, beds: 3, baths: 2, sqFt: { value: 2185 }, yearBuilt: { value: 1914 }, dom: { value: 2 },
      mlsId: { value: '426150277' }, mlsStatus: 'Coming Soon', sashes: [{ sashTypeName: 'Early Access Redfin Coming Soon' }], listingRemarks: 'Bring your imagination.' },
    { url: '/CA/Oakland/1-A-St-94601/home/5', streetLine: { value: '1 A St' }, city: 'Oakland', state: 'CA', zip: '94601', mlsStatus: 'Active', sashes: [{ sashTypeName: 'New' }] }] } });
  const g = core.redfinGisHomes(body);
  eq(g.map(h => [h.addr, h.early, h.badge, h.mls, h.price, h.year]),
    [['21 College Ter, San Francisco, CA 94112', true, 'Early Access Redfin Coming Soon', 'SF426150277', 995000, 1914],
     ['1 A St, Oakland, CA 94601', false, '', '', 0, 0]], 'Redfin data: full address, Early Access badge, SF MLS #; Active is not kept');
  eq(core.redfinLabel(g[0].badge), 'Coming Soon · Early Access', 'Redfin data: Early Access label for the board');
  eq(core.redfinGisHomes('<html>blocked</html>'), null, 'Redfin data: a blocked reply is not "no homes"');
  const csv = 'SALE TYPE,ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PRICE,BEDS,BATHS,SQUARE FEET,YEAR BUILT,DAYS ON MARKET,STATUS,URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING),SOURCE,MLS#\n'
    + 'MLS Listing,"21 College Ter",San Francisco,CA,94112,995000,3,2,2185,1914,2,Coming Soon,https://www.redfin.com/CA/San-Francisco/21-College-Ter-94112/home/809328,San Francisco MLS,426150277\n'
    + 'MLS Listing,"1 A St, Unit 2",Oakland,CA,94601,700000,2,1,900,1950,5,Active,https://www.redfin.com/CA/Oakland/1-A-St-94601/home/5,bridgeMLS,41100000\n';
  eq(core.redfinCsvHomes(csv).map(h => [h.addr, h.early]), [['21 College Ter, San Francisco, CA 94112', true], ['1 A St, Unit 2, Oakland, CA 94601', false]],
    'Redfin download: STATUS column, quoted commas');
  eq(core.redfinRegionId('/county/340/CA/San-Francisco-County'), '340', 'Redfin: county region id');
  eq(/region_id=340&region_type=5&sf=1,2,3,5,6,7&status=9&uipt=1/.test(core.redfinGisUrl({ regionId: 340, maxk: 1500, page: 1 })) &&
    /max_price=1500000/.test(core.redfinGisUrl({ regionId: 340, maxk: 1500, page: 1 })), true, 'Redfin data URL: county, houses, for sale, under the cap');
  eq(core.redfinPhotoUrls('https://ssl.cdn-redfin.com/photo/1/mbphotov3/277/genMid.426150277_1_0.jpg https://ssl.cdn-redfin.com/photo/1/bigphoto/277/426150277_1_0.jpg https://ssl.cdn-redfin.com/photo/1/bigphoto/277/426150277_2_0.jpg'),
    ['https://ssl.cdn-redfin.com/photo/1/bigphoto/277/426150277_1_0.jpg', 'https://ssl.cdn-redfin.com/photo/1/bigphoto/277/426150277_2_0.jpg'],
    'Redfin photos: one per photo, the big size wins');
}

// ---- the same buy box on Redfin and on the MLS grid: single-family, under the cap, never over $3M ----
{
  const sf = { county: 'San Francisco', maxk: 1500 }, sm = { county: 'San Mateo', maxk: 2000 };
  const H = o => Object.assign({ addr: '1 A St, Oakland, CA 94601', price: 900000, ptype: '1', year: 1950 }, o);
  eq(core.redfinBuyBox(H({}), sf, 'list'), '', 'Redfin buy box: a 1950 house under the cap is kept');
  eq(/over the \$1.5M cap/.test(core.redfinBuyBox(H({ price: 1600000 }), sf, 'list')), true, 'Redfin buy box: over the $1.5M area cap');
  eq(core.redfinBuyBox(H({ price: 1900000 }), sm, 'list'), '', 'Redfin buy box: San Mateo keeps its $2M cap');
  eq(/over the \$3M cap/.test(core.redfinBuyBox(H({ price: 3200000 }), { county: 'X', maxk: 5000 }, 'list')), true, 'Redfin buy box: never over $3M, whatever the area says');
  eq(/not a single-family/.test(core.redfinBuyBox(H({ ptype: '2' }), sf, 'list')), true, 'Redfin buy box: a condo (type 2) is dropped');
  eq(/not a single-family/.test(core.redfinBuyBox(H({ ptype: 'Townhouse' }), sf, 'list')), true, 'Redfin buy box: a townhouse is dropped');
  eq(/not a single-family/.test(core.redfinBuyBox(H({ ptype: 'Multi-Family (2-4 Unit)' }), sf, 'list')), true, 'Redfin buy box: multi-family is dropped');
  eq(core.redfinBuyBox(H({ ptype: 'Single Family Residential' }), sf, 'page'), '', 'Redfin buy box: the page saying Single Family keeps it');
  eq(core.redfinBuyBox(H({ ptype: '' }), sf, 'list'), '', 'Redfin buy box: type unknown in the list waits for the page');
  eq(/too new/.test(core.redfinBuyBox(H({ year: 2015 }), sf, 'list')), true, 'Redfin buy box: 25+ years old, like the MLS scan');
  eq(core.redfinBuyBox(H({ addr: '21 College Terrace, San Francisco, CA 94112', price: 2500000 }), sf, 'list'), '', 'Redfin buy box: a confirmed deal is never dropped');
  const homes = core.redfinGisHomes('{}&&' + JSON.stringify({ payload: { homes: [{ url: '/CA/X/1-A-St-94601/home/9', uiPropertyType: 2, mlsStatus: 'Coming Soon' }] } }));
  eq(homes[0].ptype, '2', 'Redfin data: the house type travels with the home');
  const g = core.filterCandidates({ 'All San Francisco': { county: 'San Francisco', rows: [
    { mls: 'SF1', addr: '1 A St', price: '$1,200,000', sqft: '1,200', age: '70', dom: '5', cls: 'Single Family' },
    { mls: 'SF2', addr: '2 B St', price: '$1,700,000', sqft: '1,200', age: '70', dom: '5', cls: 'Single Family' },
    { mls: 'SF3', addr: '3 C St', price: '$900,000', sqft: '900', age: '70', dom: '5', cls: 'Condominium' }] } });
  eq([g.candidates.map(r => r.mls), g.rejected.map(r => r.mls + ': ' + r._reason).sort()],
    [['SF1'], ['SF2: $1,700k is over the $1.5M cap', 'SF3: not a single-family home — Condominium']], 'MLS grid: same backstop — over the cap or not single-family is dropped');
}

// ---- Redfin: the listing agent's contact, from the "Listed by" block only ----
{
  const A = core.parseRedfinAgent;
  eq(A({ text: 'Listed by Karyn Kambur • DRE #01234567 • Coldwell Banker Realty • (415) 555-0142 • karyn@cb.com' }),
    { name: 'Karyn Kambur', brokerage: 'Coldwell Banker Realty', phone: '(415) 555-0142', email: 'karyn@cb.com', dre: '01234567' },
    'Redfin agent: name, brokerage, phone, email from the block text');
  eq(A({ text: 'Listed by Jane Doe • Compass', tels: ['+1-650-555-0199'], mails: ['jane@compass.com'] }).phone, '(650) 555-0199',
    'Redfin agent: tel: link wins and is formatted');
  eq(A({ text: 'Listed by Jane Doe • Compass' }), { name: 'Jane Doe', brokerage: 'Compass', phone: '', email: '', dre: '' },
    'Redfin agent: no phone shown is blank, not guessed');
  eq(A({ text: 'Listed by Jane Doe • Compass • questions? help@redfin.com' }).email, '', 'Redfin agent: a redfin.com address is never the listing agent');
  eq(A(null).name, '', 'Redfin agent: nothing read is nothing');
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  eq(/BAD = \/contact agent/.test(src), true, 'Redfin agent: the "Contact agent" button is never clicked');
}

// ---- the page-reading snippets must reach the page with their backslashes ----
{
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  eq(/Key=\(\\\\d\+\)/.test(src), true, 'photo key regex is double-escaped in its template string');
}

if (fails) { console.error(`\n${fails} failing`); process.exit(1); }
console.log('\nall board hand-off tests pass');
