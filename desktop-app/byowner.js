/**
 * By owner — a BETA (v1.76.0-beta). Seth, 14 Nov: "build it first to see if
 * it's feasible, make it a beta of FlipScout", then "or else we won't be able
 * to test it out" for the app itself.
 *
 * Homes their owners list on Craigslist ("real estate — by owner"), which never
 * reach the MLS. The same steps as flipscout-board/test/byowner.py, run from
 * this computer by a person pressing the button: no schedule, no Grok, no AI.
 *
 * 1. Find. One page per Bay Area section, newest first (search engines don't
 *    index these posts, so they are read from Craigslist itself, slowly).
 * 2. Sort. Rentals, rooms, land, multi-unit, condos and townhouses, commercial
 *    space, mobile homes, "we buy houses" and partner ads, posts outside our
 *    counties and homes over the board's $3M ceiling are counted and left out.
 *    A home over our price cap stays in, flagged, as on the board.
 * 3. Read. Each house left is opened: street address (when given), map pin,
 *    posted date, beds, baths, square feet, the owner's words. The words get
 *    the comp checker's condition read (as-is / light update / remodeled), and
 *    signs of a scam are flagged.
 * 4. Match. Against the sheet's Leads tab, and against the public MLS site's
 *    active listings for the home's zip (from the US Census geocoder): a "by
 *    owner" post that is an MLS listing is an agent or wholesaler reposting it.
 *
 * Pure functions plus run(), which takes its fetch, sleep, log and stop check
 * from the caller (main.js), so test-byowner.js runs it on stand-in pages.
 * PropertyRadar (is the poster the owner of record?) stays a person's check.
 */
'use strict';

const SECTIONS = { sfc: 'San Francisco', pen: 'Peninsula', eby: 'East Bay', sby: 'South Bay', nby: 'North Bay' };
const CAP = { 'San Mateo': 2500000 };   // the board's Buy Box defaults
const CAP_ELSE = 1500000;
const CEIL = 3000000;                   // over this the board auto-passes
const BOX = [37.1, 38.35, -122.75, -121.45];   // lat, lat, lng, lng around our six counties
const BAY_ZIP = /^9(?:4[0-9]|5[01]|54)/;
const MAX_POSTS = 40;                   // houses opened per run
const DELAY_MS = 2500;                  // between pages, so the sites are read the way a person would
const RETRY_MS = 10000;                 // before the one retry of a page that was refused
const RETRY_RE = /HTTP (403|429|5\d\d)|timed out|fetch failed|ECONNRESET|ETIMEDOUT|network/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GEOCODER = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=';

// the board's county list, city -> county (compcheck.py's COUNTIES)
const COUNTIES = {
  'San Francisco': 'San Francisco',
  'San Mateo': 'Daly City|Pacifica|South San Francisco|Redwood City|San Bruno|San Mateo|Menlo Park|East Palo Alto|Belmont|El Granada|San Carlos|Burlingame|Foster City|Millbrae|La Honda|Half Moon Bay|Woodside|Moss Beach|Montara|Atherton|Portola Valley|Brisbane|Colma|Hillsborough|Pescadero|Emerald Hills',
  'Santa Clara': 'San Jose|Morgan Hill|Gilroy|Santa Clara|Milpitas|Campbell|Sunnyvale|Los Gatos|San Martin|Mountain View|Palo Alto|Cupertino|Saratoga|Los Altos|Monte Sereno',
  'Alameda': 'Oakland|Berkeley|San Leandro|Hayward|Fremont|Livermore|Union City|Castro Valley|Newark|Albany|Alameda|Dublin|Pleasanton|Sunol|San Lorenzo|Emeryville|Piedmont',
  'Contra Costa': 'Richmond|Antioch|Pittsburg|Concord|Martinez|Pleasant Hill|Oakley|Walnut Creek|Orinda|Brentwood|Lafayette|Clayton|Discovery Bay|San Pablo|El Sobrante|El Cerrito|Pacheco|San Ramon|North Richmond|Moraga|Danville|Pinole|Bay Point|Kensington|Hercules|Rodeo|Crockett|Byron|Knightsen|Alamo',
  'Marin': 'San Rafael|Mill Valley|Novato|San Anselmo|Fairfax|Bolinas|Larkspur|Corte Madera|Woodacre|Sausalito|Tiburon|Greenbrae|Kentfield|Point Reyes Station|Inverness|Stinson Beach|Forest Knolls|Lagunitas',
};
const CITY_COUNTY = {};
Object.keys(COUNTIES).forEach(k => COUNTIES[k].split('|').forEach(c => { CITY_COUNTY[c.toLowerCase()] = k; }));

