/**
 * Offline test for By owner (v1.76.0-beta) — run with `node desktop-app/test-byowner.js`.
 * Craigslist's search and post pages, the public MLS site's zip page and the
 * Census geocoder are stand-ins written here (no downloaded pages), shaped like
 * the real ones read on 14 Nov. Checks what is left out and why, what a post
 * says, the condition read, the verdicts, the sheet rows (no formulas from a
 * stranger's text), and a whole run() with a stand-in fetch, a Stop, and a
 * section that does not answer.
 */
const b = require('./byowner');

let fails = 0;
const eq = (a, b2, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b2);
  if (A !== B) { fails++; console.error('FAIL ' + m + '\n  got      ' + A + '\n  expected ' + B); }
  else console.log('ok   ' + m);
};

// ---- stand-in pages ----
const li = (id, title, price, hood) => `<li class="cl-static-search-result" title="${title}">
  <a href="https://sfbay.craigslist.org/${id.sub}/reo/d/${id.slug}/${id.id}.html">
    <div class="title">${title}</div><div class="details"><div class="price">${price ? '$' + price.toLocaleString('en-US') : ''}</div>
    <div class="location">${hood}</div></div></a></li>`;
const ldItem = (title, city, lat, lng, bd) => ({ item: { '@type': 'SingleFamilyResidence', name: title, address: { addressLocality: city, postalCode: '' },
  latitude: lat, longitude: lng, numberOfBedrooms: bd } });
function searchPage(sub, posts) {
  return '<html><body><ol>' + posts.map(p => li({ sub, slug: 'x', id: p.id }, p.title, p.price, p.hood)).join('') + '</ol>'
    + '<script type="application/ld+json" id="ld_searchpage_results">' + JSON.stringify({ itemListElement: posts.map(p => ldItem(p.title, p.city, p.lat, p.lng, p.bd)) }) + '</script></body></html>';
}
function postPage(o) {
  return `<html><body><span class="price">${o.price ? '$' + o.price.toLocaleString('en-US') : ''}</span>
    <div id="map" data-latitude="${o.lat || ''}" data-longitude="${o.lng || ''}"></div>
    ${o.map ? `<div class="mapaddress">${o.map}</div>` : ''}
    <div class="attrgroup"><span class="shared-line-bubble"><b>${o.bd}BR</b> / <b>${o.ba}Ba</b></span> <span>${o.sqft ? o.sqft + 'ft<sup>2</sup>' : ''}</span></div>
    <div class="attrgroup"><span>${o.kind || 'house'}</span></div>
    <section id="postingbody"><div class="print-information print-qrcode-container"><p class="print-qrcode-label">QR Code Link to This Post</p></div>
    ${o.body}</section>
    <p class="postinginfo">posted: <time class="date timeago" datetime="${o.posted || '2026-11-12T10:00:00-0800'}">x</time></p>
    ${Array.from({ length: o.imgs == null ? 3 : o.imgs }, (_, i) => `<img src="https://images.craigslist.org/00a0a_abc${i}Def_0t20CI_600x450.jpg">`).join('')}
    </body></html>`;
}

// ---- left out from the title alone ----
const E = (title, price, extra) => b.early(Object.assign({ title, price, city: 'Oakland', hood: 'oakland east', lat: 37.77, lng: -122.2 }, extra || {}));
eq(E('Great 3bd/2ba fixer in East Oakland', 650000), '', 'a house in our counties is opened');
eq(E('For Rent 3bd house', 3200), 'rental or room', 'a rental');
eq(E('Cozy home', 2900), 'rental or room', 'a price under $60k is rent');
eq(E('WE BUY HOUSES any condition cash', 0), 'cash-buyer ad or wanted ad', 'a "we buy houses" ad');
eq(E('Looking for partners on a flip', 0), 'cash-buyer ad or wanted ad', 'a partner ad');
eq(E('Fixer', 500000), 'cash-buyer ad or wanted ad', 'a one-word title is an ad, not a post');
eq(E('Duplex in Oakland, both units rented', 900000), 'multi-unit', 'a duplex');
eq(E('2 acres buildable land Livermore', 400000), 'land', 'land');
eq(E('Hillside lot with a cottage', 400000), '', 'a lot with a house on it stays');
eq(E('Downtown condo with view', 700000), 'condo or townhouse', 'a condo');
eq(E('Double wide mobile home', 120000), 'mobile home or RV', 'a mobile home');
eq(E('Retail storefront for sale', 900000), 'commercial', 'commercial');
eq(E('Great 3bd/2ba in historic Lathrop', 425000, { city: 'Lathrop', hood: 'lathrop' }), 'outside our counties', 'a city outside our counties');
eq(E('Ranch home near Reno', 425000, { city: 'Oakland' }), 'outside our counties', 'a far-away place in the title');
eq(E('3bd home 95820 must see', 425000, { city: 'Oakland' }), 'outside our counties', 'a zip outside the Bay Area');
eq(E('3bd home', 425000, { city: 'Oakland', lat: 40.3, lng: -122.2 }), 'outside our counties', 'a map pin outside our counties');
eq(E('Estate home in the hills', 3500000), 'over the $3M ceiling', 'over the $3M ceiling');
eq(b.countyOf({ city: '', hood: 'san mateo / redwood city' }), 'San Mateo', 'the county from "city / city"');

