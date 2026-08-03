/**
 * FlipScout scan-core — shared MLS field IDs, in-page extraction snippets, and
 * the pure Flip Scout math (filter + deal model). No Electron/Node-only APIs here
 * so it can be required by main.js and unit-tested with plain node.
 *
 * Matrix uses dynamic Fm9_CtrlNNNN ids; if a <select> comes back empty the form
 * changed — re-introspect and update FIELDS.
 */
const FIELDS = {
  status: '#Fm9_Ctrl1161_LB',
  propType: '#Fm9_Ctrl65_LB',
  county: '#Fm9_Ctrl1738_LB',
  cityBox: '#Fm9_Ctrl1739_LB_TB',
  cityList: '#Fm9_Ctrl1739_LB',
  listDate: '#Fm9_Ctrl1162_TB',
  price: '#Fm9_Ctrl63_TB',      // (000s) box checked -> thousands
  zip: '#Fm9_Ctrl1780_TextBox',
  mls: '#Fm9_Ctrl75_TextBox',
};

const SEARCH_URL = 'https://search.mlslistings.com/Matrix/Search/Residential/ResidentialSearch';

// The full buy box (flip-scout-SOP): County:City[:maxPriceK]. City '*' = whole county.
const DEFAULT_BUYBOX = [
  { county: 'San Francisco', city: '*', maxk: 1500 },
  { county: 'San Mateo', city: '*', maxk: 2000 },
  { county: 'Santa Clara', city: 'Sunnyvale', maxk: 1500 },
  { county: 'Santa Clara', city: 'San Jose', maxk: 1500 },
  { county: 'Alameda', city: 'Oakland', maxk: 1500 },
  { county: 'Alameda', city: 'Berkeley', maxk: 1500 },
  { county: 'Alameda', city: 'San Leandro', maxk: 1500 },
  { county: 'Alameda', city: 'Hayward', maxk: 1500 },
  { county: 'Contra Costa', city: 'Richmond', maxk: 1500 },
];

// ---- in-page snippets (strings executed via webContents.executeJavaScript) ----

// Scrape the current results grid into row objects.
const JS_SCRAPE_GRID = `(() => {
  const clean = t => (t||'').replace(/\\s+/g,' ').trim();
  const h = document.querySelector('.singleLineTableHeader');
  const hc = h ? Array.from(h.children).map(c => clean(c.innerText)) : [];
  const idx = {}; hc.forEach((c,i)=>{ if(c) idx[c]=i; });
  // Zip is not a standard column in this grid view and the header wording varies
  // by display, so find it by pattern rather than by exact name. Anchored so
  // "Postal City" cannot match it.
  const zipKey = Object.keys(idx).find(h => /^(zip|zip code|postal code|postal)$/i.test(h));
  const out = [];
  document.querySelectorAll('tr.DisplayRegRow, tr.DisplayAltRow').forEach(tr => {
    const cells = Array.from(tr.children).map(c => clean(c.innerText));
    const pick = k => idx[k]!=null ? cells[idx[k]] : '';
    const zipCell = zipKey ? (cells[idx[zipKey]]||'') : '';
    // Failing a column of its own, the street line often carries it.
    const inAddr = (pick('Street Address').match(/\\b(9[0-5]\\d{3})\\b/)||[])[1] || '';
    out.push({ mls: pick('MLS #'), addr: pick('Street Address'), price: pick('Price'),
      sqft: pick('SqFt'), bds: pick('Bds'), city: pick('Postal City'), age: pick('Age'), dom: pick('DOM'),
      zip: (zipCell.match(/9[0-5]\\d{3}/)||[''])[0] || inAddr });
  });
  return out;
})()`;

