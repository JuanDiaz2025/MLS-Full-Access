/**
 * FlipScout Desktop — Electron main process.
 *
 * Two windows: a Control panel (buttons/progress/report) and a visible MLS
 * browser window that the app drives. Login happens in the visible window so
 * you can complete 2FA/SSO yourself; the app auto-fills what it can and then
 * detects the dashboard. Scanning navigates the MLS window through Matrix and
 * runs the same extraction used by the headless pipeline.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, net, nativeImage } = require('electron');
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
  comingSoon: true,    // also scan Coming Soon listings (section 3 checkbox)
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

// ---------- re-review a past scan (v1.46) ----------
// The MLS #s a "Re-review a past scan" freed up: the next scan re-judges them,
// including the ones already on the Leads tab (re-scored in place, never
// re-added). Cleared one by one as the sheet takes each new verdict.
const REREVIEW_FILE = () => path.join(app.getPath('userData'), 'rereview.json');
function loadRereview() {
  try { const j = JSON.parse(fs.readFileSync(REREVIEW_FILE(), 'utf8')); return { date: j.date || '', mls: j.mls || {} }; }
  catch (_) { return { date: '', mls: {} }; }
}
function saveRereview(r) {
  try { fs.mkdirSync(path.dirname(REREVIEW_FILE()), { recursive: true }); fs.writeFileSync(REREVIEW_FILE(), JSON.stringify(r, null, 1)); }
  catch (e) { log('Could not save the re-review list: ' + e.message, 'warn'); }
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
// In-page helper: make a multi-select hold EXACTLY the options whose text
// matches one of `patterns` (regex sources), and fire change. Returns the
// texts it selected, so the caller can say plainly when the MLS has no such
// status rather than silently searching the wrong one.
const selectOnly = (sel, patterns) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); if(!el) return null;
  const res = ${JSON.stringify(patterns)}.map(p => new RegExp(p, 'i'));
  const got = [];
  [...el.options].forEach(o => { const on = res.some(r => r.test(o.text.trim())); o.selected = on; if (on) got.push(o.text.trim()); });
  el.dispatchEvent(new Event('change',{bubbles:true}));
  return got;
})()`;
const STATUS_ACTIVE = '^active$';
const STATUS_COMING_SOON = '^coming[\\s-]*soon';
// Picked up by the not-on-the-market pass when the form offers it; skipped
// silently when it doesn't (selectOnly only ticks options that exist).
const STATUS_PRIVATE = '^(?:private|office[\\s-]*exclusive)';
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
// opts.comingSoon: search Coming Soon listings instead of Active. They are
// not on the open market yet, so they can have no List Date — that pass skips
// the List Date window (Coming Soon volume is small, a county is a few pages).
async function scanArea(area, opts) {
  const comingSoon = !!(opts && opts.comingSoon);
  const label = area.city && area.city !== '*' ? area.city : `All ${area.county}`;
  await waitIfPaused();
  log(comingSoon ? `Scanning ${label} — Coming Soon (@ $${area.maxk}k)…` : `Scanning ${label} (@ $${area.maxk}k)…`);
  await nav(core.SEARCH_URL, 2500);
  if (comingSoon) {
    const got = await js(selectOnly(core.FIELDS.status, [STATUS_COMING_SOON, STATUS_PRIVATE])).catch(() => null);
    if (!got || !got.length) {
      log(`  ⚠ the MLS search has no "Coming Soon" status to pick — Coming Soon not scanned in ${label}`, 'warn');
      return { city: label, county: area.county, count: '0', rows: [], comingSoonMissing: true };
    }
    log(`  statuses searched: ${got.join(', ')}`);
  } else {
    await js(selectByLabel(core.FIELDS.status, 'Active'));
  }
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
  if (!comingSoon) await js(setInput(core.FIELDS.listDate, `${fmt(from)}-${fmt(to)}`));
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
    log(`  ⚠ ${label}: the MLS showed ${count} matches but no rows could be read — the results page is not the grid the app knows.`, 'error');
    // Keep the evidence: what the page was, and a picture of it.
    try {
      const dir = path.join(app.getPath('userData'), 'grid-debug');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.join(dir, label.replace(/[^a-z0-9]+/gi, '-') + '-' + Date.now());
      const dbg = await js(core.JS_GRID_DEBUG).catch(e => ({ error: String(e) }));
      fs.writeFileSync(base + '.json', JSON.stringify(dbg, null, 2));
      if (mlsWin && !mlsWin.isDestroyed()) {
        const img = await mlsWin.webContents.capturePage();
        fs.writeFileSync(base + '.png', img.toPNG());
      }
      log(`  Saved what the page showed to ${base}.json and .png — send both to Claude.`, 'warn');
    } catch (e) { log('  (could not save the page: ' + e.message + ')', 'warn'); }
  }
  if (comingSoon) all.forEach(r => { r._comingSoon = true; });
  return { city: label, county: area.county, count, rows: all };
}

// ---------- open a single MLS# and render its full photo gallery in the MLS window ----------
// opts.factsOnly: read the reports (remarks, offer date, price, status) and
// skip the photo grid and the dwell — what "Refresh leads on the board" needs.
async function showGallery(mls, opts) {
  const factsOnly = !!(opts && opts.factsOnly);
  await nav(core.SEARCH_URL, 2200);
  // Look the MLS # up among Active AND Coming Soon listings. The form's
  // default status is Active, so a Coming Soon house came back "not found" —
  // at review and again on every board refresh.
  await js(selectOnly(core.FIELDS.status, [STATUS_ACTIVE, STATUS_COMING_SOON, STATUS_PRIVATE])).catch(() => null);
  await sleep(300);
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
async function readWholePage(run = js) {
  const pause = Math.max(150, Number(cfg.scrollPauseMs != null ? cfg.scrollPauseMs : 700));
  await run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const panels = [document.scrollingElement || document.documentElement]
      .concat([...document.querySelectorAll('div, main, section')]
        .filter(el => el.clientHeight > 250 && el.scrollHeight > el.clientHeight + 80
          && /(auto|scroll)/.test(getComputedStyle(el).overflowY))
        .sort((a, b) => b.scrollHeight - a.scrollHeight).slice(0, 2));
    for (const el of panels) {
      const step = Math.max(200, Math.round((el === panels[0] ? innerHeight : el.clientHeight) * 0.8));
      // At most 40 screens: a page that loads more as it is scrolled would
      // otherwise keep this going for ever.
      for (let y = 0, n = 0; y <= el.scrollHeight && n < 40; y += step, n++) { el.scrollTop = y; await wait(${pause}); }
      el.scrollTop = el.scrollHeight; await wait(${pause});
    }
    for (const el of panels) el.scrollTop = 0;
    return true;
  })()`, 120000).catch(() => false);
  return await run('document.body.innerText').catch(() => '');
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
  // Private remarks too: the needs-work words on Seth's 28 Sep approvals
  // ("Fixer", "Great bones--cosmetic remodel", "sold as-is") were agent-only.
  const remarks = [gal && gal.remarks, gal && gal.privateRemarks].filter(Boolean).join(' / ').slice(0, 1200);
  return `You are screening a real-estate listing for a house-FLIPPING buy box.

Listing: ${c.addr}, ${c._cityKey} — ${c._sqft} sqft, $${c._price.toLocaleString()}.
You have been given ${photoCount} SEPARATE photos of this listing (every photo the MLS has, up to 20).
${remarks ? `Agent remarks: "${remarks}"` : 'No agent remarks available.'}

Work through the photos ONE BY ONE before answering. For each, note what room it is
and the state of the finishes. Pay closest attention to the KITCHEN and BATHROOMS —
that is where renovation shows first, and a listing is often photographed to hide it.
Do not answer from the exterior shots alone.

KEEP GENUINE value-add fixers that LOOK LIKE THEY NEED WORK: worn/distressed/neglected interiors, estate/probate look, old kitchens/baths in poor shape, worn or damaged flooring, needs cosmetic-to-heavy work.

ONE UPDATED SURFACE IS NOT A FLIP. An older house where ONE thing was redone (granite on old cabinets, one remodeled bathroom, a new water heater) while the rest is original — dated kitchen, other baths original, old carpet or flooring — is a KEEP: a flipper still has a full job there. DROP for renovation only when the house as a whole has been flipped: the kitchen is new end to end (cabinets AND counters AND appliances) and the bathrooms are redone, or new finishes run throughout.

Occupants, furniture and belongings are not finishes: judge the house, not who lives in it (occupancy is handled by other rules).

TWO questions decide it:
1. HAS WORK BEEN DONE TO THIS HOUSE? Judge the FINISHES, not the staging — furniture and a fresh stage do not make a house renovated.
2. DOES IT LOOK LIKE IT NEEDS WORK NOW? The buyer takes AS-IS houses that visibly need renovation. KEEP only when the photos show wear, neglect or damage: missing or broken cabinet doors, chipped or damaged counters, patched, stained or scuffed walls, torn, worn or stained flooring, grimy or cracked tile, tired original bathrooms, a house left dirty or in disrepair. Remarks saying as-is, deferred maintenance, needs TLC/work also count.
OLD STYLE IS NOT THE SAME AS ORIGINAL. Judge the ERA of the finishes, not whether they look fashionable today.
- ORIGINAL (what the buyer wants): finishes from the 1950s-1980s — wall-to-wall or shag carpet, sheet vinyl / linoleum floors, wood-panelled walls, dark 1960s-70s wood or painted cabinets with laminate or tile counters, popcorn/textured ceilings, pink/yellow/green tile baths, heavy drapes.
- A PRIOR UPDATE (work already done — the buyer does NOT want it, even though it looks dated now): a 1995-2015 refresh — cherry, maple or light-oak cabinets WITH granite or solid-surface counters, stainless appliances, laminate / engineered / "Brazilian cherry" / LVP floors, glossy large tile, recessed lights, white shaker cabinets. A 2005 cherry-and-granite kitchen is "old style", but someone already renovated it: that is a DROP, reason "prior update (2000s finishes)".
Seth's check (28 Sep): every house he approved had ORIGINAL 1950s-80s finishes worn or dirty (stained carpet, shag, linoleum, panelling) or a stripped/damaged interior; the ones he rejected had cherry/maple + granite + stainless + laminate that the reviewer had called "dated".

A house that is DATED BUT IN GOOD REPAIR — old oak or painted cabinets and tile counters, but tidy, intact and livable as it stands — is a DROP, reason "dated but in good condition". Dated is not enough; it has to look like it needs work. When torn between "worn" and "dated but fine", choose KEEP and say so in the reason.

DROP if ANY of:
- Renovated / remodeled / updated / refreshed / turnkey: new or refaced cabinets, quartz/granite counters, new stainless appliances, redone bathrooms (new tile/vanity/fixtures), new flooring throughout, recessed lighting, modern tile backsplash, luxury vinyl plank, fresh designer finishes. Actual work done = DROP.
- Dated but in good repair (see question 2): original finishes that are tidy, intact and livable as-is = DROP.
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
 "era":"original"|"prior-update"|"new" — the era of the kitchen and bath finishes (original = 1950s-80s; prior-update = a 1995-2015 refresh such as granite + stainless + laminate; new = a recent flip),
 "wear":"heavy"|"some"|"none" — wear, neglect or damage you actually SAW (missing/broken doors, chipped counters, stained/torn floors, patched or scuffed walls, grime, cracked tile). Old-fashioned is NOT wear: tidy oak cabinets, tile counters or a 1970s bath in good repair = "none",
 "damage":"<the specific wear/damage items you saw, or 'none'>",
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
    const photos = gal.b64 || await collectPhotos(gal.urls, 20);
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
    // The model's KEEP is not taken on trust: with no wear seen and no
    // needs-work wording in the remarks, it is "dated but in good condition".
    const av = core.aiVerdict(o, [gal.remarks, gal.privateRemarks].filter(Boolean).join(' '));
    const decision = av.decision;
    // Surface what it actually saw, so a wrong call is diagnosable from the log
    // instead of being a bare verdict.
    const seen = [o.wear && ('wear: ' + o.wear + (o.damage && !/^none/i.test(o.damage) ? ' (' + o.damage + ')' : '')),
      o.kitchen && ('kitchen: ' + o.kitchen), o.bathroom && ('bath: ' + o.bathroom),
      o.quickFlip && ('rehab: ' + o.quickFlip)].filter(Boolean).join(' | ');
    const reason = [av.why, (o.reason || text || '').trim(), seen].filter(Boolean).join(' — ');
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
    // Seth, 1 Oct: a 204-lead East Bay scan ran with the photo check off (1 of
    // 204 had an AI verdict) and refurbished houses with "as-is" boilerplate
    // landed in A. Say it loudly at the start, not silently.
    if (!(cfg.useAI && cfg.apiKey)) {
      log('⚠ AI PHOTO CHECK IS OFF — no API key / "Use AI" not ticked in section 2. Leads will be judged on the remarks only, so refurbished houses WILL get through. Stop now and add the key unless that is intended.', 'error');
    }

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
      // Coming Soon: a second, small search per area. Same buy box, same
      // review; the rows are tagged so the rest of the run knows.
      if (cfg.comingSoon !== false && !control.stopped) {
        const cs = await scanArea(area, { comingSoon: true });
        const have = new Set(scanned.rows.map(r => r.mls));
        const add = cs.rows.filter(r => r.mls && !have.has(r.mls));
        scanned.rows = scanned.rows.concat(add);
        runKpi.comingSoon = (runKpi.comingSoon || 0) + add.length;
        if (!cs.comingSoonMissing) log(`  ${label}: ${add.length} Coming Soon listing(s) added to the scan`, add.length ? 'good' : 'info');
      }
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
          comingSoon: !!c._comingSoon || core.isComingSoon(gal.status),
        });
        c._comingSoon = !!c._comingSoon || core.isComingSoon(gal.status);
        if (c._comingSoon) log('  Coming Soon listing — not on the open market yet', 'good');
        if (core.isPrivateListing(gal.status) || core.isPrivateListing(gal.privateRemarks) || core.isPrivateListing(gal.remarks))
          log('  Private Listing — office exclusive, not on the open market', 'good');
        if (!gal.gridOk && n) log(`  photo grid did not load — only ${n} carousel photo(s) seen, photo count not used`, 'warn');
        if (gal.privateRemarks) log(`  private remarks read (${gal.privateRemarks.length} chars)`);
        // Only A and B go to the AI: it can only move a lead DOWN, so asking
        // about a C (hard exclusion or low score) costs money and changes nothing.
        // A Coming Soon listing with only its first few photos posted cannot be
        // judged from the pictures yet — the AI would drop it as "insufficient
        // photos". It stays as the text scored it, and says why.
        const csTooFew = c._comingSoon && n > 0 && n <= 4;
        if (csTooFew) q.why += ' + AI photo check waits for the photos to post';
        if (cfg.useAI && cfg.apiKey && aiFailStreak < 3 && !core.isConfirmed(c.addr) && !q.hard && q.bucket !== 'C' && !csTooFew) {
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
            score: c._q ? c._q.score : '', why: c._q ? c._q.why : '',
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

// ---------- Redfin: Coming Soon / Early Access (v1.50) ----------
// No MLS sign-in. A visible Redfin window is driven from this computer (Redfin
// refuses cloud servers, so this only ever runs here). For each ticked county:
// Redfin's location lookup gives the county page, the search (houses under the
// area's cap, newest first) is paged through, and only cards whose badge says
// Coming Soon / Early Access / private exclusive are kept. Each one's own page
// is read slowly, then judged by the same rules as an MLS listing — renovated
// still drops (Rule #0) — and its photos go to the AI check when it is on.
let rfWin = null;
function ensureRedfinWindow() {
  if (rfWin && !rfWin.isDestroyed()) return rfWin;
  rfWin = new BrowserWindow({ width: 1280, height: 900, show: true, title: 'Redfin — FlipScout',
    webPreferences: { partition: 'persist:redfin' } });
  rfWin.on('closed', () => { rfWin = null; });
  return rfWin;
}
// Every wait on the Redfin window has a time limit. Without one, a request
// Redfin holds open, or a page that redirects while a snippet is running, left
// executeJavaScript waiting for ever — the "search that never stops" (2 Oct).
const timeLimit = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' timed out')), ms))]);
const rfJs = (code, ms = 30000) => timeLimit(ensureRedfinWindow().webContents.executeJavaScript(code, true), ms, 'Redfin page');
async function rfNav(url, settle = 3500) {
  await timeLimit(ensureRedfinWindow().loadURL(url), 30000, 'Redfin page load').catch(() => {});
  await sleep(settle);
}
// What each Redfin data call returned, for checking a run that finds nothing.
let rfDiag = [];
const rfDiagNote = line => { rfDiag.push(new Date().toISOString().slice(11, 19) + ' ' + line); };
/** fetch() inside the Redfin page (its own cookies), given up after 20 s. */
async function rfFetch(url) {
  const r = await rfJs(`(async () => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
    try { const r = await fetch(${JSON.stringify(url)}, { credentials: 'include', signal: ac.signal });
      return { status: r.status, body: await r.text() }; }
    catch (e) { return { status: 0, body: String(e && e.message || e) }; }
    finally { clearTimeout(t); }
  })()`, 25000).catch(e => ({ status: 0, body: e.message }));
  rfDiagNote(`${r.status} ${url}\n    ${String(r.body || '').slice(0, 300).replace(/\s+/g, ' ')}`);
  return r;
}

