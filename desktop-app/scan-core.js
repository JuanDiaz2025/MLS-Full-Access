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
// Price caps follow the standing rule: San Mateo (the Peninsula) $2.5M (Bryan, 2 Oct; was $2.0M),
// everywhere else $1.5M. County names are exactly as the Matrix dropdown spells
// them — checked against the live form, not guessed.
//
// San Francisco stays FIRST. It is the priority market and each area is
// finished completely before the next one starts, so SF reaches the sheet first.
const DEFAULT_BUYBOX = [
  { county: 'San Francisco', city: '*', maxk: 1500 },
  { county: 'San Mateo', city: '*', maxk: 2500 },
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
  // "5,000" sqft or "0.11 Acres" — the sheet's Lot SqFt is square feet.
  const lotOf = t => { const m = String(t||'').replace(/,/g,'').match(/([\\d.]+)\\s*(ac)?/i); if (!m) return '';
    const n = Number(m[1]); return n ? Math.round(m[2] || /acre/i.test(t) ? n * 43560 : n) : ''; };
  const out = [];
  document.querySelectorAll('tr.DisplayRegRow, tr.DisplayAltRow').forEach(tr => {
    const cells = Array.from(tr.children).map(c => clean(c.innerText));
    const pick = k => idx[k]!=null ? cells[idx[k]] : '';
    const zipCell = zipKey ? (cells[idx[zipKey]]||'') : '';
    // Failing a column of its own, the street line often carries it.
    const inAddr = (pick('Street Address').match(/\\b(9[0-5]\\d{3})\\b/)||[])[1] || '';
    out.push({ mls: pick('MLS #'), addr: pick('Street Address'), price: pick('Price'),
      sqft: pick('SqFt'), bds: pick('Bds'), baths: pick('Bths'), lotSqft: lotOf(pick('Lot Size')),
      city: pick('Postal City'), age: pick('Age'), dom: pick('DOM'), cls: pick('Class'),
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
          bds: p('Bds') || p('Beds'), baths: p('Bths') || p('Baths'), lotSqft: lotOf(p('Lot Size')),
          city: p('Postal City') || p('City'), age: p('Age'), dom: p('DOM'),
          cls: p('Class') || p('Property Type') || p('Prop Type'),
          zip: (street.match(/\\b(9[0-5]\\d{3})\\b/)||[])[1] || '' });
      });
    }
  }
  return out;
})()`;

// The SOLD results grid, for comps (v1.73). Same rows as JS_SCRAPE_GRID, plus
// the sold price and the close date when the display has columns for them.
// Their headings have not been seen on the live sold grid yet, so they are
// found by pattern ("Sold Price", "Close Price", "SP", "Sold Date", "COE Date"
// …), and Price is the fallback — on a Sold search Matrix's Price is the sale price.
const JS_SCRAPE_SOLD = `(() => {
  const clean = t => (t||'').replace(/\\s+/g,' ').trim();
  let head = [], rows = [];
  const h = document.querySelector('.singleLineTableHeader');
  if (h) { head = Array.from(h.children).map(c => clean(c.innerText)); rows = Array.from(document.querySelectorAll('tr.DisplayRegRow, tr.DisplayAltRow')); }
  else {
    const trs = Array.from(document.querySelectorAll('tr'));
    const cellsOf = r => Array.from(r.children).map(c => clean(c.innerText));
    const hi = trs.findIndex(r => { const t = cellsOf(r); return t.includes('MLS #') && t.some(x => /price/i.test(x)); });
    if (hi >= 0) { head = cellsOf(trs[hi]); const tbl = trs[hi].closest('table'); rows = trs.slice(hi + 1).filter(tr => !tbl || tr.closest('table') === tbl); }
  }
  const find = re => head.findIndex(x => re.test(x));
  const ix = {
    mls: find(/^MLS ?#$/i), addr: find(/^(street )?address$/i), price: find(/^(list )?price$/i),
    sold: find(/^(sold|sale|selling|close|closing) ?price$|^SP$/i), date: find(/^(sold|sale|close|closing|coe)( of escrow)? ?date$|^COE$/i),
    sqft: find(/^sq ?ft$/i), bds: find(/^(bds|beds)$/i), baths: find(/^(bths|baths)$/i), age: find(/^age$/i), yr: find(/^(yr|year) ?(blt|built)$/i),
    // v1.75 team comps: a radius search adds Distance; DOM and Area when the display has them
    dom: find(/^c?dom$/i), dist: find(/^dist(ance)?$/i), area: find(/^(mls )?area$/i), city: find(/^postal city$/i),
  };
  const out = [];
  rows.forEach(tr => {
    const cells = Array.from(tr.children).map(c => clean(c.innerText));
    const p = k => ix[k] >= 0 ? (cells[ix[k]] || '') : '';
    const mls = p('mls');
    if (!/^[A-Z]{0,6}\\d{5,}$/.test(mls)) return;
    out.push({ mls, addr: p('addr'), price: p('price'), soldPrice: p('sold'), sold: p('date'),
      sqft: p('sqft'), bds: p('bds'), baths: p('baths'), age: p('age'), yr: p('yr'),
      dom: p('dom'), dist: p('dist'), area: p('area'), city: p('city') });
  });
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

// v1.74.3: the listing's cover photo (Number=0) at the largest size the report
// offers — for the boards, when the public mlslistings.com page has no photo.
// v1.74.4: listing photos only (Type=1). A Coming Soon listing with no photos
// posted (2613 Sage St, 22 Oct) gave a Type=2 image as its "cover".
const JS_COVER = `(() => {
  const html = document.body.innerHTML.replace(/&amp;/g,'&');
  const all = [...html.matchAll(/https:\\/\\/search\\.mlslistings\\.com\\/MediaServer\\/GetMedia\\.ashx\\?[^'"\\s<>]+/g)].map(m=>m[0])
    .filter(u => !/[?&]Type=/i.test(u) || /[?&]Type=1(?!\\d)/i.test(u));
  let best = '', bn = Infinity, bs = -1;
  for (const u of all) {
    const n = +((u.match(/Number=(\\d+)/)||[])[1] || 0), s = +((u.match(/Size=(\\d+)/)||[])[1] || 0);
    if (n < bn || (n === bn && s > bs)) { best = u; bn = n; bs = s; }
  }
  return best;
})()`;
// What the boards treat as "no real photo" on the public page (thumbs.py's BAD_IMG).
const PUBLIC_NO_PHOTO = /nophoto|no-photo|no_photo|placeholder|coming[_-]?soon|mlslpub-cdn|mlslistings\.com\/images\//i;
// v1.74.4: is this public page the listing itself, with a real photo? Decided
// from the page's own og:url / canonical tag. v1.74.3 tested the response URL,
// which Electron's net.fetch leaves blank, so every page "failed" and leads
// whose page has a photo got one saved anyway (4 of 5 on Seth's first run).
// The site's home page, where a hidden listing redirects, says
// og:url = https://www.mlslistings.com.
function publicPageHasPhoto(html, mls) {
  const s = String(html || ''), id = String(mls || '').replace(/[^A-Za-z0-9]/g, '');
  if (!id) return false;
  const own = new RegExp('/property/' + id + '(?![A-Za-z0-9])', 'i');
  const self = [(s.match(/<meta\s+property="og:url"\s+content="([^"]*)"/i) || [])[1],
    (s.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i) || [])[1]];
  if (!self.some(u => own.test(u || ''))) return false;
  const m = s.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  return !!(m && !PUBLIC_NO_PHOTO.test(m[1]));
}
// A Photo cell holding an MLS media address (what v1.74.3 saved when it opened
// without the sign-in). It opens only from the computer that saved it — from
// the cloud, where the boards are built, the MLS answers with nothing — so a
// Refresh replaces it with a copy, and thumbs.py ignores it.
const MLS_MEDIA_LINK = /^https:\/\/search\.mlslistings\.com\/MediaServer\//i;

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
const NOT_SFR_CLASS_RE = /condo|co-?op|town\s*house|townhome|multi|duplex|triplex|fourplex|income|land|lot\b|mobile|manufactured|floating|commercial|rental|lease/i;

function filterCandidates(rowsByArea) {
  let all = [];
  for (const key of Object.keys(rowsByArea)) {
    for (const r of rowsByArea[key].rows || []) {
      const price = num(r.price), sqft = num(r.sqft);
      if (!price) continue;
      // A living area under 300 sqft (or none) is a placeholder, not a house:
      // "1" made 6003 Wragg Canyon Rd read $210,000/sqft — 35,533% of the
      // median. Kept out of $/sqft and the medians, and rejected below WITH a
      // reason (a confirmed deal still goes through).
      const realSqft = sqft >= 300 ? sqft : 0;
      // The area's own price cap, never over $3M — checked here as well as
      // in the search box, in case the search ignored it.
      const box = DEFAULT_BUYBOX.find(a => a.county === rowsByArea[key].county);
      all.push({ ...r, _price: price, _sqft: realSqft, _sqftRaw: sqft, _age: num(r.age), _dom: num(r.dom),
        _cap: Math.min(((box && box.maxk) || 1500) * 1000, 3000000),
        _ppsf: realSqft ? Math.round(price / realSqft) : 0,
        // "All San Francisco" is a log heading, not a city — never let it reach
        // a lead, a median key, or the vision prompt.
        _cityKey: r.city || String(key).replace(/^All\s+/i, '') });
    }
  }
  const byCity = {}, bySq = {};
  all.filter(r => r._ppsf).forEach(r => { (byCity[r._cityKey]=byCity[r._cityKey]||[]).push(r._ppsf); (bySq[r._cityKey]=bySq[r._cityKey]||[]).push(r._sqft); });
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
    if (!r._sqft) return r._sqftRaw ? `living area listed as ${r._sqftRaw} sqft — not a real figure; check by hand` : 'no living area (sqft) listed — check by hand';
    // Single-family only, under the cap — the search asks for both, this
    // makes sure (Bryan, 2 Oct: "filter single family home only and we don't
    // buy 3M above").
    if (r._cap && r._price > r._cap) return `$${Math.round(r._price / 1000).toLocaleString()}k is over the $${r._cap / 1e6}M cap`;
    if (r.cls && NOT_SFR_CLASS_RE.test(r.cls) && !/single[\s-]*family/i.test(r.cls)) return `not a single-family home — ${r.cls}`;
    // A BLANK age field parses to 0, which used to read as "built this year" and
    // silently discarded the listing as too new. Missing is not new: let an
    // unknown age through to photo review, where the pictures settle it.
    if (r._age > 0 && r._age < 25) return `too new — built ${new Date().getFullYear() - r._age}, want 25+ years old`;
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
  const near = r => r._ppsf ? r._ppsf / (med[r._cityKey] || 1) : 9;
  cands.sort((a, b) => near(a) - near(b));
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
  // Work done to the house (v1.72.2, Seth 17 Oct): 1928 Camargo Dr — "New
  // laminate floors throughout, New paint, New cooktop, refurbished counter
  // tops… staged" — read as "silent on condition" and "good bones" carried it
  // to A. A "needs / could use" in front never counts.
  /(?<!(?:old|older|worn|original|dated|aged|damaged|tired|scratched) )(?:laminate (?:floor|flooring|wood)|vinyl plank|engineered (?:hard)?wood)|(?<!(?:needs?|could use|requires?|wants?) )new (?:\w+ ){1,2}(?:floors|flooring)\b/i,
  /(?:refurbished|resurfaced|refinished|reglazed) (?:counter|cabinet|tub|bath|kitchen)/i,
];
// Light touches: fresh paint, new carpet, one new appliance. Sellers do these
// before listing a house that still has its original kitchen and bath, and a
// flipper still has a full job there (the 844 Brunswick lesson) — so on their
// own, even together, they never drop a house; one real finish above plus two
// of these does. Two real finishes drop as before (Camargo: laminate floors +
// refurbished counters, with paint and a cooktop on top).
const LIGHT_FINISH_KW = [
  /(?<!(?:needs?|could use|requires?|wants?) )(?:new (?:interior |exterior )?paint|fresh(?:ly)? paint(?:ed)?|newly painted|new carpet(?:ing)?)/i,
  /(?<!(?:needs?|could use|requires?|wants?) )new (?:cooktop|range|stove|oven|dishwasher|refrigerator|fridge)/i,
];
const finishHits = t => ({
  heavy: FINISH_KW.map(re => (t.match(re) || [''])[0]).filter(Boolean),
  light: LIGHT_FINISH_KW.map(re => (t.match(re) || [''])[0]).filter(Boolean),
});

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
  // The grid's Age column reads 0 for a brand-new house, which passes the
  // buy-box screen as "unknown". The report's Age/Yr Blt is the real year:
  // new construction (Meritage, SummerHill, "Lot 778") reached the board as B.
  const yb = Number(meta.yearBuilt) || 0;
  if (yb > 1800 && new Date().getFullYear() - yb < 25) {
    return { decision: 'drop', reason: `too new — built ${yb}, want 25+ years old (hard exclusion)` };
  }
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
  const fh = finishHits(t), finishes = fh.heavy.concat(fh.light);
  if (fh.heavy.length >= 2 || (fh.heavy.length >= 1 && fh.light.length >= 2)) {
    return { decision: 'drop', reason: `${finishes.length} finishes already done — "${finishes.slice(0, 3).join('", "')}" (Rule #0)` };
  }
  // Only trust a low count that came off the full photo grid. When the grid
  // fails to load the app falls back to the carousel, which only ever has ~4
  // preloaded — that dropped 844 Brunswick (29 photos) as "exterior-only".
  // A Coming Soon listing is not on the open market yet and usually has only
  // its exterior shot up — few photos there is "not posted yet", not "no
  // interior access". It goes on for a person (or the AI, once photos post).
  if (photos > 0 && photos <= 4 && meta.photosReliable !== false && !meta.comingSoon) {
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
// Seth's manual check of an Alameda run (28 Sep, 36 leads): every lead he
// approved had the remarks SAY it needs work or is a distressed sale; not one of
// the 20 he called "looks good / refurbished" did. What was missed:
// "Great bones--cosmetic remodel" (1363 Bates), a Xome auction (6225 Tevis) and
// a Fannie Mae HomePath sale (1027 76th). "not a cosmetic remodel" is a hard
// drop in SLOW_KW long before this is read.
const COSMETIC_KW = /((?:great|good|solid) bones|cosmetic (?:remodel|refresh|update|work|fixer|rehab)|(?:a lot|lots|tons|full) of potential)/i;
const DISTRESSED_SALE_KW = /(auction|xome|homepath|fannie mae|freddie mac|bank[- ]owned|\breo\b|hud home|foreclos)/i;
// Same check: no approved lead was built after 1974, and nine of the rejected
// and "double check" ones were (1978-1999). A newer house has had less time to
// wear out — scored down, never dropped.
const NEWER_BUILD = 1975;

/** Do the remarks say this house needs work (or is a distressed sale)?
 *  Nothing reaches A without it — see the 28 Sep calibration above. */
function saysNeedsWork(t) {
  t = String(t || '');
  return NEEDS_WORK_KW.test(t) || FIXER_KW.test(t) || COSMETIC_KW.test(t) || DISTRESSED_SALE_KW.test(t);
}

// ---------- comps: the after-repair value from sold homes (v1.73) ----------
// Seth, 20 Oct: the app fetches the sold comps and the ARV; the board does the
// rehab, holding and selling-cost math from its own Settings, so those numbers
// can change without a new app. ARV is AFTER repair: only sold homes whose own
// remarks say the work was done set it. An as-is sale next door is another
// fixer, not the price a finished house sells for.
const COMP_BANDS = [0.20, 0.40, 0.60];
const COMP_READ = 8;          // sold homes whose remarks are read per lead, nearest in size first
const COMP_LIST_MAX = 16;     // entries kept in the sheet's Comps column
const COMP_NEW_YEARS = 10;    // a sold house this new is a different product, not an ARV comp

/** Sold-search grid rows → comps. The subject itself, a repeat, and anything
 *  too small or too cheap to be a real house sale are left out. */
function compRows(rows, subjectMls) {
  const self = String(subjectMls || '').trim().toUpperCase(), seen = new Set(), year = new Date().getFullYear();
  // the first number only: a "2|0" or "3 (3/0)" baths cell is 2 or 3, never 20 or 330
  const lead = s => { const m = String(s || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : 0; };
  return (rows || []).map(r => {
    const price = num(r.soldPrice) || num(r.price), sqft = num(r.sqft), age = num(r.age);
    return {
      mls: String(r.mls || '').trim().toUpperCase(), addr: String(r.addr || '').replace(/\s+/g, ' ').trim(),
      price, sqft, ppsf: price && sqft ? Math.round(price / sqft) : 0, sold: dayKey(r.sold), gridSold: !!num(r.soldPrice),
      bd: lead(r.bds) || '', ba: lead(r.baths) || '',
      yr: num(r.yr) || (age > 0 && age < 200 ? year - age : ''),
    };
  }).filter(c => c.mls && c.mls !== self && c.sqft >= 300 && c.price >= 50000 && c.ppsf >= 50
    && !seen.has(c.mls) && seen.add(c.mls));
}

/** The size band: ±20% of the subject's square feet, widened to ±40% and then
 *  ±60% only while fewer than 3 sold homes fit. Nearest in size first. */
function compBand(comps, sqft) {
  const s = num(sqft);
  if (!s) return { band: '', pct: 0, widened: false, rows: [] };
  let rows = [], pct = COMP_BANDS[0];
  for (const p of COMP_BANDS) {
    pct = p;
    rows = (comps || []).filter(c => Math.abs(c.sqft - s) / s <= p);
    if (rows.length >= 3) break;
  }
  rows.sort((a, b) => Math.abs(a.sqft - s) - Math.abs(b.sqft - s));
  return { band: '±' + Math.round(pct * 100) + '%', pct, widened: pct > COMP_BANDS[0], rows };
}

/** What a sold home's own remarks say about it when it sold: 'reno' (the work
 *  was done, so its price is an after-repair price), 'fixer' (as-is, needs
 *  work, an estate or distressed sale: not an after-repair price), 'new' (a
 *  newer build: a different product), or 'unknown'. The scan's own wording
 *  rules, read the other way round: what drops a listing makes a comp count. */
function classifyComp(remarks, yearBuilt) {
  const t = String(remarks || '').replace(/\s+/g, ' ').trim();
  const yr = num(yearBuilt);
  if (yr && new Date().getFullYear() - yr < COMP_NEW_YEARS) return { k: 'new', why: 'built ' + yr };
  if (!t) return { k: 'unknown', why: 'no remarks' };
  const hit = re => (t.match(re) || [''])[0];
  if (DONE_STRONG_KW.test(t)) return /new construction|newly built|brand[- ]new home/i.test(hit(DONE_STRONG_KW))
    ? { k: 'new', why: hit(DONE_STRONG_KW) } : { k: 'reno', why: hit(DONE_STRONG_KW) };
  const fixer = [NEEDS_WORK_KW, FIXER_KW, COSMETIC_KW, DISTRESSED_SALE_KW, KEEP_KW, DISTRESS_KW].find(re => re.test(t));
  if (fixer) return { k: 'fixer', why: hit(fixer) };
  if (DONE_HOUSE_KW.test(t)) return { k: 'reno', why: hit(DONE_HOUSE_KW) };
  const f = finishHits(t);
  if (f.heavy.length >= 2) return { k: 'reno', why: f.heavy.slice(0, 3).join(', ') };
  if (f.heavy.length === 1) return { k: 'unknown', why: 'one updated finish — ' + f.heavy[0] };
  return { k: 'unknown', why: 'silent on condition' };
}

/** The ARV, from a size band whose nearest rows carry a classification (k).
 *  Median $/sqft of the renovated sales when there are 3 or more; otherwise of
 *  every sale in the band that is not a known fixer or new build (or simply
 *  every sale), and the confidence says so.
 *    High   — 5+ renovated sales inside ±20%
 *    Medium — 3–4 renovated sales, or 5+ once the band had to widen
 *    Low    — fewer than 3 renovated sales: a rough number to check by hand */
function compArv(sqft, band, total) {
  const s = num(sqft), rows = (band && band.rows) || [];
  const empty = reason => ({ arv: 0, ppsf: 0, conf: '', band: (band && band.band) || '', widened: !!(band && band.widened),
    nReno: 0, nUsed: 0, nBand: rows.length, total: total || 0, basis: '', list: [], reason });
  if (!s) return empty('no square feet on the listing');
  if (!rows.length) return empty(total ? 'no sold home within 60% of its size' : 'no sold single-family homes in its zip in the last 14 months');
  const reno = rows.filter(r => r.k === 'reno');
  let used = reno, basis = 'renovated';
  if (reno.length < 3) {
    const plain = rows.filter(r => r.k !== 'fixer' && r.k !== 'new');
    used = plain.length >= 3 ? plain : rows; basis = 'all';
  }
  const ppsf = median(used.map(r => r.ppsf));
  const conf = reno.length >= 5 && !band.widened ? 'High' : reno.length >= 3 ? 'Medium' : 'Low';
  const on = new Set(used.map(r => r.mls));
  // counted first, nearest in size within each
  const list = rows.slice().sort((a, b) => on.has(b.mls) - on.has(a.mls)).slice(0, COMP_LIST_MAX)
    .map(r => ({ mls: r.mls, addr: r.addr, price: r.price, sqft: r.sqft, ppsf: r.ppsf, sold: r.sold || '',
      bd: r.bd, ba: r.ba, yr: r.yr, use: on.has(r.mls) ? 1 : 0,
      why: String(r.k ? r.why || '' : 'remarks not read').slice(0, 80) }));
  return { arv: Math.round(ppsf * s), ppsf, conf, band: band.band, widened: !!band.widened,
    nReno: reno.length, nUsed: used.length, nBand: rows.length, total: total || 0, basis, list, reason: '' };
}

/** One line for the log and the lead: what the ARV rests on. */
function compSummary(c) {
  if (!c || !c.arv) return 'no ARV — ' + ((c && c.reason) || 'comps not run');
  return `ARV $${c.arv.toLocaleString('en-US')} · $${c.ppsf}/sqft · ${c.nUsed} of ${c.nBand} sold homes `
    + `(${c.band}${c.basis === 'renovated' ? ', renovated sales' : ', not enough renovated sales — all sales'}) · ${c.conf} confidence`;
}

/** The sheet's Comps column: compact JSON, kept well under a cell's 50,000 characters. */
function compsJson(list) {
  let l = (list || []).slice(0, COMP_LIST_MAX), s = JSON.stringify(l);
  while (s.length > 40000 && l.length) { l = l.slice(0, -1); s = JSON.stringify(l); }
  return l.length ? s : '';
}

/** A sold home's Client Full report: its remarks, year and (where the report
 *  labels them) sold price and date. Anchored to the MLS # asked for, like
 *  parseDetail, so a different listing left on screen is never read as this one. */
function parseCompReport(text, mls) {
  const d = parseDetail(text, mls);
  if (d.mismatch) return { mismatch: true, showing: d.showing };
  const t = String(text || '').replace(/\r/g, '');
  const at = t.toUpperCase().indexOf(String(mls || '').trim().toUpperCase());
  const block = at >= 0 ? t.slice(at, at + 6000) : t;
  const grab = re => { const m = block.match(re); return m ? m[1].trim() : ''; };
  // Client Full: "Sale Price:\t$1,250,000\tSale:\t09/15/2026" and "COE:\t09/15/2026".
  // A label's value is at most ONE tab away — two tabs means the field is blank.
  const date = '(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})', gap = ':?[ ]*\\t?[ ]*';
  return {
    mismatch: false, remarks: d.remarks || '', yearBuilt: d.yearBuilt || '',
    soldPrice: num(grab(new RegExp('\\b(?:Sold|Sale|Selling|Close|Closing) ?Price' + gap + '\\$?([\\d,]{5,})', 'i'))) || '',
    soldDate: dayKey(grab(new RegExp('\\b(?:Sold|Sale|Close|Closing|COE) ?Date' + gap + date, 'i'))
      || grab(new RegExp('\\b(?:COE|Sale|Sold)' + gap + date, 'i'))),
  };
}

// ---------- team comps (v1.75, for the Lead Board TEST only) ----------
// Seth, 26-27 Oct, from Gen's comps; radius and window from Juan, 27 Oct: sold
// homes within 1 mile in the last 6 months, the radius widened in the market's
// own steps when too few fit. The app only finds the sales (a radius search,
// one row per sale with its distance and days on market) and writes them to
// their own "Team Comps" tab; the Test board's compcheck.py reads each sale's
// remarks and applies the rest of the rules. Nothing here touches the Leads
// tab or the ARV the real board shows.
const TEAM_TAB = 'Team Comps';
const TEAM_HEADERS = ['MLS #', 'Address', 'Market', 'Radius Searched', 'Sales Found', 'Team Comps', 'Team Comps Run On', 'Note'];
const TEAM_STEPS = { sf: [0.5, 1, 2], city: [1, 2], thin: [1, 2, 3, 5] };
// a sale closed in the last 6 months was listed up to ~9 months ago; the close
// date itself is checked by compcheck.py from each sale's page
const TEAM_LIST_MONTHS = 9;
// widen while fewer than this many sales fit on size, beds, baths and age:
// about half of them turn out light updates or silent on condition
const TEAM_ENOUGH = 6;
const TEAM_PAGES = 20;
// the five Bay counties around San Francisco widen to 2 miles; the rest to 5
const TEAM_CITY_COUNTY = (() => {
  const m = {}, add = (county, cities) => cities.split('|').forEach(c => { m[c.toLowerCase()] = county; });
  add('San Francisco', 'San Francisco');
  add('San Mateo', 'Daly City|Pacifica|South San Francisco|Redwood City|San Bruno|San Mateo|Menlo Park|East Palo Alto|Belmont|El Granada|San Carlos|Burlingame|Foster City|Millbrae|La Honda|Half Moon Bay|Woodside|Moss Beach|Montara|Atherton|Portola Valley|Brisbane|Colma|Hillsborough|Pescadero|Emerald Hills');
  add('Santa Clara', 'San Jose|Morgan Hill|Gilroy|Santa Clara|Milpitas|Campbell|Sunnyvale|Los Gatos|San Martin|Mountain View|Palo Alto|Cupertino|Saratoga|Los Altos|Monte Sereno');
  add('Alameda', 'Oakland|Berkeley|San Leandro|Hayward|Fremont|Livermore|Union City|Castro Valley|Newark|Albany|Alameda|Dublin|Pleasanton|Sunol|San Lorenzo|Emeryville|Piedmont');
  add('Contra Costa', 'Richmond|Antioch|Pittsburg|Concord|Martinez|Pleasant Hill|Oakley|Walnut Creek|Orinda|Brentwood|Lafayette|Clayton|Discovery Bay|San Pablo|El Sobrante|El Cerrito|Pacheco|San Ramon|North Richmond|Moraga|Danville|Pinole|Bay Point|Kensington|Hercules|Rodeo|Crockett|Byron|Knightsen|Alamo');
  add('Marin', 'San Rafael|Mill Valley|Novato|San Anselmo|Fairfax|Bolinas|Larkspur|Corte Madera|Woodacre|Sausalito|Tiburon|Greenbrae|Kentfield|Point Reyes Station|Inverness|Stinson Beach|Forest Knolls|Lagunitas');
  return m;
})();

/** 'sf', 'city' or 'thin', from the city in "…, City, CA 94xxx". */
function teamMarket(addr) {
  const m = String(addr || '').match(/,\s*([^,]+?),\s*CA\b/i);
  const county = m ? TEAM_CITY_COUNTY[m[1].trim().toLowerCase()] : '';
  return county === 'San Francisco' ? 'sf' : county ? 'city' : 'thin';
}

/** Results-grid rows (JS_SCRAPE_SOLD) -> the sales kept on the Team Comps tab. */
function teamRows(rows, subjectMls) {
  const self = String(subjectMls || '').trim().toUpperCase(), seen = new Set(), year = new Date().getFullYear();
  const lead = s => { const m = String(s || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : ''; };
  return (rows || []).map(r => {
    const price = num(r.soldPrice) || num(r.price), sqft = num(r.sqft), age = num(r.age);
    const dist = String(r.dist || '').match(/(\d+(?:\.\d+)?)/);
    return {
      mls: String(r.mls || '').trim().toUpperCase(), addr: String(r.addr || '').replace(/\s+/g, ' ').trim(),
      price, sqft, bd: lead(r.bds), ba: lead(r.baths),
      yr: num(r.yr) || (age > 0 && age < 200 ? year - age : ''),
      sold: dayKey(r.sold), dom: r.dom === '' || r.dom == null ? '' : num(r.dom),
      mi: dist ? Number(dist[1]) : '', area: String(r.area || '').trim(), city: String(r.city || '').trim(),
    };
  }).filter(c => c.mls && c.mls !== self && c.sqft >= 300 && c.price >= 50000 && !seen.has(c.mls) && seen.add(c.mls));
}

/** Sales that fit the lead on what the grid shows: within 20% of its size,
 *  beds within 1, built within 20 years, and not a 0-days-on-market sale. */
function teamFits(rows, lead) {
  const sq = num(lead.sqft), bd = num(lead.beds), yr = num(lead.year);
  return (rows || []).filter(r => (!sq || (r.sqft && Math.abs(r.sqft - sq) / sq <= 0.20))
    && (!bd || r.bd === '' || Math.abs(r.bd - bd) <= 1)
    && (!yr || !r.yr || Math.abs(r.yr - yr) <= 20)
    && r.dom !== 0);
}

/** The Team Comps tab's row for one lead. The sales list is compact JSON,
 *  nearest first, kept well under a cell's 50,000 characters. */
function teamRecord(lead, market, radius, rows, note, today) {
  const keep = rows.slice().sort((a, b) => (a.mi === '' ? 99 : a.mi) - (b.mi === '' ? 99 : b.mi));
  let l = keep, s = JSON.stringify(l);
  while (s.length > 45000 && l.length) { l = l.slice(0, -1); s = JSON.stringify(l); }
  return { 'MLS #': lead.mls, 'Address': lead.addr || '', 'Market': market, 'Radius Searched': radius ? radius + ' mi' : '',
    'Sales Found': rows.length, 'Team Comps': l.length ? s : '', 'Team Comps Run On': today, 'Note': note || '' };
}

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
  else if (COSMETIC_KW.test(t)) add(20, `needs cosmetic work — "${hit(COSMETIC_KW)}"`);
  if (DISTRESSED_SALE_KW.test(t)) add(10, `distressed sale — "${hit(DISTRESSED_SALE_KW)}"`);
  // Probate / trust on its own was 3 of Seth's 20 "looks good" (6138 Oakdale,
  // 513 Carobe, 7160 Thorndale): an estate sale is often a well-kept house.
  if (DISTRESS_KW.test(t)) add(5, `probate / trust / estate — "${hit(DISTRESS_KW)}"`);
  if (ORIGINAL_KW.test(t)) add(10, `original / long-held — "${hit(ORIGINAL_KW)}"`);
  // Coming Soon: ahead of the open market. Scored like any other listing —
  // the gate's calibration is untouched — but always said, so nobody misses
  // that showings may not have started.
  if (m.comingSoon) signals.push({ pts: 0, what: 'Coming Soon — not on the open market yet; photos and showings may not have started' });
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
  else if (yb >= NEWER_BUILD) add(-5, `newer build (${yb})`);
  const dom = Number(m.dom) || 0;
  if (dom >= 21) add(5, `${dom} days on market`);

  // Retail-ready signals that are not disqualifying on their own.
  const fh = finishHits(t), finishes = fh.heavy.concat(fh.light);
  if (finishes.length && !NEEDS_WORK_KW.test(t)) add(-5, finishes.length === 1 ? `one updated finish — "${finishes[0]}"` : `freshened up — "${finishes.join('", "')}"`);
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
  // A = "Work Now", and on the 28 Sep check an A without needs-work wording was
  // never a buy (6138 Oakdale, 2825 Hillcrest). Price, $/sqft and vacancy say
  // it is cheap, not that it needs work: those wait in B for the photos.
  const needsWork = saysNeedsWork(t);
  // "Sold as-is" is legal boilerplate on refurbished houses too (1542 Buena
  // Vista, 36173 Cedar — Seth, 1 Oct): on its own it is not evidence of work
  // to do, so it cannot carry a lead to A. It still scores; the photos decide.
  // "First time on the market in 50 years" / "original condition" is evidence
  // too — that is what kept 347 Faxon an A.
  const noAsIs = t.replace(/\bas[- ]is\b/gi, '');
  const needsWorkBeyondAsIs = saysNeedsWork(noAsIs) || ORIGINAL_KW.test(noAsIs);
  if (bucket === 'A' && !needsWork) {
    bucket = 'B';
    score = Math.min(score, BUCKET_A - 1);
    signals.push({ pts: 0, what: 'remarks never say it needs work — held at B for the photos' });
  } else if (bucket === 'A' && !needsWorkBeyondAsIs) {
    bucket = 'B';
    score = Math.min(score, BUCKET_A - 1);
    signals.push({ pts: 0, what: 'only a boilerplate "as-is" — held at B for the photos' });
  }
  // Remarks silent on condition and the reviewer asked for unsure = drop.
  if (r.decision === 'manual' && m.whenUnsure === 'drop' && bucket === 'B' && !top.length) bucket = 'C';
  const note = signals.filter(x => x.pts === 0 && /tenant now|held at B|Coming Soon/.test(x.what)).map(x => x.what);
  const why = [...top, ...neg, ...note].join(' + ') || r.reason;
  return { bucket, label: BUCKET_LABEL[bucket], score, decision: bucket === 'C' ? 'drop' : 'keep',
    hard: false, why, signals, needsWork };
}

/* ---------- the second look: our own past deals (v1.74, Seth 21 Oct) ----------
 * The ~$180k deal Juan lost was thrown away by one step of the line, and
 * nothing compared it with houses we had already bought. So a listing the gate
 * scores C (a low score — never a hard exclusion) is not dropped when we bought
 * in the SAME city, within 40% of its price, and made money there: it goes to
 * B for a person to look at. A loss among those deals means no second look.
 *
 * The deals come from the sheet's "Past Deals" tab, kept by Cherry and Juan.
 * Only deals with every number known count (Seth: "for those that are blank do
 * not include them yet ... be picky"), bought at or under $1.5M (Seth, 21 Oct).
 * Hard exclusions — renovated (Rule #0), fire, tenant, multi-unit, structural,
 * too new, too few photos — and the buy box are never overruled, and the AI
 * photo check still judges the house like any B. */
const PAST_DEALS_TAB = 'Past Deals';
const PAST_DEAL_HEADERS = ['Address', 'City', 'Bought', 'Sold', 'Net', 'Bought On', 'Sold On', 'Status', 'Notes'];
const PAST_DEAL_CAP = 1500000, PAST_DEAL_BAND = 0.4;
const UNRESOLVED_DEAL = /status conflict|unresolved|not an acquisition|never took title/i;

/** "$1,350,000", "1.35M", "$950K", "-71,477", "−$71k", "(71,477)" → a number; anything else → null. */
function money(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v == null ? '' : v).trim().replace(/[\s,$]/g, '').replace(/[−–]/g, '-');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.charAt(0) === '-') { neg = !neg; s = s.slice(1); }
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1);
  return Math.round(neg ? -n : n);
}

const dealCity = c => String(c || '').split(',')[0].toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/** The "Past Deals" tab (header row first) → { deals, left, error }. A row with
 *  a blank in Bought / Sold / Net, no city, over the cap, a Status other than
 *  Sold, or an unresolved note is left out and listed in `left` with the why. */
function pastDealsFromGrid(grid) {
  const head = ((grid && grid[0]) || []).map(h => String(h || '').trim().toLowerCase());
  const at = h => head.indexOf(h.toLowerCase());
  const need = ['Address', 'City', 'Bought', 'Sold', 'Net'];
  const missing = need.filter(h => at(h) < 0);
  if (!grid || !grid.length) return { deals: [], left: [], error: 'the tab is empty' };
  if (missing.length) return { deals: [], left: [], error: `the tab has no ${missing.join(' / ')} column — it needs ${PAST_DEAL_HEADERS.slice(0, 5).join(' · ')}` };
  const deals = [], left = [];
  grid.slice(1).forEach(r => {
    const g = h => (at(h) >= 0 && r ? String(r[at(h)] == null ? '' : r[at(h)]).trim() : '');
    const a = g('Address'), c = g('City');
    if (!a && !c) return;
    const b = money(g('Bought')), s = money(g('Sold')), n = money(g('Net')), st = g('Status');
    const why = !a || !c ? 'no address or city'
      : b === null || s === null || n === null ? 'a blank in ' + [['Bought', b], ['Sold', s], ['Net', n]].filter(x => x[1] === null).map(x => x[0]).join(' / ')
      : !(b > 0) ? 'no purchase price'
      : b > PAST_DEAL_CAP ? `bought over the $${(PAST_DEAL_CAP / 1e6).toFixed(1)}M cap`
      : st && !/^sold$/i.test(st) ? `status "${st.slice(0, 30)}", not Sold`
      : UNRESOLVED_DEAL.test(g('Notes')) ? 'status unresolved in the notes' : '';
    if (why) { left.push({ addr: [a, c].filter(Boolean).join(', '), why }); return; }
    deals.push({ addr: a.slice(0, 80), city: c.split(',')[0].trim().slice(0, 40), bought: b, sold: s, net: n,
      boughtOn: dayKey(g('Bought On')) || '', soldOn: dayKey(g('Sold On')) || '' });
  });
  return { deals, left, error: '' };
}

const kMoney = n => { const a = Math.abs(n); return (a >= 1e6 ? '$' + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : '$' + Math.round(a / 1e3) + 'k'); };

/** Our deals in this listing's city bought within 40% of its price.
 *  → null (nothing to compare), { keep: false, why } (one of them lost money),
 *  or { keep: true, why, deals } (every one made money). */
function secondLook(m, deals) {
  const price = num(m && m.price), city = dealCity(m && m.city);
  if (!(price > 0) || !city || !Array.isArray(deals) || !deals.length) return null;
  const near = deals.filter(d => dealCity(d.city) === city && Math.abs(d.bought - price) <= PAST_DEAL_BAND * price)
    .sort((x, y) => Math.abs(x.bought - price) - Math.abs(y.bought - price));
  if (!near.length) return null;
  const line = d => `${d.net < 0 ? 'lost' : 'made'} ${d.net < 0 ? '−' : '+'}${kMoney(d.net)} on ${d.addr}, ${d.city} (bought ${kMoney(d.bought)}, sold ${kMoney(d.sold)})`;
  const lost = near.filter(d => !(d.net > 0));
  if (lost.length) return { keep: false, deals: near, why: `we ${line(lost[0])} — a past loss near this price, so no second look` };
  return { keep: true, deals: near,
    why: `SECOND LOOK — we ${line(near[0])}${near.length > 1 ? ` and ${near.length - 1} more there at a similar price, all made money` : ''}` };
}

/** The gate's verdict after the second look: a soft C (a low score, never a
 *  hard exclusion, never a confirmed or AI drop) becomes a B when secondLook()
 *  says keep. Returns the look (or null) and changes `q` in place. */
function applySecondLook(q, m, deals) {
  if (!q || q.bucket !== 'C' || q.hard || /^AI/.test(String(q.why || ''))) return null;
  const sl = secondLook(m, deals);
  if (sl && sl.keep) {
    Object.assign(q, { bucket: 'B', label: BUCKET_LABEL.B, decision: 'keep', secondLook: true,
      why: `${sl.why} · the scan scored it ${q.score}: ${q.why}` });
  }
  return sl;
}

/**
 * Turn the vision model's JSON into a verdict.
 *
 * The model is not trusted to apply "dated but in good repair = DROP" itself:
 * on Seth's 28 Sep check it said KEEP on all 36 leads, while writing "dated
 * but intact", "clean but old style", "in good condition" about 20 houses he
 * rejected. So it now reports the WEAR it saw ("heavy" | "some" | "none") and
 * the code decides: a KEEP with no wear is a drop — unless the remarks say the
 * house needs work, which the photos may simply not show.
 */
function aiVerdict(o, remarksText) {
  o = o || {};
  const keep = /^keep$/i.test(String(o.decision || '').trim());
  const wear = String(o.wear || '').trim().toLowerCase();
  if (!keep) return { decision: 'drop', why: '' };
  // "Old style" is not original. A 2000s cherry/granite/stainless kitchen reads
  // as "dated" and was KEPT on 1629 68th, 9014 A St, 37735 Blacow, 9024 Olive,
  // 2825 Hillcrest — each a house someone had already updated (28 Sep photos).
  const era = String(o.era || '').trim().toLowerCase();
  if (/^(prior|new)/.test(era) && !/^(heavy)/.test(wear)) {
    return { decision: 'drop', why: era.startsWith('new') ? 'recently renovated finishes' : 'prior update (1995-2015 finishes) — work already done' };
  }
  if (/^none\b/.test(wear) && !saysNeedsWork(String(remarksText || '').replace(/\bas[- ]is\b/gi, ''))) {
    return { decision: 'drop', why: 'dated but in good condition — no wear or damage in the photos' };
  }
  return { decision: 'keep', why: /^none\b/.test(wear) ? 'photos show no wear, kept because the remarks say it needs work' : '' };
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
  // Five digits only: "94928." reached the sheet with its full stop.
  let z = (String(zip || '').match(/\b(\d{5})\b/) || [])[1] || '';

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
    // TBD is read FIRST: "Offer date TBD after first weekend of open houses,
    // open Sat 10/10 2-4 PM" alerted as due Sat 4 PM, and "Offer date to be
    // determined after 10/11" as due 10/11 (Seth, 10 Oct). A date after a TBD
    // is an open house or a "not before", never the deadline.
    if (/\bT\.?B\.?[DA]\b|to be (?:determined|announced)/i.test(w.slice(0, 40))) return 'TBD';
    const date = findDate(w, now);
    if (date) return date + findTime(w);
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

// ---- v1.74.1: a passed lead is re-checked for a price cut (Seth, 21 Oct) ----
// Refresh skipped every row passed in Notes and a scan skips every row already
// on the sheet, so a cut after the pass was never seen. 1534 Kooser Rd
// (ML82059011) was passed at $1,399,888 ("PASS-SOLD LAST AUG 17"), cut to
// $999,999 — 65% of the San Jose median — and went Pending with someone else
// while the sheet still read $1.4M. Refresh now re-reads passed leads still on
// the market and says so on the Why; it never touches Notes.
const PASS_RECHECK_DAYS = 120;   // passed leads added in the last ~4 months
const PASS_CUT_PCT = 10;         // at least 10% under the price on the sheet
// a pass about the listing's status, not the house — "SOLD", "off-market", "pending"
const PASS_FOR_STATUS = /\b(?:sold|pending|contingent|off[- ]?market|withdrawn|under contract|in escrow)\b/i;
const PASS_FLAG_RE = /^(?:PRICE CUT|BACK ON THE MARKET) AFTER PASS\b[^·]*(?:·\s*|$)/;

/** A sheet date ("2026-08-26", "8/26/2026", a sheet day number) as YYYY-MM-DD, or "". */
function dayKeyOf(v) {
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s);
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  if (/^\d{5}(?:\.\d+)?$/.test(s)) return new Date(Math.round((+s - 25569) * 864e5)).toISOString().slice(0, 10);
  return '';
}
/** YYYY-MM-DD, `days` before `today` (YYYY-MM-DD). */
function daysBefore(today, days) {
  return new Date(new Date(today + 'T12:00:00Z').getTime() - days * 864e5).toISOString().slice(0, 10);
}
/** Is this passed row one a Refresh re-reads? Still on the market, added recently. */
function passRecheckDue(row, today) {
  if (!PASSED_NOTE.test(String(row.notes || ''))) return false;
  if (CLOSED_STATUS.test(String(row.mlsStatus || ''))) return false;
  const d = dayKeyOf(row.firstAdded);
  return !d || d >= daysBefore(today, PASS_RECHECK_DAYS);   // no date: check rather than skip
}
const shortPrice = n => (n >= 995000 ? '$' + (n / 1e6).toFixed(2) + 'M' : '$' + Math.round(n / 1000) + 'k');
/**
 * A passed lead, read again: did its price fall far enough to look again, or
 * did a lead passed as sold / pending come back on the market?
 * {note, sheetPrice, listPrice, status} -> {flag, why}
 */
function passRecheck(o) {
  const was = num(o.sheetPrice), now = num(o.listPrice), st = String(o.status || '').trim();
  if (was > 0 && now > 0 && now <= was * (1 - PASS_CUT_PCT / 100)) {
    return { flag: true, why: 'PRICE CUT AFTER PASS — ' + shortPrice(was) + ' → ' + shortPrice(now)
      + ' (−' + Math.round(100 * (was - now) / was) + '%)' + (st ? ', now ' + st : '') + ': look again' };
  }
  if (PASS_FOR_STATUS.test(String(o.note || '')) && /^\s*(?:active|coming soon)\b/i.test(st)) {
    return { flag: true, why: 'BACK ON THE MARKET AFTER PASS — passed as off the market, the MLS now says ' + st + ': look again' };
  }
  return { flag: false, why: '' };
}
/** The Why with the after-pass flag in front — replacing an older flag, never stacking. */
function withPassFlag(why, flag) {
  const rest = String(why || '').replace(PASS_FLAG_RE, '').trim();
  return flag + (rest ? ' · ' + rest : '');
}

// ---- v1.74.1: Refresh comps the live A/B leads that have no ARV yet ----
// v1.73 comps every NEW A/B lead; the ~1,050 added before it had none (15 of
// 1,064 live A/B leads carried an ARV on 21 Oct), so the board's Comps agent
// had nothing to show. Each Refresh comps a few, A first.
const REFRESH_COMPS_MAX = 25;          // per Refresh: a new zip reads up to COMP_READ sold reports
const REFRESH_COMPS_RETRY_DAYS = 14;   // a lead that found no comps is tried again after two weeks
/** Should a Refresh comp this row? {bucket, arv, compsAt, status} */
function refreshNeedsComps(row, today) {
  if (!/^[AB]/.test(String(row.bucket || ''))) return false;
  if (num(row.arv) > 0) return false;
  if (CLOSED_STATUS.test(String(row.status || '')) || PENDING_STATUS.test(String(row.status || ''))) return false;
  const d = dayKeyOf(row.compsAt);
  return !d || d < daysBefore(today, REFRESH_COMPS_RETRY_DAYS);
}

// v1.74.5 (Seth, 22 Oct): a Refresh that stopped at 632 of 1,176 started over
// at lead 1 when it was run again — two hours redoing leads it had just saved.
// The MLS #s each Refresh SAVES to the sheet are kept for the day; run again
// the same day, it skips them and picks up where it stopped. A new day starts
// the list over (statuses move), and a Refresh that finishes clears the list.
/** The MLS #s an unfinished Refresh already saved today. {day, done: [...]} */
function refreshResume(progress, today) {
  if (!progress || progress.day !== today || !Array.isArray(progress.done)) return new Set();
  return new Set(progress.done.map(m => String(m || '').trim().toUpperCase()).filter(Boolean));
}
/** Add the MLS #s just saved; a list from another day is started over. */
function refreshProgressAdd(progress, today, mlsList) {
  const done = [...refreshResume(progress, today)], seen = new Set(done);
  for (const m of mlsList || []) {
    const k = String(m || '').trim().toUpperCase();
    if (k && !seen.has(k)) { seen.add(k); done.push(k); }
  }
  return { day: today, done };
}

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
  // A relisted house carries a new MLS # and lands on Leads a second time
  // (278 6th St, Richmond: CC41137475 and CC41150273). List it once — the
  // row added last, which is the live listing.
  // Key: the whole street line (suffix and punctuation ignored) + zip, so
  // "100 N Main St" and "100 N Oak St" never collide.
  // Suffixes are mapped to one spelling, never removed ("Oak St" and "Oak Ct"
  // are different houses); the zip is the last one in the address.
  const SUFFIX = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', court: 'ct', lane: 'ln', boulevard: 'blvd',
    place: 'pl', terrace: 'ter', terrance: 'ter', circle: 'cir', parkway: 'pkwy' };
  const SUF = new Set(Object.values(SUFFIX).concat(['way', 'cir', 'hwy', 'sq', 'loop', 'aly']));
  const parts = r => { const a = cell(r, 'Address').toLowerCase();
    const z = (a.match(/\b9\d{4}\b/g) || []).pop() || '';
    const w = a.split(',')[0].replace(/[^a-z0-9 ]+/g, ' ').replace(/[a-z]+/g, x => SUFFIX[x] || x).trim().split(/\s+/);
    if (!/^\d+[a-z]?$/.test(w[0] || '') || w.length < 2 || !z) return null;
    const suf = w.length > 2 && SUF.has(w[w.length - 1]) ? w.pop() : '';
    return { base: w.join(' ') + ' ' + z, suf }; };
  // "5826 Avenal" and "5826 Avenal Avenue" are one house; "Oak St" and "Oak Ct" are two.
  const sufs = {};
  notPassed.forEach(r => { const p = parts(r); if (p && p.suf) (sufs[p.base] = sufs[p.base] || new Set()).add(p.suf); });
  const houseKey = r => { const p = parts(r); if (!p) return '';
    const only = sufs[p.base] && sufs[p.base].size === 1 ? [...sufs[p.base]][0] : '';
    return p.base + '|' + (p.suf || only || '?'); };
  // A real MLS # beats a Redfin-only id (it has the MLS link and a refresh
  // can look it up); between equals, the row added last wins.
  const realMls = r => { const m = cell(r, 'MLS #').toUpperCase(); return /^[A-Z]{2,6}\d{5,}$/.test(m) && !/^RF\d/.test(m) ? 1 : 0; };
  const lastFor = {};
  notPassed.forEach((r, i) => { const k = houseKey(r); if (!k || CLOSED_STATUS.test(cell(r, 'MLS Status')) || isC(r)) return;
    if (lastFor[k] == null || realMls(r) >= realMls(notPassed[lastFor[k]])) lastFor[k] = i; });
  const live = notPassed.filter((r, i) => !CLOSED_STATUS.test(cell(r, 'MLS Status')) && !isC(r)
    && (!houseKey(r) || lastFor[houseKey(r)] === i));
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
  // The remark starts on the label's own line ("Private:<tab>supra now is on
  // the property…"). An EMPTY field is empty: the old `:\s*` crossed the line
  // break and saved the next section's heading, "Showing & Location", as the
  // remark — 51 rows on the sheet, 136 Rae Ave (SF426167828) among them, whose
  // agent later added "Offer date to be 10/28/2026 by 2:00pm" (Seth, 22 Oct).
  // If a report ever puts the remark on the line BELOW the label, that line is
  // taken only when it is plainly a remark — never a section heading or another
  // field's "Label:" line.
  const t = String(text || '');
  const m = /(?:^|\n)[ \t]*(?:Private(?:[ \t]*Remarks?)?|(?:Agent|Realtor|Broker|Confidential)[ \t]*(?:Only[ \t]*)?Remarks?)[ \t]*:[ \t]*/i.exec(t);
  if (!m) return '';
  let rest = t.slice(m.index + m[0].length);
  if (rest === '' || rest.charAt(0) === '\n') {               // nothing on the label's own line
    const next = rest.replace(/^\n[ \t]*/, '');
    const line = next.split('\n')[0].trim();
    if (!line || isJunkPrivate(line) || /^[A-Za-z][\w .&/#()'-]{0,40}:/.test(line)) return '';
    rest = next;
  }
  const end = rest.search(/\n[ \t]*\n|\n[ \t]*Showing|\nVirtual Open|\nFeatures/i);
  const v = (end < 0 ? rest : rest.slice(0, end)).slice(0, 1500).replace(/\s+/g, ' ').trim();
  return isJunkPrivate(v) ? '' : v;
}
/** A section heading saved as a private remark by the old reader — never a real remark. */
const JUNK_PRIVATE = /^\s*(?:Showing\s*(?:&|and)\s*Location|Showing\s+Information|Virtual\s+Open\s+House|Features)\s*$/i;
function isJunkPrivate(v) { return JUNK_PRIVATE.test(String(v == null ? '' : v)); }

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
    // Comps (v1.73): the ARV and the sold homes it rests on.
    arv: num(l.arv), arvPpsf: num(l.arvPpsf), compConf: clip(l.compConf, 80),
    comps: boardComps(l.comps),
  };
}
/** The Comps column (JSON text, or a list) as the board stores it, every field checked. */
function boardComps(v) {
  let a = v;
  if (typeof a === 'string') { try { a = a ? JSON.parse(a) : []; } catch (_) { a = []; } }
  const n = x => (x === '' || x == null || !isFinite(Number(x))) ? null : Number(x);
  return (Array.isArray(a) ? a : []).slice(0, COMP_LIST_MAX).filter(c => c && typeof c === 'object').map(c => ({
    mls: clip(c.mls, 20).toUpperCase(), addr: clip(c.addr, 120), price: n(c.price), sqft: n(c.sqft), ppsf: n(c.ppsf),
    sold: /^\d{4}-\d{2}-\d{2}$/.test(String(c.sold || '')) ? c.sold : '', bd: n(c.bd), ba: n(c.ba), yr: n(c.yr),
    use: c.use ? 1 : 0, why: clip(c.why, 80),
  })).filter(c => /^[A-Z0-9]{5,20}$/.test(c.mls));
}

