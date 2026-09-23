/**
 * Headless San Francisco scan — the same pipeline the desktop app runs, so the
 * two can never disagree about what qualifies. Uses desktop-app/scan-core.js
 * for every rule; nothing is re-implemented here.
 *
 *   node scripts/mls-sf-scan.js            # SF, Active, <=$1.5M
 *   MAX_LISTINGS=20 node scripts/mls-sf-scan.js
 *
 * Writes .mls-artifacts/sf-scan.json and prints a table. Needs a live session
 * (scripts/mls-login.js) — Rule #1.
 */
const fs = require('fs');
const path = require('path');
const { launchBrowser, STATE, OUT } = require('./mls-lib.js');
const core = require('../desktop-app/scan-core.js');
const ledger = path.join(__dirname, '..', 'data', 'scanned-ledger.json');

const MAX = parseInt(process.env.MAX_LISTINGS || '0', 10);
const fmt = d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = n => '$' + Number(n || 0).toLocaleString();

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(ledger, 'utf8')); }
  catch (_) { return { version: 1, entries: {}, note: '' }; }
}
function recordLedger(items) {
  const j = loadLedger();
  const today = '2026-08-01';
  items.forEach(it => {
    const k = String(it.mls).trim().toUpperCase();
    const prev = j.entries[k] || {};
    j.entries[k] = { first_seen: prev.first_seen || today, last_seen: today,
      verdict: it.verdict, addr: it.addr, city: it.city || 'San Francisco' };
  });
  j.updated = today;
  fs.writeFileSync(ledger, JSON.stringify(j, null, 1));
  return Object.keys(j.entries).length;
}

