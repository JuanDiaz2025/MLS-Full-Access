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
  const out = [];
  document.querySelectorAll('tr.DisplayRegRow, tr.DisplayAltRow').forEach(tr => {
    const cells = Array.from(tr.children).map(c => clean(c.innerText));
    const pick = k => idx[k]!=null ? cells[idx[k]] : '';
    out.push({ mls: pick('MLS #'), addr: pick('Street Address'), price: pick('Price'),
      sqft: pick('SqFt'), bds: pick('Bds'), city: pick('Postal City'), age: pick('Age'), dom: pick('DOM') });
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

// Stage-3 filter: below-market $/sf + older SFR; drop large-home traps.
// No days-on-market cap — the 45-day rule is lifted for now.
function filterCandidates(rowsByArea) {
  let all = [];
  for (const key of Object.keys(rowsByArea)) {
    for (const r of rowsByArea[key].rows || []) {
      const price = num(r.price), sqft = num(r.sqft);
      if (!price || !sqft) continue;
      all.push({ ...r, _price: price, _sqft: sqft, _age: num(r.age), _dom: num(r.dom),
        _ppsf: Math.round(price/sqft), _cityKey: r.city || key });
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
  const MAX_DOM = 45;

  const why = r => {
    const a = String(r.addr || '').trim();
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
const DROP_KW = /(remodel|renovat|updated throughout|fully updated|turnkey|turn[- ]key|move[- ]?in ready|quartz|stainless|luxury vinyl|designer|reimagined|refreshed|newly built|new construction|fully renovated|beautifully updated|tastefully updated|gut renovat)/i;
const KEEP_KW = /(fixer|as[- ]?is|\btlc\b|handyman|contractor special|probate|estate sale|trust sale|needs work|needs updating|bring your|first time on market|deferred maintenance|original condition|diamond in the rough|great potential|tear[- ]?down|sold as[- ]is|needs tlc)/i;
const MULTI_KW = /(duplex|triplex|fourplex|two units|2 units|3 units|second unit|in[- ]?law|mother[- ]in[- ]law|\badu\b|multi[- ]?unit|separate unit|two homes|2 homes)/i;
const FIRE_KW = /(fire damage|fire[- ]damaged|fire gutted|gutted by fire|burned|fire[- ]affected)/i;

function rulesDecide(meta) {
  const t = ((meta.remarks || '') + ' ' + (meta.condition || '')).toLowerCase();
  const photos = meta.photos || 0;
  if (FIRE_KW.test(t)) return { decision: 'drop', reason: 'remarks note fire damage (hard exclusion)' };
  if (MULTI_KW.test(t)) return { decision: 'drop', reason: 'remarks indicate multi-unit / second unit' };
  if (DROP_KW.test(t)) return { decision: 'drop', reason: 'remarks describe renovated / updated / turnkey (Rule #0)' };
  if (photos > 0 && photos <= 4 && !KEEP_KW.test(t)) return { decision: 'drop', reason: `only ${photos} photos, likely exterior-only / no interior access (tenant?)` };
  if (KEEP_KW.test(t)) return { decision: 'keep', reason: 'as-is / estate / fixer language + below-market $/sf' };
  // Remarks say nothing either way. This engine reads TEXT only — it has not
  // looked at a single photo — so "no renovated keyword" is not evidence the
  // house is a fixer. Auto-keeping here is what let renovated listings through.
  // Hand it to a human (or to AI vision, which does look) instead of guessing.
  return { decision: 'manual', reason: 'remarks are silent on condition — photos must be judged by eye' };
}

module.exports = {
  FIELDS, SEARCH_URL, DEFAULT_BUYBOX,
  JS_SCRAPE_GRID, JS_PHOTOS, JS_MATCH_COUNT, JS_TITLE,
  num, median, filterCandidates, scoreDeal, arvFromComps, holding, gate, rulesDecide,
};
