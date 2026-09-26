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

// THE WHOLE BAY AREA — all nine counties, every city in each (Bryan, 1 Aug).
// City '*' means the entire county, so no city list has to be maintained and
// nothing is missed because a town was never typed in.
//
// Price caps follow the standing rule: San Mateo (the Peninsula) $2.0M,
// everywhere else $1.5M. County names are exactly as the Matrix dropdown spells
// them — checked against the live form, not guessed.
//
// San Francisco stays FIRST. It is the priority market and each area is
// finished completely before the next one starts, so SF reaches the sheet first.
const DEFAULT_BUYBOX = [
  { county: 'San Francisco', city: '*', maxk: 1500 },
  { county: 'San Mateo', city: '*', maxk: 2000 },
  { county: 'Santa Clara', city: '*', maxk: 1500 },
  { county: 'Alameda', city: '*', maxk: 1500 },
  { county: 'Contra Costa', city: '*', maxk: 1500 },
  { county: 'Marin', city: '*', maxk: 1500 },
  { county: 'Sonoma', city: '*', maxk: 1500 },
  { county: 'Napa', city: '*', maxk: 1500 },
  { county: 'Solano', city: '*', maxk: 1500 },
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
  // Fallback for a grid whose rows carry other class names (San Francisco read
  // "280 matches -> 0 rows" even after waiting): find the header row by its
  // cells, then read every later row of the same table that holds an MLS #.
  if (!out.length) {
    const trs = Array.from(document.querySelectorAll('tr'));
    const cellsOf = r => Array.from(r.children).map(c => clean(c.innerText));
    const hi = trs.findIndex(r => { const t = cellsOf(r); return t.includes('MLS #') && t.some(x => /^(List )?Price$/i.test(x)); });
    if (hi >= 0) {
      const ix = {}; cellsOf(trs[hi]).forEach((c,i)=>{ if(c && ix[c]==null) ix[c]=i; });
      const tbl = trs[hi].closest('table');
      trs.slice(hi + 1).forEach(tr => {
        if (tbl && tr.closest('table') !== tbl) return;
        const cells = cellsOf(tr);
        const p = k => ix[k]!=null ? (cells[ix[k]]||'') : '';
        const mls = p('MLS #');
        if (!/^[A-Z]{2,6}\\d{5,}$/.test(mls)) return;
        const street = p('Street Address') || p('Address');
        out.push({ mls, addr: street, price: p('Price') || p('List Price'), sqft: p('SqFt'),
          bds: p('Bds') || p('Beds'), city: p('Postal City') || p('City'), age: p('Age'), dom: p('DOM'),
          zip: (street.match(/\\b(9[0-5]\\d{3})\\b/)||[])[1] || '' });
      });
    }
  }
  return out;
})()`;

// What the results page looked like when no rows could be read — saved so a
// "matches but 0 rows" area can be diagnosed from the user's machine.
const JS_GRID_DEBUG = `(() => {
  const clean = t => (t||'').replace(/\\s+/g,' ').trim();
  const trs = Array.from(document.querySelectorAll('tr'));
  const cls = {}; trs.forEach(t => { const c = t.className || '(none)'; cls[c] = (cls[c]||0) + 1; });
  const withMls = Array.from(document.querySelectorAll('*')).filter(e => e.children.length < 3 && /^MLS ?#$/.test(clean(e.textContent))).slice(0, 5)
    .map(e => ({ tag: e.tagName, cls: e.className, parent: e.parentElement && e.parentElement.tagName + '.' + e.parentElement.className }));
  return { url: location.href, title: document.title, frames: window.frames.length, rowClasses: cls, mlsHeaders: withMls,
    text: clean(document.body.innerText).slice(0, 2500) };
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
  'not a cosmetic (?:remodel|flip|fix|job|project|rehab)',
  'extensive (?:damage|water damage|repairs)',
  '\\bmold\\b', 'dry ?rot throughout', 'sinking', 'landslide', 'slide zone',
].join('|'), 'i');

// Tenant-occupied is a DROP again (Seth, 26 Sep: "Juan won't take tenant
// occupied" — reverses the 23 Sep rule that scored it as an opportunity).
// The one exception: the listing says the house is delivered VACANT at close
// ("tenant is expected to vacate prior to Close of Escrow"). That stays, with
// a note to confirm it with the agent. The MLS's own "Occupied By: Tenant"
// field counts as much as any word in the remarks.
const TENANT_KW = new RegExp([
  'tenant[- ]occupied', 'occupied by (?:a )?tenant', 'tenants? in place',
  'currently rented', 'lease in place', 'subject to (?:a )?lease',
  'do not disturb (?:the )?tenant', 'month[- ]to[- ]month tenan',
].join('|'), 'i');

const VACANT_AT_CLOSE_RE = new RegExp([
  'delivered vacant', 'deliver(?:ed)? (?:the property )?vacant', 'vacant (?:at|upon|by|before|prior to) (?:the )?(?:close|closing|coe)',
  'tenants? (?:is |are )?(?:expected |scheduled |set |going )?to (?:vacate|move out|leave)',
  'tenants? will (?:vacate|move out|be (?:gone|out))', 'vacate (?:prior to|before|by) (?:the )?(?:close|closing|coe)',
].join('|'), 'i');
function tenantInfo(meta, t) {
  const occ = String((meta && meta.occupiedBy) || '');
  const tenant = /tenant/i.test(occ) || TENANT_KW.test(t);
  return { tenant, vacantAtClose: tenant && VACANT_AT_CLOSE_RE.test(t) };
}

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
  const ten = tenantInfo(meta, t);
  if (ten.tenant && !ten.vacantAtClose) {
    return { decision: 'drop', reason: 'tenant occupied — we don’t buy tenant-occupied houses (hard exclusion)' };
  }
  // The MLS's own classification beats a word in the remarks. The search asks
  // for Single Family Home and the report says so again on every listing, so a
  // keyword is not grounds to overrule it.
  const saysSingle = /single family/i.test(String(meta.propClass || ''));
  if (!saysSingle && MULTI_KW.test(t) && !POTENTIAL_RE.test(t)) {
    return { decision: 'drop', reason: `remarks indicate an existing second dwelling — "${(t.match(MULTI_KW) || [''])[0]}"` };
  }
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
  // Only trust a low count that came off the full photo grid. When the grid
  // fails to load the app falls back to the carousel, which only ever has ~4
  // preloaded — that dropped 844 Brunswick (29 photos) as "exterior-only".
  if (photos > 0 && photos <= 4 && meta.photosReliable !== false) {
    return { decision: 'drop', reason: `only ${photos} photos, likely exterior-only / no interior access` };
  }
  // Remarks say nothing either way. This engine reads TEXT only — it has not
  // looked at a single photo — so "no renovated keyword" is not evidence the
  // house is a fixer. Auto-keeping here is what let renovated listings through.
  // Hand it to a human (or to AI vision, which does look) instead of guessing.
  return { decision: 'manual', reason: 'remarks are silent on condition — photos must be judged by eye' };
}

