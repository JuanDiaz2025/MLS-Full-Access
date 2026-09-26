/**
 * FlipScout Desktop — Electron main process.
 *
 * Two windows: a Control panel (buttons/progress/report) and a visible MLS
 * browser window that the app drives. Login happens in the visible window so
 * you can complete 2FA/SSO yourself; the app auto-fills what it can and then
 * detects the dashboard. Scanning navigates the MLS window through Matrix and
 * runs the same extraction used by the headless pipeline.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, net } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('./scan-core');
const gsheets = require('./google-sheets');

let controlWin, mlsWin;
const control = { paused: false, stopped: false, running: false };
let aiFailStreak = 0;   // consecutive failed AI calls in this run
const cfg = {
  apiKey: '', model: 'claude-opus-5-5', useAI: false,   // AI vision (optional)
  readSeconds: 6,                                                      // dwell per listing
  // What to do when the text rules can't tell renovated from dated: ask | keep | drop.
  // Defaults to 'keep' so a run never stalls waiting for a click. It is a safe
  // default here because the candidate already passed the buy-box filters (25+
  // years old, below-market $/sqft) and because the sheet reviewer rejects
  // anything wrong — with that rejection feeding straight back into the ledger.
  whenUnsure: 'keep',
  runComps: false,     // OFF for now — qualify on CONDITION first, comp later
  scrollPauseMs: 700,  // pause per screen while scrolling a report — reading slowly
  boardUrl: 'https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1',   // FlipScout Lead Board
};

// ---------- AI provider: Anthropic or OpenAI, told apart by the key ----------
// Anthropic keys start "sk-ant-"; any other key is treated as OpenAI (ChatGPT).
// The photo prompt and the KEEP/DROP rules are the same for both — only the
// request and response shapes differ (see aiCall).
const OPENAI_DEFAULT_MODEL = 'gpt-4.1';
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
function aiProvider(key) { return /^sk-ant-/.test(String(key || '').trim()) ? 'anthropic' : 'openai'; }
function aiModel() {
  const prov = aiProvider(cfg.apiKey), m = String(cfg.model || '').trim();
  // "claude-opus-5" was never a model id; a saved setting from an older build
  // would make every AI call fail.
  if (prov === 'anthropic') return !m || m === 'claude-opus-5' || !/^claude/i.test(m) ? ANTHROPIC_DEFAULT_MODEL : m;
  // a Claude model name sent to OpenAI would fail every call
  return !m || /^claude/i.test(m) ? OPENAI_DEFAULT_MODEL : m;
}

// The key and model survive a restart (they used to be retyped every launch).
// Kept on this computer only, next to the Google sign-in.
const AI_FILE = () => path.join(app.getPath('userData'), 'ai-settings.json');
function loadAi() {
  try { const j = JSON.parse(fs.readFileSync(AI_FILE(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (_) { return {}; }
}
function saveAi() {
  try { fs.writeFileSync(AI_FILE(), JSON.stringify({ apiKey: cfg.apiKey || '', model: cfg.model || '', useAI: !!cfg.useAI }, null, 2)); } catch (_) {}
}
ipcMain.handle('ai-settings', () => {
  const j = loadAi();
  return { apiKey: j.apiKey || '', model: j.model || '', useAI: !!j.useAI, provider: aiProvider(j.apiKey) };
});

ipcMain.on('set-config', (_e, c) => {
  Object.assign(cfg, c || {});
  cfg.model = aiModel();
  // Saved only when the AI fields themselves change: every other settings push
  // (including the one at startup, before the saved key is back in the box)
  // carries an empty key and must not wipe the saved one.
  if (c && c.aiSave) saveAi();
});

/**
 * One call to whichever provider the key belongs to. `photos` are base64
 * JPEGs, `text` is the prompt. Resolves {text} or throws with the provider's
 * own error message, so a wrong key or model name says so in the log.
 */