// Every search card on the page: the box around each /home/<id> link.
const JS_REDFIN_CARDS = `(() => {
  const out = [], seen = new Set();
  document.querySelectorAll('a[href*="/home/"]').forEach(a => {
    const href = a.href.split(/[?#]/)[0];
    if (!/\\/home\\/\\d+$/.test(href) || seen.has(href)) return;
    // Widen to the whole card (photo + badge + facts): the largest box that
    // still holds links to this one home only.
    let el = a;
    const only = node => new Set([...node.querySelectorAll('a[href*="/home/"]')].map(x => x.href.split(/[?#]/)[0])).size <= 1;
    while (el.parentElement && el.parentElement !== document.body && only(el.parentElement)) el = el.parentElement;
    seen.add(href);
    out.push({ href, text: (el.innerText || '').slice(0, 800) });
  });
  return out;
})()`;

// The listing agent's block on a Redfin home page ("Listed by …"), read the
// way a person would: open the "Show more" toggles, scroll the block into view,
// pause, then take its text and its tel:/mailto: links. Only that block — the
// "Contact agent" card at the top is Redfin's own agent, never the listing
// agent, and its buttons are never clicked.
const JS_REDFIN_AGENT = pause => `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const SAFE = /^(show more|see more|read more|show all|see all|more agent info|show (?:agent|contact|phone)[\\w ]*|view (?:agent|contact)[\\w ]*)$/i;
  const BAD = /contact agent|request|tour|ask a question|schedule|message|start an offer|get pre/i;
  for (const b of [...document.querySelectorAll('button, a[role="button"], span[role="button"]')]) {
    const t = (b.innerText || '').trim();
    if (t.length < 40 && SAFE.test(t) && !BAD.test(t)) { try { b.click(); await wait(300); } catch (_) {} }
  }
  const all = [...document.querySelectorAll('div, section, p, span')];
  const hit = all.filter(el => /\\b(listed by|listing agent|listing provided courtesy of|listing courtesy of)\\b/i.test(el.innerText || '')
      && (el.innerText || '').length < 1500)
    .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
  if (!hit) return { text: '', tels: [], mails: [] };
  hit.scrollIntoView({ block: 'center' }); await wait(${Math.max(600, pause * 2)});
  // Widen from the "Listed by" line to its block — never so far that it takes
  // in the "Contact agent" card or the rest of the page.
  let box = hit;
  for (let i = 0; i < 4; i++) {
    const up = box.parentElement;
    if (!up || up === document.body || (up.innerText || '').length > 1500 || BAD.test(up.innerText || '')) break;
    box = up;
  }
  const links = sel => [...box.querySelectorAll(sel)].map(a => a.getAttribute('href') || '');
  return { text: (box.innerText || '').slice(0, 1500),
    tels: links('a[href^="tel:"]').map(h => h.slice(4)),
    mails: links('a[href^="mailto:"]').map(h => h.slice(7).split('?')[0]) };
})()`;