// ---------- re-reviewing a past scan (v1.46) ----------
// Seth, 29 Sep: a teammate scanned with an outdated app and there was no way
// to re-check those listings. Two things made "Clear ledger" useless: the scan
// pulled EVERY MLS # on the Rejected tab back in as checked (its own drops
// included, on every computer), and leads already on the sheet are always
// skipped. Only a PERSON's rejection is permanent; the scan's own drops live in
// each computer's local ledger, and a past scan can be re-reviewed by date.

/** A Rejected row a person made (email in By, or a Reviewer / Deleted-by-hand
 *  stage) — as opposed to one the scan wrote ('FlipScout'). */
function isPersonRejection(by, stage) {
  return /@/.test(String(by || '')) || /reviewer|deleted by hand/i.test(String(stage || ''));
}

/** A sheet date cell as YYYY-MM-DD: "2026-09-27", "9/27/2026", "9/27/26". */
function dayKey(cell) {
  const t = String(cell == null ? '' : cell).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return '';
}

/**
 * What to forget so the next scan re-reviews one day's work.
 *   ledger     — the local seen-ledger { MLS: {last_seen, verdict} }
 *   rejectGrid — the Rejected tab (header row first), leadGrid — the Leads tab
 * Returns { forget: [MLS…] (drop from the ledger), leads: [MLS…] (on the sheet,
 * re-judged in place) }. Never touches a person's rejection or a lead the team
 * passed in Notes.
 */