// ---- qualification gate: Opportunity Score 0-100 and an A / B / C bucket ----
//
//   A — WORK NOW        score >= 70: strong distress / value-add signals
//   B — AI REVIEW ONLY  score 35-69: plausible, not obvious — needs a deeper look
//   C — AUTO-PASS       score < 35, or a hard exclusion: never reaches the board
//
// A listing cannot enter the working queue until something here says there is
// a plausible value-add opportunity. Hard exclusions (renovated, multi-unit,
// fire, structural / permit-heavy, too few photos) come straight from
// rulesDecide, so the two can never disagree about what is disqualifying.
// Everything else is scored from the listing text and data — public AND
// private remarks, price cuts, $/sqft against the area, age and DOM. Photos are
// not scored yet; AI vision still decides keep/drop when it is switched on.
const BUCKET_A = 70, BUCKET_B = 35;
const BUCKET_LABEL = { A: 'A — Work Now', B: 'B — AI Review', C: 'C — Auto-Pass' };

// Fixer language for SCORING. KEEP_KW also carries probate / estate / first
// time on market, which score under their own signals below — counting them
// twice would inflate the score.
const FIXER_KW = /(fixer|\bas[- ]is\b|\btlc\b|handyman|contractor special|needs work|needs updating|diamond in the rough|great potential|investor special)/i;
const DISTRESS_KW = /(probate|trust sale|estate sale|court confirmation|conservatorship|administrator|executor|\bheirs?\b|inherited)/i;
const ORIGINAL_KW = /((?:first|1st) time on (?:the )?market|same (?:owner|family) (?:for|since)|(?:long[- ]?time|original) owners?|in the (?:same )?family for|original condition|untouched|time capsule|never (?:been )?(?:updated|renovated|remodel))/i;
const VACANT_KW = /\bvacant\b|delivered vacant|no one living/i;
const HOARD_KW = /(hoarder|clutter(?:ed)?|needs (?:a )?(?:good )?clean[- ]?out|full of (?:contents|belongings)|sold with contents)/i;
const MOTIVATED_KW = /(cash only|cash offers?|investor special|investors? welcome|bring (?:all )?offers|motivated seller|priced to sell|quick close|no repairs will be made|seller will not make any repairs)/i;
const STAGED_KW = /(professionally staged|virtually staged|staged to perfection|beautifully staged)/i;