const FAR = /\b(reno|nevada|tahoe|truckee|oregon|arizona|phoenix|texas|idaho|washington state|puerto rico|japan|mexico|las vegas|hawaii|illinois|sacramento|stockton|modesto|fresno|redding|lathrop|tracy|manteca|clearlake|lake county|mendocino|humboldt|tulare|merced|los banos|gold country|placerville|sonora|chico)\b/i;
const RENT = /\b(for rent|for lease|rent(?:al)?\b|lease\b|leasing|\/\s*mo(?:nth)?\b|per month|room for|roommate|furnished room|sublet|short[- ]term|studio (?:with|available))/i;
const AD = /\b(we buy|cash (?:buyer|offer)s?|buy(?:ing)? houses|any condition|sell (?:your|my) (?:house|home) fast|close (?:fast|quick)|fast clos|investors? looking|looking for (?:a )?(?:fixer|house|home|property|partners?)|wanted|partners?\b|partnership|joint venture|crypto|bitcoin|\bbtc\b|\?\s*$)/i;
const FIXER = /\b(fixer|tlc|needs? (?:some )?(?:work|updating|repairs?)|handyman|as[- ]is|original condition|blank canvas|bring your (?:ideas|vision|contractor|tools)|investor special|contractor special|sweat equity|estate sale|probate|inherited|deferred maintenance)/i;
const MULTI = /\b(duplex|triplex|fourplex|four-plex|\d-?plex|plex\b|\d+\s*units?\b|(?:apartment|apt\.?) (?:building|complex|bldg)|multi[- ]?(?:unit|family)|mobile home park|rv park)/i;
const LAND = /\b(acres?|\blot\b|lots\b|land\b|parcel|building lot|vacant lot)/i;
const HOUSE = /\b(house|home|bungalow|ranch|cottage|victorian|craftsman|single[- ]family|sfr|\dbd|\d\s*b(?:ed)?r?\s*\/|\d\s*bed)/i;
const COMM = /\b(warehouse|office|retail|commercial|storefront|industrial|business|restaurant|flex property|mooring)/i;
const MOBILE = /\b(mobile home|manufactured|park model|\brv\b|trailer|tiny home)/i;
const CONDO = /\b(condo|condominium|townho(?:use|me)|apartment|co-?op|loft)/i;
const SCAM = /\b(wire (?:the|a|transfer)|western union|moneygram|zelle|cashier.?s check|gift card|deposit (?:before|to hold|first)|send (?:me )?(?:the )?(?:deposit|money)|out of the country|overseas|missionary|military (?:duty|deployment)|keys (?:will be )?(?:mailed|sent))/i;
const STREET = /\b(\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z.']*(?:\s+[A-Za-z][A-Za-z.']*){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ct|Court|Ln|Lane|Way|Blvd|Boulevard|Pl|Place|Ter|Terrace|Cir|Circle|Pkwy|Parkway|Hwy|Highway|Loop|Row|Sq|Square|Trl|Trail))\b\.?/i;
const SELLER_CARRY = /\b(seller (?:will )?carr(?:y|ies)|owner financ\w*|seller financ\w*)/i;

// ---------- what the owner's words say was done (compcheck.py's condition()) ----------
const WORK = '(?:remodel(?:l)?ed|renovated|redone|rebuilt)';
const QUAL = '(?:fully|completely|totally|extensively|comprehensively|thoughtfully|meticulously|impeccably|'
  + 'beautifully|newly|recently|tastefully|stunningly|gorgeously|lovingly|expertly|professionally)';
const ROOMS = '(?:kitchen|bath|bathroom|baths|bathrooms|primary|master|guest|hall|powder|en[- ]?suite|garage|basement)';
const BATHW = '(?:bath|bathroom)s?';
const WHOLE = new RegExp('\\b(?:' + QUAL + '\\s+' + WORK + '(?!\\s+(?:and\\s+\\w+\\s+)?' + ROOMS + ')'
  + '|(?:complete|comprehensive|full|total|extensive|gut|whole[- ]house|major|meticulous|thoughtful|stunning)\\s+'
  + '(?:remodel|renovation|rehab|transformation)'
  + '|' + WORK + '\\s+(?:from\\s+)?top\\s+to\\s+bottom|' + WORK + '\\s+throughout'
  + '|every\\s+(?:surface|inch)\\s+(?:has\\s+been\\s+|was\\s+)?(?:touched|updated|' + WORK + '))', 'i');
