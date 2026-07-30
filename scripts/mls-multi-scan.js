#!/usr/bin/env node
/**
 * Scan several Matrix cities in one browser session (Active SFR within the buy box).
 * Reuses a saved session (run scripts/mls-login.js first).
 *
 * Env (all optional):
 *   CITIES        "County:City;County:City;..."  (default: East Bay set below)
 *   MAX_PRICE_K   default 1500  (thousands; the "(000s)" box is checked)
 *   DAYS          default 45    (List Date within the last N days)
 *   PROPERTY_TYPE default "Single Family Home"
 *   OUT_JSON      default <scratch or cwd>/multi-scan.json
 *
 * Output: JSON keyed by city -> { county, city, count, rows[] }, where each row is
 * { mls, addr, price, sqft, bds, city, cls, age, dom }. Field IDs documented in CLAUDE.md.
 */
const fs = require('fs');
const { launchBrowser, STATE } = require('./mls-lib');

// Full buy box (flip-scout-SOP.md). Entry format: "County:City[:maxPriceK]".
// City "*" (or empty) scans the WHOLE county. Peninsula/San Mateo caps at $2.0M;
// everywhere else $1.5M. "San Francisco:*" = the whole city (county == city).
const DEFAULT_CITIES = [
  'San Francisco:*',            // SF county = the whole city, $1.5M
  'San Mateo:*:2000',           // entire Peninsula, $2.0M cap
  'Santa Clara:Sunnyvale',
  'Santa Clara:San Jose',
  'Alameda:Oakland',
  'Alameda:Berkeley',
  'Alameda:San Leandro',
  'Alameda:Hayward',
  'Contra Costa:Richmond',
].join(';');
const DEFAULT_MAXK = parseInt(process.env.MAX_PRICE_K || '1500', 10);
const CITIES = (process.env.CITIES || DEFAULT_CITIES).split(';').map(s => {
  const [county, city, capK] = s.split(':').map(x => x.trim());
  return { county, city: (city && city !== '*') ? city : null, maxk: capK ? parseInt(capK, 10) : DEFAULT_MAXK };
}).filter(c => c.county);
const MAXK = DEFAULT_MAXK;
const DAYS = parseInt(process.env.DAYS || '45', 10);
const PTYPE = process.env.PROPERTY_TYPE || 'Single Family Home';
const OUT_JSON = process.env.OUT_JSON || `${process.cwd()}/multi-scan.json`;

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
const dateRange = `${fmt(new Date(Date.now() - DAYS * 86400000))}-${fmt(new Date())}`;

const scrapeGrid = page => page.evaluate(() => {
  const clean = t => (t || '').replace(/\s+/g, ' ').trim();
  const h = document.querySelector('.singleLineTableHeader');
  const hc = h ? Array.from(h.children).map(c => clean(c.innerText)) : [];
  const idx = {}; hc.forEach((c, i) => { if (c) idx[c] = i; });
  const out = [];
  document.querySelectorAll('tr.DisplayRegRow, tr.DisplayAltRow').forEach(tr => {
    const cells = Array.from(tr.children).map(c => clean(c.innerText));
    const pick = k => idx[k] != null ? cells[idx[k]] : '';
    out.push({ mls: pick('MLS #'), addr: pick('Street Address'), price: pick('Price'), sqft: pick('SqFt'), bds: pick('Bds'), city: pick('Postal City'), cls: pick('Class'), age: pick('Age'), dom: pick('DOM') });
  });
  return out;
});

async function runCity(page, county, city, maxk) {
  const label = city || `All ${county}`;
  // Matrix keeps long-lived connections open, so 'networkidle' never fires and
  // the nav times out. Wait for the DOM instead, then let the form settle.
  await page.goto('https://search.mlslistings.com/Matrix/Search/Residential/ResidentialSearch', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#Fm9_Ctrl1161_LB', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.selectOption('#Fm9_Ctrl1161_LB', { label: 'Active' }).catch(() => {}); await page.waitForTimeout(400);
  if (PTYPE) { await page.selectOption('#Fm9_Ctrl65_LB', { label: PTYPE }).catch(() => {}); await page.waitForTimeout(400); }
  await page.selectOption('#Fm9_Ctrl1738_LB', { label: county }).catch(() => {}); await page.waitForTimeout(1200);
  if (city) { // omit the city filter to scan the whole county (e.g. entire Peninsula)
    try {
      await page.fill('#Fm9_Ctrl1739_LB_TB', city); await page.waitForTimeout(700);
      await page.selectOption('#Fm9_Ctrl1739_LB', { label: city }); await page.waitForTimeout(1000);
    } catch (e) { console.log('  city select failed:', city, e.message.split('\n')[0]); }
  }
  await page.fill('#Fm9_Ctrl63_TB', `0-${maxk}`); await page.locator('#Fm9_Ctrl63_TB').blur(); await page.waitForTimeout(500);
  await page.fill('#Fm9_Ctrl1162_TB', dateRange); await page.locator('#Fm9_Ctrl1162_TB').blur(); await page.waitForTimeout(1800);
  const count = await page.evaluate(() => { const m = document.body.innerText.match(/([\d,]+\+?)\s*match/i); return m ? m[1] : '?'; });
  console.log(`\n=== ${label} (${county}) @ $${maxk}k: ${count} matches ===`);
  if (count === '0') return { city: label, county, count, rows: [] };
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}),
    page.locator('a:has-text("Results"), input[value="Results" i]').first().click().catch(() => {}),
  ]);
  // Wait explicitly for grid rows — large result sets load slowly.
  await page.waitForSelector('tr.DisplayRegRow, tr.DisplayAltRow', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  let all = []; let prevFirst = '';
  for (let pg = 1; pg <= 12; pg++) {
    const rows = await scrapeGrid(page);
    if (!rows.length || rows[0].mls === prevFirst) break;
    prevFirst = rows[0].mls; all = all.concat(rows);
    const nxt = page.locator('a:has-text("Next")').first();
    if (!(await nxt.count().catch(() => 0))) break;
    await nxt.click().catch(() => {}); await page.waitForTimeout(3500);
  }
  const seen = new Set();
  all = all.filter(r => { if (!r.mls || seen.has(r.mls)) return false; seen.add(r.mls); return true; });
  console.log(`  scraped ${all.length} rows`);
  return { city: label, county, count, rows: all };
}

(async () => {
  if (!fs.existsSync(STATE)) { console.error('No session at', STATE, '— run scripts/mls-login.js first.'); process.exit(2); }
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: STATE });
  const page = await ctx.newPage();
  const results = {};
  try {
    for (const { county, city, maxk } of CITIES) {
      const label = city || `All ${county}`;
      try { results[label] = await runCity(page, county, city, maxk); }
      catch (e) { console.log('CITY ERR', label, e.message.split('\n')[0]); results[label] = { city: label, county, count: 'ERR', rows: [] }; }
    }
    fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 1));
    await ctx.storageState({ path: STATE });
    console.log('\n=== SUMMARY ===');
    for (const c of Object.keys(results)) console.log(`  ${c}: match=${results[c].count} scraped=${results[c].rows.length}`);
    console.log('saved ->', OUT_JSON);
  } catch (e) {
    console.error('FATAL', e.message.split('\n')[0]);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
