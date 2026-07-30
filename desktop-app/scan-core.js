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

// Stage-3 filter: below-market $/sf + older SFR; drop DOM>45 and large-home traps.
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
  const cands = all.filter(r =>
    r._dom <= 45 && r._age >= 25 && r._sqft <= medSq[r._cityKey]*1.5 && r._ppsf <= med[r._cityKey]*0.85
  ).sort((a,b) => (a._ppsf/med[a._cityKey]) - (b._ppsf/med[b._cityKey]));
  return { candidates: cands, medians: med };
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

module.exports = {
  FIELDS, SEARCH_URL, DEFAULT_BUYBOX,
  JS_SCRAPE_GRID, JS_PHOTOS, JS_MATCH_COUNT, JS_TITLE,
  num, median, filterCandidates, scoreDeal, arvFromComps, holding, gate,
};