/**
 * Score one listing. `m` carries what the report and the grid gave us:
 *   remarks, privateRemarks, condition, occupiedBy, propClass, addr, photos, photosReliable,
 *   dom, yearBuilt, price, origPrice, ppsfRatio (listing $/sqft ÷ area median),
 *   whenUnsure ('keep' | 'drop').
 * Returns { bucket, label, score, decision: 'keep'|'drop', why, hard, signals }.
 */
function qualify(m) {
  m = m || {};
  const text = [m.remarks, m.privateRemarks].filter(Boolean).join(' ');
  if (isConfirmed(m.addr)) {
    return { bucket: 'A', label: BUCKET_LABEL.A, score: 100, decision: 'keep', hard: false,
      why: 'confirmed deal — kept regardless of the rules', signals: [] };
  }

  const r = rulesDecide({ ...m, remarks: text });
  const signals = [];
  const add = (pts, what) => { signals.push({ pts, what }); };
  const t = (text + ' ' + (m.condition || '')).toLowerCase();
  const hit = re => (t.match(re) || [''])[0];

  // Opportunity signals.
  if (NEEDS_WORK_KW.test(t)) add(20, `needs work — "${hit(NEEDS_WORK_KW)}"`);
  else if (FIXER_KW.test(t)) add(20, `fixer / as-is — "${hit(FIXER_KW)}"`);
  if (DISTRESS_KW.test(t)) add(10, `probate / trust / estate — "${hit(DISTRESS_KW)}"`);
  if (ORIGINAL_KW.test(t)) add(10, `original / long-held — "${hit(ORIGINAL_KW)}"`);
  // The MLS's own "Occupied By" field beats a word in the remarks.
  const occ = String(m.occupiedBy || '');
  const ten = tenantInfo(m, t);   // tenant without "vacant at close" was already a hard drop above
  if (ten.vacantAtClose) signals.push({ pts: 0, what: 'tenant now, to be delivered vacant at close — confirm with the agent' });
  if (/vacant/i.test(occ) || VACANT_KW.test(t)) add(5, 'vacant');
  if (HOARD_KW.test(t)) add(10, `clutter / hoarder — "${hit(HOARD_KW)}"`);
  if (MOTIVATED_KW.test(t)) add(5, `motivated seller — "${hit(MOTIVATED_KW)}"`);

  const orig = num(m.origPrice), list = num(m.price);
  const cut = orig > list && list > 0 ? (orig - list) / orig : 0;
  if (cut >= 0.08) add(15, `price cut ${Math.round(cut * 100)}% ($${Math.round((orig - list) / 1000)}k)`);
  else if (cut >= 0.02) add(10, `price cut ${Math.round(cut * 100)}% ($${Math.round((orig - list) / 1000)}k)`);

  const ratio = Number(m.ppsfRatio) || 0;
  if (ratio > 0 && ratio < 0.75) add(15, `$/sqft ${Math.round(ratio * 100)}% of the area median`);
  else if (ratio > 0 && ratio < 0.9) add(8, `$/sqft ${Math.round(ratio * 100)}% of the area median`);
  else if (ratio > 1.2) add(-10, `$/sqft ${Math.round(ratio * 100)}% of the area median — priced above the area`);

  const yb = Number(m.yearBuilt) || 0;
  if (yb >= 1850 && yb <= 1960) add(5, `built ${yb}`);
  const dom = Number(m.dom) || 0;
  if (dom >= 21) add(5, `${dom} days on market`);

  // Retail-ready signals that are not disqualifying on their own.
  const finishes = FINISH_KW.map(re => (t.match(re) || [''])[0]).filter(Boolean);
  if (finishes.length === 1 && !NEEDS_WORK_KW.test(t)) add(-5, `one updated finish — "${finishes[0]}"`);
  if (STAGED_KW.test(t)) add(-5, `staged — "${hit(STAGED_KW)}"`);
  if (!text.trim()) signals.push({ pts: 0, what: 'no remarks — nothing to read, needs a look' });

  const raw = 40 + signals.reduce((s, x) => s + x.pts, 0);
  let score = Math.max(0, Math.min(100, raw));
  const top = signals.filter(x => x.pts > 0).sort((a, b) => b.pts - a.pts).map(x => x.what);
  const neg = signals.filter(x => x.pts < 0).map(x => x.what);

  // Hard exclusions: auto-pass whatever the score would have been.
  if (r.decision === 'drop') {
    score = Math.min(score, 15);
    return { bucket: 'C', label: BUCKET_LABEL.C, score, decision: 'drop', hard: true,
      why: r.reason, signals };
  }

  let bucket = score >= BUCKET_A ? 'A' : score >= BUCKET_B ? 'B' : 'C';
  // Remarks silent on condition and the reviewer asked for unsure = drop.
  if (r.decision === 'manual' && m.whenUnsure === 'drop' && bucket === 'B' && !top.length) bucket = 'C';
  const note = signals.filter(x => x.pts === 0 && /tenant now/.test(x.what)).map(x => x.what);
  const why = [...top, ...neg, ...note].join(' + ') || r.reason;
  return { bucket, label: BUCKET_LABEL[bucket], score, decision: bucket === 'C' ? 'drop' : 'keep',
    hard: false, why, signals };
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
    // Colon required and the value may not cross a tab or line: a blank field
    // otherwise swallowed the NEXT one ("Family Room: Roof:"), and a bare
    // "property condition" in a disclaimer was read as the condition itself.
    condition: grab(/Prop(?:erty)?\s*Condition:[ ]*\t?([^\t\n]{0,60})/i),
    // "Status: Active" — Pending / Contingent means the window has closed.
    status: grab(/\bStatus:[ ]*\t?([A-Za-z][A-Za-z \-]{2,24})/),
    // Agent Full only — "Occupied By: Vacant / Tenant / Owner".
    occupiedBy: grab(/Occupied\s*By:[ ]*\t?([^\t\n]{0,40})/i),
    // The MLS's own classification — "Res. Single Family / Attached, Single
    // Family". It outranks any keyword in the remarks about second units.
    propClass: grab(/Class:?\s*([^\n\t]{0,80})/i),
    // "Orig Price: $998,000 ... List Price: $899,000" — a cut is a signal.
    origPrice: num(grab(/Orig(?:inal)?\s*Price:?\s*(\$?[\d,]+)/i)) || '',
    listPrice: num(grab(/List\s*Price:?\s*(\$?[\d,]+)/i)) || '',
    // "Listed By: Daniel K. Cheng, Coldwell Banker Realty" — who to call.
    listedBy: grab(/Listed\s*By:?\s*([^\n]{0,120})/i),
    privateRemarks: privateRemarks(block),
    // Agent Full only. "LA Ph: (415) 279-6833", "LA Em: name@host",
    // "Instructions: Lockbox - Supra iBox, Go Directly, Leave Card".
    agentPhone: (grab(/\bLA\s*Ph:[ ]*\t?([^\t\n]{0,30})/i).match(/\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/) || [''])[0],
    agentEmail: (grab(/\bLA\s*Em:[ ]*\t?([^\t\n]{0,120})/i).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [''])[0],
    showing: [grab(/\bInstructions:[ ]*\t?([^\n]{0,160})/i).replace(/\t+/g, ' ').trim(),
      (s => s ? 'contact ' + s : '')(grab(/\bShow\s*Contact:[ ]*\t?([^\t\n]{0,60})/i))].filter(Boolean).join(' · '),
    disclosuresField: (grab(/\bDisclosures\s*URL:[ ]*\t?([^\t\n]{0,300})/i).match(/https?:\/\/\S+/) || [''])[0],
  };
}