/** Photos for the AI without going through a page: fetched here and shrunk
 *  with nativeImage, so a CDN's CORS rules cannot stop it. */
async function collectPhotosDirect(urls, max) {
  const out = [];
  for (const u of spreadPhotos(urls, max || 20)) {
    try {
      const r = await net.fetch(u);
      if (!r.ok) continue;
      let img = nativeImage.createFromBuffer(Buffer.from(await r.arrayBuffer()));
      if (img.isEmpty()) continue;
      const { width, height } = img.getSize();
      if (Math.max(width, height) > 768) img = img.resize(width >= height ? { width: 768 } : { height: 768 });
      const b = img.toJPEG(72).toString('base64');
      if (b.length > 2000) out.push(b);
    } catch (_) { /* one bad photo must not sink the listing */ }
  }
  return out;
}

/** Open the home's photo viewer and step through EVERY photo with the arrow
 *  key, pausing on each, so each one actually loads (Rule #2 — never judge
 *  from the cover). Returns every photo URL the page showed along the way. */
async function viewRedfinPhotos(pause) {
  const wc = ensureRedfinWindow().webContents;
  const grab = () => rfJs(`[...document.images].map(i => i.currentSrc || i.src).filter(u => /cdn-redfin\\.com\\/photo\\//.test(u))`).catch(() => []);
  await rfJs('window.scrollTo(0, 0)').catch(() => {});
  const opened = await rfJs(`(() => {
    const imgs = [...document.images].filter(i => /cdn-redfin\\.com\\/photo\\//.test(i.currentSrc || i.src));
    const big = imgs.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    if (!big) return false;
    (big.closest('button, a, [role="button"]') || big).click();
    return true;
  })()`).catch(() => false);
  if (!opened) return await grab();
  await sleep(2000);
  const all = new Set(await grab());
  let still = 0;
  for (let n = 0; n < 80 && still < 3; n++) {
    if (control.stopped) break;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await sleep(Math.max(500, pause));
    const before = all.size;
    (await grab()).forEach(u => all.add(u));
    still = all.size === before ? still + 1 : 0;
  }
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(500);
  return [...all];
}