// Pull every photo URL (Size=2) for the single listing shown in the results grid.
const JS_PHOTOS = `(() => {
  const html = document.body.innerHTML.replace(/&amp;/g,'&');
  const all = [...html.matchAll(/https:\\/\\/search\\.mlslistings\\.com\\/MediaServer\\/GetMedia\\.ashx\\?[^'"\\s]+/g)].map(m=>m[0]);
  const bySize = {};
  all.forEach(u => { const n=(u.match(/Number=(\\d+)/)||[])[1]; const s=(u.match(/Size=(\\d+)/)||[])[1];
    if(n!=null&&s!=null){(bySize[s]=bySize[s]||{})[n]=u;} });
  const pick = bySize['2'] || bySize['5'] || bySize['1'] || {};
  return Object.keys(pick).map(Number).sort((a,b)=>a-b).map(n=>pick[n]);
})()`;

const JS_MATCH_COUNT = `(() => { const m=document.body.innerText.match(/([\\d,]+\\+?)\\s*match/i); return m?m[1]:'?'; })()`;
const JS_TITLE = `document.title`;

// ---- pure math ----
const num = s => { const n = parseFloat(String(s||'').replace(/[^0-9.]/g,'')); return isFinite(n)?n:0; };
const median = a => { const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length? (s.length%2? s[m] : Math.round((s[m-1]+s[m])/2)) : 0; };

// Days on market: 45 or less, and the search itself only asks for listings from
// the last LIST_WINDOW_DAYS. The window is wider on purpose - DOM can never be
// larger than the days since the list date, so 60 cannot exclude anything the
// 45-day rule would keep, and DOM below stays the real test.
const MAX_DOM_DAYS = 45;
const LIST_WINDOW_DAYS = 60;

// Stage-3 filter: older SFR, on the market 45 days or less. The price screens
// are gone; $/sqft is recorded and sorts the output but excludes nothing.
function filterCandidates(rowsByArea) {
  let all = [];
  for (const key of Object.keys(rowsByArea)) {
    for (const r of rowsByArea[key].rows || []) {
      const price = num(r.price), sqft = num(r.sqft);
      if (!price || !sqft) continue;
      all.push({ ...r, _price: price, _sqft: sqft, _age: num(r.age), _dom: num(r.dom),
        _ppsf: Math.round(price/sqft),
        // "All San Francisco" is a log heading, not a city — never let it reach
        // a lead, a median key, or the vision prompt.
        _cityKey: r.city || String(key).replace(/^All\s+/i, '') });
    }
  }
  const byCity = {}, bySq = {};
  all.forEach(r => { (byCity[r._cityKey]=byCity[r._cityKey]||[]).push(r._ppsf); (bySq[r._cityKey]=bySq[r._cityKey]||[]).push(r._sqft); });
  const med = {}, medSq = {};
  Object.keys(byCity).forEach(c => { med[c]=median(byCity[c]); medSq[c]=median(bySq[c]); });
  // Say WHY each listing failed, not just that it did. This is the first place
  // leads get rejected — long before photo review — so without a reason here
  // "why isn't this on my list" has no answer for most of the buy box.
  // Two screens: age and days on market. Per Bryan, both PRICE screens are gone.
  //
  //   - the "<=85% of city median $/sqft" cut is gone
  //   - the oversized-for-the-area cut is gone
  //
  // The oversize rule was demonstrably wrong: 21 College Terrace was $455/sqft,
  // 56% of the SF median — genuinely cheap — and it was discarded purely for
  // being 2,185 sqft against a 1,333 median. The rule existed to avoid $/sqft
  // traps on big houses, but it threw away real opportunities to do it.
  //
  // Consequence, stated plainly: with no price screen there is no value filter
  // before photo review, so nearly every old SFR in the buy box now reaches
  // that stage. $/sqft is still recorded and still sorts the output — it just
  // no longer excludes anything.
  // Addresses Bryan has already rejected. Removing the price screens brought
  // 1430 Shafter Ave straight back as the cheapest candidate, so this list has
  // to be enforced in code, not just remembered.
  const REJECTED_ADDR = [/^1430\s+shafter/i, /^183\s+victoria/i, /^322\s+1st\s+ave/i];

  // Days on market: the 45-day cap is BACK ON (Bryan, 1 Aug) — list only what
  // has been on the market 45 days or less. Applied to the MLS's own DOM rather
  // than a List Date search window, so a relisted property is judged on the DOM
  // the sheet will actually show.
  const MAX_DOM = MAX_DOM_DAYS;

  const why = r => {
    const a = String(r.addr || '').trim();
    if (isConfirmed(a)) return '';   // confirmed deal — no screen may drop it
    if (REJECTED_ADDR.some(re => re.test(a))) return 'previously rejected by Bryan — do not resurface';
    // A BLANK age field parses to 0, which used to read as "built this year" and
    // silently discarded the listing as too new. Missing is not new: let an
    // unknown age through to photo review, where the pictures settle it.
    if (r._age > 0 && r._age < 25) return `too new — built ${2026 - r._age}, want 25+ years old`;
    // Same treatment for a missing DOM: 0 means "the MLS didn't say", not
    // "listed today", and a blank must not be read as passing the cap either
    // way — it simply isn't grounds to drop.
    if (r._dom > MAX_DOM) return `on market ${r._dom} days — over the ${MAX_DOM}-day limit`;
    return '';
  };

  const cands = [], rejected = [];
  for (const r of all) {
    const reason = why(r);
    if (reason) rejected.push({ ...r, _reason: reason, _nearness: r._ppsf / (med[r._cityKey] || 1) });
    else cands.push(r);
  }
  cands.sort((a, b) => (a._ppsf / med[a._cityKey]) - (b._ppsf / med[b._cityKey]));
  // Near-misses first: those are the ones worth questioning. A full dump of
  // every listing in the county would bury the tab in noise.
  rejected.sort((a, b) => a._nearness - b._nearness);
  return { candidates: cands, medians: med, rejected: rejected };
}

