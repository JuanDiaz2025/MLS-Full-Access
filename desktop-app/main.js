/**
 * FlipScout Desktop — Electron main process.
 *
 * Two windows: a Control panel (buttons/progress/report) and a visible MLS
 * browser window that the app drives. Login happens in the visible window so
 * you can complete 2FA/SSO yourself; the app auto-fills what it can and then
 * detects the dashboard. Scanning navigates the MLS window through Matrix and
 * runs the same extraction used by the headless pipeline.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('./scan-core');
const gsheets = require('./google-sheets');

let controlWin, mlsWin;
const control = { paused: false, stopped: false, running: false };
const pendingDecision = {}; // mls -> resolve fn
const cfg = {
  apiKey: '', model: 'claude-opus-5', autoVerify: false, useAI: false, // auto-verify config
  readSeconds: 6,                                                      // dwell per listing
  // What to do when the text rules can't tell renovated from dated: ask | keep | drop.
  // Defaults to 'keep' so a run never stalls waiting for a click. It is a safe
  // default here because the candidate already passed the buy-box filters (25+
  // years old, below-market $/sqft) and because the sheet reviewer rejects
  // anything wrong — with that rejection feeding straight back into the ledger.
  whenUnsure: 'keep',
  runComps: false,     // OFF for now — qualify on CONDITION first, comp later
};

ipcMain.on('set-config', (_e, c) => { Object.assign(cfg, c || {}); });

// ---------- daily KPIs ----------
// Every scan folds its funnel counts into a per-day record kept on disk, so the
// numbers survive closing the app and "how did today go" is answerable without
// re-running anything. One row per calendar day, accumulated across runs.
const KPI_FILE = () => path.join(app.getPath('userData'), 'kpi-history.json');
const KPI_FIELDS = ['runs', 'scanned', 'candidates', 'skippedAlreadyChecked', 'reviewed', 'kept',
  'dropped', 'droppedRenovated', 'droppedMultiUnit', 'droppedFire',
  'droppedFewPhotos', 'droppedOther', 'leads', 'gateCleared', 'pushed', 'pushSkipped'];
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function loadKpi() {
  try {
    const p = KPI_FILE();
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j && typeof j === 'object' && j.days) ? j.days : {};
  } catch (_) { return {}; }   // a corrupt file must not block a scan
}

function saveKpi(days) {
  try {
    fs.mkdirSync(path.dirname(KPI_FILE()), { recursive: true });
    fs.writeFileSync(KPI_FILE(), JSON.stringify({ version: 1, days }, null, 1));
  } catch (e) { log('Could not save KPI history: ' + e.message, 'warn'); }
}

function blankKpi() { const o = {}; KPI_FIELDS.forEach(f => { o[f] = 0; }); return o; }

/** Fold one finished run into today's totals and return the updated day. */
function recordKpi(run) {
  const days = loadKpi();
  const k = todayKey();
  const day = Object.assign(blankKpi(), days[k] || {});
  KPI_FIELDS.forEach(f => { day[f] += (run[f] || 0); });
  day.lastRun = new Date().toISOString();
  days[k] = day;
  saveKpi(days);
  return { date: k, ...day };
}

/** Bucket a drop reason so the daily report can say WHY things were dropped.
 *  The vision model usually names the FINISHES it saw ("quartz counters, new
 *  stainless") rather than the word "renovated", so match those too — otherwise
 *  the biggest drop category silently lands in "other". */
const RENOVATED_RE = new RegExp([
  'renovat', 'remodel', 'updated', 'turnkey', 'turn[- ]key', 'move[- ]?in',
  'newer build', 'new construction', 'newly built', 'luxury', 'designer',
  'quartz', 'granite', 'stainless', 'backsplash', 'recessed',
  'new(?:ly)?[- ]?(?:refaced |painted |installed )?(?:cabinet|counter|floor|appliance|vanity|tile)',
  'refaced', 'vinyl plank', 'lvp', 'modern kitchen', 'modern bath', 'upgraded',
].join('|'), 'i');

function dropBucket(reason) {
  const t = String(reason || '');
  if (/fire|charring|burned/i.test(t)) return 'droppedFire';
  if (/multi[- ]?unit|duplex|triplex|second unit|in[- ]?law|two kitchens|2 kitchens/i.test(t)) return 'droppedMultiUnit';
  if (RENOVATED_RE.test(t)) return 'droppedRenovated';
  if (/photo|exterior[- ]only|no interior/i.test(t)) return 'droppedFewPhotos';
  return 'droppedOther';
}

// ---------- seen-ledger: never photo-review the same listing twice ----------
// Photo review is the expensive stage (a gallery load + a judgement per
// listing). Every MLS # that reaches it is recorded here, so a later run skips
// it outright — scanned yesterday or earlier means never looked at again.
// Kept in userData so it survives app restarts and upgrades.
const LEDGER_FILE = () => path.join(app.getPath('userData'), 'scanned-ledger.json');

function loadLedger() {
  try {
    const p = LEDGER_FILE();
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j && j.entries) || {};
  } catch (_) { return {}; }
}
function saveLedger(entries) {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE()), { recursive: true });
    fs.writeFileSync(LEDGER_FILE(), JSON.stringify({ version: 1, updated: new Date().toISOString(), entries }, null, 1));
  } catch (e) { log('Could not save the seen-ledger: ' + e.message, 'warn'); }
}
function ledgerRecord(mls, verdict, extra) {
  if (!mls) return;
  const e = loadLedger();
  const d = todayKey();
  e[String(mls).trim().toUpperCase()] = Object.assign(
    { first_seen: (e[mls] && e[mls].first_seen) || d }, extra || {},
    { last_seen: d, verdict: verdict || 'checked' });
  saveLedger(e);
}
/** Bulk-mark, one write instead of N. */
function ledgerRecordMany(items) {
  const e = loadLedger();
  const d = todayKey();
  for (const it of items) {
    const k = String(it.mls || '').trim().toUpperCase();
    if (!k) continue;
    e[k] = { first_seen: (e[k] && e[k].first_seen) || d, last_seen: d,
      verdict: it.verdict || 'checked', addr: it.addr || '', city: it.city || '' };
  }
  saveLedger(e);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const send = (ch, payload) => controlWin && !controlWin.isDestroyed() && controlWin.webContents.send(ch, payload);
const log = (msg, level = 'info') => send('log', { msg, level, t: Date.now() });

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 720, height: 860, title: 'FlipScout',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  controlWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  controlWin.on('closed', () => { controlWin = null; });
}

function ensureMlsWindow() {
  if (mlsWin && !mlsWin.isDestroyed()) return mlsWin;
  mlsWin = new BrowserWindow({
    width: 1280, height: 900, show: true, title: 'MLS — FlipScout',
    webPreferences: { partition: 'persist:mls' }, // persistent cookies across runs
  });
  mlsWin.on('closed', () => { mlsWin = null; });
  return mlsWin;
}

const js = code => mlsWin.webContents.executeJavaScript(code, true);
async function nav(url, settle = 1800) {
  await mlsWin.loadURL(url).catch(() => {}); // Matrix keeps sockets open; loadURL resolves on load event
  await sleep(settle);
}