(async () => {
  const browser = await launchBrowser();
  const page = await (await browser.newContext({ storageState: STATE })).newPage();

  // Rule #1 — never run a search on a dead session.
  await page.goto('https://search.mlslistings.com/Matrix/Search/Residential/ResidentialSearch',
    { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const title = await page.title();
  if (/sign in|login/i.test(title)) throw new Error('session is dead — run scripts/mls-login.js first');

  const set = async (sel, v) => page.evaluate(([s, val]) => {
    const el = document.querySelector(s);
    if (el) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }, [sel, v]);
  const pick = async (sel, label) => page.evaluate(([s, l]) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const o = [...el.options].find(x => x.text.trim() === l);
    if (!o) return false;
    o.selected = true; el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [sel, label]);

  await pick(core.FIELDS.status, 'Active');       await sleep(400);
  await pick(core.FIELDS.propType, 'Single Family Home'); await sleep(400);
  await pick(core.FIELDS.county, 'San Francisco'); await sleep(1400);
  await set(core.FIELDS.price, '0-1500');          await sleep(600);
  // 45-day rule, cut in at the search. The window is wider than the rule on
  // purpose — DOM can never exceed days-since-listed, so this cannot exclude
  // anything DOM <= 45 would keep.
  const to = new Date(), from = new Date(Date.now() - core.LIST_WINDOW_DAYS * 86400000);
  await set(core.FIELDS.listDate, `${fmt(from)}-${fmt(to)}`);
  await sleep(2000);

  const count = await page.evaluate(core.JS_MATCH_COUNT);
  console.log(`San Francisco · Active · SFR · <=$1.5M · listed in the last ${core.LIST_WINDOW_DAYS} days → ${count} matches`);

  await page.evaluate(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  await sleep(4000);

  let rows = [], prev = '';
  for (let pg = 1; pg <= 12; pg++) {
    const got = await page.evaluate(core.JS_SCRAPE_GRID).catch(() => []);
    if (!got.length || got[0].mls === prev) break;
    prev = got[0].mls; rows = rows.concat(got);
    const moved = await page.evaluate(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/^\\s*Next/i.test(x.textContent)); if(a){a.click(); return true;} return false; })()`).catch(() => false);
    if (!moved) break;
    await sleep(3200);
  }
  const seenIds = new Set();
  rows = rows.filter(r => r.mls && !seenIds.has(r.mls) && seenIds.add(r.mls));
  console.log(`scraped ${rows.length} rows`);

  const { candidates, rejected } = core.filterCandidates({ 'San Francisco': { rows } });
  console.log(`after the buy-box filter (25+ yrs, DOM <= ${core.MAX_DOM_DAYS}): ${candidates.length} candidates, ${rejected.length} out`);

  const seen = loadLedger().entries;
  let fresh = candidates.filter(c => !seen[String(c.mls).trim().toUpperCase()]);
  if (MAX) fresh = fresh.slice(0, MAX);
  console.log(`new since the last run: ${fresh.length}\n`);

  const keeps = [], drops = [], skipped = [];
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    process.stdout.write(`[${i + 1}/${fresh.length}] ${c.addr} … `);
    let detail = null;
    try {
      await page.goto(core.SEARCH_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2200);
      await set(core.FIELDS.mls, c.mls);
      await sleep(1700);
      await page.evaluate(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
      await sleep(3000);
      const photos = (await page.evaluate(core.JS_PHOTOS).catch(() => [])).length;
      await page.evaluate(`(() => { const cb=document.querySelector('tr.DisplayRegRow input[type=checkbox], tr.DisplayAltRow input[type=checkbox]'); if(cb && !cb.checked) cb.click(); })()`);
      await sleep(600);
      await page.evaluate(`(() => { const s=document.getElementById('m_ucDisplayPicker_m_ddlDisplayFormats'); if(!s) return; const o=[...s.options].find(o=>/Client Full - All Photos/i.test(o.text)); if(o){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      await sleep(4000);
      const text = await page.evaluate(`document.body.innerText.replace(/\\r/g,'')`);
      detail = core.parseDetail(text, c.mls);
      detail.photos = photos;
    } catch (e) {
      console.log('lookup failed: ' + e.message);
      skipped.push({ ...c, why: 'lookup failed: ' + e.message });
      continue;
    }
    // Never read whatever listing happens to be on screen.
    if (detail.mismatch) {
      console.log(`SKIP — MLS showed ${detail.showing || 'another listing'}`);
      skipped.push({ ...c, why: `MLS served ${detail.showing || 'another listing'}` });
      continue;
    }
    const v = core.rulesDecide({ addr: c.addr, photos: detail.photos,
      remarks: detail.remarks, condition: detail.condition, propClass: detail.propClass });
    const rec = {
      mls: c.mls,
      address: core.fullAddress(detail.address || c.addr, c.city, detail.zip),
      price: c._price, ppsf: c._ppsf, sqft: c._sqft, beds: c.bds, dom: c._dom,
      yearBuilt: detail.yearBuilt || (c._age > 0 ? 2026 - c._age : ''),
      photos: detail.photos, reason: v.reason,
      remarks: (detail.remarks || '').slice(0, 300),
      link: `https://search.mlslistings.com/Matrix/Public/Portal.aspx?ID=${c.mls}`,
    };
    // Silent remarks fall to the configured default, same as the app.
    const decision = v.decision === 'manual' ? 'keep' : v.decision;
    rec.needsEye = v.decision === 'manual';
    console.log(`${decision.toUpperCase()}${rec.needsEye ? ' (rules unsure)' : ''} — ${v.reason.slice(0, 70)}`);
    (decision === 'keep' ? keeps : drops).push(rec);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, 'sf-scan.json');
  fs.writeFileSync(outFile, JSON.stringify({
    scanned: rows.length, candidates: candidates.length,
    filterRejects: rejected.slice(0, 40).map(r => ({ mls: r.mls, addr: r.addr, reason: r._reason,
      price: r._price, ppsf: r._ppsf, dom: r._dom })),
    keeps, drops, skipped,
  }, null, 1));

  const total = recordLedger([
    ...keeps.map(k => ({ mls: k.mls, addr: k.address, verdict: 'kept' })),
    ...drops.map(d => ({ mls: d.mls, addr: d.address, verdict: 'dropped' })),
  ]);

  console.log(`\n=== ${keeps.length} KEEP · ${drops.length} drop · ${skipped.length} skipped ===`);
  keeps.sort((a, b) => a.ppsf - b.ppsf).forEach(k => {
    console.log(`  ${money(k.price).padStart(10)} ${String(k.sqft).padStart(6)} sf  $${String(k.ppsf).padStart(4)}/sf  ${String(k.yearBuilt).padStart(4)}  DOM ${String(k.dom).padStart(3)}  ${k.address}`);
  });
  console.log(`\nledger: ${total} listing(s) recorded → ${outFile}`);
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
