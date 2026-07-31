/**
 * FlipScout Desktop — Electron main process.
 *
 * Two windows: a Control panel (buttons/progress/report) and a visible MLS
 * browser window that the app drives. Login happens in the visible window so
 * you can complete 2FA/SSO yourself; the app auto-fills what it can and then
 * detects the dashboard. Scanning navigates the MLS window through Matrix and
 * runs the same extraction used by the headless pipeline.
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('./scan-core');

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
  sheetUrl: '', sheetSecret: '', autoPush: false,                      // Flip Scout Agent sheet
};
/** Apps Script hands out two URL shapes for the same deployment. The
 *  /a/macros/<domain>/ one only works for signed-in Workspace users, so rewrite
 *  it to the public form rather than letting it fail confusingly. */
function normalizeExecUrl(u) {
  const s = String(u || '').trim();
  const m = s.match(/^https:\/\/script\.google\.com\/a\/macros\/[^/]+\/s\/([^/]+)\/exec/i);
  return m ? `https://script.google.com/macros/s/${m[1]}/exec` : s;
}

ipcMain.on('set-config', (_e, c) => {
  const next = Object.assign({}, c || {});
  if (next.sheetUrl) next.sheetUrl = normalizeExecUrl(next.sheetUrl);
  Object.assign(cfg, next);
});

// Shipped defaults for the sheet connection, so section 6 arrives pre-filled
// instead of blank. Bundled next to main.js; missing/!valid JSON just means
// "no defaults", never a crash on startup.
function sheetDefaults() {
  try {
    const p = path.join(__dirname, 'sheet-config.json');
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { url: normalizeExecUrl(j.url || ''), secret: j.secret || '', autoPush: !!j.autoPush };
  } catch (_) { return {}; }
}
ipcMain.handle('sheet-defaults', () => sheetDefaults());