const KIT_R = new RegExp("\\b(?:(?:new|brand[- ]new|all[- ]new|" + WORK + "|custom|designer)\\s+(?:eat[- ]in\\s+|chef'?s\\s+|gourmet\\s+)?kitchen"
  + "|kitchen\\s+(?:was\\s+|has\\s+been\\s+|is\\s+)?(?:fully\\s+|completely\\s+|newly\\s+|recently\\s+|totally\\s+)?" + WORK
  + "|kitchen\\s+(?:remodel|renovation)|(?:abundant\\s+|all\\s+)?new\\s+(?:kitchen\\s+)?cabinet(?:s|ry)"
  + "|custom\\s+(?:kitchen\\s+)?cabinet(?:s|ry)|thermador|sub[- ]?zero|wolf\\s+(?:range|appliance|stove|oven)"
  + "|new\\s+(?:quartz|stone|marble|granite|quartzite|caesarstone)\\s+(?:counter|countertop)s?\\s+and\\s+cabinet)", 'i');
const KIT_L = new RegExp("\\b(?:(?:updated|refreshed|upgraded|refinished|renewed|remodeled\\s+looking)\\s+(?:eat[- ]in\\s+)?kitchen"
  + "|kitchen\\s+(?:was\\s+|has\\s+been\\s+|is\\s+)?(?:fully\\s+|recently\\s+|nicely\\s+)?(?:updated|refreshed|upgraded)"
  + "|(?:newly\\s+)?painted\\s+cabinet|new\\s+(?:cooktop|range|stove|appliances|stainless(?:\\s+steel)?\\s+appliances|dishwasher)"
  + "|kitchen\\s+with\\s+(?:new|modern|stainless|updated))", 'i');
const BATH_R = new RegExp("\\b(?:(?:new|brand[- ]new|all[- ]new|" + WORK + "|newly[- ]tiled|spa[- ](?:like|inspired)|designer)\\s+"
  + "(?:(?:primary|master|guest|hall|full|both|two|three|all|the|en[- ]?suite)\\s+)?" + BATHW
  + "|" + BATHW + "\\s+(?:were\\s+|was\\s+|have\\s+been\\s+|has\\s+been\\s+)?(?:fully\\s+|completely\\s+|newly\\s+|recently\\s+|all\\s+)?" + WORK
  + "|(?:bath|bathroom)\\s+(?:remodel|renovation)s?|new\\s+tiled?\\s+(?:shower|tub|bath)s?|new\\s+vanit(?:y|ies))", 'i');
const BATH_L = new RegExp("\\b(?:(?:updated|refreshed|upgraded|refinished)\\s+(?:stylish\\s+)?(?:(?:primary|master|guest|hall|the)\\s+)?" + BATHW
  + "|" + BATHW + "\\s+(?:was\\s+|were\\s+|has\\s+been\\s+|have\\s+been\\s+)?(?:nicely\\s+)?(?:updated|refreshed))", 'i');
const BOTH_R = new RegExp("\\b(?:(?:new|brand[- ]new|all[- ]new|" + QUAL + "\\s+" + WORK + "|" + WORK + ")\\s+kitchen\\s+(?:and|&)\\s+(?:the\\s+)?(?:\\w+\\s+)?" + BATHW
  + "|kitchen\\s+(?:and|&)\\s+(?:the\\s+)?(?:\\w+\\s+)?" + BATHW + "\\s+(?:were\\s+|have\\s+been\\s+|are\\s+)?(?:all\\s+|fully\\s+|completely\\s+|newly\\s+)?" + WORK + ")", 'i');
const NEWB = /\b(?:new\s+construction|newly\s+(?:built|constructed)|brand[- ]new\s+(?:home|construction|build)|rebuilt\s+from|(?:down\s+to|from)\s+the\s+studs|studs?[- ]up|ground[- ]up)\b/i;
const ASIS = new RegExp("\\b(?:fixer|as[- ]is|original\\s+condition|needs?\\s+(?:work|tlc|updating|updates|renovation|some\\s+love|a\\s+full)|"
  + "tlc\\b|contractor'?s?\\s+(?:special|delight)|investor\\s+(?:special|opportunity)|bring\\s+your\\s+(?:contractor|vision|ideas|tools)|"
  + "handyman|sweat\\s+equity|deferred\\s+maintenance|tear[- ]?down|renovate\\s+or\\s+rebuild|"
  + "opportunity\\s+to\\s+(?:renovate|update|remodel|restore)|ready\\s+for\\s+(?:your|a)\\s+(?:renovation|remodel|update|vision|personal\\s+touch))", 'i');