// ---- the condition read ----
eq(b.condition('Fixer upper, sold as-is, bring your contractor').c, 'asis', 'as-is');
eq(b.condition('Remodeled kitchen and baths, turnkey').c, 'remodel', 'kitchen and baths remodeled');
eq(b.condition('Fully remodeled throughout, new everything').c, 'remodel', 'a whole-house remodel');
eq(b.condition('Updated kitchen, original bath').c, 'light', 'a light update');
eq(b.condition('New construction, never lived in').c, 'new', 'new construction');
eq(b.condition('3 bedrooms, big yard, close to BART').c, 'unknown', 'nothing said about the work');
eq(b.condition('').c, 'unknown', 'no words at all');

// ---- one post ----
const p1 = { id: 'a1', title: 'Original condition 3bd home, East Oakland', price: 0, url: 'u', city: 'Oakland', county: 'Alameda' };
const parts = b.parsePost(postPage({ price: 649000, lat: 37.7612, lng: -122.1801, map: '2150 35th Ave near High St', bd: 3, ba: 1.5, sqft: '1,240',
  body: 'Selling my mother&#39;s house as-is. Needs TLC &amp; a new roof. Offers welcome.', imgs: 4 }), p1);
eq([p1.addr, p1.price, p1.bd, p1.ba, p1.sqft, p1.imgs, p1.posted, p1.lat], ['2150 35th Ave', 649000, 3, 1.5, 1240, 4, '2026-11-12', 37.7612],
  'a post: address (not the cross street), price, beds, baths, square feet, photos, date, pin');
eq(parts.body, "Selling my mother's house as-is. Needs TLC & a new roof. Offers welcome.", 'the owner\'s words, decoded, without Craigslist\'s QR line');
eq(b.late(p1, parts.attrs, parts.body), '', 'a house is kept after opening');
const p2 = { title: 'Lovely home', price: 0 };
b.parsePost(postPage({ bd: 2, ba: 1, body: 'Located 12 minutes drive from downtown. 3 bed home.' }), p2);
eq(p2.addr, '', '"12 minutes drive" is no address');
const p3 = { title: 'Home in Concord', price: 0 };
b.parsePost(postPage({ bd: 3, ba: 2, body: 'House at 1813 Ygnacio Valley Rd and Oak Grove. Great schools.' }), p3);
eq(p3.addr, '1813 Ygnacio Valley Rd', 'an address in the words, without the cross street');
const L = (kind, body, price, title) => { const p = { title: title || 'A home', price: price || 0, lat: 37.8, lng: -122.2 }; const r = b.parsePost(postPage({ bd: 2, ba: 1, kind, body }), p); return b.late(p, r.attrs, r.body); };
eq(L('condo', 'Nice place'), 'condo, townhouse or multi-unit (post details)', 'a condo by the post\'s own type');
eq(L('manufactured', 'Nice place'), 'mobile home or RV', 'a manufactured home');
eq(L('house', 'For rent, $3,000 per month, security deposit required'), 'rental or room', 'a rental found in the words');
eq(L('house', 'Owner financing available, $40,000 down payment, $2,000 per month', 0), '', 'seller financing is a sale, not a rental');
eq(L('house', 'Fire damaged, sold as is', 400000, 'Fire-damaged home'), 'fire damage (a hard rule on the board)', 'fire damage is out');
eq(L('house', 'Beautiful home in Sacramento, near the river'), 'outside our counties', 'a far-away place in the words');