// Seed the live config at startup so an auto-push works even if the renderer
// never touches section 6.
(() => {
  const d = sheetDefaults();
  if (d.url) cfg.sheetUrl = d.url;
  if (d.secret) cfg.sheetSecret = d.secret;
  if (d.autoPush) cfg.autoPush = true;
})();

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
      meta = await js(`(() => { const t=document.body.innerText.replace(/\\r/g,''); const grab=re=>{const m=t.match(re);return m?m[1].replace(/\\s+/g,' ').trim():'';}; return { remarks: grab(/(?:Public Remarks?|Marketing Remarks?|Remarks?):?\\s*([\\s\\S]{0,600}?)(?:Agent|Directions|Showing|Compensation|Listing Office|\\u00a9|Presented|$)/i), condition: grab(/Prop(?:erty)? Condition:?\\s*([^\\n]{0,60})/i) }; })()`).catch(() => ({ remarks: '', condition: '' }));
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

  return { count: urls.length, urls: urls, remarks: meta.remarks, condition: meta.condition, details: meta.details || {} };
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
      const { candidates: cityCands } = core.filterCandidates({ [label]: scanned });
      runKpi.candidates += cityCands.length;

      const seen = loadLedger();
      const fresh = cityCands.filter(c => !seen[String(c.mls || '').trim().toUpperCase()]);
      const skipped = cityCands.length - fresh.length;
      runKpi.skippedAlreadyChecked += skipped;

      log(`${label}: ${scanned.rows.length} scanned → ${cityCands.length} candidates → `
        + `${fresh.length} NEW (${skipped} already checked, skipped)`, 'good');
      send('funnel', { city: label, scanned: runKpi.scanned, candidates: runKpi.candidates,
        fresh: fresh.length, skipped: runKpi.skippedAlreadyChecked,
        byArea: Object.fromEntries(Object.entries(byArea).map(([k, v]) => [k, v.rows.length])) });

      if (!fresh.length) { log(`${label}: nothing new — moving on.`); continue; }

      // --- review this city's listings, one by one ---
      send('city', { label, index: ai + 1, total: areas.length, phase: 'reviewing', count: fresh.length });
      const kept = [];
      for (let i = 0; i < fresh.length; i++) {
        await waitIfPaused();
        if (control.stopped) break;
        const c = fresh[i];
        log(`[${label}] Photo-review ${i + 1}/${fresh.length}: ${c.addr}`);
        const gal = await showGallery(c.mls).catch(() => ({ count: 0, remarks: '', condition: '', details: {} }));
        const n = gal.count;
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
            const mode = cfg.whenUnsure || 'ask';
            if (mode === 'ask') {
              log(`  RULES: ${v.reason} — over to you`, 'warn');
              send('review', { ...base, needsEye: true, aiReason: 'Rules: ' + v.reason });
              decision = await new Promise(res => { pendingDecision[c.mls] = res; });
              delete pendingDecision[c.mls];
              dropReason = 'manual review';
            } else {
              decision = mode;
              dropReason = v.reason + ' (auto-' + mode + ' per your setting)';
              send('review', { ...base, ai: true, aiDecision: mode, aiReason: 'Rules (unsure → ' + mode + '): ' + v.reason });
              log(`  RULES unsure → ${mode.toUpperCase()}: ${v.reason}`, mode === 'keep' ? 'info' : 'info');
            }
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
        else { runKpi.dropped++; runKpi[dropBucket(dropReason)]++; log(`  dropped ${c.addr}`); }
        // Record as we go, not at the end — a crash or Stop mid-run must not
        // cost us the listings already judged.
        ledgerRecord(c.mls, decision === 'keep' ? 'kept' : 'dropped', { addr: c.addr, city: label });
      }

      // --- comp + score this city, before touching the next one ---
      send('city', { label, index: ai + 1, total: areas.length, phase: 'comping', count: kept.length });
      const cityLeads = [];
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

      leads.push(...cityLeads);
      leads.sort((a, b) => b.grossLight - a.grossLight);
      runKpi.leads = leads.length;
      runKpi.gateCleared = leads.filter(l => l.surface).length;
      send('report', { leads, generatedAt: new Date().toString(), partial: ai + 1 < areas.length });

      // Push this city's winners now, so finished work reaches the sheet even
      // if a later city fails or you stop the run.
      const cityWinners = cityLeads.filter(l => l.surface);
      if (cfg.autoPush && cfg.sheetUrl && cfg.sheetSecret && cityWinners.length) {
        const r = await pushLeads(cityWinners);
        if (r.ok) { runKpi.pushed += r.added; runKpi.pushSkipped += r.skipped; }
        log(`[${label}] sheet: ${r.ok ? `${r.added} added, ${r.skipped} already there` : 'push failed — ' + r.error}`,
          r.ok ? 'good' : 'error');
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
    // Leads were already pushed city by city above — don't re-send them here.
    log(`Done. ${runKpi.gateCleared} of ${leads.length} kept leads clear the profit gate`
      + (cfg.autoPush ? `; ${runKpi.pushed} sent to the sheet.` : '.'), 'good');
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
    // Only attempt the KPI push when the sheet is actually connected — an
    // unconfigured app must not log a failure after every single run.
    if (cfg.autoPush && cfg.sheetUrl && cfg.sheetSecret) pushKpi(day).catch(() => {});
  }
});

ipcMain.on('pause', () => { control.paused = true; log('Paused.', 'warn'); });
ipcMain.on('resume', () => { control.paused = false; log('Resumed.', 'good'); });
ipcMain.on('stop', () => { control.stopped = true; control.paused = false; Object.values(pendingDecision).forEach(r => r('drop')); });
ipcMain.on('decide', (_e, { mls, decision }) => { if (pendingDecision[mls]) pendingDecision[mls](decision); });