// In-page helper: set an MLS <select> by visible option text and fire change.
const selectByLabel = (sel, label) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return false;
  const o = [...el.options].find(o => o.text.trim() === ${JSON.stringify(label)} || o.text.includes(${JSON.stringify(label)}));
  if(!o) return false; o.selected = true; el.dispatchEvent(new Event('change',{bubbles:true})); return true;
})()`;
const setInput = (sel, val) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(el, ${JSON.stringify(val)});
  el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); el.blur(); return true;
})()`;

async function waitIfPaused() {
  while (control.paused && !control.stopped) { await sleep(400); }
  if (control.stopped) throw new Error('stopped');
}

// ---------- login ----------
ipcMain.handle('login', async (_e, { user, pass }) => {
  ensureMlsWindow();
  log('Opening MLS sign-in…');
  await nav('https://prodashboard.mlslistings.com/', 3500);
  // Best-effort autofill of the Azure B2C form; user submits + handles 2FA in the window.
  await js(`(() => {
    const u = document.querySelector('#signInName, #email, input[name=Username], input[type=email]');
    const p = document.querySelector('#password, input[name=Password], input[type=password]');
    if (u) u.value = ${JSON.stringify(user || '')};
    if (p) p.value = ${JSON.stringify(pass || '')};
    return { user: !!u, pass: !!p };
  })()`).catch(() => {});
  log('Sign-in page ready. Complete sign-in (and 2FA if asked) in the MLS window, then click “Check session”.', 'warn');
  return { ok: true };
});

ipcMain.handle('check-session', async () => {
  if (!mlsWin || mlsWin.isDestroyed()) return { loggedIn: false };
  const title = await js(core.JS_TITLE).catch(() => '');
  const loggedIn = /MLSListings Pro Dashboard/i.test(title) || /Matrix/i.test(title);
  log(loggedIn ? `Session OK — ${title}` : `Not logged in yet (page: ${title})`, loggedIn ? 'good' : 'warn');
  return { loggedIn, title };
});

// ---------- scan one area ----------
async function scanArea(area) {
  const label = area.city && area.city !== '*' ? area.city : `All ${area.county}`;
  await waitIfPaused();
  log(`Scanning ${label} (@ $${area.maxk}k)…`);
  await nav(core.SEARCH_URL, 2500);
  await js(selectByLabel(core.FIELDS.status, 'Active'));
  await sleep(300);
  await js(selectByLabel(core.FIELDS.propType, 'Single Family Home'));
  await sleep(300);
  await js(selectByLabel(core.FIELDS.county, area.county));
  await sleep(1200);
  if (area.city && area.city !== '*') {
    await js(setInput(core.FIELDS.cityBox, area.city)); await sleep(700);
    await js(selectByLabel(core.FIELDS.cityList, area.city)); await sleep(900);
  }
  // No List Date filter — the 45-day window is lifted for now. Set DAYS to a
  // positive number to restore a rolling window.
  const days = parseInt(process.env.DAYS || '0', 10);
  const fmt = d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  await js(setInput(core.FIELDS.price, `0-${area.maxk}`)); await sleep(500);
  if (days > 0) {
    const to = new Date(); const from = new Date(Date.now() - days * 86400000);
    await js(setInput(core.FIELDS.listDate, `${fmt(from)}-${fmt(to)}`));
  }
  await sleep(1600);
  const count = await js(core.JS_MATCH_COUNT).catch(() => '?');
  log(`  ${label}: ${count} matches`);
  if (count === '0') return { city: label, county: area.county, count, rows: [] };
  await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  await sleep(3500);
  let all = [], prev = '';
  for (let pg = 1; pg <= 12; pg++) {
    await waitIfPaused();
    const rows = await js(core.JS_SCRAPE_GRID).catch(() => []);
    if (!rows.length || rows[0].mls === prev) break;
    prev = rows[0].mls; all = all.concat(rows);
    const moved = await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/^\\s*Next/i.test(x.textContent)); if(a){a.click(); return true;} return false; })()`).catch(() => false);
    if (!moved) break;
    await sleep(3200);
  }
  const seen = new Set();
  all = all.filter(r => r.mls && !seen.has(r.mls) && seen.add(r.mls));
  log(`  scraped ${all.length} rows`);
  return { city: label, county: area.county, count, rows: all };
}

// ---------- open a single MLS# and render its full photo gallery in the MLS window ----------
async function showGallery(mls) {
  await nav(core.SEARCH_URL, 2200);
  await js(setInput(core.FIELDS.mls, mls)); await sleep(1600);
  await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  await sleep(2600);
  // The results grid lazy-loads; poll until the photo count stops growing
  // instead of grabbing whatever happens to be there after a fixed sleep.
  let urls = [];
  for (let tries = 0; tries < 6; tries++) {
    const got = await js(core.JS_PHOTOS).catch(() => []);
    if (got.length && got.length === urls.length) break;   // settled
    urls = got;
    await sleep(900);
  }
  // Capture agent remarks + condition (for the no-API rules engine) via the Client Full report.
  let meta = { remarks: '', condition: '' };
  try {
    await js(`(() => { const cb=document.querySelector('tr.DisplayRegRow input[type=checkbox], tr.DisplayAltRow input[type=checkbox]'); if(cb && !cb.checked) cb.click(); })()`);
    await sleep(400);
    const selId = await js(`(() => { const s=[...document.querySelectorAll('select')].find(se=>[...se.options].some(o=>/Client Full - All Photos/i.test(o.text))); return s?s.id:null; })()`);
    if (selId) {
      await js(`(() => { const s=document.getElementById(${JSON.stringify(selId)}); if(!s) return; const o=[...s.options].find(o=>/Client Full - All Photos/i.test(o.text)); if(o){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      await sleep(2600);
      // The zip only exists on this report — the results grid has no zip column,
      // which is why the sheet used to show a blank one. Three patterns, most
      // specific first; California zips all start with 9, so the last fallback
      // is safe enough for a buy box that never leaves the Bay Area.
      meta = await js(`(() => { const t=document.body.innerText.replace(/\\r/g,''); const grab=re=>{const m=t.match(re);return m?m[1].replace(/\\s+/g,' ').trim():'';}; return { remarks: grab(/(?:Public Remarks?|Marketing Remarks?|Remarks?):?\\s*([\\s\\S]{0,600}?)(?:Agent|Directions|Showing|Compensation|Listing Office|\\u00a9|Presented|$)/i), condition: grab(/Prop(?:erty)? Condition:?\\s*([^\\n]{0,60})/i), zip: grab(/(?:Zip(?:\\s*Code)?|Postal\\s*Code)\\s*:?\\s*(9\\d{4})\\b/i) || grab(/,\\s*CA\\s+(9\\d{4})\\b/) || grab(/\\b(9[0-5]\\d{3})\\b/) }; })()`).catch(() => ({ remarks: '', condition: '', zip: '' }));
    }
  } catch (_) {}
  // Render the full gallery so you can watch along, then WAIT for the images to
  // actually decode before anything judges the listing.
  await js(`(() => {
    const urls = ${JSON.stringify(urls)};
    const cell = (u,i) => '<div style="width:32%"><img src="'+u+'" style="width:100%;height:220px;object-fit:cover"><div style="color:#fff;font:12px sans-serif">#'+i+'</div></div>';
    document.body.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:6px;background:#111;padding:8px;font-family:sans-serif">' + urls.map(cell).join('') + '</div>';
  })()`).catch(() => {});
  await js(`(async () => {
    const imgs = [...document.images];
    await Promise.all(imgs.map(im => im.complete ? null : new Promise(r => {
      im.onload = im.onerror = r; setTimeout(r, 8000);
    })));
    return imgs.filter(i => i.naturalWidth > 0).length;
  })()`).catch(() => 0);

  // Dwell, so a human watching can actually see the gallery and the run isn't
  // blasting through listings faster than the pictures render.
  const dwell = Math.max(0, Number(cfg.readSeconds != null ? cfg.readSeconds : 6) * 1000);
  if (dwell) await sleep(dwell);

  return { count: urls.length, urls: urls, remarks: meta.remarks, condition: meta.condition,
    zip: meta.zip || '', details: meta.details || {} };
}