const LIGHT = 70, HEAVY = 145;
const holding = p => 0.025*p + 2000*(p/1e6) + 0.003125*p + 400;
const gate = arv => arv>=1e6 ? 100000 : arv>=500000 ? 70000 : 50000;

// Deal math for one subject given its ARV.
function scoreDeal({ price, sqft, arv }) {
  const rehabL = LIGHT*sqft, rehabH = HEAVY*sqft, hold = holding(price);
  const totL = price+rehabL+hold, totH = price+rehabH+hold;
  const grossL = arv-totL, grossH = arv-totH;
  const g = gate(arv), clearsL = grossL>=g, clearsH = grossH>=g;
  const rec = clearsL ? (clearsH?'Strong Deal':'Marginal') : 'Pass';
  const lossProfile = (price>1e6 && rehabH/price>0.25) || price>1.5e6;
  const quality = (grossL<=0||!clearsL) ? 'Negative' : lossProfile ? 'Flip W/ Caution' : (clearsH&&grossL>=1.5*g) ? 'Good Flip' : 'Thin Flip';
  const score = clearsL ? Math.max(4, Math.min(10, Math.round(4 + 6*(grossL-g)/(2*g)))) : Math.min(3, grossL>0?2:1);
  return {
    rehabLight: Math.round(rehabL), rehabHeavy: Math.round(rehabH), holding: Math.round(hold),
    totalLight: Math.round(totL), totalHeavy: Math.round(totH),
    grossLight: Math.round(grossL), grossHeavy: Math.round(grossH),
    gate: g, recommendation: rec, flipQuality: quality, score, surface: clearsL,
    recommendedMaxOffer: arv ? Math.round(arv - rehabL - hold - g) : 0,
  };
}

// ARV from a scraped sold-comp set (already restricted to the subject zip + recent).
function arvFromComps(soldRows, subjectSqft) {
  const comps = soldRows.map(r => ({ sqft: num(r.sqft), ppsf: (num(r.price)&&num(r.sqft)) ? num(r.price)/num(r.sqft) : 0 }))
    .filter(r => r.ppsf && r.sqft > 300);
  const band = pct => comps.filter(r => Math.abs(r.sqft-subjectSqft)/subjectSqft <= pct);
  let sel = band(0.20), w = '±20%';
  if (sel.length < 3) { sel = band(0.40); w = '±40%'; }
  if (sel.length < 3) { sel = band(0.60); w = '±60%'; }
  const mp = median(sel.map(r => r.ppsf));
  return { medianPpsf: Math.round(mp), arv: Math.round(mp*subjectSqft), band: w, n: sel.length, totalComps: comps.length };
}