// Early Access homes are shown in full only to signed-in Redfin users. The
// Redfin window keeps its own cookies (persist:redfin), so one sign-in lasts.
ipcMain.handle('redfin-signin', async () => {
  const w = ensureRedfinWindow();
  await w.loadURL('https://www.redfin.com/login').catch(() => {});
  w.show(); w.focus();
  log('Redfin window opened — sign in there (optional; it lets the scan see Early Access homes). Then press 🏠 Scan Redfin.', 'good');
  return { ok: true };
});

async function redfinCounty(county) {
  const r = await rfFetch('/stingray/do/location-autocomplete?v=2&al=1&location=' + encodeURIComponent(county + ' County, CA'));
  return core.redfinCountyPath(r.body, county);
}

ipcMain.handle('redfin-scan', async (_e, opts) => {
  if (control.running) return { ok: false, error: 'already running' };
  const picked = opts && Array.isArray(opts.areaIndexes) ? opts.areaIndexes : null;
  const areas = (picked ? picked.map(i => core.DEFAULT_BUYBOX[i]) : core.DEFAULT_BUYBOX).filter(Boolean);
  if (!areas.length) { log('No areas selected — tick at least one in section 3.', 'warn'); return { ok: false }; }
  control.running = true; control.stopped = false; control.paused = false;
  aiFailStreak = 0;
  const runKpi = Object.assign(blankKpi(), { runs: 1 });
  const MAX_PAGES = 25;
  let found = 0;
  try {
    rfDiag = [];
    log('━━━ Redfin — Coming Soon & Early Access (no MLS sign-in) ━━━', 'good');
    if (!(cfg.useAI && cfg.apiKey)) log('⚠ AI PHOTO CHECK IS OFF — every photo will be opened and looked through, but nothing judges them. Add the key in section 2 and tick "Use AI" to have renovated houses dropped from the photos.', 'error');
    await rfNav('https://www.redfin.com/', 4000);
    // The ledger knows every MLS # the MLS scans have checked; Redfin shows the
    // same numbers, sometimes without the board's prefix — match on digits too.
    const seen = loadLedger();
    const seenDigits = new Set(Object.keys(seen).map(k => k.replace(/\D/g, '')).filter(d => d.length >= 6));
    const isSeen = id => !!id && (seen[id] || seenDigits.has(id.replace(/\D/g, '')));
    for (let ai = 0; ai < areas.length; ai++) {
      if (await stopRequested()) break;
      const area = areas[ai];
      const label = `All ${area.county}`;
      send('city', { label: 'Redfin · ' + label, index: ai + 1, total: areas.length, phase: 'scanning' });
      const cpath = await redfinCounty(area.county);
      if (!cpath) { log(`  ${label}: Redfin did not return the county page — skipped`, 'warn'); continue; }
      // --- the county's homes for sale, from Redfin's own data first ---
      const early = [], ids = new Set();
      let cardsSeen = 0, source = '';
      const regionId = core.redfinRegionId(cpath);
      await rfNav(core.redfinSearchUrl(cpath, area.maxk, 1), 4500);   // the search page, as a person would open it
      for (const csv of [false, true]) {
        if (cardsSeen || !regionId) break;
        for (const market of ['sanfrancisco', '']) {
          if (cardsSeen) break;
          for (let page = 1; page <= 10; page++) {
            if (await stopRequested()) break;
            const r = await rfFetch(core.redfinGisUrl({ regionId, maxk: area.maxk, page, csv, market }));
            const homes = (r.status === 200 && (csv ? core.redfinCsvHomes(r.body) : core.redfinGisHomes(r.body))) || [];
            const add = homes.filter(h => !ids.has(h.homeId));
            add.forEach(h => { ids.add(h.homeId); if (h.early) early.push(h); });
            cardsSeen += add.length;
            log(`  ${label}: Redfin ${csv ? 'download' : 'data'} page ${page}${market ? '' : ' (no market)'} — `
              + (r.status === 200 ? `${homes.length} house(s), ${add.filter(h => h.early).length} Coming Soon / Early Access`
                : `no answer (HTTP ${r.status || 'none'})`), r.status === 200 ? 'info' : 'warn');
            if (homes.length < 350 || !add.length) break;
          }
          if (cardsSeen) source = csv ? 'Redfin download data' : 'Redfin search data';
        }
      }
      // --- fallback: the cards on the search pages ---
      if (!cardsSeen) {
        let page = 1;
        for (; page <= MAX_PAGES; page++) {
          if (await stopRequested()) break;
          if (page > 1) await rfNav(core.redfinSearchUrl(cpath, area.maxk, page), 4500);
          const raw = await rfJs(JS_REDFIN_CARDS).catch(() => []);
          const cards = (raw || []).map(core.redfinCard).filter(c => c && !ids.has(c.homeId));
          log(`  ${label}: Redfin search page ${page} — ${cards.length} new house card(s), ${cards.filter(c => c.early).length} Coming Soon / Early Access`);
          if (!cards.length) break;
          cards.forEach(c => { ids.add(c.homeId); if (c.early) early.push(c); });
          cardsSeen += cards.length;
        }
        if (page > MAX_PAGES) log(`  ⚠ ${label}: stopped at ${MAX_PAGES} pages of Redfin results — some homes not looked at`, 'warn');
        if (cardsSeen) source = 'Redfin search cards';
      }
      if (!cardsSeen) {
        const dir = path.join(app.getPath('userData'), 'grid-debug');
        try {
          fs.mkdirSync(dir, { recursive: true });
          const f = path.join(dir, `redfin-${area.county.replace(/\W+/g, '-')}-${Date.now()}`);
          fs.writeFileSync(f + '.txt', String(await rfJs('location.href + "\\n\\n" + document.body.innerText.slice(0, 20000)').catch(() => '')));
          fs.writeFileSync(f + '.png', (await ensureRedfinWindow().webContents.capturePage()).toPNG());
          log(`  ${label}: read 0 homes off Redfin — page saved to ${f}.txt/.png for checking`, 'error');
        } catch (_) { log(`  ${label}: read 0 homes off Redfin`, 'error'); }
        continue;
      }
      log(`  ${label}: read ${cardsSeen} houses for sale from ${source}`);
      if (!early.length) log(`  ${label}: none of them is Coming Soon / Early Access on Redfin right now`
        + ' (Early Access homes only show when signed in to Redfin — use "Sign in to Redfin" in section 3)', 'warn');
      runKpi.scanned += early.length;
      // The same buy box as the MLS scan, checked here on every home — not
      // left to Redfin's search filters: single-family only, under the area's
      // cap (never over $3M), 25+ years old.
      const kept = [], rejects = [];
      const rejectRow = (c, reason, stage) => ({ mls: c.mls || ('RF' + c.homeId), addr: c.addr, city: (c.addr.split(',')[1] || area.county).trim(),
        zip: (c.addr.match(/\b(9\d{4})$/) || [])[1] || '', price: c.price, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '', sqft: c.sqft,
        dom: c.dom, reason, stage, link: c.url });
      const inBox = [];
      early.forEach(c => {
        const why = core.redfinBuyBox(c, area, 'list');
        if (why) { rejects.push(rejectRow(c, why, 'Buy-box filter')); log(`  skip ${c.addr} — ${why}`); }
        else inBox.push(c);
      });
      const fresh = inBox.filter(c => !seen['RF' + c.homeId]);
      log(`${label}: ${cardsSeen} houses on Redfin → ${early.length} Coming Soon / Early Access → ${inBox.length} single-family under the cap → ${fresh.length} new`, 'good');
      // --- read each one's own page, judge it like an MLS listing ---
      for (let i = 0; i < fresh.length; i++) {
        if (await stopRequested()) break;
        const c = fresh[i];
        log(`[Redfin ${area.county}] opening ${i + 1}/${fresh.length}: ${c.addr || c.url} — ${c.badge}`, 'good');
        send('review', { i: i + 1, total: fresh.length, city: area.county, mls: 'RF' + c.homeId, addr: c.addr,
          price: c.price, sqft: c.sqft, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '', photos: 0,
          remarks: c.remarks || '', details: {}, verdict: 'reviewing', why: 'Reading the Redfin page' });
        await rfNav(c.url, 4000);
        const text = await readWholePage(rfJs);
        const html = await rfJs('document.documentElement.innerHTML').catch(() => '');
        const h = core.parseRedfinHome(text);
        // Fill what the page did not say from Redfin's data for the home.
        if (!h.remarks && c.remarks) h.remarks = c.remarks;
        if (!h.year && c.year) h.year = c.year;
        if (h.dom === '' && c.dom !== '' && c.dom != null) h.dom = c.dom;
        if (!h.mls && c.mls) h.mls = c.mls;
        // The page says what the list may not have: the type, the year.
        const pageWhy = core.redfinBuyBox({ ...c, ptype: h.ptype || c.ptype, year: h.year || c.year }, area, 'page');
        if (pageWhy) {
          log(`  skip — ${pageWhy}`);
          rejects.push(rejectRow(c, pageWhy, 'Buy-box filter'));
          ledgerRecord('RF' + c.homeId, 'dropped', { addr: c.addr });
          continue;
        }
        if (/sign in|join or sign/i.test(text.slice(0, 3000)) && !h.remarks) log('  this Early Access home is only shown in full when signed in to Redfin', 'warn');
        // EVERY photo, one by one, in Redfin's own viewer (Rule #2).
        const seenPhotos = await viewRedfinPhotos(Number(cfg.scrollPauseMs) || 700);
        const urls = core.redfinPhotoUrls(seenPhotos.join(' ') + ' ' + html);
        log(`  looked through ${urls.length} photo(s)`, urls.length > 4 ? 'good' : 'warn');
        const ag = core.parseRedfinAgent(await rfJs(JS_REDFIN_AGENT(Number(cfg.scrollPauseMs) || 700)).catch(() => null));
        log(ag.name || ag.phone || ag.email
          ? `  listing agent: ${[ag.name, ag.brokerage, ag.phone, ag.email].filter(Boolean).join(' · ')}`
          : '  listing agent contact not shown on Redfin — call the brokerage', ag.phone || ag.email ? 'good' : 'info');
        if (isSeen(h.mls)) { log(`  already checked as ${h.mls} by an MLS scan — skipped`); ledgerRecord('RF' + c.homeId, 'on-mls', { addr: c.addr }); continue; }
        const city = (c.addr.split(',')[1] || area.county).trim();
        const q = core.qualify({
          addr: c.addr, remarks: h.remarks, propClass: h.propClass,
          photos: urls.length, photosReliable: false, dom: h.dom, yearBuilt: h.year,
          price: c.price, whenUnsure: cfg.whenUnsure, comingSoon: true,
        });
        q.why = 'Redfin ' + c.badge + ' · ' + q.why;
        if (!(cfg.useAI && cfg.apiKey)) q.why += ' + photos viewed but not judged (AI photo check off)';
        const tooFew = urls.length <= 4;
        if (tooFew) q.why += ' + photos not posted on Redfin yet — check them before offering';
        let aiKept = false;
        if (cfg.useAI && cfg.apiKey && aiFailStreak < 3 && !q.hard && q.bucket !== 'C' && !tooFew) {
          const b64 = await collectPhotosDirect(urls, 20);
          const v = await autoDecide({ addr: c.addr, _cityKey: city, _sqft: c.sqft, _price: c.price,
            _gal: { b64, remarks: h.remarks } });
          if (v.error) { aiFailStreak++; log(`  ${v.reason} — kept the text rules' verdict`, 'warn'); }
          else if (v.decision !== 'keep') {
            aiFailStreak = 0;
            Object.assign(q, { bucket: 'C', label: core.BUCKET_LABEL.C, decision: 'drop', score: Math.min(q.score, 15), why: 'AI (vision): ' + v.reason });
          } else { aiFailStreak = 0; aiKept = true; q.why += ' + AI (vision) keep: ' + v.reason; }
        }
        // Fixers only (Bryan, 2 Oct: "on early access make sure only fixer").
        // A Coming Soon / Early Access home stays only if its description says
        // it needs work, or the AI saw the wear in its photos.
        const notFixer = q.decision === 'keep' ? core.redfinFixerGate({ addr: c.addr, remarks: h.remarks, aiKept }) : '';
        if (notFixer) Object.assign(q, { bucket: 'C', label: core.BUCKET_LABEL.C, decision: 'drop', score: Math.min(q.score, 30), why: q.why + ' — ' + notFixer });
        runKpi.reviewed++; runKpi['bucket' + q.bucket]++;
        const id = h.mls || ('RF' + c.homeId);
        log(`  ${q.label} · score ${q.score} — ${q.why}`, q.decision === 'keep' ? 'good' : 'info');
        send('review', { i: i + 1, total: fresh.length, city: area.county, mls: id, addr: c.addr, price: c.price, sqft: c.sqft,
          ppsf: c.sqft ? Math.round(c.price / c.sqft) : '', photos: urls.length, remarks: h.remarks || '', details: {},
          verdict: q.decision, why: `${q.label} · score ${q.score} — ${q.why}` });
        if (q.decision === 'keep') {
          runKpi.kept++;
          const offer = core.offerDue(h.remarks);
          kept.push({
            mls: id, address: c.addr, city, zip: (c.addr.match(/\b(9\d{4})$/) || [])[1] || '',
            beds: c.beds, baths: c.baths, sqft: c.sqft, lotSqft: h.lotSqft || '', yearBuilt: h.year || '',
            dom: h.dom, price: c.price, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '',
            arv: 0, arvBasis: 'not comped yet', recommendation: 'Needs Comps', flipQuality: '', score: '',
            risks: 'Found on Redfin (' + c.badge + ') — confirm on the MLS',
            bucket: q.bucket, bucketLabel: q.label, oppScore: q.score, why: q.why,
            listedBy: [ag.name || h.agent, ag.brokerage].filter(Boolean).join(', '), offerDue: offer, privateRemarks: '', occupiedBy: '',
            mlsStatus: core.redfinLabel(c.badge), remarks: h.remarks, redfin: c.url,
            agentPhone: ag.phone, agentEmail: ag.email, showing: '', disclosures: '', priceCut: '',
            link: c.url, surface: true, needsComps: true,
          });
        } else {
          runKpi.dropped++;
          rejects.push({ mls: id, addr: c.addr, city, zip: '', price: c.price, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '',
            sqft: c.sqft, dom: h.dom, reason: `Auto-pass (score ${q.score}): ${q.why}`, score: q.score, why: q.why,
            stage: 'Redfin review', link: c.url });
        }
        ledgerRecord('RF' + c.homeId, q.decision === 'keep' ? 'kept' : 'dropped', { addr: c.addr, city, mls: h.mls });
      }
      found += kept.length;
      if (kept.length || rejects.length) {
        const rows = kept.map(toSheetRow);
        if (googleReady() && googleCfg().autoSync) {
          const r = await googleSync(rows, rejects);
          if (r.ok) { runKpi.pushed += r.leads.added; log(`[Redfin ${area.county}] sheet: ${r.leads.added} new lead(s)`, 'good'); }
          else log(`[Redfin ${area.county}] sheet write failed: ${r.error} — kept in the local backup`, 'warn');
        }
        writeBackup(rows, rejects);
        if (kept.length) {
          const b = writeBoardScan(kept);
          log(b.ok ? `[Redfin ${area.county}] ${kept.length} lead(s) added to today's Lead Board file` : `could not write the Lead Board file: ${b.error}`, b.ok ? 'good' : 'warn');
        }
      }
      send('report', { leads: kept, generatedAt: new Date().toString(), partial: ai + 1 < areas.length });
    }
    return { ok: true, found };
  } catch (e) {
    log('Redfin scan error: ' + e.message, 'error'); return { ok: false, error: e.message };
  } finally {
    control.running = false;
    try { if (rfWin && !rfWin.isDestroyed()) rfWin.close(); } catch (_) {}
    rfWin = null;
    try {
      const f = path.join(app.getPath('userData'), 'redfin-last-run.txt');
      fs.writeFileSync(f, rfDiag.join('\n') + '\n');
      log(`What Redfin answered on each step is saved in ${f} — send it if this run found nothing.`);
    } catch (_) {}
    const day = recordKpi(runKpi);
    if (googleReady() && googleCfg().autoSync) await rebuildBoard(day).catch(() => {});
    const line = `Redfin scan ${control.stopped ? 'STOPPED' : 'COMPLETE'} — ${runKpi.scanned} Coming Soon / Early Access found · `
      + `${runKpi.reviewed} reviewed → ${runKpi.bucketA} A · ${runKpi.bucketB} B · ${runKpi.bucketC} C.`;
    log(line, 'good');
    const board = boardStatus();
    if (board.count) {
      try { clipboard.writeText(fs.readFileSync(board.file, 'utf8'));
        log(`Today's ${board.count} lead(s) are copied — open the Lead Board, click "Add scan", and paste`
          + (googleReady() ? ' (or press "↻ Refresh from sheet" on the board — the sheet already has them).' : '.'), 'good'); } catch (_) {}
    }
    send('board', board);
    // Leads found: open the Lead Board with them already on the clipboard.
    if (found && /^https:\/\/claude\.ai\//.test(String(cfg.boardUrl || ''))) {
      shell.openExternal(cfg.boardUrl);
      log(`Opened the Lead Board — click "Add scan" and paste (Ctrl+V) to add the ${found} Redfin lead(s).`, 'good');
    }
    send('kpi', { today: day, history: kpiReport() });
    send('done', { stopped: control.stopped, summary: line, redfin: true });
  }
});

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