// ---------- comps for one kept candidate ----------
async function compFor(mls, zip, sqft) {
  await nav(core.SEARCH_URL, 2200);
  await js(selectByLabel(core.FIELDS.status, 'Sold')); await sleep(400);
  await js(selectByLabel(core.FIELDS.propType, 'Single Family Home')); await sleep(400);
  await js(setInput(core.FIELDS.zip, zip)); await sleep(1000);
  const to = new Date(); const from = new Date(to.getFullYear(), to.getMonth() - 14, 1);
  const fmt = d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  await js(setInput(core.FIELDS.listDate, `${fmt(from)}-${fmt(to)}`)); await sleep(1600);
  await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  await sleep(2600);
  let all = [], prev = '';
  for (let pg = 1; pg <= 8; pg++) {
    const rows = await js(core.JS_SCRAPE_GRID).catch(() => []);
    if (!rows.length || rows[0].addr === prev) break;
    prev = rows[0].addr; all = all.concat(rows);
    const moved = await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/^\\s*Next/i.test(x.textContent)); if(a){a.click(); return true;} return false; })()`).catch(() => false);
    if (!moved) break;
    await sleep(2600);
  }
  return core.arvFromComps(all, sqft);
}

// ---------- AI auto-verify (Claude vision applies the buy-box rules) ----------
function rulesPrompt(c, photoCount, gal) {
  const remarks = ((gal && gal.remarks) || '').slice(0, 700);
  return `You are screening a real-estate listing for a house-FLIPPING buy box.

Listing: ${c.addr}, ${c._cityKey} — ${c._sqft} sqft, $${c._price.toLocaleString()}.
You have been given ${photoCount} SEPARATE photos of this listing (every photo the MLS has, up to 20).
${remarks ? `Agent remarks: "${remarks}"` : 'No agent remarks available.'}

Work through the photos ONE BY ONE before answering. For each, note what room it is
and the state of the finishes. Pay closest attention to the KITCHEN and BATHROOMS —
that is where renovation shows first, and a listing is often photographed to hide it.
Do not answer from the exterior shots alone.

KEEP GENUINE value-add fixers: dated/original/worn/distressed interiors, vacant-original, estate/probate look, old kitchens/baths (formica, tile counters, old cabinets), worn or original flooring, needs cosmetic-to-heavy work.

The ONLY question that matters is: HAS WORK BEEN DONE TO THIS HOUSE? Judge the FINISHES, not the housekeeping or the staging. A house that is tidy, empty, swept, or professionally staged but still has ORIGINAL DATED FINISHES is a KEEP — "clean" is not "renovated". When torn between "clean but dated" and "lightly updated", choose KEEP.

DROP if ANY of:
- Renovated / remodeled / updated / refreshed / turnkey: new or refaced cabinets, quartz/granite counters, new stainless appliances, redone bathrooms (new tile/vanity/fixtures), new flooring throughout, recessed lighting, modern tile backsplash, luxury vinyl plank, fresh designer finishes. Actual work done = DROP. Merely clean or staged = KEEP.
- Multi-unit: 2+ full kitchens, a separate in-law/second unit with its own kitchen, duplex/triplex, or a detached rear dwelling that's a living unit.
- Fire damage / charring.
- Newer build that looks modern.
- Exterior-only / too few interior photos to judge condition (then DROP, reason "insufficient photos").

If you saw NO kitchen photo and NO bathroom photo, you cannot judge condition: DROP with
reason "no kitchen/bath photos".