function rereviewPlan(ledger, rejectGrid, leadGrid, date, passedNote) {
  const col = (grid, h) => ((grid && grid[0]) || []).indexOf(h);
  const up = v => String(v || '').trim().toUpperCase();
  const person = {}, forget = {}, leads = {};
  const R = rejectGrid || [], rM = col(R, 'MLS #'), rOn = col(R, 'Rejected On'), rBy = col(R, 'By'), rSt = col(R, 'Stage');
  R.slice(1).forEach(r => {
    const k = up(r[rM]); if (!k) return;
    if (isPersonRejection(r[rBy], r[rSt])) { person[k] = true; return; }
    if (dayKey(r[rOn]) === date) forget[k] = true;
  });
  const L = leadGrid || [], lM = col(L, 'MLS #'), lAdd = col(L, 'First Added'), lN = col(L, 'Notes');
  const pass = passedNote || PASSED_NOTE;
  L.slice(1).forEach(r => {
    const k = up(r[lM]); if (!k || dayKey(r[lAdd]) !== date) return;
    if (pass.test(String(r[lN] || ''))) return;
    leads[k] = true; forget[k] = true;
  });
  Object.keys(ledger || {}).forEach(k => {
    const e = ledger[k] || {};
    if (e.last_seen === date && /^(kept|dropped)$/.test(e.verdict || '')) forget[k] = true;
  });
  Object.keys(person).forEach(k => { delete forget[k]; delete leads[k]; });
  return { forget: Object.keys(forget), leads: Object.keys(leads) };
}