async function aiCall(photos, text, maxTokens) {
  const key = String(cfg.apiKey || '').trim(), model = aiModel();
  if (aiProvider(key) === 'anthropic') {
    const content = photos.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }));
    content.push({ type: 'text', text });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens || 1024, messages: [{ role: 'user', content }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.type === 'error') throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return { text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' '), model, provider: 'Anthropic' };
  }
  // OpenAI Chat Completions: images go in as data URLs.
  const content = [{ type: 'text', text }].concat(photos.map(b64 => ({
    type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'auto' },
  })));
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    // max_completion_tokens, not max_tokens: the newer models refuse the old name
    body: JSON.stringify({ model, max_completion_tokens: maxTokens || 1024, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  return { text: (msg && typeof msg.content === 'string' ? msg.content : '') || '', model, provider: 'OpenAI' };
}

// "Test key" in section 2: a tiny text-only call, so a bad key or model name
// shows up before a scan, not as a run full of failed reviews.
ipcMain.handle('ai-test', async () => {
  if (!cfg.apiKey) return { ok: false, error: 'Paste an API key first.' };
  try {
    const r = await aiCall([], 'Reply with the single word: ready', 20);
    return { ok: true, provider: r.provider, model: r.model, reply: (r.text || '').trim().slice(0, 40) };
  } catch (e) { return { ok: false, provider: aiProvider(cfg.apiKey) === 'anthropic' ? 'Anthropic' : 'OpenAI', model: aiModel(), error: e.message }; }
});

// ---------- daily KPIs ----------
// Every scan folds its funnel counts into a per-day record kept on disk, so the
// numbers survive closing the app and "how did today go" is answerable without
// re-running anything. One row per calendar day, accumulated across runs.
const KPI_FILE = () => path.join(app.getPath('userData'), 'kpi-history.json');
const KPI_FIELDS = ['runs', 'scanned', 'candidates', 'skippedAlreadyChecked', 'reviewed', 'kept',
  'dropped', 'droppedRenovated', 'droppedMultiUnit', 'droppedFire',
  'droppedFewPhotos', 'droppedOther', 'leads', 'gateCleared', 'pushed', 'pushSkipped',
  'bucketA', 'bucketB', 'bucketC'];
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
    width: 720, height: 860, title: `FlipScout Filters v${app.getVersion()}`,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Keep the build name and version in the title bar, so it is always clear
  // which build is running. The page's own <title> would replace it.
  controlWin.on('page-title-updated', e => e.preventDefault());
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

// Always go through ensureMlsWindow: the window is closed when a scan
// finishes, and the next run has to be able to reopen it. Cookies live in the
// 'persist:mls' partition, so reopening keeps the MLS session.
const js = code => ensureMlsWindow().webContents.executeJavaScript(code, true);
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

/** Like waitIfPaused, but a Stop is an answer, not an exception. Loops that
 *  have already read listings use it so a Stop BREAKS out and the work done
 *  so far is still written to the sheet — throwing skipped that write, so a
 *  Stop mid-refresh lost the last unsaved leads and a Stop mid-scan lost
 *  reviewed leads the ledger already counted as checked. */
async function stopRequested() {
  try { await waitIfPaused(); } catch (_) { /* stopped */ }
  return control.stopped;
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
  // Reopen and reload rather than reporting "not signed in" just because the
  // last scan closed the window — the cookies are still there.
  const fresh = !mlsWin || mlsWin.isDestroyed();
  if (fresh) { ensureMlsWindow(); await nav(core.SEARCH_URL, 3000); }
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
  await js(setInput(core.FIELDS.price, `0-${area.maxk}`)); await sleep(500);
  // Cut the 45-day rule in at the SEARCH, not just after — otherwise the scan
  // drags a whole county's back catalogue through the grid to throw most of it
  // away. The search form has no days-on-market field (checked against the live
  // form), so List Date is the lever.
  //
  // The window is deliberately WIDER than the rule: DOM can never exceed the
  // days since the list date, so a 60-day list window is guaranteed to contain
  // every listing with DOM <= 45, while still cutting the volume hard. DOM
  // stays the authoritative test in filterCandidates.
  const fmt = d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const to = new Date(), from = new Date(Date.now() - core.LIST_WINDOW_DAYS * 86400000);
  await js(setInput(core.FIELDS.listDate, `${fmt(from)}-${fmt(to)}`));
  await sleep(1600);
  const count = await js(core.JS_MATCH_COUNT).catch(() => '?');
  log(`  ${label}: ${count} matches`);
  if (count === '0') return { city: label, county: area.county, count, rows: [] };
  await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  // The grid can take far longer than a fixed pause to fill (a slow MLS left
  // San Francisco at "280 matches → scraped 0 rows" and the run moved on), so
  // poll for rows instead of reading once.
  const gridRows = async (notFirst, waitMs) => {
    const until = Date.now() + waitMs;
    for (;;) {
      const r = await js(core.JS_SCRAPE_GRID).catch(() => []);
      if (r.length && r[0].mls !== notFirst) return r;
      if (Date.now() > until || control.stopped) return r;
      await sleep(1000);
    }
  };
  // Whole counties run to hundreds of listings — Contra Costa alone returns
  // ~800. A 12-page cap silently truncated anything past ~600 and the run would
  // report a clean finish having never seen the rest, so the cap is now high
  // enough for the largest county AND says so if it is ever hit.
  const PAGE_CAP = 60;
  let all = [], prev = '', pagesRead = 0;
  for (let pg = 1; pg <= PAGE_CAP; pg++) {
    await waitIfPaused();
    if (control.stopped) break;
    // page 1: wait for the grid to fill; later pages: wait until the first
    // row is a different listing, i.e. the page really turned
    const rows = await gridRows(prev, pg === 1 ? 25000 : 20000);
    if (!rows.length || rows[0].mls === prev) break;
    prev = rows[0].mls; all = all.concat(rows); pagesRead = pg;
    const moved = await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/^\\s*Next/i.test(x.textContent)); if(a){a.click(); return true;} return false; })()`).catch(() => false);
    if (!moved) break;
    await sleep(1500);
  }
  const seen = new Set();
  all = all.filter(r => r.mls && !seen.has(r.mls) && seen.add(r.mls));
  if (pagesRead >= PAGE_CAP) {
    log(`  ⚠ hit the ${PAGE_CAP}-page cap in ${label} — some listings were NOT scanned`, 'warn');
  }
  log(`  scraped ${all.length} rows`);
  if (!all.length && count !== '0' && count !== '?') {
    log(`  ⚠ ${label}: the MLS showed ${count} matches but no rows could be read — the results grid did not load. Scan this area again.`, 'error');
  }
  return { city: label, county: area.county, count, rows: all };
}

// ---------- open a single MLS# and render its full photo gallery in the MLS window ----------
// opts.factsOnly: read the reports (remarks, offer date, price, status) and
// skip the photo grid and the dwell — what "Refresh leads on the board" needs.
async function showGallery(mls, opts) {
  const factsOnly = !!(opts && opts.factsOnly);
  await nav(core.SEARCH_URL, 2200);
  await js(setInput(core.FIELDS.mls, mls)); await sleep(1600);
  await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  await sleep(2600);

  // The Client Full report is the only place the full address, the zip, the
  // year built and the real remarks exist — the results grid has none of them.
  let meta = { remarks: '', condition: '', zip: '', address: '', yearBuilt: '', propClass: '', mismatch: false };
  try {
    await js(`(() => { const cb=document.querySelector('tr.DisplayRegRow input[type=checkbox], tr.DisplayAltRow input[type=checkbox]'); if(cb && !cb.checked) cb.click(); })()`);
    await sleep(400);
    const selId = await js(`(() => { const s=[...document.querySelectorAll('select')].find(se=>[...se.options].some(o=>/Client Full - All Photos/i.test(o.text))); return s?s.id:null; })()`);
    if (selId) {
      await js(`(() => { const s=document.getElementById(${JSON.stringify(selId)}); if(!s) return; const o=[...s.options].find(o=>/Client Full - All Photos/i.test(o.text)); if(o){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      await sleep(2600);
      // Parse in Node rather than in the page: it makes the extraction testable
      // against saved report text, which is how the wrong-listing bug surfaced.
      const raw = factsOnly ? await js('document.body.innerText').catch(() => '') : await readWholePage();
      meta = core.parseDetail(raw, mls);
      saveReportSample(mls, 'client', raw);
    }
  } catch (_) {}

  // EVERY photo, not the handful the carousel happens to have preloaded.
  //
  // The report shows ONE frame at a time with three or four queued behind it,
  // so reading it returned about 4 of 26 — and photo 1 is the exterior. The AI
  // was being asked to judge a kitchen it had never been shown, which is
  // exactly the "you are not analysing the images" complaint. PhotoPopup.aspx
  // with View=G is a grid of the lot; the URL is built from the media Key on
  // any carousel image, so no popup window has to be driven.
  let urls = [], gridOk = false, info = null;
  try {
    if (!factsOnly) info = await js(`(() => {
      const img = [...document.images].find(i => /MediaServer/i.test(i.src));
      if (!img) return null;
      // Double backslashes: this is a template string, and a single \d here
      // reaches the page as a bare "d" — the regex never matched, so the full
      // photo grid was never opened and every listing fell back to the ~4
      // photos the carousel preloads.
      const key = (img.src.match(/Key=(\\d+)/) || [])[1];
      const tid = (img.src.match(/TableID=(\\d+)/) || [])[1] || '9';
      // The carousel counter reads "1 / 29", spaced. Beds/baths ("3/0") and
      // Age/Yr Blt ("122/1904") are not, so they cannot be taken for the count.
      const n = (document.body.innerText.match(/\\b1 \\/ (\\d{1,3})\\b/) || [])[1];
      return key ? { key: key, tid: tid, n: n || '60' } : null;
    })()`).catch(() => null);
  } catch (_) {}
  // Carousel fallback, read NOW while the report is still on screen — once we
  // leave for the Agent Full report or the photo grid it is gone.
  const carousel = factsOnly ? [] : await js(core.JS_PHOTOS).catch(() => []);

  // Private / agent-only remarks live on the Agent Full report, not Client
  // Full. Same results page, different display — switch, read, move on.
  try {
    const agentSel = await js(`(() => { const s=[...document.querySelectorAll('select')].find(se=>[...se.options].some(o=>/^\\s*Agent Full\\s*$/i.test(o.text))); return s?s.id:null; })()`);
    if (agentSel) {
      await js(`(() => { const s=document.getElementById(${JSON.stringify(agentSel)}); if(!s) return; const o=[...s.options].find(o=>/^\\s*Agent Full\\s*$/i.test(o.text)); if(o){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
      await sleep(2600);
      const rawAgent = factsOnly ? await js('document.body.innerText').catch(() => '') : await readWholePage();
      saveReportSample(mls, 'agent', rawAgent);
      const agent = core.parseDetail(rawAgent, mls);
      if (!agent.mismatch) {
        meta.privateRemarks = agent.privateRemarks || '';
        // Agent Full may carry facts Client Full left blank.
        ['origPrice', 'listPrice', 'listedBy', 'remarks', 'address', 'zip', 'yearBuilt', 'propClass', 'condition', 'occupiedBy', 'status',
          'agentPhone', 'agentEmail', 'showing', 'disclosuresField']
          .forEach(k => { if (!meta[k] && agent[k]) meta[k] = agent[k]; });
      }
    }
  } catch (_) {}

  try {
    if (info) {
      await nav('https://search.mlslistings.com/Matrix/Public/PhotoPopup.aspx'
        + `?n=${info.n}&i=0&L=1&tid=${info.tid}&key=${info.key}&mtid=1&View=G`, 3000);
      urls = await js(`[...document.images].map(i => i.src).filter(u => /MediaServer/i.test(u))`)
        .catch(() => []);
      gridOk = urls.length > 0;
    }
  } catch (_) {}
  // Fall back to the carousel rather than judging a listing with no photos.
  // Its count is NOT the listing's photo count (only ~4 are ever preloaded),
  // so gridOk=false tells the rules not to read "few photos" into it.
  if (!urls.length) urls = carousel || [];

  // The grid page IS the gallery, so there is nothing to rebuild — just wait
  // for the images to decode before anything judges the listing.
  if (!factsOnly) await js(`(async () => {
    const imgs = [...document.images];
    await Promise.all(imgs.map(im => im.complete ? null : new Promise(r => {
      im.onload = im.onerror = r; setTimeout(r, 8000);
    })));
    return imgs.filter(i => i.naturalWidth > 0).length;
  })()`).catch(() => 0);

  // Dwell, so a human watching can actually see the gallery and the run is not
  // blasting through listings faster than the pictures render.
  const dwell = factsOnly ? 0 : Math.max(0, Number(cfg.readSeconds != null ? cfg.readSeconds : 6) * 1000);
  if (dwell) await sleep(dwell);

  return { count: urls.length, urls: urls, gridOk: gridOk,
    remarks: meta.remarks || '', condition: meta.condition || '',
    zip: meta.zip || '', address: meta.address || '', yearBuilt: meta.yearBuilt || '',
    propClass: meta.propClass || '',
    privateRemarks: meta.privateRemarks || '', origPrice: meta.origPrice || '',
    listPrice: meta.listPrice || '', listedBy: meta.listedBy || '', occupiedBy: meta.occupiedBy || '',
    status: meta.status || '',
    agentPhone: meta.agentPhone || '', agentEmail: meta.agentEmail || '', showing: meta.showing || '',
    disclosures: core.disclosuresLink(meta.disclosuresField, [meta.privateRemarks, meta.remarks].filter(Boolean).join(' \n ')),
    mismatch: !!meta.mismatch, showing: meta.showing || '' };
}

// Scroll the report top to bottom, a screen at a time, before reading it.
// Matrix builds some sections as they come into view, and it is how a person
// reads a listing: all of it, not the first screen. The pause per screen is
// the "Scroll pause" setting in section 3. Only real content panels are
// scrolled — the page and at most two tall panels — not every menu.
async function readWholePage() {
  const pause = Math.max(150, Number(cfg.scrollPauseMs != null ? cfg.scrollPauseMs : 700));
  await js(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const panels = [document.scrollingElement || document.documentElement]
      .concat([...document.querySelectorAll('div, main, section')]
        .filter(el => el.clientHeight > 250 && el.scrollHeight > el.clientHeight + 80
          && /(auto|scroll)/.test(getComputedStyle(el).overflowY))
        .sort((a, b) => b.scrollHeight - a.scrollHeight).slice(0, 2));
    for (const el of panels) {
      const step = Math.max(200, Math.round((el === panels[0] ? innerHeight : el.clientHeight) * 0.8));
      for (let y = 0; y <= el.scrollHeight; y += step) { el.scrollTop = y; await wait(${pause}); }
      el.scrollTop = el.scrollHeight; await wait(${pause});
    }
    for (const el of panels) el.scrollTop = 0;
    return true;
  })()`).catch(() => false);
  return await js('document.body.innerText').catch(() => '');
}

// Look the kept house up on Redfin, from this computer, so the Lead Board can
// link straight to its page. A failure only costs the link, never the lead.
async function redfinUrl(address) {
  if (!address) return '';
  try {
    const u = 'https://www.redfin.com/stingray/do/location-autocomplete?v=2&al=1&location='
      + encodeURIComponent(address);
    const r = await net.fetch(u, { headers: { 'Accept': 'application/json, text/plain, */*' } });
    if (!r.ok) return '';
    return core.redfinUrlFrom(await r.text(), address);
  } catch (_) { return ''; }
}

/** Keep the raw report text for the first few listings of each run, so the
 *  Agent Full layout (private-remarks label) can be checked against the real
 *  page instead of guessed. userData/report-samples/<MLS#>-<kind>.txt */
let samplesThisRun = 0;
function saveReportSample(mls, kind, text) {
  try {
    if (!text || samplesThisRun >= 10) return;
    if (kind === 'agent') samplesThisRun++;
    const dir = path.join(app.getPath('userData'), 'report-samples');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${String(mls).replace(/[^A-Z0-9]/gi, '')}-${kind}.txt`), text);
  } catch (_) {}
}

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
  for (let pg = 1; pg <= 8; pg++) {   // comps only need the nearest few pages
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

KEEP GENUINE value-add fixers: dated/original/worn/distressed interiors, vacant-original, estate/probate look, tenant-occupied (NOT a reason to drop), old kitchens/baths (formica, tile counters, old cabinets), worn or original flooring, needs cosmetic-to-heavy work.

ONE UPDATED SURFACE IS NOT A FLIP. An older house where ONE thing was redone (granite on old cabinets, one remodeled bathroom, a new water heater) while the rest is original — dated kitchen, other baths original, old carpet or flooring — is a KEEP: a flipper still has a full job there. DROP for renovation only when the house as a whole has been flipped: the kitchen is new end to end (cabinets AND counters AND appliances) and the bathrooms are redone, or new finishes run throughout.

The ONLY question that matters is: HAS WORK BEEN DONE TO THIS HOUSE? Judge the FINISHES, not the housekeeping or the staging. A house that is tidy, empty, swept, or professionally staged but still has ORIGINAL DATED FINISHES is a KEEP — "clean" is not "renovated". When torn between "clean but dated" and "lightly updated", choose KEEP.

DROP if ANY of:
- Renovated / remodeled / updated / refreshed / turnkey: new or refaced cabinets, quartz/granite counters, new stainless appliances, redone bathrooms (new tile/vanity/fixtures), new flooring throughout, recessed lighting, modern tile backsplash, luxury vinyl plank, fresh designer finishes. Actual work done = DROP. Merely clean or staged = KEEP.
- Multi-unit: 2+ full kitchens, a separate in-law/second unit with its own kitchen, duplex/triplex, or a detached rear dwelling that's a living unit.
- Fire damage / charring.
- Newer build that looks modern.
- Exterior-only / too few interior photos to judge condition (then DROP, reason "insufficient photos").
- NOT A QUICK FLIP. We want a COSMETIC job — paint, floors, kitchen, bath, done in one pass without drawings or engineers. DROP if the photos or remarks show work that is structural or permit-heavy: foundation cracks, visible settlement or a sloping/sagging floor, jacked-up posts or shoring, an open framed shell / stripped down to studs, a collapsed or missing roof, extensive water damage or mould, or a tear-down / land-value listing. A dated house needing everything cosmetically is EXACTLY what we want; a house needing an engineer is not.

If you saw NO kitchen photo and NO bathroom photo, you cannot judge condition: DROP with
reason "no kitchen/bath photos".

Respond with ONLY a JSON object, no other text:
{"kitchen":"<what the kitchen photos show, or 'none seen'>",
 "bathroom":"<what the bathroom photos show, or 'none seen'>",
 "quickFlip":"<cosmetic | structural — and why, in a few words. 'structural' means foundation, framing, settlement, roof or water damage ONLY; renovated finishes are never 'structural'>",
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
/** Choose WHICH photos to send. Photo 1 is the exterior on essentially every
 *  listing, and the first several are usually more exterior and street shots,
 *  so taking the first N biases the model away from the kitchen and baths —
 *  the only rooms that answer "has work been done here". Skip the cover and
 *  spread across the rest. */
function spreadPhotos(urls, max) {
  const rest = (urls || []).slice(1);
  if (rest.length <= max) return rest;
  const step = rest.length / max;
  const out = [];
  for (let i = 0; out.length < max && Math.floor(i) < rest.length; i += step) out.push(rest[Math.floor(i)]);
  return out;
}

async function collectPhotos(urls, max) {
  const list = spreadPhotos(urls, max || 20);
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
    let text;
    try { text = (await aiCall(photos, rulesPrompt(c, photos.length, gal), aiProvider(cfg.apiKey) === 'openai' ? 4000 : 1024)).text; }
    // A failed CALL is not a verdict on the house: say so, and let the text
    // rules stand. (It used to return DROP, so a typo in the model name
    // auto-passed every listing in the run.)
    catch (e) { return { error: true, reason: 'AI call failed: ' + e.message }; }
    // An empty or unreadable answer is not a DROP either (a "thinking" model
    // can spend its whole budget before writing anything).
    if (!/\{[\s\S]*"decision"[\s\S]*\}/.test(text || '')) return { error: true, reason: 'AI gave no usable answer' + (text ? ': "' + String(text).trim().slice(0, 80) + '"' : ' (empty reply)') };
    let o = {}; const m = text.match(/\{[\s\S]*\}/);
    try { o = JSON.parse(m ? m[0] : text); } catch (_) {}
    const decision = /^keep$/i.test(String(o.decision || '').trim()) ? 'keep' : 'drop';
    // Surface what it actually saw, so a wrong call is diagnosable from the log
    // instead of being a bare verdict.
    const seen = [o.kitchen && ('kitchen: ' + o.kitchen), o.bathroom && ('bath: ' + o.bathroom),
      o.quickFlip && ('rehab: ' + o.quickFlip)].filter(Boolean).join(' | ');
    const reason = [(o.reason || text || '').trim(), seen].filter(Boolean).join(' — ');
    return { decision, reason: reason.slice(0, 300), photos: photos.length };
  } catch (e) { return { error: true, reason: 'AI call failed: ' + e.message }; }
}

// ---------- full run ----------
/** The buy box as pickable areas, for the checkboxes in section 3. */
ipcMain.handle('buybox', () => core.DEFAULT_BUYBOX.map((a, i) => ({
  i, maxk: a.maxk,
  label: a.city && a.city !== '*' ? a.city : `All ${a.county}`,
})));

ipcMain.handle('start-scan', async (_e, opts) => {
  if (control.running) return { ok: false, error: 'already running' };
  // Indexes, not objects: the renderer says WHICH areas, the buy box itself
  // stays defined in one place.
  const picked = opts && Array.isArray(opts.areaIndexes) ? opts.areaIndexes : null;
  const areas = picked
    ? picked.map(i => core.DEFAULT_BUYBOX[i]).filter(Boolean)
    : core.DEFAULT_BUYBOX;
  if (!areas.length) { log('No areas selected — tick at least one in section 3.', 'warn'); return { ok: false }; }
  control.running = true; control.stopped = false; control.paused = false;
  samplesThisRun = 0;
  aiFailStreak = 0;
  const runKpi = Object.assign(blankKpi(), { runs: 1 });
  // Only a run that actually started closes the browser window at the end.
  // Bailing out for "not signed in" and then shutting the window the user is
  // about to sign in through would be its own small disaster.
  let started = false;
  try {
    // A finished scan closes the MLS window, so reopen it and let the saved
    // session load before deciding whether we are signed in.
    if (!mlsWin || mlsWin.isDestroyed()) { ensureMlsWindow(); await nav(core.SEARCH_URL, 3000); }
    const s = await js(core.JS_TITLE).catch(() => '');
    if (!/Dashboard|Matrix/i.test(s)) { log('Not logged in — sign in first.', 'error'); return { ok: false }; }
    started = true;

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
      // "All San Francisco" is a heading for the log, never a city name. Data
      // rows use the listing's OWN Postal City — which is also the only right
      // answer on a county-wide scan, where the rows are not all one city —
      // and fall back to the area name with the "All " stripped off.
      const areaCity = label.replace(/^All\s+/i, '');
      // The MLS leaves DOM blank on some listings. num() turns that into 0,
      // which on the sheet reads as "listed today" — a fact we were never told.
      // Blank in, blank out.
      const domOf = r => (String(r.dom || '').trim() ? r._dom : '');
      const cityOf = r => String(r.city || '').trim() || areaCity;
      log(`━━━ ${label}  (area ${ai + 1} of ${areas.length}) ━━━`, 'good');
      send('city', { label, index: ai + 1, total: areas.length, phase: 'scanning' });

      const scanned = await scanArea(area);
      byArea[label] = scanned;
      runKpi.scanned += scanned.rows.length;

      // Medians are per-city anyway, so filtering a city on its own gives the
      // same answer as filtering the whole batch — without the wait.
      const { candidates: cityCands, rejected: cityFiltered, medians: cityMedians } = core.filterCandidates({ [label]: scanned });
      runKpi.candidates += cityCands.length;

      // Log why listings failed the buy-box filter. Capped, near-misses first —
      // a whole county's worth of "not below market" would drown the tab.
      // EVERY buy-box rejection is logged, not a sample. This used to keep only
      // the 25 nearest misses, which made "Scan Rejected" on the KPI tab an
      // undercount — and a number that quietly means "some of them" is worse
      // than no number at all.
      const filterRejects = (cityFiltered || []).map(r => ({
        mls: r.mls, addr: r.addr, city: cityOf(r), zip: r.zip || '',
        price: r._price, ppsf: r._ppsf, sqft: r._sqft, dom: r._dom, reason: r._reason,
        link: core.mlsUrl(r.mls),
      }));
      if (filterRejects.length) log(`[${label}] ${filterRejects.length} failed the buy-box filter — all logged with the reason`);

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
        if (await stopRequested()) break;   // save what was read, then stop
        const c = fresh[i];
        log(`[${label}] Photo-review ${i + 1}/${fresh.length}: ${c.addr}`);
        const gal = await showGallery(c.mls).catch(() => ({ count: 0, remarks: '', condition: '', zip: '', mismatch: false }));
        // Matrix sometimes ignores the MLS # filter and leaves a DIFFERENT
        // listing on screen. Judging that would put another property's photos,
        // remarks and address onto this lead, so skip it — deliberately without
        // a ledger entry, so the next run tries again instead of writing it off.
        if (gal.mismatch) {
          log(`  SKIPPED ${c.addr} — the MLS showed ${gal.showing || 'another listing'} instead of ${c.mls}; will retry next run`, 'warn');
          continue;
        }
        const n = gal.count;
        // Address, zip and year built all come off the detail report; the grid
        // carries none of them reliably.
        if (gal.zip) c.zip = gal.zip;
        if (gal.address) c.fullAddr = gal.address;
        if (gal.yearBuilt) c._yearBuilt = Number(gal.yearBuilt);
        const base = { i: i + 1, total: fresh.length, city: cityOf(c), mls: c.mls, addr: c.addr,
          price: c._price, sqft: c._sqft, ppsf: c._ppsf, photos: n,
          remarks: gal.remarks || '', details: gal.details || {} };
        // THE QUALIFICATION GATE. Every listing gets an Opportunity Score and a
        // bucket — A work now, B AI review, C auto-pass. C never reaches the
        // board; it goes to the Rejected tab with its score and why. Hard
        // exclusions (renovated, multi-unit, fire, structural, too few photos)
        // are always C. The run never stops to ask.
        const q = core.qualify({
          addr: c.addr, remarks: gal.remarks, privateRemarks: gal.privateRemarks,
          condition: gal.condition, occupiedBy: gal.occupiedBy, propClass: gal.propClass,
          photos: n, photosReliable: gal.gridOk,
          dom: domOf(c), yearBuilt: c._yearBuilt || (c._age > 0 ? 2026 - c._age : ''),
          price: gal.listPrice || c._price, origPrice: gal.origPrice,
          ppsfRatio: cityMedians && cityMedians[c._cityKey] ? c._ppsf / cityMedians[c._cityKey] : 0,
          whenUnsure: cfg.whenUnsure,
        });
        if (!gal.gridOk && n) log(`  photo grid did not load — only ${n} carousel photo(s) seen, photo count not used`, 'warn');
        if (gal.privateRemarks) log(`  private remarks read (${gal.privateRemarks.length} chars)`);
        // Only A and B go to the AI: it can only move a lead DOWN, so asking
        // about a C (hard exclusion or low score) costs money and changes nothing.
        if (cfg.useAI && cfg.apiKey && aiFailStreak < 3 && !core.isConfirmed(c.addr) && !q.hard && q.bucket !== 'C') {
          // AI vision still has the final say on condition when it is on: a
          // DROP from the photos is an auto-pass whatever the text scored.
          const v = await autoDecide({ ...c, _cityKey: cityOf(c), _sqft: c._sqft, _price: c._price, _gal: gal });
          if (v.error) {
            // the text verdict stands; three failures in a row = stop asking this run
            aiFailStreak++;
            log(`  ${v.reason} — kept the text rules' verdict`, 'warn');
            if (aiFailStreak >= 3) log('AI vision failed 3 times in a row — turned off for the rest of this run. Check the key and model in section 2 (Test key).', 'error');
          } else if (v.decision !== 'keep') {
            aiFailStreak = 0;
            Object.assign(q, { bucket: 'C', label: core.BUCKET_LABEL.C, decision: 'drop',
              score: Math.min(q.score, 15), why: 'AI (vision): ' + v.reason });
          } else {
            aiFailStreak = 0;
            q.why = q.why + ' + AI (vision) keep: ' + v.reason;
          }
        }
        c._q = q;
        c._gal = { origPrice: gal.origPrice, listPrice: gal.listPrice, listedBy: gal.listedBy,
          occupiedBy: gal.occupiedBy || '', privateRemarks: gal.privateRemarks || '', status: gal.status || '',
          agentPhone: gal.agentPhone || '', agentEmail: gal.agentEmail || '', showing: gal.showing || '',
          disclosures: gal.disclosures || '',
          // No MLS field holds it — agents write it into the remarks.
          offerDue: core.offerDue([gal.privateRemarks, gal.remarks].filter(Boolean).join(' \n ')) };
        if (c._gal.offerDue) log(`  offer due: ${c._gal.offerDue}`, 'good');
        const decision = q.decision;
        const dropReason = q.decision === 'drop' ? `Auto-pass (score ${q.score}): ${q.why}` : '';
        send('review', { ...base, verdict: decision, why: `${q.label} · score ${q.score} — ${q.why}` });
        log(`  ${q.label} · score ${q.score} — ${q.why}`, decision === 'keep' ? 'good' : 'info');
        if (control.stopped) break;
        runKpi.reviewed++;
        runKpi['bucket' + q.bucket]++;
        if (decision === 'keep') {
          // For the Lead Board: the public remarks and the house's own Redfin page.
          c._remarks = gal.remarks || '';
          c._redfin = await redfinUrl(c.fullAddr || c.addr);
          log(c._redfin ? `  Redfin page: ${c._redfin}` : '  no matching Redfin page found', c._redfin ? 'good' : 'info');
          kept.push(c); runKpi.kept++; log(`  kept ${c.addr}`, 'good');
        }
        else {
          runKpi.dropped++; runKpi[dropBucket(dropReason)]++;
          log(`  dropped ${c.addr} — ${dropReason || 'no reason given'}`);
          // Record WHY, so the Rejected tab can answer "why isn't this on my list".
          cityRejects.push({
            mls: c.mls, addr: c.fullAddr || c.addr, city: cityOf(c), zip: c.zip || '',
            price: c._price, ppsf: c._ppsf, sqft: c._sqft, dom: domOf(c),
            reason: dropReason || 'dropped at photo review',
            stage: c._q && !c._q.hard && !/^AI/.test(c._q.why) ? 'Qualification gate' : 'Photo review',
            link: core.mlsUrl(c.mls),
          });
        }
        // Record as we go, not at the end — a crash or Stop mid-run must not
        // cost us the listings already judged.
        ledgerRecord(c.mls, decision === 'keep' ? 'kept' : 'dropped', { addr: c.addr, city: cityOf(c) });
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
            mls: c.mls, address: c.fullAddr || c.addr, city: cityOf(c), zip: c.zip || '',
            beds: c.bds, baths: c.baths || '', sqft: c._sqft,
            lotSqft: core.num(c.lotSqft || 0) || '',
            // The report's own year beats 2026 - Age, which reads "2026" when
            // the grid's Age column is blank.
            yearBuilt: c._yearBuilt || (c._age > 0 ? 2026 - c._age : ''),
            dom: domOf(c), price: c._price, ppsf: c._ppsf,
            arv: 0, arvBasis: 'not comped yet',
            recommendation: 'Needs Comps', flipQuality: '', score: '',
            risks: 'Condition-qualified only — ARV and profit not yet calculated',
            ...gateFields(c),
            link: core.mlsUrl(c.mls),
            // Push these: with no ARV there is no gate to clear, and the point
            // of this mode is to get the qualified list in front of you.
            surface: true, needsComps: true,
          });
        }
        log(`[${label}] comps skipped — ${cityLeads.length} condition-qualified listing(s)`, 'good');
      } else {
      send('city', { label, index: ai + 1, total: areas.length, phase: 'comping', count: kept.length });
      for (const c of kept) {
        if (await stopRequested()) break;   // save what was read, then stop
        log(`[${label}] Comping ${c.addr}…`);
        const zip = (c.zip || '').match(/9\d{4}/) ? c.zip : await js(`(() => { const m=document.body.innerText.match(/\\b(9[45]\\d{3})\\b/); return m?m[1]:''; })()`).catch(() => '');
        let comp = { arv: 0, medianPpsf: 0, band: 'n/a', n: 0 };
        try { comp = await compFor(c.mls, zip || c.zip || '', c._sqft); } catch (e) { log(`  comp failed: ${e.message}`, 'warn'); }
        const deal = core.scoreDeal({ price: c._price, sqft: c._sqft, arv: comp.arv });
        cityLeads.push({ mls: c.mls, address: c.fullAddr || c.addr, city: cityOf(c), zip, beds: c.bds, baths: c.baths || '',
          sqft: c._sqft, lotSqft: core.num(c.lotSqft || 0) || '',
          yearBuilt: c._yearBuilt || (c._age > 0 ? 2026 - c._age : ''), dom: domOf(c), price: c._price,
          arv: comp.arv, arvPpsf: comp.medianPpsf, compBand: comp.band, compN: comp.n,
          arvBasis: comp.arv ? `${comp.band} band, ${comp.n} comps @ $${comp.medianPpsf}/sf` : 'no comps found',
          link: core.mlsUrl(c.mls),
          ...deal, ...gateFields(c) });
      }
      }

      leads.push(...cityLeads);
      // Without comps there is no profit to rank by — fall back to the best
      // value signal we do have, cheapest $/sqft first.
      // A before B, then the higher Opportunity Score; profit (with comps) or
      // cheapest $/sqft (without) breaks ties.
      leads.sort((a, b) => String(a.bucket || 'Z').localeCompare(String(b.bucket || 'Z'))
        || (b.oppScore || 0) - (a.oppScore || 0)
        || (cfg.runComps ? b.grossLight - a.grossLight : (a.ppsf || Infinity) - (b.ppsf || Infinity)));
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
        }
        // Written either way: a failed API call, or a disconnected sheet, must
        // never lose a city that has already been reviewed.
        const d = writeBackup(rows, cityRejects);
        if (!d.ok) log(`[${label}] could not write the local backup: ${d.error}`, 'warn');
        // The Lead Board's copy of this city, merged into the day's file.
        if (cityWinners.length) {
          const b = writeBoardScan(cityWinners);
          if (b.ok) log(`[${label}] ${cityWinners.length} lead(s) added to today's Lead Board file`, 'good');
          else log(`[${label}] could not write the Lead Board file: ${b.error}`, 'warn');
        }
      }
      const cityA = cityLeads.filter(l => l.bucket === 'A').length;
      log(`━━━ ${label} done: ${cityA} A — Work Now · ${cityLeads.length - cityA} B — AI Review · `
        + `${cityRejects.filter(r => r.stage !== 'Buy-box filter').length} C — Auto-Pass ━━━`, 'good');
      send('city', { label, index: ai + 1, total: areas.length, phase: 'done',
        kept: kept.length, winners: cityWinners.length });
    }

    if (!leads.length) {
      log('No new qualifying listings this run.', 'good');
      send('report', { leads: [], generatedAt: new Date().toString(), noNew: true });
      return { ok: true, leads: [] };
    }
    // Leads were already written city by city above — don't re-send them here.
    log(cfg.runComps
      ? `Done. ${runKpi.gateCleared} of ${leads.length} kept leads clear the profit gate.`
      : `Done. ${leads.length} lead(s) on the board — comps are off, so no profit figures yet.`, 'good');
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
    if (started && googleReady() && googleCfg().autoSync) await rebuildBoard(day);
    // Only attempt the KPI push when a sheet is actually connected — an
    // unconfigured app must not log a failure after every single run.
    // FINISH, VISIBLY. The run used to just stop making noise — the MLS window
    // still showed the last gallery, "Now reviewing" still named a property,
    // and there was no way to tell a finished scan from a stalled one.
    // Everything now shuts down on its own and says so.
    finishRun(runKpi, day, started);
  }
});