/** Every MLS # a PERSON rejected on the Rejected tab. The scan's own drops
 *  ('FlipScout' in By) are not a permanent verdict — a re-review may keep them. */
async function rejectedOnSheet(token) {
  const g = googleCfg();
  const info = await gsheets.listTabs(token, g.sheetId);
  if (info.tabs.indexOf(g.rejectTab) < 0) return {};
  return personRejections(await gsheets.readAll(token, g.sheetId, g.rejectTab));
}
function personRejections(grid) {
  const h = (grid && grid[0]) || [], iM = h.indexOf('MLS #'), iB = h.indexOf('By'), iS = h.indexOf('Stage');
  const out = {};
  (grid || []).slice(1).forEach(r => {
    const k = String((r && r[iM]) || '').trim().toUpperCase();
    if (k && core.isPersonRejection(r[iB], r[iS])) out[k] = true;
  });
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
    // A re-reviewed listing that now fails and is already on Leads is re-judged
    // IN PLACE — bucket C, the new score and why — so the Board stops listing it.
    // Its Rejected row takes the new date, reason and stage.
    const rr = loadRereview(), isRR = r => r && rr.mls[String(r.mls || '').trim().toUpperCase()];
    const rrRejects = (rejects || []).filter(isRR);
    if (rrRejects.length) {
      const lcol = gsheets.colName(LEAD_HEADERS.indexOf('MLS #'));
      const onLeads = {};
      (await gsheets.readCol(token, g.sheetId, g.leadTab, `${lcol}2:${lcol}`))
        .forEach(m => { const k = String(m || '').trim().toUpperCase(); if (k) onLeads[k] = true; });
      const down = rrRejects.filter(r => onLeads[String(r.mls).trim().toUpperCase()]).map(r => ({
        'MLS #': r.mls, 'Bucket': core.BUCKET_LABEL.C, 'Opportunity Score': r.score != null && r.score !== '' ? r.score : 0,
        'Why': (r.why || r.reason || 'dropped') + ' (re-review ' + today() + ')',
      }));
      if (down.length) {
        await gsheets.syncRows(token, g.sheetId, g.leadTab, LEAD_HEADERS, 'MLS #', down, { overwrite: ['Bucket', 'Opportunity Score', 'Why'] });
        log(`${down.length} lead(s) already on the sheet failed the re-review — moved to C.`, 'warn');
      }
    }
    const plainRejects = (rejects || []).filter(r => r && r.mls && !isRR(r));
    const R = plainRejects.length
      ? await gsheets.syncRows(token, g.sheetId, g.rejectTab, REJECT_HEADERS, 'MLS #', plainRejects.map(rejectRecord))
      : blank;
    if (rrRejects.length) await gsheets.syncRows(token, g.sheetId, g.rejectTab, REJECT_HEADERS, 'MLS #',
      rrRejects.map(rejectRecord), { overwrite: ['Rejected On', 'Reason', 'Stage', 'By'] });
    // Everything this batch judged has its new verdict on the sheet now.
    const doneRR = (leads || []).concat(rejects || []).filter(isRR);
    if (doneRR.length) {
      doneRR.forEach(r => { delete rr.mls[String(r.mls).trim().toUpperCase()]; });
      saveRereview(rr);
    }
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
    mlsStatus: core.listingLabel({ status: g.status, comingSoon: c._comingSoon,
      remarks: c._remarks || g.remarks, privateRemarks: g.privateRemarks }),
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
      const info = await gsheets.listTabs(token, g.sheetId);
      const rgrid = info.tabs.indexOf(g.rejectTab) < 0 ? [] : await gsheets.readAll(token, g.sheetId, g.rejectTab);
      const people = personRejections(rgrid);
      const iM = ((rgrid[0]) || []).indexOf('MLS #');
      // Every MLS # on the tab still counts as checked — the scan's own drops
      // too, so a second computer does not redo the first one's work. But the
      // listings a "Re-review a past scan" freed are left alone until the scan
      // re-judges them, and only a PERSON's rejection is permanent on the sheet.
      const rrSet = loadRereview().mls;
      const ids = rgrid.slice(1).map(r => String((r && r[iM]) || '').trim().toUpperCase())
        .filter(k => k && !rrSet[k]);
      const seen = loadLedger();
      const fresh = ids.filter(m => m && !seen[String(m).trim().toUpperCase()]);
      if (fresh.length) {
        ledgerRecordMany(fresh.map(m => ({ mls: m, verdict: people[m] ? 'reviewer-rejected' : 'scan-dropped' })));
        log(`Rejections synced: ${fresh.length} new (won't be checked again unless you re-review their scan).`);
      }
      // Leads already on the board are not re-reviewed by a scan either — that
      // was 15 of 16 listings on the first test run, re-reviewed for nothing.
      // "Refresh leads on the board" is what keeps their facts current.
      const lcol = gsheets.colName(LEAD_HEADERS.indexOf('MLS #'));
      const onBoard = info.tabs.indexOf(g.leadTab) < 0 ? []
        : await gsheets.readCol(token, g.sheetId, g.leadTab, `${lcol}2:${lcol}`);
      const seen2 = loadLedger(), rr = loadRereview().mls;
      const freshBoard = onBoard.filter(m => m && !seen2[String(m).trim().toUpperCase()] && !rr[String(m).trim().toUpperCase()]);
      const rrLeft = Object.keys(rr).length;
      if (rrLeft) log(`Re-review: ${rrLeft} listing(s) from ${loadRereview().date} will be judged again by this scan (if they are still in the areas you picked).`, 'warn');
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
        batch.push({ 'MLS #': mls, 'MLS Status': 'Not found in Active / Coming Soon search — check' });
        log('    not found among Active or Coming Soon listings — may be pending or off market', 'warn');
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
              condition: gal.condition, propClass: gal.propClass, occupiedBy: gal.occupiedBy || val(r, 'Occupied By') })
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
      + `${flagged} moved to C by a red flag · ${notFound} not found among Active or Coming Soon listings.`;
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