/** Is this MLS status "Coming Soon" (however the MLS spells it)? */
const COMING_SOON_RE = /coming[\s-]*soon/i;
const isComingSoon = s => COMING_SOON_RE.test(String(s || ''));

// A private / office-exclusive listing is never on the open market. The MLS
// marks it in the status on some boards, and agents say it in the remarks on
// the rest. Whole phrases only: "private remarks", "private yard" and "private
// showing" are not a private listing.
const PRIVATE_LISTING_RE = /\b(?:private[\s-]*listing|office[\s-]*exclusive|pocket[\s-]*listing|off[\s-]*mls)\b/i;
const isPrivateListing = s => PRIVATE_LISTING_RE.test(String(s || ''));

/** The listing-type label the Lead Board colours (Team Guide: Active green,
 *  Coming Soon blue with a ring, Private Listing grey with a dashed ring;
 *  Pending/Contingent orange, Sold/Withdrawn/Expired red). Never blank for a
 *  listing found in a search, so every lead on the board carries a chip. */
function listingLabel({ status, comingSoon, remarks, privateRemarks } = {}) {
  const st = String(status || '').trim();
  if (/sold|withdrawn|expired|cancel|off.?market|closed|pending|contingent|under contract/i.test(st)) return st;
  if (/^private|office[\s-]*exclusive/i.test(st) || isPrivateListing(st) || isPrivateListing(privateRemarks) || isPrivateListing(remarks)) return 'Private Listing';
  if (comingSoon || isComingSoon(st)) return 'Coming Soon';
  return st || 'Active';
}