/** Close the browser window, clear the live panels, and announce the totals. */
function finishRun(runKpi, day, started) {
  if (!started) { send('done', { neverStarted: true, summary: 'Not signed in — nothing scanned.' }); return; }
  closeMlsWindow();
  const line = control.stopped
    ? `Scan STOPPED early — ${runKpi.reviewed} reviewed, ${runKpi.kept} kept, ${runKpi.pushed} written to the sheet.`
    : `Scan COMPLETE — ${runKpi.scanned} scanned · ${runKpi.skippedAlreadyChecked} already checked (skipped) · `
      + `${runKpi.reviewed} reviewed → ${runKpi.bucketA} A — Work Now · ${runKpi.bucketB} B — AI Review · `
      + `${runKpi.bucketC} C — Auto-Pass · sheet: ${runKpi.pushed} new, ${runKpi.pushSkipped} updated.`;
  log(line, 'good');
  // Hand today's leads to the Lead Board: on the clipboard, ready to paste.
  const board = boardStatus();
  if (board.count) {
    try {
      clipboard.writeText(fs.readFileSync(board.file, 'utf8'));
      log(`Today's ${board.count} lead(s) are copied — open the Lead Board, click "Add scan", and paste.`
        + (board.offers ? ` ${board.offers} have an offer deadline.` : ''), 'good');
    } catch (e) { log('Could not copy the leads: ' + e.message + ' — use "Copy for the board".', 'warn'); }
  }
  send('board', board);
  log('Nothing else is running. Start scan again whenever you want the next pass.', 'good');
  send('done', {
    stopped: control.stopped, summary: line,
    scanned: runKpi.scanned, reviewed: runKpi.reviewed, kept: runKpi.kept,
    dropped: runKpi.dropped, pushed: runKpi.pushed,
    skipped: runKpi.skippedAlreadyChecked, day: day,
  });
}