/**
 * The disclosures link: the MLS's own "Disclosures URL" field when the agent
 * filled it (2 of 10 live samples), otherwise a link in the remarks that sits
 * next to the word "disclosure" or points at a known disclosure host.
 */
const DISCLOSURE_HOST = /(glide\.com|homelight\.com|disclosures\.io|dropbox\.com|docs\.google\.com|drive\.google\.com|box\.com|onedrive|sharepoint|docusign|disclosure)/i;
function disclosuresLink(field, text) {
  if (field) return field.replace(/[).,;]+$/, '');
  const t = String(text || '');
  const urls = [...t.matchAll(/https?:\/\/[^\s<>"')]+/gi)];
  for (const u of urls) {
    const before = t.slice(Math.max(0, u.index - 80), u.index);
    if (/disclos/i.test(before) || DISCLOSURE_HOST.test(u[0])) return u[0].replace(/[).,;]+$/, '');
  }
  return '';
}

/**
 * The offer deadline, read out of the remarks. The MLS has no field for it
 * (checked every label on live Agent Full pages, 23 Sep) — agents write it
 * into the private remarks as prose:
 *   "All offers due Monday 9/21/26 6:00 PM"
 *   "Offers welcome on Wednesday, September 23rd by 10:00 am"
 *   "Offer date: 9/30/26 by Noon"            "Offer Date TBD."
 * Returns "2026-09-30 12:00 PM (Wed)", "TBD", or '' when nothing says when.
 * Only a sentence that is about an offer DEADLINE counts — "offer to include a
 * copy of the deposit" and "seller may reject any offer" say nothing about when.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const OFFER_CUE = /\boffers?\b[\s,:-]{0,3}(?:(?:are|will be|to be|must be|shall be|being|if any|,)\s+){0,2}(?:due|date|deadline|welcome|reviewed|review(?:ed)? on|presented|presentation|accepted|taken|considered|by|on)\b/gi;
function offerDue(text, today) {
  const t = String(text || '');
  const now = today ? new Date(today) : new Date();
  OFFER_CUE.lastIndex = 0;
  let m;
  while ((m = OFFER_CUE.exec(t))) {
    const w = t.slice(m.index, m.index + 110);
    const date = findDate(w, now);
    if (date) return date + findTime(w);
    if (/\bT\.?B\.?D\b|to be determined|to be announced|\bTBA\b/i.test(w.slice(0, 40))) return 'TBD';
  }
  return '';
}
function findDate(w, now) {
  let mo, d, y;
  const num = w.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  const word = w.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?/i);
  // "Wednesday the 23rd" / "Wed 23rd": a day with no month. Take the month
  // that makes that day fall on that weekday, starting this month.
  const bare = w.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);
  const first = [num, word].filter(Boolean).sort((a, b) => a.index - b.index)[0];
  if (!first && bare) {
    const wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(bare[1].slice(0, 3).toLowerCase());
    const day = +bare[2];
    for (let k = 0; k < 3; k++) {
      const c = new Date(now.getFullYear(), now.getMonth() + k, day);
      if (c.getDate() === day && c.getDay() === wd && c >= new Date(now.getTime() - 30 * 86400000)) {
        mo = c.getMonth() + 1; d = day; y = c.getFullYear();
        const pad = n => String(n).padStart(2, '0');
        return `${y}-${pad(mo)}-${pad(d)} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]})`;
      }
    }
    return '';
  }
  if (!first) return '';
  if (first === num) { mo = +num[1]; d = +num[2]; y = num[3] ? +num[3] : 0; }
  else { mo = MONTHS.indexOf(word[1].slice(0, 3).toLowerCase()) + 1; d = +word[2]; y = word[3] ? +word[3] : 0; }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  if (y && y < 100) y += 2000;
  if (!y) {
    // No year written: the nearest one that is not months in the past.
    y = now.getFullYear();
    if (new Date(y, mo - 1, d) < new Date(now.getTime() - 60 * 86400000)) y++;
  }
  const dt = new Date(y, mo - 1, d);
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}` + ` (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()]})`;
}
function findTime(w) {
  if (/\bnoon\b/i.test(w)) return ' 12:00 PM';
  if (/\bmidnight\b/i.test(w)) return ' 12:00 AM';
  const tm = w.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/i);
  if (!tm) return '';
  return ` ${+tm[1]}:${tm[2] || '00'} ${tm[3].toUpperCase()}M`;
}

// ---- listing links ----
// The public listing page, which opens for anyone with no sign-in:
// https://www.mlslistings.com/Property/SF426159646 (checked for SF, ML, CROC
// and BE numbers, active and sold). The old link, Matrix/Public/Portal.aspx
// ?ID=<MLS#>, is MLS's client EMAIL portal — it wants an id from an agent's
// email, not an MLS number, and every one of those links showed
// "The email URL you are using is either not valid or it has expired".
const mlsUrl = mls => mls ? 'https://www.mlslistings.com/Property/' + encodeURIComponent(String(mls).trim()) : '';
/** Rewrite an old Portal.aspx link to the working one; leave anything else. */
function fixLink(link, mls) {
  const m = String(link || '').match(/Portal\.aspx\?ID=([A-Z0-9]+)/i);
  if (m) return mlsUrl(m[1]);
  return link || mlsUrl(mls);
}

// Listing status off the report. Closed listings are finished: they come off
// the Board and a refresh stops re-reading them. Pending / contingent may
// still fall out of escrow, so they stay on the Board, at the bottom.
const CLOSED_STATUS = /\b(sold|withdrawn|expired|cancel+ed|off[- ]?market|closed)\b/i;
const PENDING_STATUS = /\b(pending|contingent|under contract)\b/i;

// ---- the Board: one tab that says what to work on, rebuilt every time ----

// A row a person has already passed on in the Notes column. Those stay on
// Leads (the reviewer never used the reject button for them) but they are
// not work, so the Board counts them and leaves them off.
const PASSED_NOTE = /^\s*(?:pass\b|passing\b|passed\b|we'?re passing|rejected\b|not a (?:fit|deal))/i;

/** "2026-09-30 (Wed) 12:00 PM" -> Date, or null for TBD / blank. */
function offerDueToDate(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:\s*\(\w+\))?(?:\s+(\d{1,2}):(\d{2})\s*([AP])M)?/i);
  if (!m) return null;
  let h = m[4] ? +m[4] % 12 : 23, min = m[4] ? +m[5] : 59;   // no time: end of that day
  if (m[6] && m[6].toUpperCase() === 'P') h += 12;
  return new Date(+m[1], +m[2] - 1, +m[3], h, min);
}