// ---------- Redfin: Coming Soon / Early Access (v1.50) ----------
// Bryan, 2 Oct: find the Coming Soon and early-access homes on Redfin too,
// straight from redfin.com, no MLS sign-in. The app drives a Redfin window
// from the user's own computer (Redfin refuses cloud servers), reads the
// search cards class-agnostically (a card is the box around a /home/<id>
// link) and keeps only cards whose badge says the home is not on the open
// market yet. Each kept card's own page is then read and judged by the same
// rules as an MLS listing.

/** A badge that means "not on the open market yet". Read off the TOP of a
 *  card only, so a description that mentions "coming soon" (a new roof coming
 *  soon) does not count. */
const REDFIN_EARLY_RE = /\b(coming[\s-]*soon|early[\s-]*access|pre[\s-]*market|private[\s-]*(?:listing|exclusive)|off[\s-]*market[\s-]*(?:listing|exclusive)|exclusive[\s-]*listing|(?:redfin|compass|zillow)[\s-]*exclusive)\b/i;

/** The Redfin county page for a buy-box county, from Redfin's own location
 *  lookup ("{}&&{json}"): "/county/343/CA/San-Francisco-County". */
function redfinCountyPath(body, county) {
  let j;
  try { j = JSON.parse(String(body || '').replace(/^\{\}&&/, '')); } catch (_) { return ''; }
  const want = String(county || '').toLowerCase().replace(/\s+county$/, '').replace(/[^a-z]+/g, '-');
  const rows = [];
  ((j.payload && j.payload.sections) || []).forEach(s => (s.rows || []).forEach(r => rows.push(r)));
  if (j.payload && j.payload.exactMatch) rows.unshift(j.payload.exactMatch);
  const hit = rows.map(r => String(r.url || '')).find(u =>
    /^\/county\/\d+\/CA\/[A-Za-z-]+$/.test(u) && (!want || u.toLowerCase().includes('/' + want + '-county')));
  return hit || '';
}