/** The MLS window exists only to drive a scan — leaving it open after one
 *  finishes is what made a completed run look like it was still going. */
function closeMlsWindow() {
  try { if (mlsWin && !mlsWin.isDestroyed()) mlsWin.close(); } catch (_) {}
  mlsWin = null;
}

ipcMain.on('pause', () => { control.paused = true; log('Paused.', 'warn'); });
ipcMain.on('resume', () => { control.paused = false; log('Resumed.', 'good'); });
ipcMain.on('stop', () => { control.stopped = true; control.paused = false; });

// ---------- the Lead Board hand-off ----------
// One file per day, in Documents/FlipScout, holding every lead the day's runs
// kept — remarks, offer deadline, listing agent and bucket included. The Lead
// Board's "Add scan" takes this file (or the same text pasted). An artifact's
// shared data can only be written from the board page itself, which is why
// this is a paste and not a push. Field names match the board's scanLead().
const BOARD_DIR = () => path.join(app.getPath('documents'), 'FlipScout');
const BOARD_FILE = (d = todayKey()) => path.join(BOARD_DIR(), `FlipScout-scan-${d}.json`);

const boardLead = core.boardLead;

function readBoardScan(d) {
  try {
    const j = JSON.parse(fs.readFileSync(BOARD_FILE(d), 'utf8'));
    if (j && j.kind === 'flipscout-scan' && Array.isArray(j.leads)) return j;
  } catch (_) {}
  return null;
}

