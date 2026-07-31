/**
 * Photo contact-sheet generator (HARD RULE #2 — review every photo).
 *
 * For each MLS# in MLS_LIST, pulls the FULL photo set from the results-row
 * ImageViewerLightbox() call (every Number, Size=2) and renders a single
 * contact-sheet PNG to .mls-artifacts/sheets/<MLS>.png for visual review.
 *
 * Why the lightbox and not the report's <img> tags: the "Client Full - All
 * Photos" report lazy-loads only a few thumbnails into the DOM, but the results
 * row embeds a JS object with every photo URL (thumb/medium/large). We parse
 * that — it's the only way to reliably get ALL photos.
 *
 * Usage: MLS_LIST="EB41140898,ML82051677" node scripts/mls-photo-sheet.js
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, STATE, OUT } = require('./mls-lib');

const TARGETS = (process.env.MLS_LIST || '').split(',').map(s => s.trim()).filter(Boolean);
const SHEETS_DIR = path.join(OUT, 'sheets');

async function one(p, mls) {
  await p.goto('https://search.mlslistings.com/Matrix/Search/Residential/ResidentialSearch', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(1400);
  await p.fill('#Fm9_Ctrl75_TextBox', mls); await p.locator('#Fm9_Ctrl75_TextBox').blur(); await p.waitForTimeout(1600);
  await Promise.all([p.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {}), p.locator('a:has-text("Results")').first().click().catch(() => {})]);
  await p.waitForSelector('tr.DisplayRegRow, tr.DisplayAltRow', { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(900);
  const data = await p.evaluate(() => {
    const html = document.body.innerHTML.replace(/&amp;/g, '&');
    const all = [...html.matchAll(/https:\/\/search\.mlslistings\.com\/MediaServer\/GetMedia\.ashx\?[^'"\s]+/g)].map(m => m[0]);
    const bySize = {};
    all.forEach(u => {
      const num = (u.match(/Number=(\d+)/) || [])[1];
      const size = (u.match(/Size=(\d+)/) || [])[1];
      if (num == null || size == null) return;
      (bySize[size] = bySize[size] || {})[num] = u;
    });
    const pick = bySize['2'] || bySize['5'] || bySize['1'] || {};
    const nums = Object.keys(pick).map(Number).sort((a, b) => a - b);
    return { urls: nums.map(n => pick[n]), count: nums.length };
  });
  await p.evaluate((imgs) => {
    document.body.innerHTML = '<div id="cs" style="display:flex;flex-wrap:wrap;background:#111;padding:5px;gap:5px">' +
      imgs.map((u, i) => `<div style="width:340px"><img src="${u}" style="width:340px;height:255px;object-fit:cover"><div style="color:#fff;font:11px sans-serif">#${i}</div></div>`).join('') + '</div>';
  }, data.urls);
  await p.waitForTimeout(1200);
  await p.evaluate(async () => { await Promise.all(Array.from(document.images).map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; }))); });
  await p.waitForTimeout(600);
  const loaded = await p.evaluate(() => Array.from(document.images).filter(i => i.naturalWidth > 50).length);
  const cs = await p.$('#cs');
  const out = path.join(SHEETS_DIR, mls + '.png');
  await (cs ? cs.screenshot({ path: out }) : p.screenshot({ path: out, fullPage: true })).catch(() => {});
  return { mls, count: data.count, loaded };
}

(async () => {
  if (!TARGETS.length) { console.error('Set MLS_LIST="mls1,mls2,..."'); process.exit(1); }
  fs.mkdirSync(SHEETS_DIR, { recursive: true });
  const b = await launchBrowser();
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1400 }, storageState: STATE });
  const p = await ctx.newPage(); const res = [];
  try {
    for (const m of TARGETS) {
      try { const r = await one(p, m); res.push(r); console.log(`${m}: photos=${r.count} loaded=${r.loaded} -> ${path.join(SHEETS_DIR, m + '.png')}`); }
      catch (e) { console.log(m, 'ERR', e.message.split('\n')[0]); res.push({ mls: m, err: 1 }); }
    }
    fs.writeFileSync(path.join(OUT, 'photo-sheet-results.json'), JSON.stringify(res, null, 1));
    console.log('DONE');
  } finally { await b.close(); }
})();
