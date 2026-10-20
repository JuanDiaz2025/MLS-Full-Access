/**
 * Sold-comp ARV engine (size-matched, zip-precise, recent).
 *
 * ARV = median $/sqft of SOLD single-family homes in the subject's ZIP, listed
 * in the last ~14 months, within ±20% of subject sqft (widen to ±40%, then ±60%
 * only if <3 comps) × subject sqft. Never a flat zip-wide/citywide median.
 *
 * IMPORTANT: a Sold search with no date bound returns MLS's "2500+" display cap
 * (all historical sales), which silently defeats the zip filter — so we ALWAYS
 * set a List Date range as a recency proxy. That is what makes the zip filter
 * actually bite and keeps comps recent.
 *
 * Reads jobs from .mls-artifacts/comp-jobs.json: [{mls, zip, sf}].
 * Writes .mls-artifacts/comps-out.json: [{mls, zip, sf, medianPpsf, arv, band, nMatched, ...}].
 *
 * Env: LIST_RANGE (MM/DD/YYYY-MM/DD/YYYY, default last ~14 months).
 * Usage: node scripts/mls-comps.js
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, STATE, OUT } = require('./mls-lib');

const JOBS = process.env.ONE_ZIP
  ? [{ mls: 'TEST', zip: process.env.ONE_ZIP, sf: +(process.env.ONE_SF || 1200) }]
  : JSON.parse(fs.readFileSync(path.join(OUT, 'comp-jobs.json'), 'utf8'));

// Default List Date range: last ~14 months up to today (recency proxy for solds).
function defaultRange() {
  const d = new Date();
  const to = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const f = new Date(d.getFullYear(), d.getMonth() - 14, 1);
  const from = `${String(f.getMonth() + 1).padStart(2, '0')}/01/${f.getFullYear()}`;
  return `${from}-${to}`;
}
const LIST_RANGE = process.env.LIST_RANGE || defaultRange();

const num = s => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; };
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

const scrapeGrid = p => p.evaluate(() => {
  const clean = t => (t || '').replace(/\s+/g, ' ').trim();
  const h = document.querySelector('.singleLineTableHeader');
  const hc = h ? Array.from(h.children).map(c => clean(c.innerText)) : [];
  const idx = {}; hc.forEach((c, i) => { if (c) idx[c] = i; });
  const out = [];
  document.querySelectorAll('tr.DisplayRegRow, tr.DisplayAltRow').forEach(tr => {
    const cells = Array.from(tr.children).map(c => clean(c.innerText));
    const pick = k => idx[k] != null ? cells[idx[k]] : '';
    out.push({ price: pick('Price') || pick('Sold Price') || pick('Close Price'), sqft: pick('SqFt'), addr: pick('Street Address') || pick('Address') });
  });
  return out;
});

async function comp(p, { mls, zip, sf }) {
  await p.goto('https://search.mlslistings.com/Matrix/Search/Residential/ResidentialSearch', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(1800);
  await p.selectOption('#Fm9_Ctrl1161_LB', { label: 'Sold' }).catch(() => {}); await p.waitForTimeout(500);
  await p.selectOption('#Fm9_Ctrl65_LB', { label: 'Single Family Home' }).catch(() => {}); await p.waitForTimeout(400);
  await p.click('#Fm9_Ctrl1780_TextBox').catch(() => {}); await p.fill('#Fm9_Ctrl1780_TextBox', zip).catch(() => {}); await p.keyboard.press('Tab'); await p.waitForTimeout(1200);
  await p.fill('#Fm9_Ctrl1162_TB', LIST_RANGE).catch(() => {}); await p.keyboard.press('Tab'); await p.waitForTimeout(1500);
  const count = await p.evaluate(() => { const m = document.body.innerText.match(/([\d,]+\+?)\s*match/i); return m ? m[1] : '?'; });
  await Promise.all([p.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}), p.locator('a:has-text("Results")').first().click().catch(() => {})]);
  await p.waitForSelector('tr.DisplayRegRow, tr.DisplayAltRow', { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(1600);
  let all = [], prev = '';
  for (let pg = 1; pg <= 10; pg++) {
    const rows = await scrapeGrid(p);
    if (!rows.length || rows[0].addr === prev) break;
    prev = rows[0].addr; all = all.concat(rows);
    const nxt = p.locator('a:has-text("Next")').first();
    if (!(await nxt.count().catch(() => 0))) break;
    await nxt.click().catch(() => {}); await p.waitForTimeout(2000);
  }
  const comps = all.map(r => ({ price: num(r.price), sqft: num(r.sqft), ppsf: (num(r.price) && num(r.sqft)) ? num(r.price) / num(r.sqft) : null }))
    .filter(r => r.ppsf && r.sqft > 300 && r.price > 50000);
  const band = pct => comps.filter(r => Math.abs(r.sqft - sf) / sf <= pct);
  let sel = band(0.20), w = '±20%';
  if (sel.length < 3) { sel = band(0.40); w = '±40%'; }
  if (sel.length < 3) { sel = band(0.60); w = '±60%'; }
  const med = median(sel.map(r => r.ppsf));
  return { mls, zip, sf, count, scraped: all.length, valid: comps.length, band: w, nMatched: sel.length, medianPpsf: med ? Math.round(med) : null, arv: med ? Math.round(med * sf) : null };
}

(async () => {
  const b = await launchBrowser();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, storageState: STATE });
  const p = await ctx.newPage(); const res = [];
  console.log('List Date range (recency proxy):', LIST_RANGE);
  try {
    for (const j of JOBS) {
      try { const r = await comp(p, j); res.push(r); console.log(JSON.stringify(r)); }
      catch (e) { console.log(j.mls, j.zip, 'ERR', e.message.split('\n')[0]); res.push({ ...j, err: 1 }); }
    }
    if (!process.env.ONE_ZIP) fs.writeFileSync(path.join(OUT, 'comps-out.json'), JSON.stringify(res, null, 1));
    console.log('DONE');
  } finally { await b.close(); }
})();