/** "$1.5M" → Redfin's price slug. */
const redfinPrice = maxk => (maxk >= 1000 ? (maxk / 1000) + 'M' : maxk + 'k');

/** The county's search: houses under the area's cap, newest first. Coming
 *  Soon homes are part of Redfin's for-sale results and are told apart by
 *  their badge, so no status slug has to be guessed. */
function redfinSearchUrl(countyPath, maxk, page) {
  return 'https://www.redfin.com' + countyPath + '/filter/property-type=house,max-price=' + redfinPrice(maxk)
    + ',sort=lo-days' + (page > 1 ? '/page-' + page : '');
}

/** "$1,250,000", "$1.25M", "$950K", "1250000" → dollars (0 when unreadable).
 *  A "$2.7M" read as 0 used to pass every price cap. */
function parsePrice(x) {
  const m = String(x == null ? '' : x).replace(/\s+/g, '').match(/\$?([\d,]*\.?\d+)([MmKk])?/);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  if (!isFinite(n)) return 0;
  return Math.round(m[2] && /m/i.test(m[2]) ? n * 1e6 : m[2] && /k/i.test(m[2]) ? n * 1e3 : n);
}

/** One search card's text → the facts on it. `top` is the badge area. */
function redfinCard({ href, text }) {
  const url = String(href || '').replace(/[?#].*$/, '');
  const m = url.match(/^https:\/\/www\.redfin\.com\/[A-Z]{2}\/[^/]+\/[^/]+\/home\/(\d+)$/);
  if (!m) return null;
  const t = String(text || '');
  const lines = t.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const priceAt = lines.findIndex(x => /^\$[\d,]+(?:\.\d+)?[MmKk]?\+?$/.test(x));
  // The badge sits above the price on a Redfin card.
  const top = (priceAt > 0 ? lines.slice(0, priceAt) : lines.slice(0, 2)).join(' · ');
  const badge = (top.match(REDFIN_EARLY_RE) || [])[0] || '';
  const n = re => { const x = t.match(re); return x ? Number(x[1].replace(/,/g, '')) : 0; };
  const addr = lines.find(x => /^\d+\S*\s.+,\s*[A-Za-z .'-]+,\s*CA\s*9\d{4}$/.test(x)) || redfinAddrFromUrl(url);
  return {
    homeId: m[1], url, addr, badge, top,
    price: priceAt >= 0 ? parsePrice(lines[priceAt]) : 0,
    beds: n(/([\d.]+)\s*beds?\b/i), baths: n(/([\d.]+)\s*baths?\b/i), sqft: n(/([\d,]+)\s*sq\s*ft/i),
    early: !!badge,
  };
}

/** "/CA/San-Francisco/21-College-Ter-94112/home/1" → "21 College Ter, San Francisco, CA 94112". */
function redfinAddrFromUrl(url) {
  const m = String(url || '').match(/\/([A-Z]{2})\/([^/]+)\/([^/]+)-(9\d{4})\/home\/\d+$/);
  return m ? `${m[3].replace(/-/g, ' ')}, ${m[2].replace(/-/g, ' ')}, ${m[1]} ${m[4]}` : '';
}

/** A Redfin home page's text → what the rules need. */
function parseRedfinHome(text) {
  const t = String(text || '').replace(/\r/g, '');
  const grab = re => { const m = t.match(re); return m ? m[1].trim() : ''; };
  // The description, whether Redfin lays it out on its own lines or runs it
  // into the next section on one line (the first app run read nothing).
  let remarks = grab(/About this home\s+([\s\S]{20,4000}?)(?=\s+(?:Show (?:more|less)|Listed by|Redfin last checked|Source:|Hide|Read more|Home facts|Property details|Built in (?:18|19|20)\d\d|\d+ days? on Redfin)\b|$)/i);
  remarks = remarks.replace(/\s+/g, ' ').trim();
  const source = grab(/Source:\s*([^\n#]{2,60}?)\s*#/i);
  const rawMls = grab(/(?:MLS\s*#|Source:[^\n#]{0,60}#)\s*([A-Z]{0,4}\d{5,12})\b/i).toUpperCase();
  const year = Number(grab(/(?:Built in|Year Built\s*:?)\s*((?:18|19|20)\d{2})\b/i)) || 0;
  const dom = grab(/\b(\d+)\s+days?\s+on\s+Redfin/i);
  const lot = t.match(/Lot Size\s*:?\s*([\d,.]+)\s*(sq\.?\s*ft|acres?)/i);
  // The asking price: the first dollar figure at the top of the page that is
  // not the Redfin Estimate, a monthly payment or a price per sq ft.
  const top = t.slice(0, 2500).split('\n');
  const priceLine = top.find(x => /\$\s?[\d,.]+\s*[MmKk]?/.test(x) && !/estimate|est\.|\/mo|per month|\/sq|sq\.?\s*ft|payment|rent|sold for|last sold/i.test(x)) || '';
  const pagePrice = parsePrice((priceLine.match(/\$\s?[\d,.]+\s*[MmKk]?/) || [''])[0]);
  const status = (t.slice(0, 1500).match(REDFIN_EARLY_RE) || [])[0]
    || grab(/(?:Listing |MLS )?Status\s*:?\s*([A-Za-z][A-Za-z -]{2,30})\n/i);
  const ptype = redfinPageType(t);
  return {
    remarks, year, dom: dom === '' ? '' : Number(dom), status, price: pagePrice,
    agent: grab(/Listed by\s+([^•·\n]{3,80}?)\s*(?:•|·|\n|$)/i),
    mls: redfinMlsId(rawMls, source), mlsDigits: redfinMlsDigits(rawMls),
    lotSqft: lot ? Math.round(Number(lot[1].replace(/,/g, '')) * (/acre/i.test(lot[2]) ? 43560 : 1)) : 0,
    propClass: /single/i.test(ptype) ? 'Res. Single Family' : ptype, ptype,
    ptypeLabelled: /^[ \t]*Property[ \t]*type[ \t]*:?[ \t]*(?:\n[ \t]*)?[A-Za-z]/im.test(t),
  };
}

/** Redfin shows the MLS's number; turn it into the id the MLS scan uses, so
 *  the same house is not reviewed twice. SFAR numbers appear without "SF". */
function redfinMlsId(raw, source) {
  const id = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!id) return '';
  if (/^[A-Z]{2,4}\d{5,}$/.test(id)) return id;
  if (/^42\d{7}$/.test(id) || (/^\d{9}$/.test(id) && /san francisco/i.test(source || ''))) return 'SF' + id;
  if (/^32\d{7}$/.test(id)) return 'BA' + id;   // Bay Area Real Estate Information Services
  // Anything else is not an MLS # the board can use: an Early Access home has
  // no MLS listing, and Redfin puts its own listing id there instead
  // ("2199662030468543705", "120807"); a bare bridgeMLS "41149866" may be EB,
  // BE or CC on MLSListings, so its prefix cannot be guessed. Those leads keep
  // RF<homeId> as their id; redfinMlsDigits() still matches them against the
  // MLS #s already checked or on the board.
  return '';
}

/** The digits of a Redfin "MLS #" worth matching against MLS #s (8–10 digits:
 *  real MLS numbers are 8–10 digits; Redfin's own listing ids are not). '' when there is nothing to match on. */
/**
 * Which type to judge a Redfin home on. The page's "Property type" label wins
 * only when it is decisive — single-family, or clearly not a house. A generic
 * "Residential" (MLS wording, with the subtype elsewhere) or a label too long to
 * read must not overrule Redfin's own data saying house (uiPropertyType 1).
 */
function resolveRedfinType(pageType, pageLabelled, dataType) {
  const p = String(pageType || '').trim();
  if (pageLabelled && p && (isSfrType(p) || NOT_HOUSE_RE.test(p))) return p;
  if (isSfrType(dataType)) return dataType;
  return p || dataType || '';
}

function redfinMlsDigits(raw) {
  const d = String(raw || '').trim().replace(/^[A-Za-z]{2,4}(?=\d)/, '');
  return /^\d{8,10}$/.test(d) ? d : '';
}

/** The label a Redfin find carries on the board: always reads as Coming Soon
 *  or Private Listing, so the chip is coloured (Team Guide). */
function redfinLabel(badge) {
  const b = String(badge || '');
  if (/private|exclusive/i.test(b)) return 'Private Listing';
  if (/early[\s-]*access/i.test(b)) return 'Coming Soon · Early Access';
  return 'Coming Soon';
}

/** The listing agent off a Redfin home page's "Listed by" block: name,
 *  brokerage, phone and email. A phone or email outside the block is never
 *  used — the page's own contact card belongs to a Redfin agent. */
function parseRedfinAgent(blk) {
  const b = blk || {};
  const t = String(b.text || '').replace(/\s+/g, ' ').trim();
  const fmt = p => { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ''; };
  const after = t.replace(/^[\s\S]*?\b(?:listed by|listing agent:?|listing (?:provided )?courtesy of)\s*/i, '');
  const raw = String(b.text || '').replace(/^[\s\S]*?\b(?:listed by|listing agent:?|listing (?:provided )?courtesy of)\s*/i, '');
  const parts = raw.split(/\s*[•·|\n]\s*|\s+-\s+/)
    .map(x => x.replace(/\(?\b\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b|[^\s@]+@[^\s@]+/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const name = (parts[0] || '').replace(/\s*(?:DRE|CalDRE|Lic)[\s\S]*$/i, '').replace(/[,(].*$/, '').trim();
  const brokerage = (parts.slice(1).find(x => !/DRE|#|\d{3}.*\d{4}|@|^contact/i.test(x)) || '').replace(/[,(].*$/, '').trim();
  const phone = (b.tels || []).map(fmt).find(Boolean)
    || fmt((after.match(/\(?\b\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/) || [])[0]);
  const email = ((b.mails || []).concat(after.match(/[^\s@<>"'(),;:]{1,64}@[^\s@<>"'(),;:]{1,190}\.[A-Za-z]{2,}/g) || []))
    .map(x => String(x).trim()).find(x => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(x) && !/redfin\.com$/i.test(x)) || '';
  return { name: /^[A-Za-z][A-Za-z .,'-]{1,60}$/.test(name) ? name : '', brokerage: brokerage.slice(0, 80),
    phone, email, dre: (t.match(/DRE\s*#?\s*(\d{6,9})/i) || [])[1] || '' };
}

/** Listing-photo URLs anywhere in a Redfin page (HTML, or the srcs seen while
 *  stepping through the gallery), in order, one per photo: the same photo is
 *  served in several sizes, so it is keyed on its file name and the big
 *  version wins. */
function redfinPhotoUrls(html) {
  const re = /https:\/\/ssl\.cdn-redfin\.com\/photo\/\d+\/[a-z0-9]+\/[^"'\s)\\<>]+?\.(?:jpg|jpeg|webp)/gi;
  const key = u => u.split('/').pop().replace(/^gen[A-Za-z]+\./, '').replace(/\.(?:jpe?g|webp)$/i, '');
  const best = new Map();
  let m;
  while ((m = re.exec(String(html || '')))) {
    const u = m[0], k = key(u), had = best.get(k);
    if (!had) best.set(k, u);
    else if (/\/bigphoto\//.test(u) && !/\/bigphoto\//.test(had)) best.set(k, u);
  }
  return [...best.values()];
}

/** Only this listing's photos. A Redfin page also shows "Nearby similar homes"
 *  and "Recently sold" thumbnails, all on the same photo CDN; judging those
 *  would put a neighbour's interior on this house. Redfin names each photo
 *  after its listing number ("426150277_3_0.jpg", "genMid.426150277_1.jpg"),
 *  so photos are grouped by that stem and only this listing's group is kept:
 *  the stem carrying the MLS #'s digits when known, else the group seen most
 *  while stepping through the gallery. */
const photoStem = u => String(u || '').split('/').pop().replace(/^gen[A-Za-z]+\./, '').split(/[_.]/)[0];
function redfinSubjectPhotos(galleryUrls, pageUrls, mls) {
  const all = redfinPhotoUrls((galleryUrls || []).concat(pageUrls || []).join(' '));
  if (!all.length) return [];
  const digits = String(mls || '').replace(/\D/g, '');
  let stem = '';
  if (digits.length >= 6) stem = (all.map(photoStem).find(st => st.includes(digits)) || '');
  if (!stem) {
    const count = {};
    redfinPhotoUrls((galleryUrls || []).join(' ')).forEach(u => { const st = photoStem(u); count[st] = (count[st] || 0) + 1; });
    stem = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || '';
  }
  if (!stem) {
    const count = {};
    all.forEach(u => { const st = photoStem(u); count[st] = (count[st] || 0) + 1; });
    stem = Object.keys(count).sort((a, b) => count[b] - count[a])[0] || '';
  }
  return all.filter(u => photoStem(u) === stem);
}

// ---- Redfin's own listing data (v1.52) ----
// The search page's cards gave nothing on the first live run, so the county is
// read from the data Redfin's search page itself loads: /stingray/api/gis
// (JSON, with each home's MLS status and its "sashes" — the COMING SOON /
// EARLY ACCESS REDFIN COMING SOON badges) and /stingray/api/gis-csv (its
// "Download all" file, with a STATUS column) as the fallback. region_type 5 =
// county, uipt 1 = house, status 9 = for sale incl. coming soon.

const redfinRegionId = p => (String(p || '').match(/^\/county\/(\d+)\//) || [])[1] || '';

function redfinGisUrl({ regionId, maxk, page, csv, market }) {
  return '/stingray/api/' + (csv ? 'gis-csv' : 'gis') + '?al=1&include_nearby_homes=false'
    + (market ? '&market=' + market : '') + '&max_price=' + (maxk * 1000) + '&num_homes=350'
    + '&ord=days-on-redfin-asc&page_number=' + (page || 1) + '&region_id=' + regionId
    + '&region_type=5&sf=1,2,3,5,6,7&status=9&uipt=1&v=8';
}

const rv = x => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const rnum = x => { const v = rv(x); if (typeof v === 'number') return isFinite(v) ? v : 0; return /[MmKk]\s*$/.test(String(v || '')) ? parsePrice(v) : (Number(String(v == null ? '' : v).replace(/[$,]/g, '')) || 0); };

function redfinHome(o) {
  const url = /^https?:/.test(o.url || '') ? o.url : 'https://www.redfin.com' + (o.url || '');
  const id = (url.match(/\/home\/(\d+)/) || [])[1] || String(o.propertyId || '');
  if (!id) return null;
  const parts = [o.status, o.mlsStatus].concat(o.sashes || []).map(x => typeof x === 'string' ? x : x && (x.sashTypeName || x.sashText || x.text || '')).filter(Boolean);
  const status = parts.join(' · ');
  // The whole badge, early-access ones first: "Early Access Redfin Coming Soon".
  const badge = parts.filter(x => REDFIN_EARLY_RE.test(x)).sort((a, b) => /early/i.test(b) - /early/i.test(a))[0] || '';
  const street = String(rv(o.streetLine) || o.address || '').trim();
  const addr = street && o.city ? `${street}, ${o.city}, ${o.state || 'CA'} ${o.zip || ''}`.trim() : redfinAddrFromUrl(url);
  // House type: Redfin's uiPropertyType (1 = house) or its text label.
  const pt = String(rv(o.propertyType) == null ? '' : rv(o.propertyType));
  const ptype = o.uiPropertyType != null && o.uiPropertyType !== '' ? String(o.uiPropertyType)
    : /^\d+$/.test(pt) ? (pt === '6' ? 'propertyType:6' : 'propertyType:' + pt) : pt;
  return { homeId: id, url: url.replace(/[?#].*$/, ''), addr, badge, status, early: !!badge, ptype,
    early_access: /early[\s-]*access/i.test(status),
    price: rnum(o.price), beds: rnum(o.beds), baths: rnum(o.baths), sqft: rnum(o.sqFt || o.sqft),
    year: rnum(o.yearBuilt), dom: rv(o.dom) == null || rv(o.dom) === '' ? '' : rnum(o.dom),
    mls: redfinMlsId(rv(o.mlsId), o.source || ''), mlsDigits: redfinMlsDigits(rv(o.mlsId)), remarks: String(o.listingRemarks || '').trim() };
}

/** Never above this, whatever the area's cap says (Bryan, 2 Oct: "we don't
 *  buy 3M above"). The area caps — $2.5M San Mateo, $1.5M everywhere else —
 *  are lower still and apply first. */
const REDFIN_PRICE_CEILING = 3000000;
const NOT_HOUSE_RE = /condo|co-?op|town\s*house|townhome|multi[\s-]*family|duplex|triplex|fourplex|quadruplex|\d\s*units?\b|land|lot\b|mobile|manufactured|floating|houseboat|commercial|rental/i;

/** The MLS scan's buy box, applied to a Redfin home by the app itself — Redfin's
 *  own search filters are not trusted to have been honoured. Single-family
 *  only, at or under the area's cap and never over $3M, 25+ years old when
 *  the year is known. Returns '' to keep, else the reason. `phase` 'page'
 *  means the home's own page has been read, so an unknown type now fails. */
const UNIT_ADDR_RE = /(?:#\s*[\w-]+|\b(?:unit|apt|apartment|ste|suite|spc|space|lot)\s*#?\s*(?:[\w-]*\d[\w-]*|[A-Za-z]))\s*$/i;
/** A Redfin type that means a single-family house: uiPropertyType 1, the
 *  propertyType code 6, or a "Single Family" / "Single-family" label. */
const isSfrType = t => t === '1' || t === 'sfr' || t === 'propertyType:6' || /single[\s-]*family|^house$/i.test(String(t || '').trim());

/** The house type a Redfin home page states, read only where Redfin states it
 *  (a "Property Type" label, or the type on a line of its own in the key
 *  details) — never from the description, where "unlike a condo" or "duplex
 *  potential" would mislead. '' when the page does not say. */
function redfinPageType(text) {
  const t = String(text || '').replace(/\r/g, '');
  // The label starts its own line ("Property type: Townhouse", or the label
  // then the value on the next line) — a sentence in the description that
  // happens to say "property type" is not it.
  const lab = (t.match(/^[ \t]*Property[ \t]*type[ \t]*:?[ \t]*(?:\n[ \t]*)?([A-Za-z][^\n]{1,40}?)[ \t]*$/im) || [])[1] || '';
  if (lab) return lab.trim();
  const line = t.split('\n').map(x => x.trim()).find(x =>
    /^(single[\s-]*family(\s+(residential|home|residence))?|condo(minium)?(\/co-?op)?|co-?op|town\s*house|townhome|multi[\s-]*family(\s*\(.*\))?|duplex|triplex|fourplex|mobile\s*(\/manufactured)?\s*home|manufactured\s*home|vacant\s*land)$/i.test(x));
  return line || '';
}

function redfinBuyBox(h, area, phase) {
  if (isConfirmed(h.addr)) return '';
  const cap = Math.min(((area && area.maxk) || 1500) * 1000, REDFIN_PRICE_CEILING);
  // Once the page has been read the price must be known: an unreadable price
  // used to count as $0 and pass every cap.
  if (phase === 'page' && !(h.price > 0)) return 'asking price not shown — cannot confirm it is under the cap';
  if (h.price > cap) return `$${Math.round(h.price / 1000).toLocaleString()}k is over the $${cap / 1e6}M cap for ${area && area.county ? area.county : 'this area'}`;
  // A unit number in the address is a condo / apartment, whatever else says so.
  if (UNIT_ADDR_RE.test(String(h.addr || '').split(',')[0])) return `not a single-family home — a unit (${String(h.addr).split(',')[0]})`;
  const t = String(h.ptype || '').trim();
  if (isSfrType(t)) { /* a house */ }
  else if (/^(?:propertyType:)?\d+$/.test(t)) return `not a single-family home (Redfin type ${t.replace('propertyType:', '')})`;
  else if (t && NOT_HOUSE_RE.test(t)) return `not a single-family home — ${t}`;
  // Once the page has been read, single-family must be CONFIRMED. An unknown
  // type used to pass, which is how condos and multi-units reached the board
  // when neither Redfin's data nor the page said what the house was (Bryan,
  // 10 Oct: "not a single family as well on redfin scan").
  else if (phase === 'page') return t ? `not a single-family home — ${t}` : 'property type not confirmed as single-family — skipped';
  const y = Number(h.year) || 0;
  if (y > 1800 && new Date().getFullYear() - y < 25) return `too new — built ${y}, want 25+ years old`;
  return '';
}

/** Fixers only, for a Redfin Coming Soon / Early Access home: kept when its
 *  description says it needs work (as-is, fixer, original condition, "bring
 *  your", cosmetic remodel, probate auction…) or when the AI saw wear in the
 *  photos. A home that says nothing about its condition is not shown as a
 *  fixer. Returns '' to keep, else the reason it is not one. */
function redfinFixerGate({ addr, remarks, aiKept } = {}) {
  if (isConfirmed(addr)) return '';
  if (saysNeedsWork(remarks) || aiKept) return '';
  return String(remarks || '').trim()
    ? 'not a fixer — the description never says it needs work, and no AI photo check saw wear'
    : 'not a fixer — no description yet, and no AI photo check saw wear';
}

// ---- Coming Soon / Early Access: a first look is provisional (v1.57) ----
// A Coming Soon home is usually seen before its photos and full description
// are posted. Judged then, it was written into the seen-ledger for good: a
// quiet one dropped as "not a fixer" never came back once its photos went up,
// and one kept on its first three photos never had the AI look at the rest.
// A verdict reached WITHOUT a photo check is now a 'recheck' entry: skipped
// for RECHECK_DAYS, then opened again, at most RECHECK_MAX times (~2 weeks),
// after which the last verdict stands.
const RECHECK_DAYS = 2, RECHECK_MAX = 7;
const addDays = (day, n) => { const d = new Date(String(day) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Should a scan skip this ledger entry today? Everything is skipped except a
 *  'recheck' whose wait is over. */
function ledgerSkips(entry, today) {
  if (!entry) return false;
  if (entry.verdict === 'buybox') return false;   // outside the box last time; judged afresh if it now fits
  if (entry.verdict !== 'recheck') return true;
  return String(today || '') < String(entry.recheck_after || '');
}

/** The ledger verdict for a Coming Soon / Early Access home just judged.
 *  `provisional` = no photo check decided it (too few photos posted, or no AI
 *  verdict). Returns the fields to store. */
function comingSoonVerdict({ prev, today, provisional, decision }) {
  const done = decision === 'keep' ? 'kept' : 'dropped';
  const n = ((prev && prev.rechecks) || 0) + 1;
  if (!provisional || n > RECHECK_MAX) return { verdict: done, rechecks: n - 1, final_on: today };
  return { verdict: 'recheck', last_verdict: done, rechecks: n, recheck_after: addDays(today, RECHECK_DAYS) };
}

/** Photos decide whether a Redfin Coming Soon / Early Access home is a fixer
 *  (Bryan, 10 Oct: good-condition homes were reaching the board). `o` is the
 *  AI's raw answer. A fixer = the AI kept it AND saw HEAVY wear, or SOME wear
 *  on ORIGINAL finishes. "Dated but fine", a prior update, a new kitchen, or a
 *  structural job is not — and no description can overrule the photos here.
 *  Returns '' for a fixer, else the reason it is not. */
function redfinPhotoFixer(o) {
  o = o || {};
  const keep = /^keep$/i.test(String(o.decision || '').trim());
  const wear = String(o.wear || '').trim().toLowerCase();
  const era = String(o.era || '').trim().toLowerCase();
  if (!keep) return 'photos: not a fixer' + (o.reason ? ' — ' + String(o.reason).slice(0, 160) : '');
  if (/^structural/i.test(String(o.quickFlip || ''))) return 'photos: structural job, not a quick cosmetic flip';
  if (/^heavy/.test(wear)) return '';
  if (/^some/.test(wear) && (!era || /^original/.test(era))) return '';
  if (/^(prior|new)/.test(era)) return `photos: ${era.startsWith('new') ? 'recently renovated finishes' : 'prior update — work already done'}`;
  return 'photos: dated but in good condition — no real wear to fix';
}

// ---- cleaning up leads an older build let through (v1.61) ----
// San Mateo County (the Peninsula, $2.5M cap) by zip; everywhere else $1.5M.
// 94303 is split between East Palo Alto (San Mateo) and Palo Alto (Santa
// Clara), so the city name settles it.
const SAN_MATEO_ZIPS = new Set(['94002', '94005', '94010', '94011', '94014', '94015', '94016', '94017', '94018', '94019', '94020',
  '94021', '94025', '94026', '94027', '94028', '94030', '94037', '94038', '94044', '94060', '94061', '94062', '94063', '94064',
  '94065', '94066', '94070', '94074', '94080', '94083', '94128', '94401', '94402', '94403', '94404', '94497']);
function capForAddress(addr) {
  const a = String(addr || '');
  const zip = (a.match(/\b(9\d{4})(?:-\d{4})?\s*$/) || [])[1] || '';
  const sm = SAN_MATEO_ZIPS.has(zip) || (zip === '94303' && /east palo alto/i.test(a));
  return Math.min((sm ? 2500 : 1500) * 1000, REDFIN_PRICE_CEILING);
}

/** What is wrong, under today's rules, with a Redfin lead already on the sheet
 *  (written by an older build): over the cap, a unit, too new, or never shown
 *  by its photos to be a fixer. '' when it still qualifies. */
function oldRedfinLeadProblem({ addr, price, year, why }) {
  if (isConfirmed(addr)) return '';
  const cap = capForAddress(addr), p = Number(price) || 0, y = Number(year) || 0, w = String(why || '');
  if (p > cap) return `$${Math.round(p / 1000).toLocaleString()}k is over the $${cap / 1e6}M cap`;
  if (UNIT_ADDR_RE.test(String(addr || '').split(',')[0])) return 'not a single-family home — a unit';
  if (y > 1800 && new Date().getFullYear() - y < 25) return `too new — built ${y}`;
  if (/newer build \((\d{4})\)/.test(w) && new Date().getFullYear() - Number(RegExp.$1) < 25) return `too new — built ${RegExp.$1}`;
  if (!/photos show a fixer|AI \(vision\) keep/i.test(w)) return 'never shown by its photos to be a fixer (added by an older version)';
  return '';
}

/** /stingray/api/gis → homes. */
function redfinGisHomes(body) {
  let j;
  try { j = JSON.parse(String(body || '').replace(/^\{\}&&/, '')); } catch (_) { return null; }
  const homes = (j.payload && (j.payload.homes || (j.payload.searchResults && j.payload.searchResults.homes))) || j.homes;
  if (!Array.isArray(homes)) return null;
  return homes.map(h => redfinHome(h.homeData || h)).filter(Boolean);
}

/** /stingray/api/gis-csv → homes. */
function redfinCsvHomes(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const t = String(text || '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim().toUpperCase());
  if (!head.includes('ADDRESS') || !head.includes('STATUS')) return null;
  const col = name => head.findIndex(h => h === name || h.startsWith(name + ' '));
  const get = (r, n) => { const i = col(n); return i >= 0 ? (r[i] || '').trim() : ''; };
  return rows.filter(r => r.length > 3 && get(r, 'ADDRESS')).map(r => redfinHome({
    url: get(r, 'URL'), streetLine: get(r, 'ADDRESS'), city: get(r, 'CITY'), state: get(r, 'STATE OR PROVINCE'),
    zip: get(r, 'ZIP OR POSTAL CODE'), price: get(r, 'PRICE'), beds: get(r, 'BEDS'), baths: get(r, 'BATHS'),
    sqFt: get(r, 'SQUARE FEET'), yearBuilt: get(r, 'YEAR BUILT'), dom: get(r, 'DAYS ON MARKET'),
    mlsStatus: get(r, 'STATUS'), mlsId: get(r, 'MLS#'), source: get(r, 'SOURCE'), propertyType: get(r, 'PROPERTY TYPE'),
  })).filter(Boolean);
}

/* AI model names, forgiven. The model box used to need the exact id —
 * "gpt-4.1mini" or "GPT 4.1 mini" failed every call (Seth, 3 Oct). This writes
 * what was typed the way the services spell it: lower case, hyphens for
 * spaces, "gpt4o" -> "gpt-4o", "4.1mini" -> "4.1-mini". It never invents a
 * model: a name that is still wrong after tidying fails the Test key check
 * with the provider's own message. */
function tidyModel(m) {
  let s = String(m || '').trim().toLowerCase();
  if (!s) return '';
  // "ChatGPT 4o" means gpt-4o; the real id "chatgpt-4o-latest" stays as it is
  if (/^chat\s*gpt\s+\d/.test(s) || /^chatgpt\d/.test(s)) s = s.replace(/^chat\s*gpt\s*/, 'gpt-');
  s = s.replace(/[\s_]+/g, '-')
       .replace(/^gpt(?=\d)/, 'gpt-')                       // gpt4.1 -> gpt-4.1
       .replace(/([0-9a-z])(?=(mini|nano|turbo|pro|preview|latest)\b)/g, (x, c, _w, i, all) => /-$/.test(all.slice(0, i + 1)) ? x : c + '-')
       .replace(/^claude-?(opus|sonnet|haiku)(?=\d)/, 'claude-$1-')   // claudeopus5-5 -> claude-opus-5-5
       .replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s;
}

module.exports = {
  tidyModel,
  REDFIN_EARLY_RE, redfinCountyPath, redfinPrice, redfinSearchUrl, redfinCard, parseRedfinHome,
  redfinMlsId, redfinMlsDigits, resolveRedfinType, NOT_HOUSE_RE, redfinLabel, redfinPhotoUrls, redfinAddrFromUrl, parseRedfinAgent,
  redfinRegionId, redfinGisUrl, redfinGisHomes, redfinCsvHomes, redfinBuyBox, REDFIN_PRICE_CEILING, redfinFixerGate,
  ledgerSkips, comingSoonVerdict, RECHECK_DAYS, RECHECK_MAX, redfinPhotoFixer, redfinPageType, isSfrType, redfinSubjectPhotos, photoStem, parsePrice, capForAddress, oldRedfinLeadProblem, SAN_MATEO_ZIPS,
  isComingSoon, COMING_SOON_RE, isPrivateListing, PRIVATE_LISTING_RE, listingLabel,
  isPersonRejection, dayKey, rereviewPlan,
  saysNeedsWork, aiVerdict, COSMETIC_KW, DISTRESSED_SALE_KW,
  compRows, compBand, classifyComp, compArv, compSummary, compsJson, parseCompReport, JS_SCRAPE_SOLD,
  TEAM_TAB, TEAM_HEADERS, TEAM_STEPS, TEAM_LIST_MONTHS, TEAM_ENOUGH, TEAM_PAGES, teamMarket, teamRows, teamFits, teamRecord,
  COMP_BANDS, COMP_READ, COMP_LIST_MAX,
  boardLead,
  redfinUrlFrom,
  fullAddress, parseDetail, isConfirmed, MAX_DOM_DAYS, LIST_WINDOW_DAYS,
  FIELDS, SEARCH_URL, DEFAULT_BUYBOX,
  JS_SCRAPE_GRID, JS_GRID_DEBUG, JS_PHOTOS, JS_COVER, PUBLIC_NO_PHOTO, publicPageHasPhoto, MLS_MEDIA_LINK, JS_MATCH_COUNT, JS_TITLE,
  num, median, filterCandidates, scoreDeal, arvFromComps, holding, gate, rulesDecide,
  qualify, privateRemarks, isJunkPrivate, offerDue, offerDueToDate, buildBoard, PASSED_NOTE, BUCKET_LABEL,
  PAST_DEALS_TAB, PAST_DEAL_HEADERS, PAST_DEAL_CAP, PAST_DEAL_BAND, money, pastDealsFromGrid, secondLook, applySecondLook,
  mlsUrl, fixLink, CLOSED_STATUS, PENDING_STATUS, disclosuresLink,
  PASS_RECHECK_DAYS, PASS_CUT_PCT, dayKeyOf, passRecheckDue, passRecheck, withPassFlag,
  REFRESH_COMPS_MAX, REFRESH_COMPS_RETRY_DAYS, refreshNeedsComps, refreshResume, refreshProgressAdd,
};