// ---- built-in buy-box rules (no API): decide KEEP/DROP from remarks + photo count ----
// Encodes CLAUDE.md / flip-scout-SOP: drop renovated/turnkey (Rule #0), multi-unit,
// fire, and exterior-only/no-access; keep genuine as-is / estate / fixer language.
const KEEP_KW = /(fixer|as[- ]?is|\btlc\b|handyman|contractor special|probate|estate sale|trust sale|needs work|needs updating|bring your|(?:first|1st) time on (?:the )?market|deferred maintenance|original condition|diamond in the rough|great potential|sold as[- ]is|needs tlc)/i;
// Multi-unit, and ONLY where a second dwelling actually exists. This list used
// to include "in-law", "ADU", "second unit" and "separate unit", which dropped
// 347 Faxon Avenue — a 1924 single-family the MLS classes
// "Res. Single Family / Attached, Single Family", whose remarks merely say a
// bonus room "could serve as ... an in-law setup" and that the yard has room to
// "add an ADU". Neither exists. Those words describe POTENTIAL, and potential
// in a single-family house is a bonus, not a disqualification.
const MULTI_KW = new RegExp([
  '\\bduplex\\b', '\\btriplex\\b', '\\bfourplex\\b', '\\bmulti[- ]?unit\\b',
  '(?:two|three|four|2|3|4) (?:separate )?(?:units|homes|houses|dwellings)',
  '(?:two|2) (?:full|separate|complete) kitchens',
  'legal (?:second|2nd) unit', 'separate legal unit',
].join('|'), 'i');

// The same words, framed as something a buyer COULD do. Never a drop.
const POTENTIAL_RE = new RegExp([
  '(?:could|can|may|might|would)\\s+(?:be\\s+)?(?:serve|used?|convert|make|become|add)',
  '(?:add|adding|build|create|convert(?:ing)? to)\\s+(?:a |an )?(?:adu|in[- ]?law|unit|second unit)',
  '(?:adu|in[- ]?law|unit)\\s+potential', 'potential (?:for|to)',
  'room (?:for|to)\\b', 'possible\\b', 'opportunity to',
].join('|'), 'i');
const FIRE_KW = /(fire damage|fire[- ]damaged|fire gutted|gutted by fire|burned|fire[- ]affected)/i;

// QUICK FLIP ONLY. A quick flip is a COSMETIC job — paint, floors, kitchen,
// bath, in and out in one pass. Everything below means months of engineers,
// drawings and inspections before a hammer swings, or a job whose cost cannot
// be estimated from photos. Those are not the deals we are hunting, so they are
// dropped with the reason recorded rather than surfaced and argued about later.
// (`tear-down` used to sit in KEEP_KW; it is the opposite of a quick flip.)
const SLOW_KW = new RegExp([
  'foundation (?:issue|problem|repair|work|damage|replacement)',
  'needs? (?:a )?new foundation', 'foundation needs',
  'structural (?:issue|problem|damage|repair|work)',
  'red[- ]?tagged?', 'uninhabitable', 'not habitable', 'unsafe to enter',
  'unpermitted (?:addition|work|space)', 'permits? (?:are )?(?:required|needed|pending|in process)',
  'plans (?:approved|submitted|in review)', 'entitle(?:d|ment)',
  'tear[- ]?down', '\\bscraper\\b', '(?:land|lot) value', 'value (?:is )?in the land',
  'down to the studs', 'full gut', 'gut job',
  'extensive (?:damage|water damage|repairs)',
  '\\bmold\\b', 'dry ?rot throughout', 'sinking', 'landslide', 'slide zone',
].join('|'), 'i');

// Tenant-occupied is a hard exclusion in the SOP: no vacant possession, no
// access for trades, and a timeline nobody controls.
const TENANT_KW = new RegExp([
  'tenant[- ]occupied', 'occupied by (?:a )?tenant', 'tenants? in place',
  'currently rented', 'lease in place', 'subject to (?:a )?lease',
  'do not disturb (?:the )?tenant', 'month[- ]to[- ]month tenan',
].join('|'), 'i');