// ---- verdicts ----
const J = (o, body) => b.judge(Object.assign({ addr: '1 Main St', price: 700000, imgs: 5, county: 'Alameda', title: 'Home' }, o), body || '', '2026-11-14');
eq([J({}, 'Needs work, sold as-is').verdict, J({}, 'Needs work, sold as-is').why], ['lead', 'needs work: “Needs work”'], 'as-is, by the owner: a lead, in the owner\'s own words');
eq(J({}, 'Needs work. Send the deposit before the showing, I am overseas').verdict, 'check', 'scam signs make a lead a check');
eq(J({}, 'Needs work. Send the deposit before the showing, I am overseas').flags[0], 'scam signs in the text: Send the deposit', 'and say why');
eq(J({}, 'Gorgeous remodeled kitchen and baths').verdict, 'skip', 'already remodeled: caught');
eq(J({}, '3 beds near BART').why, 'condition not clear from the post', 'nothing said: to check');
eq(J({ mls: 'ML82012345' }, 'as-is').why, 'it is an MLS listing (ML82012345): an agent or wholesaler reposting it', 'an MLS listing reposted');
eq(J({ board: 'SF426170649' }, 'as-is').why, 'already on our sheet (SF426170649)', 'already on our sheet');
eq(J({ dup: 'x9' }, 'as-is').verdict, 'skip', 'the same house twice');
eq(J({ addr: '', price: 0, imgs: 0 }, 'as-is').flags, ['no street address: ask the owner', 'no price', 'no photos'], 'what is missing is flagged');
eq(J({ county: 'San Mateo', price: 2600000 }, 'as-is').flags, ['over our $2.5M cap for San Mateo County (-20 points on the board)'], 'over the San Mateo cap');
eq(J({ price: 1600000 }, 'as-is').flags, ['over our $1.5M cap for Alameda County (-20 points on the board)'], 'over the cap elsewhere');
eq(J({}, 'Seller will carry the loan. As-is.').flags, ['the owner offers to carry the loan (seller financing)'], 'seller financing is flagged');

// ---- the sheet ----
eq(b.norm('1242 Shafter Street, San Mateo'), '1242 shafter', 'an address\'s number and first street word');
eq(b.norm('1813 N. Main St'), '1813 main', 'a direction is skipped');
const idx = b.sheetIndex([['MLS #', 'Address'], ['SF426170649', '364 Madison Street, San Francisco, CA 94134'], ['', '2150 35Th Ave, Oakland, CA']]);
eq([idx['364 madison'][0], idx['2150 35th'][0]], ['SF426170649', 'a lead'], 'the Leads tab, by address');
eq([b.cell('=IMPORTXML("x")'), b.cell('+1 555'), b.cell('-- fixer --'), b.cell('Fixer'), b.cell(5)], ["'=IMPORTXML(\"x\")", "'+1 555", "'-- fixer --", 'Fixer', 5],
  'a stranger\'s text never runs as a formula');
const rec = b.record(Object.assign(J({}, 'as-is'), { id: 'abc', url: 'https://sfbay.craigslist.org/eby/reo/d/x/abc.html', lat: 37.7, lng: -122.2, text: 'as-is', title: '=HYPERLINK("evil")' }), '2026-11-14');
eq(Object.keys(rec), b.HEADERS, 'a row has every column, in order');
eq([rec['Post ID'], rec.Verdict, rec.Title, rec['First Seen'], rec['Team Status'], rec.Map], ['CLabc', 'Lead', "'=HYPERLINK(\"evil\")", '2026-11-14', '', 'https://www.google.com/maps?q=37.7,-122.2'],
  'the row: post id, verdict, a safe title, first seen, the team\'s column left blank, a map link');
eq(b.OVERWRITE.every(h => b.HEADERS.includes(h)) && !b.OVERWRITE.includes('Team Status') && !b.OVERWRITE.includes('First Seen'), true,
  'a re-run replaces the app\'s columns only, never Team Status or First Seen');