const SOFT = /\b(?:updated|refreshed|remodel(?:l)?ed|renovated|fresh(?:ly)?\s+paint(?:ed)?|new\s+(?:paint|flooring|floors|carpet|windows)|refinished|move[- ]in[- ]ready|turn[- ]?key)/i;

/** {c, w}: remodel | new | asis | light | unknown, and the words that decided it. */
function condition(rem) {
  const t = String(rem || '').replace(/\s+/g, ' ');
  const hit = rx => { const m = rx.exec(t); return m ? m[0] : ''; };
  const both = BOTH_R.test(t);
  const k = both || KIT_R.test(t) ? 'R' : KIT_L.test(t) ? 'L' : '';
  const b = both || BATH_R.test(t) ? 'R' : BATH_L.test(t) ? 'L' : '';
  const words = [hit(WHOLE), hit(BOTH_R) || hit(KIT_R) || hit(KIT_L), both ? '' : hit(BATH_R) || hit(BATH_L)].filter(Boolean);
  const said = () => [...new Set(words)].join(' · ');
  if (NEWB.test(t)) return { c: 'new', w: hit(NEWB) };
  if (!t.trim()) return { c: 'unknown', w: 'no remarks' };
  if ((WHOLE.test(t) && k !== 'L' && b !== 'L') || (k === 'R' && b === 'R')) return { c: 'remodel', w: said().slice(0, 90) };
  if (ASIS.test(t)) return { c: 'asis', w: hit(ASIS) };
  if (k || b || SOFT.test(t)) return { c: 'light', w: (said() || hit(SOFT)).slice(0, 90) };
  return { c: 'unknown', w: 'remarks say nothing about the work' };
}