ipcMain.handle('rereview', async (_e, date) => {
  date = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'pick the date of the scan to re-review' };
  if (!googleReady()) return { ok: false, error: 'connect your Google Sheet in section 7 first' };
  try {
    const g = googleCfg(), token = await googleToken();
    const info = await gsheets.listTabs(token, g.sheetId);
    const rgrid = info.tabs.indexOf(g.rejectTab) < 0 ? [] : await gsheets.readAll(token, g.sheetId, g.rejectTab);
    const lgrid = info.tabs.indexOf(g.leadTab) < 0 ? [] : await gsheets.readAll(token, g.sheetId, g.leadTab);
    const led = loadLedger();
    const plan = core.rereviewPlan(led, rgrid, lgrid, date);
    if (!plan.forget.length) return { ok: true, forget: 0, leads: 0, date };
    const { response } = await dialog.showMessageBox(controlWin, {
      type: 'question', buttons: ['Cancel', 'Re-review them'], defaultId: 1, cancelId: 0,
      message: `Re-review ${plan.forget.length} listing(s) from the ${date} scan?`,
      detail: `${plan.leads.length} of them are on the Leads tab: they are re-judged in place (Bucket, Score and Why change; Notes are never touched) and any that now fail move to C.\n\n` +
        `The rest were dropped by that scan and get another look.\n\nNothing a person rejected is included. Run a scan of the same area(s) next.`,
    });
    if (response !== 1) return { ok: false, cancelled: true };
    plan.forget.forEach(k => { delete led[k]; });
    saveLedger(led);
    const rr = loadRereview();
    rr.date = date;
    plan.forget.forEach(k => { rr.mls[k] = true; });
    saveRereview(rr);
    log(`Re-review ready — ${plan.forget.length} listing(s) from ${date} (${plan.leads.length} on the Leads tab) will be judged again by the next scan of their area.`, 'warn');
    return { ok: true, forget: plan.forget.length, leads: plan.leads.length, date };
  } catch (e) { return { ok: false, error: e.message }; }
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