// ---------- Flip Scout Agent sheet ----------
// Posts to the Apps Script web app in apps-script/flip-scout-agent-sheet.gs.
// The script owns de-duping (by MLS #) and the derived money columns, so the
// app sends raw values and lets the sheet be the single source of truth.
/**
 * The endpoint answered with HTML instead of JSON. By far the most common
 * cause is a deployment whose access is set to the Workspace domain rather
 * than "Anyone" — Google then serves a sign-in page, which the app cannot get
 * past because it posts without a Google login. Name that specifically.
 */
function describeHtmlReply(text) {
  const t = String(text || '');
  // Check sign-in FIRST and match it broadly: Google's login page is huge and
  // contains plenty of incidental words. (An earlier version tested a bare
  // /not found/ here, which matched inside that login page and reported a
  // deployed-version problem when the real issue was access.)
  if (/accounts\.google\.(com|[a-z.]+)|AccountChooser|signin|Sign in|ServiceLogin/i.test(t)) {
    return 'Google returned a SIGN-IN PAGE, so the deployment is still not public. '
      + 'Apps Script editor → Deploy → Manage deployments → pencil/edit → '
      + '"Who has access" = Anyone (NOT "Anyone within <your domain>") → Deploy. '
      + 'Domain-restricted deployments can never work here: the app has no Google '
      + 'login to offer.';
  }
  if (/Script function not found/i.test(t)) {
    return 'The deployed version predates doGet/doPost — Deploy → Manage '
      + 'deployments → pencil/edit → Version: New version → Deploy.';
  }
  if (/authoriz|permission|consent/i.test(t)) {
    return 'The script needs authorising — open the Apps Script editor, Run any '
      + 'function once, accept the permission prompt, then redeploy.';
  }
  if (/unable to open|does not exist|no longer exists|moved or deleted/i.test(t)) {
    return 'Google says the script file cannot be opened — the deployment URL '
      + 'points at a script that was deleted or is not shared with you.';
  }
  // Unknown page: quote it rather than shrugging, so the real cause is visible
  // instead of guessed at.
  return 'Expected JSON, got an HTML page. It says: "' + visibleText(t, 240) + '"';
}

/** Strip tags/scripts/styles and return the first meaningful text on a page. */
function visibleText(html, max) {
  const s = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max || 240) || '(the page had no readable text)';
}

/** Say which half is missing — "not configured" tells you nothing. */
function notConfiguredMsg() {
  if (!cfg.sheetUrl && !cfg.sheetSecret) return 'no web app URL or secret — see section 7';
  if (!cfg.sheetUrl) {
    return 'no web app URL yet. In the sheet: ⚡ Flip Scout → Connect the app '
      + '(deploy the script first: Deploy → New deployment → Web app, Execute as Me, '
      + 'Anyone with the link), then paste the /exec URL into section 7.';
  }
  return 'no shared secret — paste it into section 7 (⚡ Flip Scout → Connect the app shows it).';
}