// Deals Bryan has looked at and confirmed he wants. Nothing may drop these —
// not a keyword, not the vision model, not a DOM cap. The mirror of
// REJECTED_ADDR: that list is what must never come back, this is what must
// never be lost. 21 College Terrace went missing because /renovat/ matched
// "Renovation Opportunity", and a rule that can silently swallow a live deal
// needs a backstop that does not depend on the rule being right.
const CONFIRMED_ADDR = [/^21\s+college\s+(?:ter|terrace)/i];
const isConfirmed = addr => CONFIRMED_ADDR.some(re => re.test(String(addr || '').trim()));

// "Renovation" cuts BOTH ways and that is the whole difficulty. "Beautifully
// renovated" means the value is gone; "renovation opportunity" means the value
// is still there. A bare /renovat/ dropped 21 College Terrace — "Exceptional
// Renovation Opportunity ... to renovate this 1914 Edwardian ... significant
// deferred maintenance ... bring your imagination" — which is exactly the deal
// we want. So needs-work context is tested FIRST and wins.
const NEEDS_WORK_KW = new RegExp([
  '(?:renovation|remodel(?:ing)?|update|upgrade|rehab)s?\\s+(?:opportunity|potential|project|ideas?|needed|required)',
  '(?:opportunity|potential|ready|waiting|awaits?|chance|room|prime|ripe)\\s+(?:for|to)\\s+(?:a |the |your |full |complete )*(?:renovat|remodel|updat|upgrad|rehab|restor|transform)',
  '(?:to|and)\\s+(?:renovate|remodel|restore|transform|rehab|reimagine)\\s+this',
  '(?:needs?|requires?|awaiting|awaits?|calls for)\\s+(?:a |some |significant |full |complete |total |extensive |major )*(?:renovation|remodel|updating|updates|rehab|work|tlc|love|repair)',
  '(?:never|not|un)[- ]?(?:renovated|remodel(?:l?ed)|updated|touched)',
  '(?:renovate|remodel|update|customize|finish)\\s+to your',
  'deferred maintenance', 'bring your',
].join('|'), 'i');

// Completed work, stated unambiguously. These beat even needs-work language,
// because "fully renovated" is not a thing anyone writes about a fixer.
const DONE_STRONG_KW = new RegExp([
  '(?:fully|completely|totally|entirely|just|newly|recently|beautifully|tastefully|extensively|meticulously|thoughtfully|stunningly|gut)[- ]?(?:renovated|remodel(?:l?ed)|rebuilt|updated|redone|refreshed|restored)',
  '(?:renovated|remodel(?:l?ed)|updated|redone)\\s+(?:from )?top[- ]to[- ]bottom',
  'turn[- ]?key', 'move[- ]?in[- ]?ready', 'nothing to do but move in',
  'new construction', 'newly built', 'brand[- ]new home',
].join('|'), 'i');

// Whole-house completed work. These describe the HOUSE, not a surface, so one
// mention is enough — but only when nothing in the remarks says work remains.
const DONE_HOUSE_KW = new RegExp([
  'renovated', 'remodel(?:l?ed)', 'updated throughout', 'upgraded throughout',
  'modernized', 'reimagined', 'rebuilt',
].join('|'), 'i');

// Individual finishes. ONE of these is a light-rehab line item, not a flip —
// that is the 844 Brunswick calibration, and enforcing it was the whole point
// of writing it down: a 1904 house with granite counters and everything else
// original is a KEEP. TWO OR MORE distinct finishes, with no needs-work
// language anywhere, is an agent describing a kitchen and bath already done.
const FINISH_KW = [
  /quartz/i, /granite counter/i, /stainless steel appliance/i,
  /luxury vinyl|\blvp\b/i, /designer (?:kitchen|bath|finish)/i,
  /new (?:kitchen|bathrooms?|appliances|cabinets?|countertops?|flooring|floors)/i,
  /(?:updated|refaced|new) cabinet/i, /tile back[- ]?splash/i,
  /recessed light/i, /updated (?:kitchen|bath)/i,
];