/**
 * Build the Board tab from the Leads tab (header row + rows, as read off the
 * sheet) and today's scan numbers. Returns the rows to write.
 *
 * Work order: A before B, and inside each the soonest offer deadline first —
 * a deadline tomorrow beats a higher score with no date. Then TBD, then no
 * date, then deadlines already past. Rows passed in Notes are counted, not
 * listed. "Time Left" is a live formula, so it keeps counting down between
 * rebuilds.
 */
function buildBoard(leadRows, today, now) {
  now = now ? new Date(now) : new Date();
  const head = (leadRows[0] || []).map(h => String(h).trim());
  const col = h => head.indexOf(h);
  const cell = (r, h) => { const i = col(h); return i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); };
  const rows = leadRows.slice(1).filter(r => cell(r, 'MLS #'));

  const passed = rows.filter(r => PASSED_NOTE.test(cell(r, 'Notes')));
  const notPassed = rows.filter(r => !PASSED_NOTE.test(cell(r, 'Notes')));
  const closed = notPassed.filter(r => CLOSED_STATUS.test(cell(r, 'MLS Status')));
  const isC = r => /^C/.test(cell(r, 'Bucket'));
  const autoPass = notPassed.filter(r => !CLOSED_STATUS.test(cell(r, 'MLS Status')) && isC(r));
  const live = notPassed.filter(r => !CLOSED_STATUS.test(cell(r, 'MLS Status')) && !isC(r));
  const isPending = r => PENDING_STATUS.test(cell(r, 'MLS Status'));
  const bucketOf = r => (cell(r, 'Bucket').match(/^[ABC]/) || ['?'])[0];
  const due = r => offerDueToDate(cell(r, 'Offer Due'));
  const rank = r => {
    const d = due(r);
    if (d && d >= now) return [0, d.getTime()];
    if (/^TBD$/i.test(cell(r, 'Offer Due'))) return [1, 0];
    if (!d) return [2, 0];
    return [3, -d.getTime()];
  };
  live.sort((a, b) => {
    // Active first; pending / contingent after every active lead.
    const pa = isPending(a) ? 1 : 0, pb = isPending(b) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    const order = { A: 0, B: 1 };   // anything not yet scored goes last
    const ba = order[bucketOf(a)] ?? 2, bb = order[bucketOf(b)] ?? 2;
    if (ba !== bb) return ba - bb;
    const ra = rank(a), rb = rank(b);
    if (ra[0] !== rb[0]) return ra[0] - rb[0];
    if (ra[1] !== rb[1]) return ra[1] - rb[1];
    return (Number(cell(b, 'Opportunity Score')) || 0) - (Number(cell(a, 'Opportunity Score')) || 0);
  });

  const active = live.filter(r => !isPending(r));
  const in48 = active.filter(r => { const d = due(r); return d && d >= now && d - now <= 48 * 3600000; }).length;
  const pad = n => String(n).padStart(2, '0');
  const us = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${((d.getHours() + 11) % 12) + 1}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  const t = today || {};

  const out = [
    ['FlipScout Board', 'Updated', us(now), 'Rebuilt by the app after every scan and refresh — edit notes on the Leads tab, not here.'],
    [],
    ["Today's scan", 'Scanned', 'Auto-Pass (C)', 'AI Review (B)', 'Work Now (A)', 'New on the sheet'],
    ['', t.scanned || 0, t.bucketC || 0, t.bucketB || 0, t.bucketA || 0, t.pushed || 0],
    [],
    ['On the board', 'A — Work Now', 'B — AI Review', 'Offers due in 48h', 'Offer date TBD',
      'Pending / contingent', 'Closed (sold, withdrawn…)', 'Auto-Pass (C)', 'Passed in Notes'],
    ['', active.filter(r => bucketOf(r) === 'A').length, active.filter(r => bucketOf(r) === 'B').length, in48,
      active.filter(r => /^TBD$/i.test(cell(r, 'Offer Due'))).length, live.length - active.length, closed.length,
      autoPass.length, passed.length],
    [],
    ['Bucket', 'Score', 'Offer Due', 'Time Left', 'MLS Status', 'Address', 'Agent Phone', 'Showing',
      'Price', 'Price Cut', 'Occupied By', 'Listing Agent', 'Agent Email', 'Disclosures', 'Notes', 'Why', 'MLS Link'],
  ];
  live.forEach((r, i) => {
    const n = out.length + 1;   // this row's sheet row number
    const d = due(r);
    out.push([
      cell(r, 'Bucket') || 'not scored yet', cell(r, 'Opportunity Score'),
      d ? us(d) : cell(r, 'Offer Due'),
      `=IF(ISNUMBER(C${n}),IF(C${n}<NOW(),"passed",INT(C${n}-NOW())&"d "&HOUR(C${n}-NOW())&"h"),"")`,
      cell(r, 'MLS Status'), cell(r, 'Address'), cell(r, 'Agent Phone'), cell(r, 'Showing'),
      cell(r, 'Purchase Price'), cell(r, 'Price Cut'),
      cell(r, 'Occupied By'), cell(r, 'Listing Agent'), cell(r, 'Agent Email'), cell(r, 'Disclosures'),
      cell(r, 'Notes'), cell(r, 'Why'),
      fixLink(cell(r, 'MLS Link'), cell(r, 'MLS #')),
    ]);
  });
  return out;
}