Respond with ONLY a JSON object, no other text:
{"kitchen":"<what the kitchen photos show, or 'none seen'>",
 "bathroom":"<what the bathroom photos show, or 'none seen'>",
 "decision":"KEEP"|"DROP",
 "reason":"<8-15 words citing the specific finishes you saw>"}`;
}

/**
 * Pull the listing's photos as individual base64 JPEGs.
 *
 * This replaces the old capturePage() screenshot, which was the reason
 * renovated homes slipped through: capturePage grabs only the VISIBLE
 * viewport, so the model saw the first row or two of the contact sheet —
 * almost always exteriors — and never the kitchen or bathrooms where the
 * renovation evidence actually is. Fetching each photo inside the MLS window
 * (so the session cookies apply) and downscaling on a canvas gets every
 * picture to the model at a sane payload size.
 */
async function collectPhotos(urls, max) {
  const list = (urls || []).slice(0, max || 20);
  if (!list.length) return [];
  return await js(`(async () => {
    const urls = ${JSON.stringify(list)};
    const out = [];
    for (const u of urls) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) continue;
        const blob = await r.blob();
        const bmp = await createImageBitmap(blob);
        const scale = Math.min(1, 768 / Math.max(bmp.width, bmp.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(bmp.width * scale));
        cv.height = Math.max(1, Math.round(bmp.height * scale));
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        const d = cv.toDataURL('image/jpeg', 0.72);
        if (d && d.length > 2000) out.push(d.split(',')[1]);   // skip blank/failed decodes
      } catch (e) { /* one bad photo must not sink the listing */ }
    }
    return out;
  })()`).catch(() => []);
}

async function autoDecide(c) {
  try {
    const gal = c._gal || {};
    const photos = await collectPhotos(gal.urls, 20);
    if (!photos.length) {
      // Never guess with no pictures — Rule #2 says judge from the gallery.
      return { decision: 'drop', reason: 'no photos could be loaded — insufficient photos to judge' };
    }
    log(`  analysing ${photos.length} photo(s)…`);
    const content = photos.map(b64 => ({
      type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
    }));
    content.push({ type: 'text', text: rulesPrompt(c, photos.length, gal) });
    const body = { model: cfg.model || 'claude-opus-5', max_tokens: 1024, messages: [{ role: 'user', content }] };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.type === 'error') return { decision: 'drop', reason: 'AI error: ' + (j.error && j.error.message || 'unknown') };
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
    let o = {}; const m = text.match(/\{[\s\S]*\}/);
    try { o = JSON.parse(m ? m[0] : text); } catch (_) {}
    const decision = /^keep$/i.test(String(o.decision || '').trim()) ? 'keep' : 'drop';
    // Surface what it actually saw, so a wrong call is diagnosable from the log
    // instead of being a bare verdict.
    const seen = [o.kitchen && ('kitchen: ' + o.kitchen), o.bathroom && ('bath: ' + o.bathroom)]
      .filter(Boolean).join(' | ');
    const reason = [(o.reason || text || '').trim(), seen].filter(Boolean).join(' — ');
    return { decision, reason: reason.slice(0, 300), photos: photos.length };
  } catch (e) { return { decision: 'drop', reason: 'AI call failed: ' + e.message }; }
}

// ---------- full run ----------
ipcMain.handle('start-scan', async (_e, { buybox }) => {
  if (control.running) return { ok: false, error: 'already running' };
  control.running = true; control.stopped = false; control.paused = false;
  const areas = (buybox && buybox.length) ? buybox : core.DEFAULT_BUYBOX;
  const runKpi = Object.assign(blankKpi(), { runs: 1 });
  try {
    const s = await js(core.JS_TITLE).catch(() => '');
    if (!/Dashboard|Matrix/i.test(s)) { log('Not logged in — sign in first.', 'error'); return { ok: false }; }

    // Pull the reviewer's rejections down first, so anything she deleted is
    // treated as already-checked and never resurfaces.
    await syncRejectedIntoLedger();

    // ONE CITY AT A TIME, START TO FINISH. San Francisco is first in
    // DEFAULT_BUYBOX and is finished completely — scanned, every candidate
    // reviewed one by one, comped, scored and pushed — before the next city is
    // even searched. No jumping between cities mid-review.
    const leads = [];
    const byArea = {};
    for (let ai = 0; ai < areas.length; ai++) {
      if (control.stopped) break;
      const area = areas[ai];
      const label = area.city && area.city !== '*' ? area.city : `All ${area.county}`;
      log(`━━━ ${label}  (city ${ai + 1} of ${areas.length}) ━━━`, 'good');
      send('city', { label, index: ai + 1, total: areas.length, phase: 'scanning' });

      const scanned = await scanArea(area);
      byArea[label] = scanned;
      runKpi.scanned += scanned.rows.length;

      // Medians are per-city anyway, so filtering a city on its own gives the
      // same answer as filtering the whole batch — without the wait.
      const { candidates: cityCands, rejected: cityFiltered } = core.filterCandidates({ [label]: scanned });
      runKpi.candidates += cityCands.length;

      // Log why listings failed the buy-box filter. Capped, near-misses first —
      // a whole county's worth of "not below market" would drown the tab.
      const FILTER_LOG_CAP = 25;
      const filterRejects = (cityFiltered || []).slice(0, FILTER_LOG_CAP).map(r => ({
        mls: r.mls, addr: r.addr, city: label, price: r._price, ppsf: r._ppsf,
        sqft: r._sqft, dom: r._dom, reason: r._reason,
        link: `https://search.mlslistings.com/Matrix/Public/Portal.aspx?ID=${r.mls}`,
      }));
      if (cityFiltered && cityFiltered.length > FILTER_LOG_CAP) {
        log(`[${label}] ${cityFiltered.length} failed the buy-box filter; logging the ${FILTER_LOG_CAP} closest`);
      }

      const seen = loadLedger();
      const fresh = cityCands.filter(c => !seen[String(c.mls || '').trim().toUpperCase()]);
      const skipped = cityCands.length - fresh.length;
      runKpi.skippedAlreadyChecked += skipped;

      log(`${label}: ${scanned.rows.length} scanned → ${cityCands.length} candidates → `
        + `${fresh.length} NEW (${skipped} already checked, skipped)`, 'good');
      send('funnel', { city: label, scanned: runKpi.scanned, candidates: runKpi.candidates,
        fresh: fresh.length, skipped: runKpi.skippedAlreadyChecked,
        byArea: Object.fromEntries(Object.entries(byArea).map(([k, v]) => [k, v.rows.length])) });

      if (!fresh.length) {
        // Still record why the buy-box filter rejected things here, otherwise a
        // city with no new candidates explains nothing.
        if (filterRejects.length) {
          const rej = filterRejects.map(r => ({ ...r, stage: 'Buy-box filter' }));
          writeBackup([], rej);
          if (googleReady() && googleCfg().autoSync) await googleSync([], rej);
        }
        log(`${label}: nothing new — moving on.`);
        continue;
      }

      // --- review this city's listings, one by one ---
      send('city', { label, index: ai + 1, total: areas.length, phase: 'reviewing', count: fresh.length });
      const kept = [];
      // Everything rejected in this city, with its reason, for the Rejected tab.
      // Seeded with the buy-box filter failures so both stages are represented.
      const cityRejects = filterRejects.map(r => ({ ...r, stage: 'Buy-box filter' }));
      for (let i = 0; i < fresh.length; i++) {
        await waitIfPaused();
        if (control.stopped) break;
        const c = fresh[i];
        log(`[${label}] Photo-review ${i + 1}/${fresh.length}: ${c.addr}`);
        const gal = await showGallery(c.mls).catch(() => ({ count: 0, remarks: '', condition: '', zip: '', details: {} }));
        const n = gal.count;
        // The zip comes off the detail report, so carry it back onto the
        // candidate — it is needed whichever way the decision goes.
        if (gal.zip) c.zip = gal.zip;
        const base = { i: i + 1, total: fresh.length, city: label, mls: c.mls, addr: c.addr,
          price: c._price, sqft: c._sqft, ppsf: c._ppsf, photos: n,
          remarks: gal.remarks || '', details: gal.details || {} };
        let decision, dropReason = '';
        if (cfg.autoVerify && cfg.useAI && cfg.apiKey) {
          const v = await autoDecide({ ...c, _cityKey: label, _sqft: c._sqft, _price: c._price, _gal: gal });
          decision = v.decision; dropReason = v.reason;
          send('review', { ...base, ai: true, aiDecision: v.decision, aiReason: 'AI (vision): ' + v.reason });
          log(`  AI ${v.decision.toUpperCase()}: ${v.reason}`, v.decision === 'keep' ? 'good' : 'info');
        } else if (cfg.autoVerify) {
          const v = core.rulesDecide({ photos: n, remarks: gal.remarks, condition: gal.condition });
          if (v.decision === 'manual') {
            // The text rules genuinely can't tell renovated from dated — they
            // never see a photo. What happens next is your call (section 2):
            //   ask  — stop and show it (accurate, but hands-on)
            //   keep — let it through (fast, may surface renovated homes)
            //   drop — skip it (fast, loses some real fixers)
            // With an API key + AI vision this branch never runs, because
            // vision actually looks at the pictures.
            // Never stop the run to ask. Auto-verify means unattended.
            const mode = cfg.whenUnsure === 'drop' ? 'drop' : 'keep';
            decision = mode;
            dropReason = v.reason + ' (auto-' + mode + ')';
            send('review', { ...base, ai: true, aiDecision: mode, aiReason: 'Rules (unsure → ' + mode + '): ' + v.reason });
            log(`  RULES unsure → ${mode.toUpperCase()}: ${v.reason}`);
          } else {
            decision = v.decision; dropReason = v.reason;
            send('review', { ...base, ai: true, aiDecision: v.decision, aiReason: 'Rules: ' + v.reason });
            log(`  RULES ${v.decision.toUpperCase()}: ${v.reason}`, v.decision === 'keep' ? 'good' : 'info');
          }
        } else {
          send('review', base);
          decision = await new Promise(res => { pendingDecision[c.mls] = res; });
          delete pendingDecision[c.mls];
        }
        if (control.stopped) break;
        runKpi.reviewed++;
        if (decision === 'keep') { kept.push(c); runKpi.kept++; log(`  kept ${c.addr}`, 'good'); }
        else {
          runKpi.dropped++; runKpi[dropBucket(dropReason)]++;
          log(`  dropped ${c.addr} — ${dropReason || 'no reason given'}`);
          // Record WHY, so the Rejected tab can answer "why isn't this on my list".
          cityRejects.push({
            mls: c.mls, addr: c.addr, city: label, price: c._price,
            ppsf: c._ppsf, sqft: c._sqft, dom: c._dom,
            reason: dropReason || 'dropped at photo review', stage: 'Photo review',
            link: `https://search.mlslistings.com/Matrix/Public/Portal.aspx?ID=${c.mls}`,
          });
        }
        // Record as we go, not at the end — a crash or Stop mid-run must not
        // cost us the listings already judged.
        ledgerRecord(c.mls, decision === 'keep' ? 'kept' : 'dropped', { addr: c.addr, city: label });
      }

      // --- comps: OFF by default for now ---
      // Comping is the slow stage (a second Matrix search per kept listing).
      // With it off the run stops at CONDITION-QUALIFIED: everything that
      // survived photo review goes to the sheet with its listing facts, no ARV
      // and no deal math. Turn it back on in section 3 to restore ARV, profit
      // and the gate.
      const cityLeads = [];
      if (!cfg.runComps) {
        for (const c of kept) {
          cityLeads.push({
            mls: c.mls, address: c.addr, city: label, zip: c.zip || '',
            beds: c.bds, baths: c.baths || '', sqft: c._sqft,
            lotSqft: core.num(c.lotSqft || 0) || '',
            yearBuilt: 2026 - c._age, dom: c._dom, price: c._price, ppsf: c._ppsf,
            arv: 0, arvBasis: 'not comped yet',
            recommendation: 'Needs Comps', flipQuality: '', score: '',
            risks: 'Condition-qualified only — ARV and profit not yet calculated',
            link: `https://search.mlslistings.com/Matrix/Public/Portal.aspx?ID=${c.mls}`,
            // Push these: with no ARV there is no gate to clear, and the point
            // of this mode is to get the qualified list in front of you.
            surface: true, needsComps: true,
          });
        }
        log(`[${label}] comps skipped — ${cityLeads.length} condition-qualified listing(s)`, 'good');
      } else {
      send('city', { label, index: ai + 1, total: areas.length, phase: 'comping', count: kept.length });
      for (const c of kept) {
        await waitIfPaused();
        if (control.stopped) break;
        log(`[${label}] Comping ${c.addr}…`);
        const zip = (c.zip || '').match(/9\d{4}/) ? c.zip : await js(`(() => { const m=document.body.innerText.match(/\\b(9[45]\\d{3})\\b/); return m?m[1]:''; })()`).catch(() => '');
        let comp = { arv: 0, medianPpsf: 0, band: 'n/a', n: 0 };
        try { comp = await compFor(c.mls, zip || c.zip || '', c._sqft); } catch (e) { log(`  comp failed: ${e.message}`, 'warn'); }
        const deal = core.scoreDeal({ price: c._price, sqft: c._sqft, arv: comp.arv });
        cityLeads.push({ mls: c.mls, address: c.addr, city: label, zip, beds: c.bds, baths: c.baths || '',
          sqft: c._sqft, lotSqft: core.num(c.lotSqft || 0) || '',
          yearBuilt: 2026 - c._age, dom: c._dom, price: c._price,
          arv: comp.arv, arvPpsf: comp.medianPpsf, compBand: comp.band, compN: comp.n,
          arvBasis: comp.arv ? `${comp.band} band, ${comp.n} comps @ $${comp.medianPpsf}/sf` : 'no comps found',
          link: `https://search.mlslistings.com/Matrix/Public/Portal.aspx?ID=${c.mls}`,
          ...deal });
      }
      }

      leads.push(...cityLeads);
      // Without comps there is no profit to rank by — fall back to the best
      // value signal we do have, cheapest $/sqft first.
      leads.sort(cfg.runComps
        ? (a, b) => b.grossLight - a.grossLight
        : (a, b) => (a.ppsf || Infinity) - (b.ppsf || Infinity));
      runKpi.leads = leads.length;
      runKpi.gateCleared = leads.filter(l => l.surface).length;
      send('report', { leads, generatedAt: new Date().toString(), partial: ai + 1 < areas.length });

      // Hand this city's winners to the sheet now, so finished work is visible
      // even if a later city fails or you stop the run.
      const cityWinners = cityLeads.filter(l => l.surface);
      if (cityWinners.length || cityRejects.length) {
        const rows = cityWinners.map(toSheetRow);
        // Primary path: write into the spreadsheet over the Sheets API, using
        // the Google account signed in at section 7. The rows are in the sheet
        // by the time this line logs — nothing to refresh, nothing to wait for.
        if (googleReady() && googleCfg().autoSync) {
          const s = await googleSync(rows, cityRejects);
          if (s.ok) {
            runKpi.pushed += s.leads.added;
            runKpi.pushSkipped += s.leads.updated;
            log(`[${label}] sheet updated: ${s.leads.added} new lead(s), ${s.leads.updated} refreshed, `
              + `${s.rejects.added} rejection(s) logged`, 'good');
          } else {
            log(`[${label}] sheet write failed: ${s.error} — kept in the local backup`, 'warn');
          }
        } else {
          log(`[${label}] Google Sheet not connected — ${cityWinners.length} lead(s) held in the `
            + 'local backup. Connect it in section 7 and hit "Send this run\'s leads".', 'warn');
        }
        // Written either way: a failed API call, or a disconnected sheet, must
        // never lose a city that has already been reviewed.
        const d = writeBackup(rows, cityRejects);
        if (!d.ok) log(`[${label}] could not write the local backup: ${d.error}`, 'warn');
      }
      log(`━━━ ${label} done: ${kept.length} kept, ${cityWinners.length} clear the gate ━━━`, 'good');
      send('city', { label, index: ai + 1, total: areas.length, phase: 'done',
        kept: kept.length, winners: cityWinners.length });
    }

    if (!leads.length) {
      log('No new qualifying listings this run.', 'good');
      send('report', { leads: [], generatedAt: new Date().toString(), noNew: true });
      return { ok: true, leads: [] };
    }
    // Leads were already written city by city above — don't re-send them here.
    log(`Done. ${runKpi.gateCleared} of ${leads.length} kept leads clear the profit gate`
      + (googleReady() ? `; ${runKpi.pushed} written to the sheet.` : '.'), 'good');
    return { ok: true, leads };
  } catch (e) {
    if (e.message === 'stopped') { log('Scan stopped.', 'warn'); return { ok: false, stopped: true }; }
    log('Scan error: ' + e.message, 'error'); return { ok: false, error: e.message };
  } finally {
    control.running = false;
    // Record even a stopped or failed run — partial work still consumed effort,
    // and a day with three aborted runs should look different from a quiet one.
    const day = recordKpi(runKpi);
    send('kpi', { today: day, history: kpiReport() });
    // Only attempt the KPI push when a sheet is actually connected — an
    // unconfigured app must not log a failure after every single run.
    if (googleReady() && googleCfg().autoSync) googleSyncKpi(day).catch(() => {});
  }
});