// There is deliberately NO "nice house" rule any more. It dropped on
// "immaculate", "pristine", "pride of ownership", "meticulously maintained" —
// every one of which describes HOUSEKEEPING, and HARD RULE #2 says in as many
// words: judge the finishes, not the housekeeping or the staging. A spotless
// house with a 1950s kitchen is exactly what we are hunting.

function rulesDecide(meta) {
  const t = ((meta.remarks || '') + ' ' + (meta.condition || '')).toLowerCase();
  const photos = meta.photos || 0;
  if (isConfirmed(meta.addr)) return { decision: 'keep', reason: 'confirmed deal — Bryan wants this one' };
  if (FIRE_KW.test(t)) return { decision: 'drop', reason: 'remarks note fire damage (hard exclusion)' };
  // The MLS's own classification beats a word in the remarks. The search asks
  // for Single Family Home and the report says so again on every listing, so a
  // keyword is not grounds to overrule it.
  const saysSingle = /single family/i.test(String(meta.propClass || ''));
  if (!saysSingle && MULTI_KW.test(t) && !POTENTIAL_RE.test(t)) {
    return { decision: 'drop', reason: `remarks indicate an existing second dwelling — "${(t.match(MULTI_KW) || [''])[0]}"` };
  }
  if (TENANT_KW.test(t)) return { decision: 'drop', reason: 'remarks say tenant-occupied (hard exclusion)' };
  if (SLOW_KW.test(t)) {
    const hit = (t.match(SLOW_KW) || [''])[0];
    return { decision: 'drop', reason: `not a quick flip — remarks mention "${hit}" (structural/permit work, not cosmetic)` };
  }
  // Completed work, stated outright — no amount of fixer language rescues this.
  if (DONE_STRONG_KW.test(t)) {
    return { decision: 'drop', reason: `remarks say the work is done — "${(t.match(DONE_STRONG_KW) || [''])[0]}" (Rule #0)` };
  }
  // Needs-work context beats every softer renovated-sounding word.
  const needsWork = NEEDS_WORK_KW.test(t);
  if (needsWork) {
    return { decision: 'keep', reason: `remarks describe work still to do — "${(t.match(NEEDS_WORK_KW) || [''])[0]}"` };
  }
  if (KEEP_KW.test(t)) return { decision: 'keep', reason: 'as-is / estate / fixer language' };
  if (DONE_HOUSE_KW.test(t)) {
    return { decision: 'drop', reason: `remarks say the house is done — "${(t.match(DONE_HOUSE_KW) || [''])[0]}" (Rule #0)` };
  }
  // Two or more separate finishes redone = the kitchen and bath are already
  // someone else's work. One on its own is a line item and stays.
  const finishes = FINISH_KW.map(re => (t.match(re) || [''])[0]).filter(Boolean);
  if (finishes.length >= 2) {
    return { decision: 'drop', reason: `${finishes.length} finishes already done — "${finishes.slice(0, 3).join('", "')}" (Rule #0)` };
  }
  if (photos > 0 && photos <= 4) return { decision: 'drop', reason: `only ${photos} photos, likely exterior-only / no interior access (tenant?)` };
  // Remarks say nothing either way. This engine reads TEXT only — it has not
  // looked at a single photo — so "no renovated keyword" is not evidence the
  // house is a fixer. Auto-keeping here is what let renovated listings through.
  // Hand it to a human (or to AI vision, which does look) instead of guessing.
  return { decision: 'manual', reason: 'remarks are silent on condition — photos must be judged by eye' };
}

/**
 * "1326 Palou Avenue, San Francisco, CA 94124" — one column, whatever shape the
 * pieces arrive in.
 *
 * The street line is not always just a street: the Client Full report gives
 * "844 Brunswick Street, San Francisco 94112" complete with city and zip. So
 * take any trailing zip and state OFF the street line first and recompose from
 * the parts — appending blindly produced "…San Francisco 94112, CA".
 */