// ---------- page text ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', deg: '°', frac12: '½', reg: '®', copy: '©', trade: '™', times: '×' };
function unescape(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (_) { return m; }
    }
    const v = ENT[e.toLowerCase()];
    return v == null ? m : v;
  });
}
const text = s => unescape(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const money = s => { const d = String(s || '').replace(/\D/g, ''); return d ? parseInt(d, 10) : 0; };
const grab = (s, rx) => { const m = rx.exec(s); return m ? m[1] : ''; };

const searchUrl = sub => `https://www.craigslist.org/search/subarea/${sub}?cat=rea&purveyor=owner`;

/** A section's posts: title, price, area, url, and from its structured data the
 *  home type, city, zip, map pin, beds and baths. */
function parseSearch(html, sub) {
  const s = String(html || '');
  const lis = [...s.matchAll(/<li class="cl-static-search-result"[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  let ld = [];
  const m = /id="ld_searchpage_results"[^>]*>([\s\S]*?)<\/script>/.exec(s);
  if (m) {
    try { ld = (JSON.parse(m[1]).itemListElement || []).map(x => (x && x.item) || {}); } catch (_) { ld = []; }
  }
  const out = [];
  lis.forEach((li, i) => {
    const href = grab(li, /href="([^"]+)"/);
    if (!href) return;
    const title = text(grab(li, /<div class="title">([\s\S]*?)<\/div>/));
    const it = i < ld.length && text(ld[i].name || '').slice(0, 20) === title.slice(0, 20) ? ld[i] : {};
    const a = it.address || {};
    out.push({
      id: href.replace(/\/+$/, '').split('/').pop().replace(/\.html?$/i, ''), sub, url: href, title,
      price: money(grab(li, /<div class="price">([\s\S]*?)<\/div>/)),
      hood: text(grab(li, /<div class="location">([\s\S]*?)<\/div>/)),
      type: it['@type'] || '', city: a.addressLocality || '', zip: a.postalCode || '',
      lat: it.latitude == null ? null : Number(it.latitude), lng: it.longitude == null ? null : Number(it.longitude),
      bd: it.numberOfBedrooms == null ? null : it.numberOfBedrooms, ba: it.numberOfBathroomsTotal == null ? null : it.numberOfBathroomsTotal,
    });
  });
  return out;
}

function countyOf(p) {
  for (const raw of [p.city || '', p.hood || '']) {
    const c = raw.trim().toLowerCase();
    if (CITY_COUNTY[c]) return CITY_COUNTY[c];
    for (const part of c.split(/\s*\/\s*/)) if (CITY_COUNTY[part]) return CITY_COUNTY[part];
  }
  return '';
}

/** A post about a home somewhere else: its map pin outside our counties, a
 *  far-away place in its words, or a zip outside the Bay Area. */
function far(p, t) {
  const lat = p.lat, lng = p.lng;
  if (lat && lng && !(BOX[0] <= lat && lat <= BOX[1] && BOX[2] <= lng && lng <= BOX[3])) return true;
  if (FAR.test(t)) return true;
  const z = /\b(9\d{4})\b/.exec(t);
  return !!(z && !BAY_ZIP.test(z[1]));
}

/** Why a post is left out from its title, price and type alone, or '' to open it. */
function early(p) {
  const t = p.title || '';
  if (!/\s/.test(t.trim()) || AD.test(t)) return 'cash-buyer ad or wanted ad';
  if (RENT.test(t) || (p.price > 0 && p.price < 60000 && !LAND.test(t))) return 'rental or room';
  if (COMM.test(t)) return 'commercial';
  if (MOBILE.test(t)) return 'mobile home or RV';
  if (MULTI.test(t)) return 'multi-unit';
  if (LAND.test(t) && !HOUSE.test(t)) return 'land';
  if (CONDO.test(t)) return 'condo or townhouse';
  p.county = countyOf(p);
  if (!p.county || far(p, t)) return 'outside our counties';
  if (p.price && p.price > CEIL) return 'over the $3M ceiling';
  return '';
}

/** Reads a post's page into p; returns {attrs, body} for late(). */
function parsePost(html, p) {
  const s = String(html || '');
  p.map = text(grab(s, /<div class="mapaddress">([\s\S]*?)<\/div>/));
  p.lat = Number(grab(s, /data-latitude="([^"]+)"/) || p.lat || 0) || null;
  p.lng = Number(grab(s, /data-longitude="([^"]+)"/) || p.lng || 0) || null;
  p.posted = grab(s, /<time class="date timeago" datetime="([^"]+)"/).slice(0, 10);
  const attrs = text([...s.matchAll(/class="attrgroup"([\s\S]*?)<\/div>/g)].map(m => m[1]).join(' '));
  p.attrs = attrs.slice(0, 200);
  let m = /(\d+)BR\s*\/\s*(\d+(?:\.\d+)?)Ba/.exec(attrs);
  if (m) { p.bd = parseInt(m[1], 10); p.ba = parseFloat(m[2]); }
  m = /(\d[\d,]*)\s*ft\s*2/.exec(attrs);   // "2080ft<sup>2</sup>" reads "2080ft 2"
  p.sqft = m ? money(m[1]) : null;
  p.price = money(grab(s, /class="price">([^<]+)</)) || p.price;
  const body = text(grab(s, /<section id="postingbody">([\s\S]*?)<\/section>/)).replace('QR Code Link to This Post', '').trim();
  p.text = body.slice(0, 1500);
  p.imgs = new Set([...s.matchAll(/images\.craigslist\.org\/([A-Za-z0-9_]+?)_\d/g)].map(x => x[1])).size;
  // the street address: the map line when it starts with a number, else one in the title or text
  let addr = /^\d{1,6}\s+\S/.test(p.map) ? p.map : '';
  if (!addr) { const sm = STREET.exec(p.title || '') || STREET.exec(body); addr = sm ? sm[1] : ''; }
  addr = addr.replace(/\s+(near|at|&|and)\s+.*$/i, '').trim();
  if (/\b(minutes?|mins?|miles?|blocks?|hours?|seconds?|years?|feet|ft|sq)\b/i.test(addr)) addr = '';
  p.addr = addr;
  return { attrs, body };
}

/** Why a house is left out once its page is read, or ''. */
function late(p, attrs, body) {
  const a = String(attrs || '').toLowerCase(), title = p.title || '';
  if (/\bmanufactured\b/.test(a)) return 'mobile home or RV';
  if (/\bland\b/.test(a) && !/\bhouse\b/.test(a)) return 'land';
  if (/\b(condo|townhouse|duplex|in-law|flat|loft)\b/.test(a) && !/\bhouse\b/.test(a)) return 'condo, townhouse or multi-unit (post details)';
  // owners often leave Craigslist's home type on "apartment": keep it, flagged
  p.apt = /\bapartment\b/.test(a) && !/\bhouse\b/.test(a);
  if ((!p.price || p.price < 100000) && /\b(for rent|for lease|per month|\/\s*mo\b|security deposit|lease term)/i.test(body.slice(0, 600))
      && !/\b(for sale|sell|selling|asking|offers?|seller (?:will )?carr(?:y|ies)|owner financ\w*|financing|down payment|escrow)\b/i.test(body + ' ' + title)) return 'rental or room';
  if (far(p, title + ' ' + body.slice(0, 300))) return 'outside our counties';
  if (/\bfire[- ]damage/i.test(body + ' ' + title)) return 'fire damage (a hard rule on the board)';
  return '';
}

/** '1242 Shafter Street' -> '1242 shafter' (number and first street word). */
function norm(addr) {
  const m = /^\s*(\d{1,6})\s+(?:[NSEW]\.?\s+)?([A-Za-z0-9]+)/.exec(addr || '');
  return m ? m[1] + ' ' + m[2].toLowerCase() : '';
}

/** The zip of a Census geocoder answer, or ''. */
function zipFromGeocoder(json) {
  try {
    const hits = ((JSON.parse(json).result || {}).addressMatches) || [];
    const m = hits.length ? /\b(9\d{4})\b/.exec(hits[0].matchedAddress || '') : null;
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

/** One page of the public MLS site's zip search: {'1242 shafter': 'ML…'} and
 *  the links to its next pages. */
function parseMlsPage(html, zip) {
  const s = String(html || ''), found = {};
  s.split('<!-- Listing Result Card -->').slice(1).forEach(c => {
    const id = grab(c, /data-target="([A-Z0-9]+)"/);
    const t = text(c.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ''));
    const am = /(\d{1,6}\s+[^,]{2,60}),/.exec(t);
    if (id && am && norm(am[1])) found[norm(am[1])] = id;
  });
  const next = {};
  for (let n = 2; n <= 3; n++) {
    const m = new RegExp('href="(/Search/Result/' + zip + '/' + n + '\\?[^"]+)"').exec(s);
    if (m) next[n] = 'https://www.mlslistings.com' + unescape(m[1]);
  }
  return { found, next };
}

/** The flags, the verdict and its reason for a house that was opened. */
function judge(p, body, today) {
  const words = body + ' ' + (p.title || '');
  let { c, w } = condition(words);
  const fx = FIXER.exec(words);
  if (fx && c !== 'remodel' && c !== 'new') { c = 'asis'; w = fx[0]; }
  p.c = c; p.w = w; p.fixer = c === 'asis';
  const flags = [];
  const scam = SCAM.exec(body);
  if (scam) flags.push('scam signs in the text: ' + scam[0]);
  if (!p.addr) flags.push('no street address: ask the owner');
  if (!p.price) flags.push('no price');
  if (!p.imgs) flags.push('no photos');
  if (p.apt) flags.push('the owner marked it an apartment: check it is a house, not a condo');
  if (SELLER_CARRY.test(words)) flags.push('the owner offers to carry the loan (seller financing)');
  const cap = CAP[p.county] || CAP_ELSE;
  if (p.price && p.price > cap) flags.push(`over our $${String(+(cap / 1e6).toFixed(1))}M cap for ${p.county} County (-20 points on the board)`);
  p.flags = flags;
  if (p.dup) { p.verdict = 'skip'; p.why = 'the same house is posted again (same text, address, or city, price and beds)'; }
  else if (p.mls) { p.verdict = 'skip'; p.why = `it is an MLS listing (${p.mls}): an agent or wholesaler reposting it`; }
  else if (p.board) { p.verdict = 'skip'; p.why = `already on our sheet (${p.board})`; }
  else if (c === 'remodel' || c === 'new') { p.verdict = 'skip'; p.why = `already remodeled or new (${w})`; }
  else if (p.fixer || c === 'unknown' || c === 'light') {
    p.verdict = p.fixer && !flags.some(f => f.startsWith('scam')) ? 'lead' : 'check';
    p.why = p.fixer ? `needs work: “${w}”` : c === 'unknown' ? 'condition not clear from the post' : `a light update: “${w}”`;
  } else { p.verdict = 'check'; p.why = 'read the post'; }
  return p;
}

const VERDICT = { lead: 'Lead', check: 'To check', skip: 'Caught' };
const TAB = 'By Owner (beta)';
const HEADERS = ['Post ID', 'Verdict', 'Why', 'Title', 'Price', 'Address', 'City', 'County', 'Zip', 'Beds', 'Baths', 'Sq Ft',
  'Photos', 'Posted', 'Flags', 'MLS Match', 'On Our Sheet', 'Craigslist', 'Map', 'First Seen', 'Last Seen', 'Team Status', "Owner's Words"];
// the app's own columns, replaced on each run; the rest keep what is there (Team Status is the team's)
const OVERWRITE = ['Verdict', 'Why', 'Price', 'Photos', 'Flags', 'MLS Match', 'On Our Sheet', 'Last Seen'];

/** Text from a stranger's post never runs as a formula on the sheet. */
const cell = v => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v == null ? '' : v);

/** One row of the "By Owner (beta)" tab. */
function record(p, today) {
  const r = {
    'Post ID': 'CL' + p.id, 'Verdict': VERDICT[p.verdict] || p.verdict, 'Why': p.why, 'Title': p.title, 'Price': p.price || '',
    'Address': p.addr || '', 'City': p.city || p.hood || '', 'County': p.county || '', 'Zip': p.zip || '',
    'Beds': p.bd == null ? '' : p.bd, 'Baths': p.ba == null ? '' : p.ba, 'Sq Ft': p.sqft || '', 'Photos': p.imgs || 0,
    'Posted': p.posted || '', 'Flags': (p.flags || []).join('; '), 'MLS Match': p.mls || '', 'On Our Sheet': p.board || '',
    'Craigslist': p.url, 'Map': p.lat && p.lng ? `https://www.google.com/maps?q=${p.lat},${p.lng}` : '',
    'First Seen': today, 'Last Seen': today, 'Team Status': '', "Owner's Words": (p.text || '').slice(0, 1000),
  };
  Object.keys(r).forEach(k => { r[k] = cell(r[k]); });
  return r;
}

/** {'1242 shafter': ['ML81234567', '1242 Shafter Ave, San Francisco, CA']} from the Leads tab's rows. */
function sheetIndex(rows) {
  const head = (rows[0] || []).map(h => String(h).trim());
  const iM = head.indexOf('MLS #'), iA = head.indexOf('Address'), idx = {};
  if (iA < 0) return idx;
  rows.slice(1).forEach(r => {
    const k = norm(String(r[iA] || ''));
    if (k && !idx[k]) idx[k] = [String((iM >= 0 && r[iM]) || '').trim() || 'a lead', String(r[iA])];
  });
  return idx;
}

/**
 * The whole run. deps: {fetchText(url) -> html, sleep(ms), log(msg, level),
 * stop() -> true to stop, board: sheetIndex(), sections, maxPosts, delay, today, now}.
 * Returns {sections, skipped, list, posts, stopped}.
 */
async function run(deps) {
  const d = Object.assign({ sections: Object.keys(SECTIONS), maxPosts: MAX_POSTS, delay: DELAY_MS, retryDelay: RETRY_MS, board: {},
    log: () => {}, stop: async () => false, sleep: ms => new Promise(r => setTimeout(r, ms)) }, deps);
  // a site that refuses for a moment (the public MLS site did, twice in 24 zips on 14 Nov) gets one more try
  const get = async url => {
    await d.sleep(d.delay);
    try { return await d.fetchText(url); }
    catch (e) {
      if (!RETRY_RE.test(String((e && e.message) || e))) throw e;
      await d.sleep(d.retryDelay);
      return d.fetchText(url);
    }
  };
  const sections = [], skipped = {}, list = [];
  const skip = why => { skipped[why] = (skipped[why] || 0) + 1; };
  let posts = [], stopped = false;
  for (const sub of d.sections) {
    if (!SECTIONS[sub]) continue;
    if (await d.stop()) { stopped = true; break; }
    const url = searchUrl(sub);
    let got;
    try { got = parseSearch(await get(url), sub); } catch (e) { d.log(`  ${SECTIONS[sub]}: Craigslist did not answer (${String(e.message || e).slice(0, 80)})`, 'warn'); continue; }
    sections.push({ sub, name: SECTIONS[sub], url, posts: got.length });
    d.log(`  ${SECTIONS[sub]}: ${got.length} posts`);
    posts = posts.concat(got);
  }
  // a post crossposted to two sections counts once
  const seen = new Set(), uniq = [];
  posts.forEach(p => { if (seen.has(p.id)) skip('in two sections'); else { seen.add(p.id); uniq.push(p); } });
  let keep = uniq.filter(p => { const why = early(p); if (why) skip(why); return !why; });
  d.log(`${uniq.length} posts, ${keep.length} houses to open${keep.length > d.maxPosts ? ` (the newest ${d.maxPosts})` : ''}…`, 'good');
  if (keep.length > d.maxPosts) { skipped['not opened (over ' + d.maxPosts + ' a run)'] = keep.length - d.maxPosts; keep = keep.slice(0, d.maxPosts); }
  const byKey = {}, mlsCache = {};
  const mlsActive = async zip => {
    if (mlsCache[zip]) return mlsCache[zip];
    let found = {};
    try {
      const first = parseMlsPage(await get('https://www.mlslistings.com/search/result/zip/' + zip), zip);
      found = Object.assign({}, first.found);
      for (const n of [2, 3]) {
        if (!first.next[n]) break;
        Object.assign(found, parseMlsPage(await get(first.next[n]), zip).found);
      }
    } catch (e) { d.log(`    the MLS site's page for ${zip} did not answer (${String(e.message || e).slice(0, 60)}) — not checked`, 'warn'); }
    mlsCache[zip] = found;
    return found;
  };
  for (let i = 0; i < keep.length && !stopped; i++) {
    if (await d.stop()) { stopped = true; break; }
    const p = keep[i];
    let parts;
    try { parts = parsePost(await get(p.url), p); } catch (e) { d.log(`  [${i + 1}/${keep.length}] page did not open: ${p.url}`, 'warn'); continue; }
    const why = late(p, parts.attrs, parts.body);
    if (why) { skip(why); d.log(`  [${i + 1}/${keep.length}] out — ${p.title.slice(0, 60)}: ${why}`); continue; }
    // the same house posted twice (same address, or the same text, or the same city, price and beds)
    const key = norm(p.addr) || parts.body.slice(0, 160).toLowerCase();
    const twin = p.price ? `${(p.city || '').toLowerCase()}|${p.price}|${p.bd}` : '';
    p.dup = byKey[key] || (twin ? byKey[twin] || '' : '');
    if (!p.dup) { byKey[key] = p.id; if (twin) byKey[twin] = p.id; }
    // on our sheet already? on the MLS (an agent or wholesaler reposting it)?
    const nk = norm(p.addr);
    p.board = nk && d.board[nk] ? d.board[nk][0] : '';
    p.mls = '';
    if (nk && !p.dup) {
      if (!p.zip) {
        try { p.zip = zipFromGeocoder(await get(GEOCODER + encodeURIComponent(`${p.addr}, ${p.city || p.hood || ''}, CA`))); } catch (_) { p.zip = ''; }
      }
      if (p.zip) p.mls = (await mlsActive(p.zip))[nk] || '';
    }
    judge(p, parts.body, d.today);
    list.push(p);
    d.log(`  [${i + 1}/${keep.length}] ${VERDICT[p.verdict].padEnd(8)} ${p.price ? '$' + p.price.toLocaleString('en-US') : 'no price'} · ${(p.addr || p.title).slice(0, 50)} — ${p.why.slice(0, 80)}`,
      p.verdict === 'lead' ? 'good' : 'info');
  }
  const order = { lead: 0, check: 1, skip: 2 };
  list.sort((a, b) => order[a.verdict] - order[b.verdict] || (b.price || 0) - (a.price || 0));
  return { sections, skipped, list, posts: uniq.length, stopped };
}

/** "184 posts in 5 sections; 17 houses opened: 4 leads, 9 to check, 4 caught". */
function summary(res) {
  const n = v => res.list.filter(p => p.verdict === v).length;
  return `${res.posts} posts in ${res.sections.length} Craigslist section(s); ${res.list.length} houses opened: `
    + `${n('lead')} lead(s), ${n('check')} to check, ${n('skip')} caught`;
}

module.exports = {
  SECTIONS, CAP, CAP_ELSE, CEIL, MAX_POSTS, DELAY_MS, RETRY_MS, UA, GEOCODER, TAB, HEADERS, OVERWRITE, VERDICT,
  condition, unescape, text, money, searchUrl, parseSearch, countyOf, far, early, parsePost, late, norm,
  zipFromGeocoder, parseMlsPage, judge, cell, record, sheetIndex, run, summary,
};