ipcMain.on('pause', () => { control.paused = true; log('Paused.', 'warn'); });
ipcMain.on('resume', () => { control.paused = false; log('Resumed.', 'good'); });
ipcMain.on('stop', () => { control.stopped = true; control.paused = false; Object.values(pendingDecision).forEach(r => r('drop')); });
ipcMain.on('decide', (_e, { mls, decision }) => { if (pendingDecision[mls]) pendingDecision[mls](decision); });

// ---------- local backup ----------
// A copy of every reviewed city, written before anything else can fail. It is
// the app's own safety net, not a hand-off: when the sheet is connected the
// rows are already there, and when it is not this is what holds the work until
// it is. Kept in userData so it survives restarts and upgrades.

const BACKUP_FILE = () => path.join(app.getPath('userData'), 'flipscout-leads.json');

/** Merge into the backup rather than replacing it — a later city must not wipe
 *  an earlier one, and a re-run must not erase what it did not re-review. */
function writeBackup(leads, rejects) {
  const p = BACKUP_FILE();
  try {
    let prevLeads = [], prevRejects = [];
    if (fs.existsSync(p)) {
      try {
        const prev = JSON.parse(fs.readFileSync(p, 'utf8'));
        prevLeads = Array.isArray(prev) ? prev : (prev.leads || []);
        prevRejects = Array.isArray(prev) ? [] : (prev.rejects || []);
      } catch (_) { /* unreadable -> rebuild rather than fail the scan */ }
    }
    const dedupe = arr => {
      const by = {};
      arr.forEach(l => {
        const k = String(l.mls || l['MLS #'] || l.address || '').trim().toUpperCase();
        if (k) by[k] = l;
      });
      return Object.keys(by).map(k => by[k]);
    };
    const mergedLeads = dedupe([...prevLeads, ...(leads || [])]);
    const mergedRejects = dedupe([...prevRejects, ...(rejects || [])]);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      updated: new Date().toISOString(),
      leads: mergedLeads,
      rejects: mergedRejects,
    }, null, 1));
    return { ok: true, path: p, total: mergedLeads.length,
      added: mergedLeads.length - prevLeads.length, rejects: mergedRejects.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

ipcMain.handle('backup-status', () => {
  const p = BACKUP_FILE();
  let count = 0, updated = '';
  if (fs.existsSync(p)) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      count = (j.leads || []).length;
      updated = j.updated || '';
    } catch (_) {}
  }
  return { path: p, exists: fs.existsSync(p), count, updated };
});