function fullAddress(street, city, zip) {
  const esc = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let s = String(street || '').trim();
  let z = String(zip || '').trim();

  const mz = s.match(/\b(9[0-5]\d{3})(?:-\d{4})?[\s,]*$/);
  if (mz) { z = z || mz[1]; s = s.slice(0, mz.index); }
  const tidy = () => { s = s.replace(/[\s,]+$/, ''); };
  tidy();
  s = s.replace(/,?\s*\bCA\b\.?$/i, '');
  tidy();

  const c = String(city || '').trim();
  // Don't repeat a city the street line already ends with.
  if (c) { s = s.replace(new RegExp(',?\\s*' + esc(c) + '$', 'i'), ''); tidy(); }

  let out = [s, c].filter(Boolean).join(', ');
  if (out) out += ', CA';
  if (z) out += (out ? ' ' : '') + z;
  return out;
}

/**
 * Read the facts off a listing's Client Full report text.
 *
 * Anchored to the MLS # we asked for, and that is not defensive padding: the
 * Matrix search sometimes does not apply the MLS # filter, and the report then
 * shows a DIFFERENT property. Reading "the first address on the page" put a
 * house in Lincoln onto a San Francisco lead during testing. So find the block
 * belonging to the requested listing and read only that; if it is not on the
 * page, say so and let the caller skip rather than invent.
 *
 * The full address lives here and nowhere else — the results grid has no zip
 * column at all, which is why zip used to reach the sheet blank.
 */
function parseDetail(text, wantMls) {
  const t = String(text || '').replace(/\r/g, '');
  const want = String(wantMls || '').trim().toUpperCase();
  const marks = [...t.matchAll(/MLS\s*#:?\s*([A-Z0-9]{6,})/gi)];
  const seen = marks.map(m => m[1].toUpperCase());

  let block = '';
  for (let i = 0; i < marks.length; i++) {
    if (seen[i] !== want) continue;
    const from = marks[i].index;
    const to = i + 1 < marks.length ? marks[i + 1].index : t.length;
    block = t.slice(from, to);
    break;
  }
  if (!block) return { mismatch: true, showing: seen[0] || '', want: want };

  const grab = re => { const m = block.match(re); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };
  // "814 Potrero Avenue, San Francisco 94110" — street, city and zip on one
  // line, exactly as the listing presents it.
  const address = grab(/^([0-9][^\n\t]*?,[^\n\t]*?\b9[0-5]\d{3})\b/m);
  return {
    mismatch: false,
    address: address,
    zip: (address.match(/9[0-5]\d{3}/) || [''])[0],
    // The grid's Age column is often blank; the report always carries the year.
    yearBuilt: grab(/Age\/Yr\s*Blt:?\s*\d*\s*\/\s*(\d{4})/i),
    // The remarks are labelled "Public:", not "Public Remarks:". Matching a bare
    // /Remarks:/ picked up the truncated Open House teaser instead of the real
    // description — which is what the rules engine was judging condition on.
    remarks: grab(/(?:^|\n)\s*(?:Public|Public Remarks?|Marketing Remarks?)\s*:\s*([\s\S]{0,1500}?)(?=\n\s*\n|\nShowing|\nVirtual Open|\nFeatures|$)/i),
    condition: grab(/Prop(?:erty)? Condition:?\s*([^\n]{0,60})/i),
    // The MLS's own classification — "Res. Single Family / Attached, Single
    // Family". It outranks any keyword in the remarks about second units.
    propClass: grab(/Class:?\s*([^\n\t]{0,80})/i),
  };
}

module.exports = {
  fullAddress, parseDetail, isConfirmed, MAX_DOM_DAYS, LIST_WINDOW_DAYS,
  FIELDS, SEARCH_URL, DEFAULT_BUYBOX,
  JS_SCRAPE_GRID, JS_PHOTOS, JS_MATCH_COUNT, JS_TITLE,
  num, median, filterCandidates, scoreDeal, arvFromComps, holding, gate, rulesDecide,
};