/**
 * Private / agent-only remarks. The Client Full report does not carry them;
 * the Agent Full report does, and the label varies ("Private:", "Agent
 * Remarks:", "Confidential Remarks:"), so several are accepted. "Agent:" on
 * its own is deliberately NOT one — it also labels contact lines.
 * Verified on a live Agent Full page (23 Sep): the label is "Private:".
 */
function privateRemarks(text) {
  const m = String(text || '').match(/(?:^|\n)\s*(?:Private(?:\s*Remarks?)?|(?:Agent|Realtor|Broker|Confidential)\s*(?:Only\s*)?Remarks?)\s*:\s*([\s\S]{0,1500}?)(?=\n\s*\n|\nShowing|\nVirtual Open|\nFeatures|$)/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/**
 * The exact Redfin page for an address, out of Redfin's location-autocomplete
 * answer (the text after its "{}&&" guard). Redfin's page links carry an
 * internal home id — /CA/San-Francisco/21-College-Ter-94112/home/1234567 — so
 * they cannot be built from the address; they have to be looked up.
 *
 * Only a result whose street number and zip match the address is taken: a
 * wrong house's page is worse than no link.
 */
function redfinUrlFrom(body, address) {
  const txt = String(body || '');
  const want = String(address || '');
  const num = (want.match(/^\s*(\d+[A-Za-z]?)\b/) || [])[1];
  const zip = (want.match(/\b(9\d{4})\b/) || [])[1];
  if (!num) return '';
  const urls = [...txt.matchAll(/"url"\s*:\s*"(\/[A-Z]{2}\/[^"]+?\/home\/\d+)"/g)].map(m => m[1]);
  for (const u of urls) {
    const slug = u.split('/')[3] || '';                 // "21-College-Ter-94112"
    if (!slug.startsWith(num + '-')) continue;
    if (zip && !slug.endsWith('-' + zip)) continue;
    return 'https://www.redfin.com' + u;
  }
  return '';
}

/**
 * One lead as the FlipScout Lead Board stores it (the board's scanLead() reads
 * exactly these names). Lengths are capped and phone, email, date and Redfin
 * link are shape-checked, so a pasted file can never put junk on the board.
 */
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function boardLead(l) {
  const num = v => (v === '' || v == null || !isFinite(Number(v))) ? null : Number(v);
  // core.offerDue writes "2026-09-30 (Wed) 12:00 PM" or "TBD".
  const od = String(l.offerDue || '');
  const date = (od.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const time = (od.match(/(\d{1,2}:\d{2} [AP]M)/) || [])[1] || '';
  const agent = String(l.listedBy || '');
  const phone = clip(l.agentPhone, 20);
  return {
    mls: clip(l.mls, 20).toUpperCase(),
    addr: clip(fullAddress(l.address, l.city, l.zip), 160),
    city: clip(l.city, 60), zip: clip(l.zip, 10),
    price: num(l.price), ppsf: num(l.ppsf), sqft: num(l.sqft),
    beds: num(l.beds), baths: num(l.baths), year: num(l.yearBuilt), dom: num(l.dom),
    remarks: clip(l.remarks, 2000), agentRemarks: clip(l.privateRemarks, 1500), showing: clip(l.showing, 600),
    offerDue: date, offerTime: time, offerFrom: od ? 'MLS remarks' : '',
    offerPhrase: od === 'TBD' ? 'Offer date TBD' : clip(od, 60),
    why: clip([l.bucketLabel, l.oppScore !== '' && l.oppScore != null ? 'score ' + l.oppScore : '', l.why]
      .filter(Boolean).join(' · '), 240),
    redfin: /^https:\/\/www\.redfin\.com\/[A-Z]{2}\/[^\s"<>]+\/home\/\d+$/.test(l.redfin || '') ? l.redfin : '',
    agentName: clip(agent.split(',')[0], 80),
    agentPhone: /^\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}$/.test(phone) ? phone : '',
    agentEmail: /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/.test(clip(l.agentEmail, 254)) ? clip(l.agentEmail, 254) : '',
    mlsStatus: clip(l.mlsStatus, 30),
  };
}

module.exports = {
  boardLead,
  redfinUrlFrom,
  fullAddress, parseDetail, isConfirmed, MAX_DOM_DAYS, LIST_WINDOW_DAYS,
  FIELDS, SEARCH_URL, DEFAULT_BUYBOX,
  JS_SCRAPE_GRID, JS_GRID_DEBUG, JS_PHOTOS, JS_MATCH_COUNT, JS_TITLE,
  num, median, filterCandidates, scoreDeal, arvFromComps, holding, gate, rulesDecide,
  qualify, privateRemarks, offerDue, offerDueToDate, buildBoard, PASSED_NOTE, BUCKET_LABEL,
  mlsUrl, fixLink, CLOSED_STATUS, PENDING_STATUS, disclosuresLink,
};