eq(b.TAB, 'By Owner (beta)', 'its own tab');

// ---- the public MLS site and the geocoder ----
const mlsPage = '<div><!-- Listing Result Card --><a data-target="ML82011111"></a><div class="addr">2150 35th Ave, Oakland, CA 94601</div>'
  + '<!-- Listing Result Card --><a data-target="ML82022222"></a><span>99 Elm Street, Oakland, CA 94601</span>'
  + '<a href="/Search/Result/94601/2?view=list&amp;criteria=abc">2</a></div>';
const mp = b.parseMlsPage(mlsPage, '94601');
eq([mp.found, mp.next[2]], [{ '2150 35th': 'ML82011111', '99 elm': 'ML82022222' }, 'https://www.mlslistings.com/Search/Result/94601/2?view=list&criteria=abc'], 'the MLS zip page: listings and the next page');
eq(b.zipFromGeocoder(JSON.stringify({ result: { addressMatches: [{ matchedAddress: '1242 SHAFTER ST, SAN MATEO, CA, 94402' }] } })), '94402', 'the zip from the geocoder');
eq(b.zipFromGeocoder('not json'), '', 'a geocoder that fails gives no zip');

// ---- a whole run, on stand-in pages ----
(async () => {
  const eby = [
    { id: 'e1', title: 'Original condition 3bd home, East Oakland', price: 649000, hood: 'oakland east', city: 'Oakland', lat: 37.76, lng: -122.18, bd: 3 },
    { id: 'e2', title: 'Room for rent, utilities included', price: 1200, hood: 'berkeley', city: 'Berkeley', lat: 37.87, lng: -122.27, bd: 1 },
    { id: 'e3', title: 'Remodeled 4bd craftsman', price: 1200000, hood: 'alameda', city: 'Alameda', lat: 37.76, lng: -122.24, bd: 4 },
    { id: 'e4', title: 'Cute 2bd bungalow', price: 800000, hood: 'hayward', city: 'Hayward', lat: 37.66, lng: -122.08, bd: 2 },
    { id: 'e5', title: 'Original condition 3bd home, Oakland', price: 649000, hood: 'oakland', city: 'Oakland', lat: 37.76, lng: -122.18, bd: 3 },   // the same house again
  ];
  const sfc = [
    { id: 'e1', title: 'Original condition 3bd home, East Oakland', price: 649000, hood: 'oakland east', city: 'Oakland', lat: 37.76, lng: -122.18, bd: 3 },   // crossposted
    { id: 's1', title: 'Fixer in the Excelsior, 3bd', price: 1100000, hood: 'excelsior', city: 'San Francisco', lat: 37.72, lng: -122.43, bd: 3 },
  ];
  const posts = {
    e1: postPage({ price: 649000, lat: 37.76, lng: -122.18, map: '2150 35th Ave', bd: 3, ba: 1, body: 'Selling as-is. Needs TLC.' }),
    e3: postPage({ price: 1200000, lat: 37.76, lng: -122.24, map: '1 Central Ave', bd: 4, ba: 2, body: 'Fully remodeled throughout. Remodeled kitchen and baths.' }),
    e4: postPage({ price: 800000, lat: 37.66, lng: -122.08, bd: 2, ba: 1, body: 'Cute place, big yard.' }),
    e5: postPage({ price: 649000, lat: 37.76, lng: -122.18, map: '2150 35th Ave', bd: 3, ba: 1, body: 'Selling as-is. Needs TLC.' }),
    s1: postPage({ price: 1100000, lat: 37.72, lng: -122.43, map: '99 Elm Street', bd: 3, ba: 1, body: 'Fixer, as-is, bring your contractor.' }),
  };
  const fetched = [];
  const fetchText = async url => {
    fetched.push(url);
    if (/subarea\/eby/.test(url)) return searchPage('eby', eby);
    if (/subarea\/sfc/.test(url)) return searchPage('sfc', sfc);
    if (/subarea\//.test(url)) throw new Error('HTTP 403');
    if (/geocoding/.test(url)) return JSON.stringify({ result: { addressMatches: [{ matchedAddress: /Elm/.test(decodeURIComponent(url)) ? '99 ELM ST, SAN FRANCISCO, CA, 94112' : '2150 35TH AVE, OAKLAND, CA, 94601' }] } });
    if (/mlslistings\.com\/search\/result\/zip\/94112/.test(url)) return mlsPage.replace('Oakland, CA 94601', 'x').replace('99 Elm Street, Oakland', '99 Elm Street, San Francisco');
    if (/mlslistings/.test(url)) return '<div></div>';
    const id = url.split('/').pop().replace('.html', '');
    if (posts[id]) return posts[id];
    throw new Error('no page for ' + url);
  };
  const logs = [];
  const res = await b.run({ fetchText, sleep: async () => {}, log: m => logs.push(m), sections: ['eby', 'sfc', 'pen'], today: '2026-11-14' });
  eq(res.sections.map(s => [s.sub, s.posts]), [['eby', 5], ['sfc', 2]], 'two sections read; one that refused is left out, not fatal');
  eq(res.posts, 6, 'a crossposted post counts once');
  eq(res.skipped, { 'in two sections': 1, 'rental or room': 1 }, 'what was left out, and why');
  eq(res.list.map(p => [p.id, p.verdict]), [['e1', 'lead'], ['e4', 'check'], ['e3', 'skip'], ['s1', 'skip'], ['e5', 'skip']],
    'leads first, then to check, then caught (by price)');
  eq(res.list.find(p => p.id === 's1').why, 'it is an MLS listing (ML82022222): an agent or wholesaler reposting it', 'a "by owner" post that is on the MLS is caught');
  eq(res.list.find(p => p.id === 'e5').dup, 'e1', 'the same house posted twice is caught');
  eq(res.list.find(p => p.id === 'e1').zip, '94601', 'the zip came from the geocoder');
  eq(fetched.filter(u => /mlslistings/.test(u)).length, 2, 'each zip\'s MLS page is read once');
  eq(b.summary(res), '6 posts in 2 Craigslist section(s); 5 houses opened: 1 lead(s), 1 to check, 3 caught', 'the summary line');
  eq(logs.some(l => /Peninsula: Craigslist did not answer \(HTTP 403\)/.test(l)), true, 'the refusal is in the log');

  // with the sheet: e1 is on the Leads tab already
  const res2 = await b.run({ fetchText, sleep: async () => {}, sections: ['eby'], board: b.sheetIndex([['MLS #', 'Address'], ['OAK1', '2150 35th Avenue, Oakland, CA']]) });
  eq(res2.list.find(p => p.id === 'e1').why, 'already on our sheet (OAK1)', 'a post already on the Leads tab is caught');

  // Stop after the first house
  let calls = 0;
  const res3 = await b.run({ fetchText, sleep: async () => {}, sections: ['eby'], stop: async () => ++calls > 2 });
  eq([res3.stopped, res3.list.length], [true, 1], 'Stop ends the run after the house it is on, keeping what was read');

  // a page refused once (HTTP 403) is tried once more after a pause; a page refused twice is given up
  const tries = {}, waits = [];
  const flaky = async url => { tries[url] = (tries[url] || 0) + 1; if (/subarea\/sfc/.test(url) && tries[url] === 1) throw new Error('HTTP 403'); return fetchText(url); };
  const res5 = await b.run({ fetchText: flaky, sleep: async ms => { waits.push(ms); }, sections: ['sfc', 'pen'] });
  eq([res5.sections.map(s => s.sub), tries[b.searchUrl('sfc')], tries[b.searchUrl('pen')], waits.includes(b.RETRY_MS)], [['sfc'], 2, 2, true],
    'a refused page is tried once more after 10 s; a page refused twice is left');
  const res6 = await b.run({ fetchText: async url => { if (/subarea/.test(url)) throw new Error('getaddrinfo ENOTFOUND'); return ''; }, sleep: async () => {}, sections: ['sfc'] });
  eq(res6.sections.length, 0, 'no internet at all: no section, and run() still returns');

  // maxPosts
  const res4 = await b.run({ fetchText, sleep: async () => {}, sections: ['eby'], maxPosts: 2 });
  eq([res4.list.length, res4.skipped['not opened (over 2 a run)']], [2, 2], 'only the newest houses up to the limit are opened');

  console.log(fails ? `\n${fails} FAILED` : '\nall By owner tests pass');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
