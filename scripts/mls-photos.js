/**
 * Download a listing's photos so they can actually be LOOKED AT.
 *
 *   node scripts/mls-photos.js SF426150277 ML82056071 ...
 *   MAX_PHOTOS=8 node scripts/mls-photos.js SF426150277
 *
 * Saves to .mls-artifacts/photos/<MLS#>/NN.jpg and prints the paths. The MLS
 * MediaServer needs the session cookies, so the fetch happens inside the
 * authenticated browser context rather than with a bare HTTP request.
 *
 * Photo 1 is nearly always the exterior — HARD RULE #2 exists because the cover
 * shot hides the condition — so the interior frames are what get pulled.
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, STATE, OUT } = require('./mls-lib.js');
const core = require('../desktop-app/scan-core.js');

const MAX_PHOTOS = parseInt(process.env.MAX_PHOTOS || '10', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const ids = process.argv.slice(2);
  if (!ids.length) { console.error('usage: node scripts/mls-photos.js <MLS#> [MLS#...]'); process.exit(1); }

  const browser = await launchBrowser();
  const ctx = await browser.newContext({ storageState: STATE });
  const page = await ctx.newPage();

  for (const mls of ids) {
    await page.goto(core.SEARCH_URL, { waitUntil: 'domcontentloaded' });
    await sleep(2200);
    await page.evaluate(([sel, v]) => {
      const el = document.querySelector(sel);
      if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, [core.FIELDS.mls, mls]);
    await sleep(1700);
    await page.evaluate(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
    await sleep(3200);

    // The default one-line display carries no images. Switch to the all-photos
    // report first — that is the page the pictures actually render on.
    await page.evaluate(`(() => { const cb=document.querySelector('tr.DisplayRegRow input[type=checkbox], tr.DisplayAltRow input[type=checkbox]'); if(cb && !cb.checked) cb.click(); })()`);
    await sleep(600);
    await page.evaluate(`(() => { const s=document.getElementById('m_ucDisplayPicker_m_ddlDisplayFormats'); if(!s) return; const o=[...s.options].find(o=>/Client Full - All Photos/i.test(o.text)); if(o){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
    await sleep(4500);

    // "Open All" opens PhotoPopup.aspx as a GRID of every photo. The report
    // itself only ever shows a carousel — one frame at a time, three or four
    // preloaded — which is why scraping it returned 4 of 26.
    const before = ctx.pages().length;
    await page.evaluate(`(() => { const f=[...document.querySelectorAll('font')].find(x=>/open all/i.test(x.title||'')); if(f) f.click(); })()`);
    await sleep(4000);
    const pages = ctx.pages();
    const grid = pages.length > before ? pages[pages.length - 1] : page;
    try { await grid.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch (_) {}
    await sleep(2500);

    // Read the img elements directly. JS_PHOTOS buckets by Size= and the popup
    // serves a different size, so it finds nothing here.
    const urls = await grid.evaluate(`[...document.images].map(i => i.src).filter(u => /MediaServer/i.test(u))`)
      .catch(() => []);
    if (!urls.length) { console.log(`${mls}: no photos found`); if (grid !== page) await grid.close().catch(()=>{}); continue; }
    console.log(`${mls}: ${urls.length} photo(s) on the grid`);

    // Skip the cover shot, then spread across the rest so the kitchen and baths
    // are represented rather than ten angles of the living room.
    const rest = urls.slice(1);
    const step = Math.max(1, Math.floor(rest.length / MAX_PHOTOS));
    const wanted = [];
    for (let i = 0; i < rest.length && wanted.length < MAX_PHOTOS; i += step) wanted.push(rest[i]);

    const dir = path.join(OUT, 'photos', mls);
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const u of wanted) {
      // Fetch inside the page: MediaServer rejects a request without the session.
      const b64 = await grid.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return '';
        const buf = await r.arrayBuffer();
        let s = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
      }, u).catch(() => '');
      if (!b64) continue;
      n++;
      const f = path.join(dir, String(n).padStart(2, '0') + '.jpg');
      fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      console.log(f);
    }
    console.log(`${mls}: ${n} photo(s) of ${urls.length} saved to ${dir}`);
    if (grid !== page) await grid.close().catch(() => {});
  }
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