ipcMain.on('show-file', (_e, p) => { try { shell.showItemInFolder(p); } catch (_) {} });

// ---------- Google Sheets, written directly ----------
// You sign in with your own Google account and paste your spreadsheet URL; the
// app writes rows into it over the Sheets API. No Apps Script, no deployment,
// no shared secret, no Drive-for-Desktop, no waiting for a trigger. The Drive
// drop file below still runs as a fallback for machines that never sign in.

const GOOGLE_FILE = () => path.join(app.getPath('userData'), 'google-account.json');
const GOOGLE_BLANK = {
  clientId: '', clientSecret: '', refreshToken: '', accessToken: '', expiresAt: 0,
  email: '', sheetId: '', sheetTitle: '',
  leadTab: 'Leads', rejectTab: 'Rejected', kpiTab: 'KPI',
  autoSync: true,
};
let googleCache = null;
function googleCfg() {
  if (googleCache) return googleCache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(GOOGLE_FILE(), 'utf8')); } catch (_) {}
  googleCache = Object.assign({}, GOOGLE_BLANK, saved);
  return googleCache;
}
function saveGoogle(patch) {
  const g = Object.assign(googleCfg(), patch || {});
  try {
    fs.mkdirSync(path.dirname(GOOGLE_FILE()), { recursive: true });
    fs.writeFileSync(GOOGLE_FILE(), JSON.stringify(g, null, 1));
  } catch (e) { log('Could not save the Google settings: ' + e.message, 'warn'); }
  return g;
}

/** A live access token, refreshed if the hour is up. Throws with an instruction
 *  rather than a Google error string when there is nothing to refresh from. */
async function googleToken() {
  const g = googleCfg();
  if (!g.refreshToken) throw new Error('not signed in to Google yet — section 7');
  if (g.accessToken && g.expiresAt > Date.now() + 60000) return g.accessToken;
  const t = await gsheets.refresh({
    clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: g.refreshToken,
  });
  saveGoogle({ accessToken: t.accessToken, expiresAt: t.expiresAt });
  return t.accessToken;
}

const googleReady = () => { const g = googleCfg(); return !!(g.refreshToken && g.sheetId); };

// Same columns the Apps Script builds, so a sheet already set up by the script
// keeps working unchanged and the two paths can't drift.
// ONE address column, holding the whole thing — street, city, state, zip —
// the way it reads on the listing. Split City/Zip columns are gone: they made
// the row hard to scan and left two more cells to arrive blank.
const LEAD_HEADERS = [
  'Status', 'MLS #', 'Address',
  'Beds', 'Baths', 'SqFt', 'Lot SqFt', 'Year Built', 'DOM',
  'Purchase Price', '$/SqFt', 'Notes', 'MLS Link', 'First Added',
];
const REJECT_HEADERS = [
  'Rejected On', 'MLS #', 'Address',
  'Price', '$/SqFt', 'SqFt', 'DOM', 'Reason', 'Stage', 'By', 'MLS Link',
];
const KPI_SHEET_HEADERS = [
  'Date', 'Runs', 'Scanned', 'Candidates', 'Already Checked (skipped)',
  'Reviewed', 'Kept', 'Dropped',
  'Dropped: Renovated', 'Dropped: Multi-unit', 'Dropped: Fire',
  'Dropped: Few photos', 'Dropped: Other',
  'Leads', 'Clear Gate', 'Sent to Sheet', 'Already There',
  'Reviewer Removed', 'Reviewer Kept', 'Reviewer',
  'Keep Rate', 'Gate Rate', 'Last Run',
];
// Everything up to 'Already There' is the app's own count and gets replaced on
// each push; the reviewer's three columns are never touched.
const KPI_APP_COLS = KPI_SHEET_HEADERS.slice(0, KPI_SHEET_HEADERS.indexOf('Reviewer Removed'))
  .concat(['Keep Rate', 'Gate Rate', 'Last Run']);

const today = () => new Date().toISOString().slice(0, 10);
const fullAddress = core.fullAddress;