async function pushLeads(leads) {
  if (!cfg.sheetUrl || !cfg.sheetSecret) return { ok: false, error: notConfiguredMsg(), unconfigured: true };
  if (!leads || !leads.length) return { ok: true, added: 0, skipped: 0 };
  try {
    const r = await fetch(cfg.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Apps Script /exec answers with a 302 to googleusercontent; follow it.
      redirect: 'follow',
      body: JSON.stringify({
        secret: cfg.sheetSecret,
        leads: leads.map(l => ({
          score: l.score, recommendation: l.recommendation, flipQuality: l.flipQuality,
          mls: l.mls, address: l.address, city: l.city, zip: l.zip,
          beds: l.beds, baths: l.baths || '', sqft: l.sqft, lotSqft: l.lotSqft || '',
          yearBuilt: l.yearBuilt, dom: l.dom,
          price: l.price, arv: l.arv,
          rehabLight: l.rehabLight, rehabHeavy: l.rehabHeavy, holding: l.holding,
          maxOffer: l.recommendedMaxOffer, arvBasis: l.arvBasis || '',
          risks: l.risks || 'None', link: l.link || '',
        })),
      }),
    });
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch (_) { return { ok: false, error: describeHtmlReply(text) }; }
    if (!j.ok) return { ok: false, error: j.error || 'unknown error' };
    return { ok: true, added: j.added || 0, skipped: j.skipped || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('push-sheet', async (_e, { leads, onlySurfacing }) => {
  const set = onlySurfacing === false ? (leads || []) : (leads || []).filter(l => l.surface);
  log(`Pushing ${set.length} lead(s) to the sheet…`);
  const r = await pushLeads(set);
  log(r.ok ? `Sheet updated: ${r.added} added, ${r.skipped} already there.`
           : `Sheet push failed: ${r.error}`, r.ok ? 'good' : 'error');
  return r;
});

ipcMain.handle('test-sheet', async () => {
  if (!cfg.sheetUrl || !cfg.sheetSecret) return { ok: false, error: 'enter the web app URL and secret first' };
  try {
    const u = cfg.sheetUrl + (cfg.sheetUrl.indexOf('?') >= 0 ? '&' : '?') + 'secret=' + encodeURIComponent(cfg.sheetSecret);
    const r = await fetch(u, { redirect: 'follow' });
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch (_) { return { ok: false, error: describeHtmlReply(text) }; }
    if (!j.ok) return { ok: false, error: j.error || 'rejected' };
    if ((j.missingColumns || []).length) {
      return { ok: false, error: 'sheet is missing columns: ' + j.missingColumns.join(', ') + ' — run setupSheet()' };
    }
    return { ok: true, sheet: j.sheet, columns: (j.columns || []).length, rows: j.rows || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------- reviewer rejections ----------
// The human reviewer works in the sheet and deletes leads she does not want.
// Those MLS #s come back here and go into the ledger, so a deleted lead is
// never scanned, reviewed, or re-pushed again.
async function syncRejectedIntoLedger() {
  if (!cfg.sheetUrl || !cfg.sheetSecret) return { ok: false, error: notConfiguredMsg(), unconfigured: true };
  try {
    const u = cfg.sheetUrl + (cfg.sheetUrl.indexOf('?') >= 0 ? '&' : '?')
      + 'secret=' + encodeURIComponent(cfg.sheetSecret) + '&rejected=1';
    const r = await fetch(u, { redirect: 'follow' });
    const j = JSON.parse(await r.text());
    if (!j.ok || !Array.isArray(j.rejected)) return { ok: false, error: j.error || 'no list returned' };
    const seen = loadLedger();
    const fresh = j.rejected.filter(m => m && !seen[String(m).trim().toUpperCase()]);
    if (fresh.length) {
      ledgerRecordMany(fresh.map(m => ({ mls: m, verdict: 'reviewer-rejected' })));
      log(`Reviewer rejections synced: ${fresh.length} new (won't be checked again).`);
    }
    return { ok: true, total: j.rejected.length, added: fresh.length };
  } catch (e) { return { ok: false, error: e.message }; }
}
ipcMain.handle('sync-rejected', () => syncRejectedIntoLedger());

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

/** Mirror the day's numbers onto the sheet's KPI tab (upserted by date). */
async function pushKpi(day) {
  if (!cfg.sheetUrl || !cfg.sheetSecret) return { ok: false, error: notConfiguredMsg(), unconfigured: true };
  try {
    const r = await fetch(cfg.sheetUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ secret: cfg.sheetSecret, kpi: day }),
    });
    const j = JSON.parse(await r.text());
    return j.ok ? { ok: true } : { ok: false, error: j.error };
  } catch (e) { return { ok: false, error: e.message }; }
}

ipcMain.handle('kpi-push', async () => {
  const rep = kpiReport(1);
  const r = await pushKpi(rep.today);
  // An unconfigured sheet is a setup step, not a failure — say it once, plainly.
  log(r.ok ? 'KPI sent to the sheet.'
    : (r.unconfigured ? 'Sheet not connected yet: ' + r.error : 'KPI push failed: ' + r.error),
    r.ok ? 'good' : 'warn');
  return r;
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