function writeBoardScan(leads) {
  try {
    const d = todayKey();
    const prev = readBoardScan(d);
    const by = {};
    ((prev && prev.leads) || []).forEach(l => { if (l.mls) by[l.mls] = l; });
    const before = Object.keys(by).length;
    (leads || []).map(boardLead).forEach(l => { if (l.mls) by[l.mls] = l; });
    const out = { kind: 'flipscout-scan', v: 1, app: app.getVersion(), pulled: d,
      made: new Date().toISOString(), leads: Object.keys(by).map(k => by[k]) };
    fs.mkdirSync(BOARD_DIR(), { recursive: true });
    fs.writeFileSync(BOARD_FILE(d), JSON.stringify(out, null, 1));
    return { ok: true, added: out.leads.length - before, total: out.leads.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

function boardStatus() {
  const j = readBoardScan();
  const leads = (j && j.leads) || [];
  return { file: BOARD_FILE(), exists: !!j, pulled: todayKey(), count: leads.length,
    offers: leads.filter(l => l.offerDue).length, made: (j && j.made) || '', url: cfg.boardUrl };
}

ipcMain.handle('board-status', () => boardStatus());
ipcMain.handle('board-copy', () => {
  const b = boardStatus();
  if (!b.count) return { ok: false, error: 'no leads kept today yet' };
  clipboard.writeText(fs.readFileSync(b.file, 'utf8'));
  log(`Copied today's ${b.count} lead(s) — paste them into the Lead Board with "Add scan".`, 'good');
  return { ok: true, count: b.count };
});
ipcMain.handle('board-open', () => {
  const u = String(cfg.boardUrl || '');
  if (!/^https:\/\/claude\.ai\//.test(u)) return { ok: false, error: 'the Lead Board link must start with https://claude.ai/' };
  shell.openExternal(u);
  return { ok: true };
});
ipcMain.on('board-show', () => {
  const b = boardStatus();
  try { b.exists ? shell.showItemInFolder(b.file) : shell.openPath(BOARD_DIR()); } catch (_) {}
});

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
  // Qualification gate — appended at the END so every existing row and the
  // reviewer script (which reads by header name) keep lining up.
  'Bucket', 'Opportunity Score', 'Why', 'Price Cut', 'Listing Agent',
  'Offer Due', 'Private Remarks', 'Occupied By', 'MLS Status',
  'Agent Phone', 'Agent Email', 'Showing', 'Disclosures',
];
// Read fresh off the listing on every review, so a re-review replaces them —
// an offer date goes from "TBD" to a real date, remarks get edited.
const GATE_HEADERS = ['Bucket', 'Opportunity Score', 'Why', 'Price Cut', 'Offer Due', 'Private Remarks', 'Occupied By', 'MLS Status',
  'Agent Phone', 'Agent Email', 'Showing', 'Disclosures'];
// Facts re-read by "Refresh leads on the board" — the listing's own data, never
// the reviewer's columns. Bucket / score are only filled where still blank.
const FACT_HEADERS = ['Price Cut', 'Listing Agent', 'Offer Due', 'Private Remarks', 'Occupied By', 'MLS Status',
  'Agent Phone', 'Agent Email', 'Showing', 'Disclosures'];
const REJECT_HEADERS = [
  'Rejected On', 'MLS #', 'Address',
  'Price', '$/SqFt', 'SqFt', 'DOM', 'Reason', 'Stage', 'By', 'MLS Link',
];
// The KPI tab is built entirely by the Apps Script, from the Rejected and Leads
// tabs. The app does not write it.
//
// Splitting it — app writes some columns, script writes others — looked tidy and
// produced a tab reading "Scan Rejected: 0" after a scan that had rejected
// hundreds: the app's figures were wiped when the header row was corrected, and
// nothing rewrote them until the next run. Every drop is already on the Rejected
// tab with its date and stage, so one source counts both numbers and they cannot
// disagree.

const today = () => new Date().toISOString().slice(0, 10);
const fullAddress = core.fullAddress;

/** A finished lead (already through toSheetRow) as a sheet record. */
const leadRecord = r => ({
  'Status': r.status || '', 'MLS #': r.mls, 'Address': fullAddress(r.address, r.city, r.zip),
  'Beds': r.beds, 'Baths': r.baths, 'SqFt': r.sqft, 'Lot SqFt': r.lotSqft,
  'Year Built': r.yearBuilt, 'DOM': r.dom, 'Purchase Price': r.price, '$/SqFt': r.ppsf,
  'Notes': r.notes, 'MLS Link': core.fixLink(r.link, r.mls), 'First Added': today(),
  'Bucket': r.bucket || '', 'Opportunity Score': r.oppScore != null ? r.oppScore : '',
  'Why': r.why || '', 'Price Cut': r.priceCut || '', 'Listing Agent': r.listedBy || '',
  'Offer Due': r.offerDue || '', 'Private Remarks': r.privateRemarks || '', 'Occupied By': r.occupiedBy || '',
  'MLS Status': r.mlsStatus || '',
  'Agent Phone': r.agentPhone || '', 'Agent Email': r.agentEmail || '', 'Showing': r.showing || '',
  'Disclosures': r.disclosures || '',
});

const rejectRecord = r => ({
  'Rejected On': today(), 'MLS #': r.mls,
  'Address': fullAddress(r.addr || r.address, r.city, r.zip),
  'Price': r.price, '$/SqFt': r.ppsf,
  'SqFt': r.sqft, 'DOM': r.dom, 'Reason': r.reason || '', 'Stage': r.stage || '',
  'By': 'FlipScout', 'MLS Link': core.fixLink(r.link, r.mls),
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
      ? await gsheets.syncRows(token, g.sheetId, g.leadTab, LEAD_HEADERS, 'MLS #', leads.map(leadRecord), { overwrite: GATE_HEADERS })
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

/** The qualification-gate fields carried on every lead. */
function gateFields(c) {
  const q = c._q || {}, g = c._gal || {};
  // Same list price the score used — the report's, falling back to the grid's.
  const orig = core.num(g.origPrice), list = core.num(g.listPrice) || c._price;
  return {
    bucket: q.bucket || '', bucketLabel: q.label || '', oppScore: q.score != null ? q.score : '',
    why: q.why || '', listedBy: g.listedBy || '',
    offerDue: g.offerDue || '', privateRemarks: g.privateRemarks || '', occupiedBy: g.occupiedBy || '',
    mlsStatus: g.status || '',
    agentPhone: g.agentPhone || '', agentEmail: g.agentEmail || '', showing: g.showing || '',
    disclosures: g.disclosures || '',
    remarks: c._remarks || '', redfin: c._redfin || '',
    priceCut: orig > list ? `-$${Math.round((orig - list) / 1000)}k (${Math.round(100 * (orig - list) / orig)}%)` : '',
  };
}

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
    bucket: l.bucketLabel || '', oppScore: l.oppScore, why: l.why || '',
    priceCut: l.priceCut || '', listedBy: l.listedBy || '',
    offerDue: l.offerDue || '', privateRemarks: l.privateRemarks || '', occupiedBy: l.occupiedBy || '',
    mlsStatus: l.mlsStatus || '',
    agentPhone: l.agentPhone || '', agentEmail: l.agentEmail || '', showing: l.showing || '',
    disclosures: l.disclosures || '',
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
      // Leads already on the board are not re-reviewed by a scan either — that
      // was 15 of 16 listings on the first test run, re-reviewed for nothing.
      // "Refresh leads on the board" is what keeps their facts current.
      const lcol = gsheets.colName(LEAD_HEADERS.indexOf('MLS #'));
      const onBoard = info.tabs.indexOf(g.leadTab) < 0 ? []
        : await gsheets.readCol(token, g.sheetId, g.leadTab, `${lcol}2:${lcol}`);
      const seen2 = loadLedger();
      const freshBoard = onBoard.filter(m => m && !seen2[String(m).trim().toUpperCase()]);
      if (freshBoard.length) {
        ledgerRecordMany(freshBoard.map(m => ({ mls: m, verdict: 'on-board' })));
        log(`Leads already on the sheet: ${freshBoard.length} (skipped by scans — use "Refresh leads on the board").`);
      }
      return { ok: true, total: ids.length, added: fresh.length, onBoard: freshBoard.length };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, unconfigured: true, error: 'connect your Google Sheet in section 7 first' };
}


// ---------- the Board tab ----------
// One tab that says what to work on: today's funnel on top, then the live A /
// B leads in work order (soonest offer deadline first). Rebuilt from the Leads
// tab after every scan and every refresh — nothing on it is typed by hand.
const BOARD_TAB = 'Board';
async function rebuildBoard(day) {
  if (!googleReady()) return { ok: false, unconfigured: true };
  try {
    const g = googleCfg();
    const token = await googleToken();
    const rows = await gsheets.readAll(token, g.sheetId, g.leadTab);
    const today = day || Object.assign(blankKpi(), loadKpi()[todayKey()] || {});
    const board = core.buildBoard(rows, today, new Date());
    await gsheets.replaceTab(token, g.sheetId, BOARD_TAB, board);
    const listed = Math.max(0, board.length - 9);
    log(`Board updated — ${listed} lead(s) in work order.`, 'good');
    return { ok: true, listed };
  } catch (e) {
    log('Board update failed: ' + e.message, 'warn');
    return { ok: false, error: e.message };
  }
}
ipcMain.handle('board-rebuild', () => rebuildBoard());

// ---------- refresh the leads already on the board ----------
// A lead is only reviewed once, but its facts move: "Offer Date TBD" becomes a
// date, the price gets cut, the listing goes pending. This re-reads JUST the
// leads on the Leads tab (not the passed ones) — reports only, no photos — and
// updates the listing's own columns. Notes and anything typed by hand are
// never touched. Rows that were never scored get a bucket and score too.
ipcMain.handle('refresh-board', async () => {
  if (control.running) return { ok: false, error: 'a scan is already running' };
  if (!googleReady()) return { ok: false, error: 'connect your Google Sheet in section 7 first' };
  control.running = true; control.stopped = false; control.paused = false;
  let done = 0, notFound = 0, scored = 0, flagged = 0, started = false;
  try {
    if (!mlsWin || mlsWin.isDestroyed()) { ensureMlsWindow(); await nav(core.SEARCH_URL, 3000); }
    const title = await js(core.JS_TITLE).catch(() => '');
    if (!/Dashboard|Matrix/i.test(title)) { log('Not logged in — sign in first.', 'error'); return { ok: false, error: 'not signed in' }; }
    started = true;
    const g = googleCfg();
    const token = await googleToken();
    const rows = await gsheets.readAll(token, g.sheetId, g.leadTab);
    const head = (rows[0] || []).map(h => String(h).trim());
    const val = (r, h) => { const i = head.indexOf(h); return i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); };
    // Newest first (rows are appended, so later rows are newer; First Added
    // breaks ties), and closed listings are skipped — a sold house has
    // nothing left to refresh, and re-reading hundreds of them took hours.
    const all = rows.slice(1).map((r, i) => ({ r, i })).filter(x => val(x.r, 'MLS #'));
    const passedN = all.filter(x => core.PASSED_NOTE.test(val(x.r, 'Notes'))).length;
    const closedN = all.filter(x => !core.PASSED_NOTE.test(val(x.r, 'Notes')) && core.CLOSED_STATUS.test(val(x.r, 'MLS Status'))).length;
    // A leads first, then B, then anything not scored yet — so the leads Juan
    // works are current within minutes. Inside a bucket, newest row first.
    // (Sorting on First Added alone put the day's SF leads at #59: every row
    // carried the same Aug 1 date.) C leads are auto-passed; skip them.
    const rankOf = r => ({ A: 0, B: 1 })[(val(r, 'Bucket').match(/^[ABC]/) || ['?'])[0]] ?? 2;
    const todo = all
      .filter(x => !core.PASSED_NOTE.test(val(x.r, 'Notes')) && !core.CLOSED_STATUS.test(val(x.r, 'MLS Status'))
        && !/^C/.test(val(x.r, 'Bucket')))
      .sort((a, b) => rankOf(a.r) - rankOf(b.r) || b.i - a.i)
      .map(x => x.r);
    log(`Refreshing ${todo.length} lead(s), A first then B (reports only, no photos) — `
      + `skipping ${closedN} closed and ${passedN} passed in Notes…`, 'good');

    let batch = [];
    // Old broken Portal.aspx links on the rows we are NOT re-reading (closed,
    // passed) are fixed in the same write — no MLS lookup needed for that.
    const skipped = all.map(x => x.r).filter(r => todo.indexOf(r) < 0 && /Portal\.aspx/i.test(val(r, 'MLS Link')));
    const flush = async () => {
      if (!batch.length) return;
      await gsheets.syncRows(await googleToken(), g.sheetId, g.leadTab, LEAD_HEADERS, 'MLS #', batch,
        { overwrite: [...FACT_HEADERS, 'Bucket', 'Opportunity Score', 'Why', 'MLS Link'] });
      batch = [];
    };
    if (skipped.length) {
      for (const r of skipped) batch.push({ 'MLS #': val(r, 'MLS #'), 'MLS Link': core.mlsUrl(val(r, 'MLS #')) });
      await flush();
      log(`  fixed ${skipped.length} old MLS link(s) on closed / passed rows`);
    }
    for (let i = 0; i < todo.length; i++) {
      if (await stopRequested()) break;   // flush + Board rebuild below still run
      const r = todo[i], mls = val(r, 'MLS #');
      log(`  [${i + 1}/${todo.length}] ${val(r, 'Address') || mls}`);
      const gal = await showGallery(mls, { factsOnly: true }).catch(() => ({ mismatch: true }));
      if (gal.mismatch) {
        // Either it left the Active search (pending / sold / withdrawn) or
        // Matrix showed another listing. Say so; never guess.
        notFound++;
        batch.push({ 'MLS #': mls, 'MLS Status': 'Not found in Active search — check' });
        log('    not found in an Active search — may be pending or off market', 'warn');
      } else {
        const list = core.num(gal.listPrice) || core.num(val(r, 'Purchase Price'));
        const orig = core.num(gal.origPrice);
        const offer = core.offerDue([gal.privateRemarks, gal.remarks].filter(Boolean).join(' \n '));
        const rec = {
          'MLS #': mls,
          'Price Cut': orig > list && list ? `-$${Math.round((orig - list) / 1000)}k (${Math.round(100 * (orig - list) / orig)}%)` : '',
          'Listing Agent': gal.listedBy || '', 'Offer Due': offer,
          'Private Remarks': gal.privateRemarks || '', 'Occupied By': gal.occupiedBy || '',
          'MLS Status': gal.status || '',
          'MLS Link': core.mlsUrl(mls),
          'Agent Phone': gal.agentPhone || '', 'Agent Email': gal.agentEmail || '',
          'Showing': gal.showing || '', 'Disclosures': gal.disclosures || '',
        };
        // Red flags in the remarks move a lead that was already scored to
        // C — a private remark like "this is not a cosmetic remodel" or
        // "plans approved by the City" is exactly what the quick-flip rule
        // excludes, and it used to stay on the Board because only unscored
        // rows were looked at. Only ever DOWN: a refresh never upgrades.
        const hard = val(r, 'Bucket') && !/^C/.test(val(r, 'Bucket')) && !core.isConfirmed(gal.address || val(r, 'Address'))
          ? core.rulesDecide({ addr: gal.address || val(r, 'Address'), photos: 0,
              remarks: [gal.remarks, gal.privateRemarks].filter(Boolean).join(' '),
              condition: gal.condition, propClass: gal.propClass })
          : null;
        if (hard && hard.decision === 'drop') {
          Object.assign(rec, { 'Bucket': core.BUCKET_LABEL.C, 'Opportunity Score': 15,
            'Why': hard.reason + ' (found on refresh)' });
          flagged++;
        } else if (!val(r, 'Bucket')) {
          // Never scored (an older row). No area medians or photos on a refresh,
          // so the score leaves those out and says so.
          const q = core.qualify({
            addr: gal.address || val(r, 'Address'), remarks: gal.remarks, privateRemarks: gal.privateRemarks,
            condition: gal.condition, occupiedBy: gal.occupiedBy, propClass: gal.propClass, photos: 0,
            dom: val(r, 'DOM'), yearBuilt: gal.yearBuilt || val(r, 'Year Built'),
            price: list, origPrice: gal.origPrice, whenUnsure: cfg.whenUnsure,
          });
          Object.assign(rec, { 'Bucket': q.label, 'Opportunity Score': q.score,
            'Why': q.why + ' (scored on refresh — no $/sqft or photo check)' });
          scored++;
        }
        batch.push(rec);
        done++;
        log(`    ${gal.status || 'status ?'}${offer ? ' · offer due ' + offer : ''}${rec.Bucket ? ' · ' + rec.Bucket + ' ' + rec['Opportunity Score'] : ''}`
          + `${gal.agentPhone ? ' · ' + gal.agentPhone : ''}${hard && hard.decision === 'drop' ? ' · RED FLAG: ' + hard.reason : ''}`,
          offer ? 'good' : 'info');
      }
      if (batch.length >= 10) await flush();   // a Stop mid-way keeps what was read
    }
    await flush();
    await rebuildBoard();
    const line = `Refresh ${control.stopped ? 'STOPPED early' : 'COMPLETE'} — ${done} updated · ${scored} scored for the first time · `
      + `${flagged} moved to C by a red flag · ${notFound} not found in an Active search.`;
    log(line, 'good');
    return { ok: true, done, scored, notFound };
  } catch (e) {
    if (e.message === 'stopped') { log('Refresh stopped.', 'warn'); return { ok: false, stopped: true }; }
    log('Refresh error: ' + e.message, 'error');
    return { ok: false, error: e.message };
  } finally {
    control.running = false;
    if (started) closeMlsWindow();
    send('done', { stopped: control.stopped, summary: `Refresh finished — ${done} updated, ${notFound} not found.` });
  }
});

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
  // The gate's columns lead: they are what decides which rows to work first.
  const cols = ['bucketLabel', 'oppScore', 'offerDue', 'agentPhone', 'agentEmail', 'showing', 'disclosures', 'why', 'priceCut', 'listedBy', 'occupiedBy', 'privateRemarks', 'score', 'recommendation', 'flipQuality', 'mls', 'address', 'city', 'zip', 'beds', 'sqft', 'yearBuilt', 'dom', 'price', 'arv', 'rehabLight', 'rehabHeavy', 'holding', 'totalLight', 'grossLight', 'grossHeavy', 'recommendedMaxOffer', 'arvBasis'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [cols.join(',')].concat(leads.map(l => cols.map(c => esc(l[c])).join(','))).join('\n');
  fs.writeFileSync(filePath, csv);
  return { ok: true, filePath };
});

app.whenReady().then(createControlWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createControlWindow(); });