/** A finished lead (already through toSheetRow) as a sheet record. */
const leadRecord = r => ({
  'Status': r.status || '', 'MLS #': r.mls, 'Address': fullAddress(r.address, r.city, r.zip),
  'Beds': r.beds, 'Baths': r.baths, 'SqFt': r.sqft, 'Lot SqFt': r.lotSqft,
  'Year Built': r.yearBuilt, 'DOM': r.dom, 'Purchase Price': r.price, '$/SqFt': r.ppsf,
  'Notes': r.notes, 'MLS Link': r.link || mlsLink(r.mls), 'First Added': today(),
});

const rejectRecord = r => ({
  'Rejected On': today(), 'MLS #': r.mls,
  'Address': fullAddress(r.addr || r.address, r.city, r.zip),
  'Price': r.price, '$/SqFt': r.ppsf,
  'SqFt': r.sqft, 'DOM': r.dom, 'Reason': r.reason || '', 'Stage': r.stage || '',
  'By': 'FlipScout', 'MLS Link': r.link || mlsLink(r.mls),
});

/** Every MLS # already on the Rejected tab. */
async function rejectedOnSheet(token) {
  const g = googleCfg();
  const info = await gsheets.listTabs(token, g.sheetId);
  if (info.tabs.indexOf(g.rejectTab) < 0) return {};
  const col = gsheets.colName(REJECT_HEADERS.indexOf('MLS #'));
  const out = {};
  (await gsheets.readCol(token, g.sheetId, g.rejectTab, `${col}2:${col}`))
    .forEach(m => { const k = String(m || '').trim().toUpperCase(); if (k) out[k] = true; });
  return out;
}

/** Push a batch straight into the spreadsheet. Leads and rejections go to their
 *  own tabs; both are append-or-backfill, so nothing on the sheet is destroyed. */
async function googleSync(leads, rejects) {
  const g = googleCfg();
  if (!g.refreshToken) return { ok: false, unconfigured: true, error: 'not signed in to Google — section 7' };
  if (!g.sheetId) return { ok: false, unconfigured: true, error: 'no spreadsheet URL yet — section 7' };
  try {
    const token = await googleToken();
    const blank = { added: 0, updated: 0, filled: 0 };
    // A rejected lead must never come back. The ledger already stops it being
    // re-reviewed, but a lead reviewed BEFORE it was rejected is still in this
    // batch — and once the reviewer deletes the Leads row there is no duplicate
    // left for the MLS # key to catch, so it would append clean. Check the
    // Rejected tab itself, which is the record that survives the deletion.
    const dead = await rejectedOnSheet(token);
    const fresh = (leads || []).filter(l => !dead[String(l.mls || '').trim().toUpperCase()]);
    const blocked = (leads || []).length - fresh.length;
    if (blocked) log(`${blocked} lead(s) skipped — already on the Rejected tab.`);
    leads = fresh;

    const L = (leads && leads.length)
      ? await gsheets.syncRows(token, g.sheetId, g.leadTab, LEAD_HEADERS, 'MLS #', leads.map(leadRecord))
      : blank;
    // Rejections can repeat an MLS # across stages; key on it anyway so the tab
    // holds one row per property rather than growing a row per scan.
    const R = (rejects && rejects.length)
      ? await gsheets.syncRows(token, g.sheetId, g.rejectTab, REJECT_HEADERS, 'MLS #',
          rejects.filter(r => r && r.mls).map(rejectRecord))
      : blank;
    return { ok: true, leads: L, rejects: R, blocked };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function googleSyncKpi(day) {
  const g = googleCfg();
  if (!googleReady()) return { ok: false, unconfigured: true, error: 'Google sheet not connected' };
  try {
    const token = await googleToken();
    const rec = {
      'Date': day.date, 'Runs': day.runs, 'Scanned': day.scanned, 'Candidates': day.candidates,
      'Already Checked (skipped)': day.skippedAlreadyChecked, 'Reviewed': day.reviewed,
      'Kept': day.kept, 'Dropped': day.dropped,
      'Dropped: Renovated': day.droppedRenovated, 'Dropped: Multi-unit': day.droppedMultiUnit,
      'Dropped: Fire': day.droppedFire, 'Dropped: Few photos': day.droppedFewPhotos,
      'Dropped: Other': day.droppedOther,
      'Leads': day.leads, 'Clear Gate': day.gateCleared, 'Sent to Sheet': day.pushed,
      'Already There': day.pushSkipped,
      'Keep Rate': day.reviewed ? Math.round((day.kept / day.reviewed) * 100) + '%' : '',
      'Gate Rate': day.leads ? Math.round((day.gateCleared / day.leads) * 100) + '%' : '',
      'Last Run': new Date().toLocaleString(),
    };
    await gsheets.syncRows(token, g.sheetId, g.kpiTab, KPI_SHEET_HEADERS, 'Date', [rec],
      { overwrite: KPI_APP_COLS });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

ipcMain.handle('google-status', () => {
  const g = googleCfg();
  return {
    // The client id/secret come back so the fields repopulate after a restart.
    // A desktop-app "secret" is not a credential — Google documents it as
    // non-confidential — and it already sits in plaintext in userData.
    clientId: g.clientId, clientSecret: g.clientSecret,
    hasClient: !!g.clientId, signedIn: !!g.refreshToken, email: g.email,
    sheetId: g.sheetId, sheetTitle: g.sheetTitle, leadTab: g.leadTab,
    autoSync: !!g.autoSync, ready: googleReady(),
  };
});

ipcMain.handle('google-save', (_e, patch) => {
  const next = {};
  if (patch.clientId !== undefined) next.clientId = String(patch.clientId).trim();
  if (patch.clientSecret !== undefined) next.clientSecret = String(patch.clientSecret).trim();
  if (patch.autoSync !== undefined) next.autoSync = !!patch.autoSync;
  if (patch.sheetUrl !== undefined) {
    const id = gsheets.parseSheetId(patch.sheetUrl);
    if (patch.sheetUrl && !id) return { ok: false, error: "that doesn't look like a Google Sheets URL or ID" };
    next.sheetId = id;
  }
  saveGoogle(next);
  return { ok: true };
});

ipcMain.handle('google-signin', async () => {
  const g = googleCfg();
  if (!g.clientId) {
    return { ok: false, error: 'paste your OAuth Client ID first — the one-time setup steps are under the button' };
  }
  try {
    log('Opening the Google sign-in page in your browser…');
    const t = await gsheets.signIn({
      clientId: g.clientId, clientSecret: g.clientSecret,
      openUrl: u => shell.openExternal(u),
    });
    // Google only issues a refresh token on the first consent for a client. If
    // this is a re-auth it may be absent — keep the one we already hold rather
    // than wiping a working connection.
    saveGoogle({
      accessToken: t.accessToken, expiresAt: t.expiresAt,
      refreshToken: t.refreshToken || g.refreshToken,
      email: t.email || g.email,
    });
    log(`Google connected${t.email ? ' as ' + t.email : ''}.`, 'good');
    return { ok: true, email: googleCfg().email };
  } catch (e) {
    log('Google sign-in failed: ' + e.message, 'error');
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('google-signout', () => {
  saveGoogle({ refreshToken: '', accessToken: '', expiresAt: 0, email: '' });
  log('Signed out of Google.', 'warn');
  return { ok: true };
});

/** Prove the whole chain works — token, spreadsheet, tabs — before a scan
 *  depends on it, and create the tabs while we're here. */
ipcMain.handle('google-test', async () => {
  const g = googleCfg();
  if (!g.refreshToken) return { ok: false, error: 'sign in with Google first' };
  if (!g.sheetId) return { ok: false, error: 'paste your spreadsheet URL first' };
  try {
    const token = await googleToken();
    const info = await gsheets.listTabs(token, g.sheetId);
    await gsheets.ensureTab(token, g.sheetId, g.leadTab, LEAD_HEADERS);
    await gsheets.ensureTab(token, g.sheetId, g.rejectTab, REJECT_HEADERS);
    saveGoogle({ sheetTitle: info.title });
    return { ok: true, title: info.title, tabs: info.tabs, email: g.email };
  } catch (e) {
    const m = /permission|PERMISSION_DENIED|403/i.test(e.message)
      ? `${g.email || 'the signed-in account'} cannot edit that spreadsheet — share it with that address, or sign in as the owner`
      : e.message;
    return { ok: false, error: m };
  }
});

ipcMain.handle('google-sync', async (_e, { leads, rejects }) => {
  const set = (leads || []).filter(l => l.surface !== false).map(toSheetRow);
  log(`Writing ${set.length} lead(s) to your Google Sheet…`);
  const r = await googleSync(set, rejects || []);
  log(r.ok
    ? `Sheet updated: ${r.leads.added} new, ${r.leads.updated} refreshed, ${r.rejects.added} rejection(s) logged.`
    : `Sheet write failed: ${r.error}`, r.ok ? 'good' : 'error');
  return r;
});

/** One lead in the shape the sheet expects. Shared by the sheet writer and the
 *  local backup so the two can never drift apart. */
function toSheetRow(l) {
  return {
    status: l.recommendation || (l.needsComps ? 'Needs Comps' : ''),
    mls: l.mls, address: l.address, city: l.city, zip: l.zip,
    beds: l.beds, baths: l.baths || '', sqft: l.sqft, lotSqft: l.lotSqft || '',
    yearBuilt: l.yearBuilt, dom: l.dom, price: l.price, ppsf: l.ppsf || '',
    notes: l.risks || '', link: l.link || '',
    arv: l.arv || '', arvBasis: l.arvBasis || '',
    rehabLight: l.rehabLight || '', rehabHeavy: l.rehabHeavy || '',
    holding: l.holding || '', maxOffer: l.recommendedMaxOffer || '',
    score: l.score || '', recommendation: l.recommendation || '', flipQuality: l.flipQuality || '',
  };
}

// ---------- reviewer rejections ----------
// The reviewer works in the sheet and rejects leads she does not want, giving a
// reason. Those MLS #s come back here and go into the ledger, so a rejected
// lead is never scanned, reviewed, or re-added again.
async function syncRejectedIntoLedger() {
  // Direct read of the Rejected tab when Google is connected — that tab is where
  // the reviewer's "Reject selected lead(s)" rows land, so it is the authoritative
  // list either way.
  if (googleReady()) {
    try {
      const g = googleCfg();
      const token = await googleToken();
      const col = gsheets.colName(REJECT_HEADERS.indexOf('MLS #'));
      const info = await gsheets.listTabs(token, g.sheetId);
      const ids = info.tabs.indexOf(g.rejectTab) < 0 ? []
        : await gsheets.readCol(token, g.sheetId, g.rejectTab, `${col}2:${col}`);
      const seen = loadLedger();
      const fresh = ids.filter(m => m && !seen[String(m).trim().toUpperCase()]);
      if (fresh.length) {
        ledgerRecordMany(fresh.map(m => ({ mls: m, verdict: 'reviewer-rejected' })));
        log(`Reviewer rejections synced: ${fresh.length} new (won't be checked again).`);
      }
      return { ok: true, total: ids.length, added: fresh.length };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, unconfigured: true, error: 'connect your Google Sheet in section 7 first' };
}


ipcMain.handle('ledger-stats', () => {
  const e = loadLedger();
  const byVerdict = {};
  Object.keys(e).forEach(k => { const v = e[k].verdict || '?'; byVerdict[v] = (byVerdict[v] || 0) + 1; });
  return { total: Object.keys(e).length, byVerdict, file: LEDGER_FILE() };
});

ipcMain.handle('ledger-clear', async () => {
  const { response } = await dialog.showMessageBox(controlWin, {
    type: 'warning', buttons: ['Cancel', 'Clear ledger'], defaultId: 0, cancelId: 0,
    message: 'Clear the seen-ledger?',
    detail: 'Every listing becomes unchecked again, so the next scan will re-review the whole buy box from scratch. This can take hours.',
  });
  if (response !== 1) return { ok: false, cancelled: true };
  saveLedger({});
  log('Seen-ledger cleared — the next scan re-reviews everything.', 'warn');
  return { ok: true };
});

// ---------- daily KPI report ----------
/** Most recent `days` calendar days, newest first, plus a total row. */
function kpiReport(days = 14) {
  const all = loadKpi();
  const keys = Object.keys(all).sort().reverse().slice(0, days);
  const rows = keys.map(k => Object.assign({ date: k }, blankKpi(), all[k]));
  const total = Object.assign(blankKpi(), { date: 'TOTAL (' + rows.length + 'd)' });
  rows.forEach(r => KPI_FIELDS.forEach(f => { total[f] += (r[f] || 0); }));
  return { rows, total, today: rows.find(r => r.date === todayKey()) || Object.assign({ date: todayKey() }, blankKpi()) };
}

ipcMain.handle('kpi-report', (_e, opts) => kpiReport((opts && opts.days) || 14));

ipcMain.handle('kpi-export', async (_e, { days }) => {
  const rep = kpiReport(days || 90);
  const { canceled, filePath } = await dialog.showSaveDialog(controlWin, {
    title: 'Export KPI history', defaultPath: 'flipscout-kpi.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  if (filePath.endsWith('.json')) { fs.writeFileSync(filePath, JSON.stringify(rep, null, 2)); return { ok: true, filePath }; }
  const cols = ['date'].concat(KPI_FIELDS);
  const csv = [cols.join(',')].concat(rep.rows.map(r => cols.map(c => r[c] == null ? '' : r[c]).join(','))).join('\n');
  fs.writeFileSync(filePath, csv);
  return { ok: true, filePath };
});

ipcMain.handle('export', async (_e, { leads }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(controlWin, {
    title: 'Export FlipScout leads', defaultPath: 'flipscout-leads.csv', filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  if (filePath.endsWith('.json')) { fs.writeFileSync(filePath, JSON.stringify(leads, null, 2)); return { ok: true, filePath }; }
  const cols = ['score', 'recommendation', 'flipQuality', 'mls', 'address', 'city', 'zip', 'beds', 'sqft', 'yearBuilt', 'dom', 'price', 'arv', 'rehabLight', 'rehabHeavy', 'holding', 'totalLight', 'grossLight', 'grossHeavy', 'recommendedMaxOffer', 'arvBasis'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [cols.join(',')].concat(leads.map(l => cols.map(c => esc(l[c])).join(','))).join('\n');
  fs.writeFileSync(filePath, csv);
  return { ok: true, filePath };
});

app.whenReady().then(createControlWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createControlWindow(); });
