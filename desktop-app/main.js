/**
 * FlipScout Desktop — Electron main process.
 *
 * Two windows: a Control panel (buttons/progress/report) and a visible MLS
 * browser window that the app drives. Login happens in the visible window so
 * you can complete 2FA/SSO yourself; the app auto-fills what it can and then
 * detects the dashboard. Scanning navigates the MLS window through Matrix and
 * runs the same extraction used by the headless pipeline.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, net, nativeImage, session } = require('electron');
const fs = require('fs');
const path = require('path');
const core = require('./scan-core');
const gsheets = require('./google-sheets');

let controlWin, mlsWin;
const control = { paused: false, stopped: false, running: false };
let aiFailStreak = 0;   // consecutive failed AI calls in this run
let pastDeals = [];     // the sheet's "Past Deals" tab, read at the start of each MLS scan (second look)
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
  runComps: true,      // sold comps + ARV for A/B leads (v1.73; section 3 checkbox)
  scrollPauseMs: 700,  // pause per screen while scrolling a report — reading slowly
  boardUrl: 'https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1',   // FlipScout Lead Board
};

// ---------- AI: Claude or ChatGPT, told apart by the key ----------
// Bryan, 10 Oct: Claude only (v1.67). Seth, 12 Oct: "can you put it back? the
// chatgpt api key instead? i can switch to claude or chatgpt" (v1.72.1).
// Claude keys start "sk-ant-"; any other key is OpenAI (ChatGPT). The photo
// prompt and the KEEP/DROP rules are the same for both — only the request and
// response shapes differ (see aiCallOnce).
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
const OPENAI_DEFAULT_MODEL = 'gpt-4.1';
const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys';
const isClaudeKey = key => /^sk-ant-/.test(String(key || '').trim());
function aiProvider(key) { return isClaudeKey(key) ? 'anthropic' : 'openai'; }
// Old saved names that are not model ids ("claude-opus-5", "claude-sonnet-5").
const OLD_MODELS = { 'claude-opus-5': 'claude-opus-5-5', 'claude-sonnet-5': 'claude-sonnet-5-5' };
function aiModel() {
  const m = core.tidyModel(cfg.model);
  if (OLD_MODELS[m]) return OLD_MODELS[m];
  // a model from the other service would fail every call: use this one's default
  if (aiProvider(cfg.apiKey) === 'anthropic') return /^claude-/.test(m) ? m : ANTHROPIC_DEFAULT_MODEL;
  return m && !/^claude/.test(m) ? m : OPENAI_DEFAULT_MODEL;
}
// The AI photo check is on with "Use AI" ticked and a key of either kind.
const aiReady = () => !!(cfg.useAI && String(cfg.apiKey || '').trim());
const aiName = key => aiProvider(key) === 'anthropic' ? 'Claude' : 'ChatGPT';
ipcMain.handle('open-claude-keys', () => { shell.openExternal(ANTHROPIC_KEYS_URL); return { ok: true }; });
ipcMain.handle('open-openai-keys', () => { shell.openExternal('https://platform.openai.com/api-keys'); return { ok: true }; });

// "Sign in to Claude" (Bryan, 10 Oct: "just log in to Claude, no key"). The app
// may not use a claude.ai chat login, so this signs in to Claude's developer
// site (console.anthropic.com — same email) in the app's own window and picks
// up the key there by itself: the user clicks Create Key, then Copy, and the
// app sees it on the clipboard, saves it, tests it and closes the window.
// Nothing to paste. Sign-in cookies persist in 'persist:anthropic'.
let claudeWin = null;
ipcMain.handle('claude-signin', async () => {
  if (claudeWin && !claudeWin.isDestroyed()) { claudeWin.focus(); return { ok: true, already: true }; }
  claudeWin = new BrowserWindow({ width: 1150, height: 850, title: 'Sign in to Claude — FlipScout',
    webPreferences: { partition: 'persist:anthropic' } });
  claudeWin.on('closed', () => { claudeWin = null; });
  claudeWin.loadURL(ANTHROPIC_KEYS_URL).catch(() => {});
  log('Sign in to Claude in the window that opened. Then click "Create Key", name it FlipScout, and click "Copy" — the app picks the key up by itself.', 'good');
  const before = String(clipboard.readText() || '').trim();
  const started = Date.now();
  return await new Promise(resolve => {
    const tick = setInterval(async () => {
      const t = String(clipboard.readText() || '').trim();
      const done = r => { clearInterval(tick); resolve(r); };
      if (!claudeWin || claudeWin.isDestroyed()) {
        if (!isClaudeKey(cfg.apiKey)) log('Claude sign-in window closed before a key was copied — click "Sign in to Claude" to try again.', 'warn');
        return done({ ok: isClaudeKey(cfg.apiKey) });
      }
      if (Date.now() - started > 20 * 60000) { try { claudeWin.close(); } catch (_) {} return done({ ok: false, error: 'timed out' }); }
      if (t === before || !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(t)) return;
      clearInterval(tick);
      Object.assign(cfg, { apiKey: t, useAI: true }); cfg.model = aiModel(); saveAi();
      try { clipboard.writeText(''); } catch (_) {}   // the key does not linger on the clipboard
      let test = { ok: true };
      try { await aiCall([], 'Reply with the single word: ready', 20); }
      catch (e) { test = { ok: false, error: e.message }; }
      if (test.ok) {
        log('✓ Signed in to Claude — the key is saved on this computer and the photo check is on. Click 🏠 Scan Redfin.', 'good');
        try { claudeWin.close(); } catch (_) {}
      } else {
        log('The key was picked up but Claude refused it: ' + test.error + ' — if it mentions credit, add a payment method on the page that is still open, then try again.', 'error');
      }
      send('ai-key', { ok: test.ok, key: cfg.apiKey, model: cfg.model, error: test.error || '' });
      resolve(test);
    }, 1000);
  });
});

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
  return { apiKey: j.apiKey || '', model: core.tidyModel(j.model), useAI: !!j.useAI, provider: aiProvider(j.apiKey) };
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
// One stuck AI request used to hang the whole run (and Test key): every call
// is abandoned after AI_TIMEOUT_MS and counts as a failed call, not a verdict.
const AI_TIMEOUT_MS = 120000;
// A busy AI is not a failed one (v1.72.2): 16 Oct's MLS scan put 36 leads on
// the sheet with no photo verdict at all — three refusals in a row switch the
// check off for the run, and a rate limit ("too many requests", 20 photos a
// call) is exactly that. A 429 / 5xx / overloaded answer now waits and tries
// again, up to 3 times; out-of-credit is said plainly and not retried.
let lastAiError = '';   // the last reason an AI call failed, for the end-of-run summary
async function aiCall(photos, text, maxTokens) {
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), AI_TIMEOUT_MS);
    try { return await aiCallOnce(photos, text, maxTokens, ac.signal); }
    catch (e) {
      const err = ac.signal.aborted ? new Error(`no answer from the AI within ${AI_TIMEOUT_MS / 1000} s`) : e;
      const busy = !err.noRetry && (err.status === 429 || err.status === 529 || (err.status >= 500 && err.status < 600));
      if (!busy || attempt >= 3) { lastAiError = err.message; throw err; }
      const wait = Math.min(60, err.retryAfter > 0 ? err.retryAfter : 15 * 2 ** attempt);
      log(`  ${aiName(cfg.apiKey)} is busy (${err.status}: ${String(err.message).slice(0, 90)}) — waiting ${wait} s and trying again`, 'warn');
      await new Promise(r => setTimeout(r, wait * 1000));
    } finally { clearTimeout(t); }
  }
}
// The service's own error, with what aiCall needs to decide whether to retry.
function aiError(r, j, prov) {
  const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  e.status = r.status;
  e.retryAfter = Number(r.headers.get('retry-after')) || 0;
  const code = (j.error && (j.error.code || j.error.type)) || '';
  if (code === 'insufficient_quota' || /credit balance|billing/i.test(e.message)) {
    e.noRetry = true;
    e.message = (prov === 'openai' ? 'the ChatGPT key is out of credit — add billing at platform.openai.com → Billing'
      : 'the Claude key is out of credit — add credit at console.anthropic.com → Billing') + ' (' + e.message.slice(0, 80) + ')';
  }
  return e;
}
async function aiCallOnce(photos, text, maxTokens, signal) {
  const key = String(cfg.apiKey || '').trim(), model = aiModel();
  if (aiProvider(key) === 'anthropic') {
    const content = photos.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }));
    content.push({ type: 'text', text });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens || 1024, messages: [{ role: 'user', content }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.type === 'error') throw aiError(r, j, 'anthropic');
    return { text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' '), model, provider: 'Claude' };
  }
  // OpenAI Chat Completions: images go in as data URLs.
  const content = [{ type: 'text', text }].concat(photos.map(b64 => ({
    type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'auto' },
  })));
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    // max_completion_tokens, not max_tokens: the newer models refuse the old
    // name; "thinking" models need room to answer, so never under 4000
    body: JSON.stringify({ model, max_completion_tokens: Math.max(maxTokens || 1024, photos.length ? 4000 : 200), messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw aiError(r, j, 'openai');
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  return { text: (msg && typeof msg.content === 'string' ? msg.content : '') || '', model, provider: 'ChatGPT' };
}

// The models this key can use, for the dropdown in section 2. Asked of the
// provider itself, so a new model shows up without a new build; when the
// lookup fails the screen falls back to its built-in list.
const NOT_FOR_PHOTOS = /audio|realtime|tts|transcribe|whisper|embedding|moderation|dall-e|image|search|instruct|davinci|babbage|codex|computer-use|deep-research|-\d{4}-\d{2}-\d{2}$|-\d{4}$/;
ipcMain.handle('tidy-model', (_e, m) => core.tidyModel(m));
ipcMain.handle('ai-models', async (_e, key) => {
  key = String(key || '').trim();
  if (!key) return { ok: false, models: [] };
  const prov = aiProvider(key);
  try {
    if (prov === 'anthropic') {
      const r = await timeLimit(fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }), 20000, 'model list');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, provider: prov, models: [], error: (j.error && j.error.message) || ('HTTP ' + r.status) };
      return { ok: true, provider: prov, models: (j.data || []).map(x => x.id).filter(id => /^claude/.test(id)) };
    }
    const r = await timeLimit(fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key } }), 20000, 'model list');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, provider: prov, models: [], error: (j.error && j.error.message) || ('HTTP ' + r.status) };
    const ids = (j.data || []).map(x => x.id).filter(id => /^(gpt-|o\d|chatgpt-)/.test(id) && !NOT_FOR_PHOTOS.test(id));
    return { ok: true, provider: prov, models: ids.sort() };
  } catch (e) { return { ok: false, provider: prov, models: [], error: e.message }; }
});

// "Test key" in section 2: a tiny text-only call, so a bad key or model name
// shows up before a scan, not as a run full of failed reviews.
ipcMain.handle('ai-test', async () => {
  if (!String(cfg.apiKey || '').trim()) return { ok: false, error: 'Paste a ChatGPT key (sk-…) or a Claude key (sk-ant-…) first.' };
  try {
    const r = await aiCall([], 'Reply with the single word: ready', 20);
    return { ok: true, provider: r.provider, model: r.model, reply: (r.text || '').trim().slice(0, 40) };
  } catch (e) { return { ok: false, provider: aiName(cfg.apiKey), model: aiModel(), error: e.message }; }
});

// ---------- daily KPIs ----------
// Every scan folds its funnel counts into a per-day record kept on disk, so the
// numbers survive closing the app and "how did today go" is answerable without
// re-running anything. One row per calendar day, accumulated across runs.
const KPI_FILE = () => path.join(app.getPath('userData'), 'kpi-history.json');
const KPI_FIELDS = ['runs', 'scanned', 'candidates', 'skippedAlreadyChecked', 'reviewed', 'kept',
  'dropped', 'droppedRenovated', 'droppedMultiUnit', 'droppedFire',
  'droppedFewPhotos', 'droppedOther', 'leads', 'gateCleared', 'pushed', 'pushSkipped',
  'bucketA', 'bucketB', 'bucketC', 'photoChecked', 'secondLook',
  'compsValued', 'compsHigh', 'compsMedium', 'compsLow', 'compsNone'];
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
  const k = String(mls).trim().toUpperCase();
  const prev = e[k] || {};
  e[k] = Object.assign({ first_seen: prev.first_seen || d }, extra || {}, { last_seen: d, verdict: verdict || 'checked' });
  if (e[k].verdict !== 'recheck') delete e[k].recheck_after;
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
  // ensureMlsWindow, not mlsWin: if the window was closed mid-run, mlsWin is
  // null and every later step used to throw (and each listing was then
  // judged on nothing).
  await ensureMlsWindow().loadURL(url).catch(() => {}); // Matrix keeps sockets open; loadURL resolves on load event
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

/** A Coming Soon / Early Access home whose wait is over: say so, and put its
 *  sheet id on the re-review list so the sheet re-judges it IN PLACE. */
function markRecheck(ledgerKey, sheetId) {
  const e = loadLedger()[String(ledgerKey).trim().toUpperCase()];
  if (!e || e.verdict !== 'recheck') return false;
  const rr = loadRereview();
  rr.mls[String(sheetId || ledgerKey).trim().toUpperCase()] = true;
  if (!rr.date) rr.date = 'Coming Soon recheck';
  saveRereview(rr);
  return true;
}

/** Take ids off the re-review list again — for a recheck that ended without
 *  a sheet write (held, or no sheet connected), which nothing else would clear;
 *  left there, every later scan warned about it and treated it as unseen. */
function clearRecheck(ids) {
  const list = (ids || []).map(x => String(x || '').trim().toUpperCase()).filter(Boolean);
  if (!list.length) return;
  const rr = loadRereview();
  let n = 0;
  list.forEach(k => { if (rr.mls[k]) { delete rr.mls[k]; n++; } });
  if (n) { if (!Object.keys(rr.mls).length) rr.date = ''; saveRereview(rr); }
}

/** Record a Coming Soon / Early Access verdict: final once photos decided it,
 *  a 'recheck' while they could not. */
function recordComingSoon(ledgerKey, { provisional, decision, extra }) {
  const prev = loadLedger()[String(ledgerKey).trim().toUpperCase()];
  const v = core.comingSoonVerdict({ prev, today: todayKey(), provisional, decision });
  ledgerRecord(ledgerKey, v.verdict, Object.assign({}, extra || {}, v));
  if (v.verdict === 'recheck') log(`  first look only (photos not checked yet) — will open it again on ${v.recheck_after} (recheck ${v.rechecks} of ${core.RECHECK_MAX})`);
}

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
  if (control.running) { log('A run is going — sign in again after it finishes (it would take over the scan\'s MLS window).', 'warn'); return { ok: false, error: 'already running' }; }
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
  // Look the MLS # up in EVERY status. v1.48 narrowed this to Active + Coming
  // Soon, so a lead that had gone Pending, Contingent or Sold could no longer
  // be found by its own number, and "↻ Refresh leads on the board" stamped
  // 572 of them "Not found" — over 142 Pending and 39 Contingent (10 Oct).
  // An MLS # names one listing; its status is something to READ, not filter on.
  await js(selectOnly(core.FIELDS.status, ['.'])).catch(() => null);
  await sleep(300);
  await js(setInput(core.FIELDS.mls, mls)); await sleep(1600);
  await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  await sleep(2600);

  // The Client Full report is the only place the full address, the zip, the
  // year built and the real remarks exist — the results grid has none of them.
  let meta = { remarks: '', condition: '', zip: '', address: '', yearBuilt: '', propClass: '', mismatch: false };
  // Whether the report was actually read. A listing judged on a report that
  // never loaded (no remarks, no photos) used to be scored and written off
  // for good; now the caller skips it and the next run tries again.
  let reportRead = false, notFound = false;
  try {
    const hasRow = await js(`(() => { const cb=document.querySelector('tr.DisplayRegRow input[type=checkbox], tr.DisplayAltRow input[type=checkbox]'); if(cb && !cb.checked) cb.click(); return !!cb; })()`);
    if (!hasRow) notFound = true;
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
      reportRead = !!String(raw || '').trim() && !meta.mismatch;
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
    notFound: notFound && !meta.mismatch, failed: !reportRead && !notFound && !meta.mismatch,
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

// ---------- comps: sold homes and the ARV (v1.73) ----------
// Seth, 20 Oct: the app fetches the comps and the ARV while it is signed in;
// the board does rehab, holding and selling costs from its own Settings.
// Nothing here may fail a scan: any problem costs that lead its comps, says
// so in the log, and the lead still goes to the sheet.

/** Every Sold single-family home in a zip with a list date in the last ~14
 *  months. The List Date window is what makes the zip filter bite: an
 *  unbounded Sold search returns MLS's "2500+" cap of all history
 *  (scripts/mls-comps.js, verified). */
async function soldSearch(zip) {
  await nav(core.SEARCH_URL, 2200);
  // "Sold", or a variant such as "Sold (Closed)" — but never a status that merely contains the word
  const st = await js(selectOnly(core.FIELDS.status, ['^sold\\b'])).catch(() => null);
  if (!st || !st.length) throw new Error('the search form has no "Sold" status');
  await sleep(400);
  await js(selectByLabel(core.FIELDS.propType, 'Single Family Home')); await sleep(400);
  await js(setInput(core.FIELDS.zip, zip)); await sleep(1000);
  const to = new Date(); const from = new Date(to.getFullYear(), to.getMonth() - 14, 1);
  const fmt = d => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  await js(setInput(core.FIELDS.listDate, `${fmt(from)}-${fmt(to)}`)); await sleep(1600);
  const count = await js(core.JS_MATCH_COUNT).catch(() => '?');
  if (count === '0') return { count, rows: [] };
  await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  let all = [], prev = '';
  for (let pg = 1; pg <= 8; pg++) {   // a zip's year of sales is a few pages
    if (control.stopped) break;
    const until = Date.now() + (pg === 1 ? 20000 : 15000);
    let rows = [];
    for (;;) {   // poll: a slow grid used to read as "no rows"
      rows = await js(core.JS_SCRAPE_SOLD).catch(() => []);
      if ((rows.length && rows[0].mls !== prev) || Date.now() > until || control.stopped) break;
      await sleep(1000);
    }
    if (!rows.length || rows[0].mls === prev) break;
    prev = rows[0].mls; all = all.concat(rows);
    const moved = await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/^\\s*Next/i.test(x.textContent)); if(a){a.click(); return true;} return false; })()`).catch(() => false);
    if (!moved) break;
    await sleep(1500);
  }
  return { count, rows: all };
}

/** One sold home's Client Full report — remarks, year, sold price and date.
 *  Lighter than showGallery: no Agent Full, no photo grid, no dwell. */
let compSamples = 0;
async function compReport(mls) {
  await nav(core.SEARCH_URL, 2200);
  await js(selectOnly(core.FIELDS.status, ['.'])).catch(() => null);
  await sleep(300);
  await js(setInput(core.FIELDS.mls, mls)); await sleep(1600);
  await js(`(() => { const a=[...document.querySelectorAll('a')].find(x=>/Results/i.test(x.textContent)); if(a) a.click(); })()`);
  await sleep(2600);
  const hasRow = await js(`(() => { const cb=document.querySelector('tr.DisplayRegRow input[type=checkbox], tr.DisplayAltRow input[type=checkbox]'); if(cb && !cb.checked) cb.click(); return !!cb; })()`).catch(() => false);
  if (!hasRow) return null;
  await sleep(400);
  const selId = await js(`(() => { const s=[...document.querySelectorAll('select')].find(se=>[...se.options].some(o=>/Client Full/i.test(o.text))); return s?s.id:null; })()`).catch(() => null);
  if (!selId) return null;
  await js(`(() => { const s=document.getElementById(${JSON.stringify(selId)}); if(!s) return; const o=[...s.options].find(o=>/Client Full/i.test(o.text)); if(o){ s.value=o.value; s.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
  await sleep(2600);
  const raw = await js('document.body.innerText').catch(() => '');
  // the first few, so the sold report's labels can be checked against the real page
  if (raw && compSamples < 3) { compSamples++; saveReportSample(mls, 'comp', raw); }
  const r = core.parseCompReport(raw, mls);
  return r.mismatch ? null : r;
}

// Sold homes already read, by MLS # — comps in one zip overlap from lead to
// lead, and a sale does not change. userData/comps-cache.json
const COMP_CACHE_FILE = () => path.join(app.getPath('userData'), 'comps-cache.json');
const COMP_CACHE_DAYS = 180;
function loadCompCache() {
  try {
    const j = JSON.parse(fs.readFileSync(COMP_CACHE_FILE(), 'utf8')) || {};
    const cut = new Date(Date.now() - COMP_CACHE_DAYS * 864e5).toISOString().slice(0, 10);
    Object.keys(j).forEach(k => { if (!j[k] || !(j[k].at >= cut)) delete j[k]; });
    return j;
  } catch (_) { return {}; }
}
function saveCompCache(c) { try { fs.writeFileSync(COMP_CACHE_FILE(), JSON.stringify(c)); } catch (_) {} }

/** The comps and ARV for one kept lead. */
async function compsFor(c, cache) {
  // the report's zip, else the one ending the full address ("…, CA 94112")
  const zip = (String(c.zip || '').match(/9[0-5]\d{3}/) || String(c.fullAddr || '').match(/9[0-5]\d{3}(?=(?:-\d{4})?\D*$)/) || [''])[0];
  if (!zip) return { arv: 0, reason: 'no zip on the listing', list: [] };
  if (!core.num(c._sqft)) return { arv: 0, reason: 'no square feet on the listing', list: [] };
  const found = await soldSearch(zip);
  const comps = core.compRows(found.rows, c.mls);
  const band = core.compBand(comps, c._sqft);
  let read = 0;
  for (const r of band.rows.slice(0, core.COMP_READ)) {
    if (await stopRequested()) break;
    const hit = cache[r.mls];
    if (hit) {
      Object.assign(r, { k: hit.k, why: hit.why, sold: r.sold || hit.sold || '', yr: r.yr || hit.yr || '' });
      if (hit.price && !r.gridSold) { r.price = hit.price; r.ppsf = Math.round(hit.price / r.sqft); }
      continue;
    }
    const rep = await compReport(r.mls).catch(() => null);
    if (!rep) { r.k = 'unknown'; r.why = 'report not read'; continue; }   // not cached: tried again next time
    read++;
    const cl = core.classifyComp(rep.remarks, rep.yearBuilt || r.yr);
    Object.assign(r, cl, { sold: r.sold || rep.soldDate || '', yr: r.yr || core.num(rep.yearBuilt) || '' });
    // the report's labelled sale price beats the grid's Price when the grid had no sold-price column
    if (rep.soldPrice && !r.gridSold) { r.price = rep.soldPrice; r.ppsf = r.sqft ? Math.round(rep.soldPrice / r.sqft) : r.ppsf; }
    cache[r.mls] = { k: r.k, why: r.why, sold: r.sold, yr: r.yr, price: rep.soldPrice || '', at: todayKey() };
  }
  const out = core.compArv(c._sqft, band, comps.length);
  out.zip = zip; out.read = read;
  return out;
}

/** The comp fields carried on a lead (sheet, backup, Lead Board file). */
function compFields(comp) {
  const ok = !!(comp && comp.arv);
  return {
    // with no ARV the confidence column says why, so the sheet explains the blank
    arv: ok ? comp.arv : '', arvPpsf: ok ? comp.ppsf : '', compConf: ok ? comp.conf : comp ? 'None — ' + (comp.reason || 'no comps') : '',
    comps: ok ? core.compsJson(comp.list) : '', compsAt: comp ? todayKey() : '',
    arvBasis: comp ? core.compSummary(comp) : 'not comped yet',
  };
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
      // No pictures is no verdict (Rule #2 says judge from the gallery): the
      // text rules stand, and a Coming Soon listing is rechecked later. It used
      // to be a DROP, which made a Coming Soon with no photos posted yet a
      // final C.
      return { error: true, noPhotos: true, reason: 'no photos could be loaded for the AI check' };
    }
    log(`  analysing ${photos.length} photo(s)…`);
    let text;
    try { text = (await aiCall(photos, rulesPrompt(c, photos.length, gal), 1024)).text; }
    // A failed CALL is not a verdict on the house: say so, and let the text
    // rules stand. (It used to return DROP, so a typo in the model name
    // auto-passed every listing in the run.)
    catch (e) { return { error: true, reason: 'AI call failed: ' + e.message }; }
    // An empty or unreadable answer is not a DROP either (a "thinking" model
    // can spend its whole budget before writing anything).
    if (!/\{[\s\S]*"decision"[\s\S]*\}/.test(text || '')) return { error: true, reason: 'AI gave no usable answer' + (text ? ': "' + String(text).trim().slice(0, 80) + '"' : ' (empty reply)') };
    let o = {}; const m = text.match(/\{[\s\S]*\}/);
    // An answer that does not parse is not a verdict (an empty object used to read as DROP).
    try { o = JSON.parse(m ? m[0] : text); } catch (_) { return { error: true, reason: 'AI answer was not valid JSON: "' + String(text).trim().slice(0, 80) + '"' }; }
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
    return { decision, reason: reason.slice(0, 300), photos: photos.length, raw: o };
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
  aiFailStreak = 0; lastAiError = '';
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
    if (!(aiReady())) {
      log('Photo check is off — leads are judged on the remarks only, so look at each lead\'s photos before calling.', 'warn');
    } else log(`AI photo check is on — ${aiName(cfg.apiKey)} · ${aiModel()}`, 'good');

    // Pull the reviewer's rejections down first, so anything she deleted is
    // treated as already-checked and never resurfaces.
    await syncRejectedIntoLedger();
    // Our own past deals, for the second look at listings the gate would drop.
    pastDeals = await loadPastDeals();

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
        price: r._price, ppsf: r._ppsf || '', sqft: r._sqftRaw || r._sqft || '', dom: r._dom, reason: r._reason,
        link: core.mlsUrl(r.mls),
      }));
      if (filterRejects.length) log(`[${label}] ${filterRejects.length} failed the buy-box filter — all logged with the reason`);

      const seen = loadLedger();
      // A house the Redfin scan already kept is on the sheet under the number
      // Redfin showed (sometimes without the board prefix, e.g. 41149486 for
      // BE41149486) — match on digits so it is not added a second time.
      const redfinKept = new Set(Object.keys(seen).filter(k => /^RF\d+$/.test(k) && seen[k].verdict === 'kept' && seen[k].mls)
        .map(k => String(seen[k].mls).replace(/\D/g, '')).filter(d => d.length >= 6));
      const fresh = cityCands.filter(c => !core.ledgerSkips(seen[String(c.mls || '').trim().toUpperCase()], todayKey())
        && !redfinKept.has(String(c.mls || '').replace(/\D/g, '')));
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
      const cityRR = [];   // Coming Soon rechecks this city put on the re-review list
      for (let i = 0; i < fresh.length; i++) {
        if (await stopRequested()) break;   // save what was read, then stop
        const c = fresh[i];
        log(`[${label}] Photo-review ${i + 1}/${fresh.length}: ${c.addr}`);
        if (markRecheck(c.mls, c.mls)) { cityRR.push(c.mls); log('  Coming Soon recheck — opened again now that its photos may be up', 'good'); }
        const gal = await showGallery(c.mls).catch(e => ({ count: 0, failed: true, error: e.message }));
        // Nothing read (report did not load, window closed, number not found):
        // not a verdict — skip WITHOUT a ledger entry so the next run retries.
        if (gal.failed || gal.notFound) {
          log(`  SKIPPED ${c.addr} — ${gal.notFound ? 'the MLS found no listing under ' + c.mls : 'its report could not be read' + (gal.error ? ' (' + gal.error + ')' : '')}; will retry next run`, 'warn');
          continue;
        }
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
          dom: domOf(c), yearBuilt: c._yearBuilt || (c._age > 0 ? new Date().getFullYear() - c._age : ''),
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
        const csTooFew = c._comingSoon && n <= 4;   // none posted yet counts too
        if (csTooFew) q.why += ' + AI photo check waits for the photos to post';
        // THE SECOND LOOK (v1.74, Seth 21 Oct). A low-score C is not thrown away
        // when we made money on a house in the same city at a similar price: it
        // goes to B for a person, and — being a B now — to the AI photo check
        // below, which can still drop it. Hard exclusions are never touched.
        const sl = core.applySecondLook(q, { city: cityOf(c), price: gal.listPrice || c._price }, pastDeals);
        if (q.secondLook) log(`  ${sl.why} — held at B for a person instead of being dropped`, 'good');
        else if (sl && !sl.keep) log(`  ${sl.why}`);
        let aiJudged = false;   // a photo verdict was reached (makes a Coming Soon verdict final)
        // Why the photos were not judged, said on the lead itself (v1.72.2):
        // a lead with no photo verdict used to look exactly like one the AI kept.
        const askAi = !core.isConfirmed(c.addr) && !q.hard && q.bucket !== 'C' && !csTooFew;
        let aiMiss = !askAi ? '' : !aiReady() ? 'AI photo check off' : aiFailStreak >= 3 ? 'AI check stopped after 3 failed calls' : '';
        if (aiReady() && aiFailStreak < 3 && askAi) {
          // AI vision still has the final say on condition when it is on: a
          // DROP from the photos is an auto-pass whatever the text scored.
          const v = await autoDecide({ ...c, _cityKey: cityOf(c), _sqft: c._sqft, _price: c._price, _gal: gal });
          if (v.error) {
            // the text verdict stands; three failures in a row = stop asking this run
            // (photos that would not download are not the AI failing)
            if (!v.noPhotos) aiFailStreak++;
            aiMiss = v.noPhotos ? 'no photos could be loaded' : 'AI call failed';
            log(`  ${v.reason} — kept the text rules' verdict`, 'warn');
            if (aiFailStreak >= 3) log('AI vision failed 3 times in a row — turned off for the rest of this run. Check the key and model in section 2 (Test key).', 'error');
          } else if (v.decision !== 'keep') {
            aiFailStreak = 0; aiJudged = true;
            Object.assign(q, { bucket: 'C', label: core.BUCKET_LABEL.C, decision: 'drop',
              score: Math.min(q.score, 15), why: 'AI (vision): ' + v.reason });
          } else {
            aiFailStreak = 0; aiJudged = true;
            q.why = q.why + ' + AI (vision) keep: ' + v.reason;
          }
        }
        if (q.decision === 'keep') {
          if (aiJudged) runKpi.photoChecked++;
          else if (aiMiss) q.why += ` + photos NOT checked (${aiMiss}) — look at them before calling`;
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
        if (q.secondLook) {
          if (decision === 'keep') runKpi.secondLook++;
          else log('  the photos dropped it anyway — no second look for a house the AI turned down', 'info');
        }
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
        // A Coming Soon listing judged before its photos could be checked is a
        // first look only: it is opened again in a couple of days. A remarks
        // hard exclusion (renovated, fire, tenant, structural) is final.
        if (c._comingSoon) recordComingSoon(c.mls, { decision, extra: { addr: c.addr, city: cityOf(c) },
          provisional: !aiJudged && !q.hard && !core.isConfirmed(c.addr) });
        else ledgerRecord(c.mls, decision === 'keep' ? 'kept' : 'dropped', { addr: c.addr, city: cityOf(c) });
      }

      // --- comps: sold homes and the ARV for every kept lead (v1.73) ---
      // Seth, 20 Oct: the app fetches the comps and the ARV; the board turns
      // them into rehab, holding, selling costs and profit from its own
      // Settings. So EVERY kept lead goes to the sheet, comped or not — there is
      // no profit gate here any more (that needs selling costs the app does not
      // have). Section 3's "Run comps on A/B leads" turns this step off.
      const cityLeads = [];
      const comping = cfg.runComps !== false && kept.length > 0;
      if (comping) send('city', { label, index: ai + 1, total: areas.length, phase: 'comping', count: kept.length });
      const compCache = comping ? loadCompCache() : null;
      for (const c of kept) {
        // A Stop skips the comps of the rest, never the leads themselves: they
        // were reviewed and the ledger already counts them as checked.
        let comp = null;
        if (comping && !(await stopRequested())) {
          log(`[${label}] Comps for ${c.addr}…`);
          try { comp = await compsFor(c, compCache); }
          catch (e) { comp = { arv: 0, reason: 'comps failed: ' + e.message, list: [] }; log(`  comps failed: ${e.message} — the lead goes to the sheet without an ARV`, 'warn'); }
          const k = comp.arv ? 'comps' + comp.conf : 'compsNone';
          runKpi[k] = (runKpi[k] || 0) + 1;
          if (comp.arv) runKpi.compsValued++;
          log(`  ${core.compSummary(comp)}${comp.read ? ` · ${comp.read} sold report(s) read` : ''}`, comp.arv ? 'good' : 'warn');
        }
        cityLeads.push({
          mls: c.mls, address: c.fullAddr || c.addr, city: cityOf(c), zip: c.zip || '',
          beds: c.bds, baths: c.baths || '', sqft: c._sqft,
          lotSqft: core.num(c.lotSqft || 0) || '',
          // The report's own year beats 2026 - Age, which reads "2026" when
          // the grid's Age column is blank.
          yearBuilt: c._yearBuilt || (c._age > 0 ? new Date().getFullYear() - c._age : ''),
          dom: domOf(c), price: c._price, ppsf: c._ppsf,
          ...compFields(comp),
          recommendation: comp && comp.arv ? '' : 'Needs Comps', flipQuality: '', score: '',
          risks: comp && comp.arv ? '' : 'Condition-qualified only — ARV and profit not yet calculated',
          ...gateFields(c),
          link: core.mlsUrl(c.mls),
          // Every kept lead is pushed: the board does the profit math.
          surface: true, needsComps: !(comp && comp.arv),
        });
      }
      if (compCache) saveCompCache(compCache);
      if (!comping && kept.length) log(`[${label}] comps off — ${cityLeads.length} condition-qualified listing(s)`, 'good');

      leads.push(...cityLeads);
      // A before B, then the higher Opportunity Score; cheapest $/sqft breaks ties.
      leads.sort((a, b) => String(a.bucket || 'Z').localeCompare(String(b.bucket || 'Z'))
        || (b.oppScore || 0) - (a.oppScore || 0)
        || (a.ppsf || Infinity) - (b.ppsf || Infinity));
      runKpi.leads = leads.length;
      runKpi.gateCleared = leads.filter(l => l.surface).length;
      send('report', { leads, generatedAt: new Date().toString(), partial: ai + 1 < areas.length });

      // Hand this city's winners to the sheet now, so finished work is visible
      // even if a later city fails or you stop the run.
      let cityWinners = cityLeads.filter(l => l.surface);
      if (cityWinners.length || cityRejects.length) {
        const rows = cityWinners.map(toSheetRow);
        // Primary path: write into the spreadsheet over the Sheets API, using
        // the Google account signed in at section 8. The rows are in the sheet
        // by the time this line logs — nothing to refresh, nothing to wait for.
        if (googleReady() && googleCfg().autoSync) {
          const s = await googleSync(rows, cityRejects);
          // a listing a person rejected stays off the Lead Board file too
          if (s.ok && s.dead) cityWinners = cityWinners.filter(l => !s.dead[String(l.mls || '').trim().toUpperCase()]);
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
      // Whatever the sheet did not re-judge (a skipped mismatch, a Stop, no sheet
      // connected) comes off the re-review list; what it did is already off.
      clearRecheck(cityRR);
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
    log(cfg.runComps !== false
      ? `Done. ${leads.length} lead(s) on the board, ${runKpi.compsValued} with an ARV from sold comps — the board works out the profit.`
      : `Done. ${leads.length} lead(s) on the board — comps are off, so no ARV yet.`, 'good');
    return { ok: true, leads };
  } catch (e) {
    if (e.message === 'stopped') { log('Scan stopped.', 'warn'); return { ok: false, stopped: true }; }
    log('Scan error: ' + e.message, 'error'); return { ok: false, error: e.message };
  } finally {
    // The run stays "running" until its shutdown (Board rebuild, window close,
    // "done") is over: clearing it first let a new run start underneath and
    // have its window closed by this one's finishRun.
    try {
    // Record even a stopped or failed run — partial work still consumed effort,
    // and a day with three aborted runs should look different from a quiet one.
    const day = recordKpi(runKpi);
    send('kpi', { today: day, history: kpiReport() });
    if (started && googleReady() && googleCfg().autoSync) await rebuildBoard(day).catch(e => log('Board rebuild failed: ' + e.message, 'warn'));
    // Only attempt the KPI push when a sheet is actually connected — an
    // unconfigured app must not log a failure after every single run.
    // FINISH, VISIBLY. The run used to just stop making noise — the MLS window
    // still showed the last gallery, "Now reviewing" still named a property,
    // and there was no way to tell a finished scan from a stalled one.
    // Everything now shuts down on its own and says so.
    finishRun(runKpi, day, started);
    } finally { control.running = false; }
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
  // How many kept leads the AI actually looked at — 16 Oct put 36 on the sheet
  // with none checked and nothing on screen said so.
  let photoLine = '';
  if (runKpi.kept) {
    photoLine = `Photos checked by the AI on ${runKpi.photoChecked} of ${runKpi.kept} kept lead(s)`
      + (runKpi.photoChecked < runKpi.kept ? ` — the other ${runKpi.kept - runKpi.photoChecked} had no photo verdict (their Why says why)`
        + (lastAiError ? `. Last AI error: ${String(lastAiError).slice(0, 160)}` : !aiReady() ? ' (AI photo check is off in section 2)' : '') : '') + '.';
    log(photoLine, runKpi.photoChecked < runKpi.kept && aiReady() ? 'error' : runKpi.photoChecked < runKpi.kept ? 'warn' : 'good');
  }
  // The listings the gate would have dropped that went to a person (v1.74).
  const slLine = runKpi.secondLook ? `Second look: ${runKpi.secondLook} listing(s) the scan would have dropped are on the sheet as B, `
    + 'because we made money on a house in the same city at a similar price — their Why starts "SECOND LOOK".' : '';
  if (slLine) log(slLine, 'good');
  // What the ARVs rest on, said once at the end (v1.73).
  const compsRun = runKpi.compsValued + runKpi.compsNone;
  const compsLine = compsRun ? `Comps: ${runKpi.compsValued} lead(s) valued (${runKpi.compsHigh} high · ${runKpi.compsMedium} medium · `
    + `${runKpi.compsLow} low), ${runKpi.compsNone} without comps.` : '';
  if (compsLine) log(compsLine, runKpi.compsNone ? 'warn' : 'good');
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
    stopped: control.stopped, summary: line + (photoLine ? ' ' + photoLine : '') + (slLine ? ' ' + slLine : '') + (compsLine ? ' ' + compsLine : ''),
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
      // Through the Redfin window's own session (its cookies, as that page
      // would load it), with Redfin as the referrer.
      const ses = ensureRedfinWindow().webContents.session;
      const buf = await timeLimit((async () => {
        const r = await (ses.fetch ? ses.fetch.bind(ses) : net.fetch)(u, { headers: { Referer: 'https://www.redfin.com/' } });
        return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
      })(), 20000, 'photo');
      if (!buf) continue;
      let img = nativeImage.createFromBuffer(buf);
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
    if (control.stopped || wc.isDestroyed()) break;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await sleep(Math.max(500, pause));
    const before = all.size;
    (await grab()).forEach(u => all.add(u));
    still = all.size === before ? still + 1 : 0;
  }
  if (!wc.isDestroyed()) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }
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
  // Every refusal says so out loud — in the log AND the status box — so a
  // click that cannot start is never mistaken for a scan that is running.
  const refuse = (msg, extra) => { log(msg, 'error'); send('done', Object.assign({ neverStarted: true, failed: true, summary: msg }, extra)); return { ok: false, error: msg }; };
  if (control.running) {
    const msg = 'Redfin scan NOT started — another run is still finishing. Wait for its "Finished" message, then click 🏠 Scan Redfin again.';
    log(msg, 'error'); return { ok: false, error: 'already running', message: msg };
  }
  const picked = opts && Array.isArray(opts.areaIndexes) ? opts.areaIndexes : null;
  const areas = (picked ? picked.map(i => core.DEFAULT_BUYBOX[i]) : core.DEFAULT_BUYBOX).filter(Boolean);
  if (!areas.length) return refuse('Redfin scan NOT started — no area ticked. Tick at least one area in section 3.');
  // Fixers are decided on the PHOTOS here; with no AI check nothing could
  // ever qualify, and the old fallback to the description is what let
  // good-condition houses through (Bryan, 10 Oct).
  const useAiBefore = cfg.useAI;
  // The photo check runs when section 2 has "Use AI" ticked and a key (Claude
  // or ChatGPT). Without it (Bryan, 12 Oct: no key needed) nothing can judge the photos, so a home is kept only when
  // its own description says it needs work, and every lead says its photos
  // were NOT checked — look at them before calling.
  const noAI = !aiReady();
  if (!noAI) log(`AI photo check is on — ${aiName(cfg.apiKey)} · ${aiModel()}`, 'good');
  if (noAI) log('Redfin scan without the AI photo check (tick "Use AI" in section 2 to turn it on): homes are kept only when their description says they need work (as-is, fixer, original condition…). Each lead says "photos not checked" — look at its photos before calling.', 'warn');
  control.running = true; control.stopped = false; control.paused = false;
  aiFailStreak = 0;
  const runKpi = Object.assign(blankKpi(), { runs: 1 });
  const MAX_PAGES = 25;
  let found = 0;
  const allKept = [];   // every county's leads — the report/Export/Send cover the whole run, not the last county
  const runRR = [];   // re-review keys this run added; cleared again even if the run fails
  try {
    rfDiag = [];
    log('━━━ Redfin — Coming Soon & Early Access (no MLS sign-in) ━━━', 'good');
    // Bring the Redfin window to the front so the run can be watched — it
    // used to open behind the app and the scan looked like it never started.
    { const w = ensureRedfinWindow(); if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
    log('Opening redfin.com…');
    await rfNav('https://www.redfin.com/', 4000);
    log('Reading the sheet first so homes already on it are not added twice…');
    // The board's own leads and the Rejected tab first, as the MLS scan does:
    // a Redfin home already on the sheet (1559 Grand Ave was EB41149866 there
    // and came back as "41149866") must not be added a second time.
    { const sr = await timeLimit(syncRejectedIntoLedger(), 90000, 'Reading the sheet').catch(e => ({ ok: false, error: e.message }));
      if (sr && !sr.ok && !sr.unconfigured) log(`  could not read the sheet first: ${sr.error}`, 'warn'); }
    // The ledger knows every MLS # the MLS scans have checked; Redfin shows the
    // same numbers, sometimes without the board's prefix — match on digits too.
    const seen = loadLedger();
    // Redfin's own entries (RF<homeId>) are left out: a home id is not an MLS #.
    const mlsKeys = Object.keys(seen).filter(k => !/^RF\d+$/.test(k));
    const seenDigits = new Set(mlsKeys.map(k => k.replace(/\D/g, '')).filter(d => d.length >= 6));
    const isSeen = id => !!id && !/^RF\d+$/.test(id) && ((seen[id] && !/^RF/.test(id)) || seenDigits.has(id.replace(/\D/g, '')));
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
      if (control.stopped) break;   // a Stop is not "Redfin returned nothing"
      if (!cardsSeen) {
        const dir = path.join(app.getPath('userData'), 'grid-debug');
        try {
          fs.mkdirSync(dir, { recursive: true });
          const f = path.join(dir, `redfin-${area.county.replace(/\W+/g, '-')}-${Date.now()}`);
          fs.writeFileSync(f + '.txt', String(await rfJs('location.href + "\\n\\n" + document.body.innerText.slice(0, 20000)').catch(() => '')));
          fs.writeFileSync(f + '.png', (await timeLimit(ensureRedfinWindow().webContents.capturePage(), 15000, 'screenshot')).toPNG());
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
      // Keyed on the MLS # only for a PHOTO verdict; a buy-box skip judged from
      // Redfin's data is keyed RF<homeId>, so it can never stop the MLS scan
      // from judging that listing itself (every Rejected MLS # is pulled into
      // the MLS scan's ledger).
      const rejectRow = (c, reason, stage) => ({ mls: stage === 'Photo review' && c.mls ? c.mls : ('RF' + c.homeId), addr: c.addr, city: (c.addr.split(',')[1] || area.county).trim(),
        zip: (c.addr.match(/\b(9\d{4})$/) || [])[1] || '', price: c.price, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '', sqft: c.sqft,
        dom: c.dom, reason, stage, link: c.url });
      // Already-renovated wording (Rule #0), fire, tenant, structural: a final
      // drop, read from whatever description we have — no need to open the
      // home or step through its photos for a house the listing itself says
      // is done (Bryan, 10 Oct: "they keep navigating property that has already
      // renovated").
      const textHard = (c, remarks, h) => {
        if (!remarks || core.isConfirmed(c.addr)) return null;
        const q0 = core.qualify({ addr: c.addr, remarks, propClass: (h && h.propClass) || '', photos: 20, photosReliable: false,
          dom: '', yearBuilt: (h && h.year) || c.year || '', price: c.price, whenUnsure: cfg.whenUnsure, comingSoon: true });
        return q0.hard ? q0 : null;
      };
      const inBox = [];
      early.forEach(c => {
        const why = core.redfinBuyBox(c, area, 'list');
        if (!why) {
          const hard = textHard(c, c.remarks);
          if (!hard) {
            // Already checked by an MLS scan or on the board: skip BEFORE opening the page.
            if (isSeen(c.mls) || (c.mlsDigits && seenDigits.has(c.mlsDigits))) {
              if (!seen['RF' + c.homeId]) ledgerRecord('RF' + c.homeId, 'on-mls', { addr: c.addr });
              return;
            }
            inBox.push(c); return;
          }
          // dropped on an earlier run already — but a held ("recheck") home is closed out now
          if (seen['RF' + c.homeId] && seen['RF' + c.homeId].verdict !== 'recheck') return;
          log(`  skip ${c.addr} — ${hard.why} (from Redfin's description; not opened)`);
          rejects.push(rejectRow(c, 'Auto-pass: ' + hard.why, 'Qualification gate'));
          ledgerRecord('RF' + c.homeId, 'dropped', { addr: c.addr, reason: hard.why });
          return;
        }
        log(`  skip ${c.addr} — ${why}`);
        const prev = seen['RF' + c.homeId];
        // Logged to the sheet once per reason, not on every run — and never over
        // a final verdict (a kept lead whose price went up stays kept; a held
        // home keeps its recheck count).
        if (!prev || (prev.verdict === 'buybox' && prev.reason !== why)) {
          rejects.push(rejectRow(c, why, 'Buy-box filter'));
          ledgerRecord('RF' + c.homeId, 'buybox', { addr: c.addr, reason: why });
        }
      });
      const fresh = inBox.filter(c => !core.ledgerSkips(seen['RF' + c.homeId], todayKey()));
      const rrIds = runRR;   // re-review keys this run put on the list
      log(`${label}: ${cardsSeen} houses on Redfin → ${early.length} Coming Soon / Early Access → ${inBox.length} single-family under the cap → ${fresh.length} new`, 'good');
      // --- read each one's own page, judge it like an MLS listing ---
      for (let i = 0; i < fresh.length; i++) {
        if (await stopRequested()) break;
        if (aiFailStreak >= 3) { log('  AI photo check is down — not opening the rest; they stay unchecked and are tried next run.', 'error'); break; }
        const c = fresh[i];
        // One home failing (window closed, page error) must not lose the
        // area's other leads: they are written after this loop.
        try {
        log(`[Redfin ${area.county}] opening ${i + 1}/${fresh.length}: ${c.addr || c.url} — ${c.badge}`, 'good');
        const isRecheck = !!(seen['RF' + c.homeId] && seen['RF' + c.homeId].verdict === 'recheck');
        if (isRecheck) log('  recheck — opened again now that its photos may be up', 'good');
        send('review', { i: i + 1, total: fresh.length, city: area.county, mls: 'RF' + c.homeId, addr: c.addr,
          price: c.price, sqft: c.sqft, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '', photos: 0,
          remarks: c.remarks || '', details: {}, verdict: 'reviewing', why: 'Reading the Redfin page' });
        await rfNav(c.url, 4000);
        // Redfin sends a removed or moved listing somewhere else; judging that
        // page would put another house's facts under this address. Skip without
        // a ledger entry, so the next run tries again.
        const onHome = u => new RegExp('/home/' + c.homeId + '(?:$|[/?#])').test(String(u || ''));
        const at = String(await rfJs('location.href').catch(() => '')).split(/[?#]/)[0];
        if (!onHome(at)) { log(`  skipped — Redfin opened ${at || 'nothing'} instead of this home; will try again next run`, 'warn'); continue; }
        // Quick look first (no scrolling, no photos): a price over the cap, a
        // non-house, or "remodeled / turnkey" wording ends it here.
        {
          const h0 = core.parseRedfinHome(String(await rfJs('document.body.innerText').catch(() => '')));
          const pt0 = core.resolveRedfinType(h0.ptype, h0.ptypeLabelled, c.ptype);
          const box0 = core.redfinBuyBox({ ...c, price: Math.max(c.price || 0, h0.price || 0), ptype: pt0, year: h0.year || c.year }, area, 'list');
          const why0 = box0 || ((textHard(c, h0.remarks || c.remarks, h0) || {}).why || '');
          if (why0) {
            log(`  skip — ${why0}`);
            rejects.push(rejectRow(c, why0, box0 ? 'Buy-box filter' : 'Qualification gate'));
            // a buy-box skip stays re-checkable (price cut, page fixed); renovated wording is final
            ledgerRecord('RF' + c.homeId, box0 ? 'buybox' : 'dropped', { addr: c.addr, reason: why0 });
            continue;
          }
        }
        const text = await readWholePage(rfJs);
        const html = await rfJs('document.documentElement.innerHTML').catch(() => '');
        const h = core.parseRedfinHome(text);
        // Fill what the page did not say from Redfin's data for the home.
        if (!h.remarks && c.remarks) h.remarks = c.remarks;
        if (!h.year && c.year) h.year = c.year;
        if (h.dom === '' && c.dom !== '' && c.dom != null) h.dom = c.dom;
        if (!h.mls && c.mls) h.mls = c.mls;
        if (!h.mlsDigits && c.mlsDigits) h.mlsDigits = c.mlsDigits;
        // The page says what the list may not have: the type, the year.
        // The page's "Property type" label wins; a type the page only shows on a
        // line of its own counts when Redfin's data has not already said house.
        const ptype = core.resolveRedfinType(h.ptype, h.ptypeLabelled, c.ptype);
        const pageBox = core.redfinBuyBox({ ...c, price: Math.max(c.price || 0, h.price || 0), ptype, year: h.year || c.year }, area, 'page');
        const pageWhy = pageBox || ((textHard(c, h.remarks, h) || {}).why || '');
        if (pageWhy) {
          log(`  skip — ${pageWhy}`);
          rejects.push(rejectRow(c, pageWhy, pageBox ? 'Buy-box filter' : 'Qualification gate'));
          ledgerRecord('RF' + c.homeId, pageBox ? 'buybox' : 'dropped', { addr: c.addr, reason: pageWhy });
          continue;
        }
        if (/sign in|join or sign/i.test(text.slice(0, 3000)) && !h.remarks) log('  this Early Access home is only shown in full when signed in to Redfin', 'warn');
        if (isSeen(h.mls) || (h.mlsDigits && seenDigits.has(h.mlsDigits))) { log(`  already checked as ${h.mls || h.mlsDigits} by an MLS scan or on the board — skipped`); ledgerRecord('RF' + c.homeId, 'on-mls', { addr: c.addr }); continue; }
        const city = (c.addr.split(',')[1] || area.county).trim();
        const sheetId = String(h.mls || ('RF' + c.homeId)).toUpperCase();
        if (isRecheck) {
          const rr = loadRereview(); rr.mls[sheetId] = true; if (!rr.date) rr.date = 'Coming Soon recheck'; saveRereview(rr);
          rrIds.push(sheetId);
        }
        // PHOTOS FIRST (Bryan, 2 Oct: "only fixer property, look on the photo
        // first"). Every photo is stepped through in Redfin's viewer and judged
        // before anything else; a house the photos do not show as a fixer is
        // dropped here, before the agent or the description is even read.
        const seenPhotos = await viewRedfinPhotos(Number(cfg.scrollPauseMs) || 700);
        // Stopped mid-walk: a partial gallery is not judged (Rule #2) and no AI
        // call is paid for — no ledger entry, so the next run opens it again.
        if (control.stopped) { log('  stopped during the photo walk — this home is tried again next run', 'warn'); break; }
        // Clicking the big photo can lead off the page (street view, a tour);
        // come back before anything else is read, or the agent would be the
        // wrong page's.
        const after = String(await rfJs('location.href').catch(() => '')).split(/[?#]/)[0];
        const galleryOk = onHome(after);   // photos seen off-page are not this house's
        if (!galleryOk) await rfNav(c.url, 3000);
        // This listing's photos only — never the "similar homes" thumbnails.
        const urls = core.redfinSubjectPhotos(galleryOk ? seenPhotos : [], core.redfinPhotoUrls(html), h.mls || h.mlsDigits);
        log(`  looked through ${urls.length} photo(s)`, urls.length > 4 ? 'good' : 'warn');
        const tooFew = urls.length <= 4;
        let aiKept = false, aiWhy = '';
        if (aiReady() && aiFailStreak < 3 && !tooFew && !core.isConfirmed(c.addr)) {
          const b64 = await collectPhotosDirect(urls, 20);
          // Photos the AI could not be given are not a verdict on the house.
          const v = !b64.length ? { error: true, reason: `could not download the ${urls.length} photo(s) for the AI check` }
            : await autoDecide({ addr: c.addr, _cityKey: city, _sqft: c.sqft, _price: c.price, _gal: { b64, remarks: h.remarks } });
          // The photos must SHOW a fixer — heavy wear, or some wear on original
          // finishes. The AI's KEEP alone is not enough (a quiet "bring your
          // vision" used to rescue a house the photos showed in good shape).
          const notFixerPhotos = !v.error && v.decision === 'keep' ? core.redfinPhotoFixer(v.raw) : '';
          if (v.error) {
            if (b64.length) aiFailStreak++;   // a photo download problem is not an AI failure
            log(`  ${v.reason} — no photo verdict, so it is held (not added as a lead)`, 'warn');
            if (aiFailStreak >= 3) log('AI photo check failed 3 times in a row — off for the rest of this run. Check the key in section 2 (Test key).', 'error');
          } else if (v.decision !== 'keep' || notFixerPhotos) {
            aiFailStreak = 0;
            const why = notFixerPhotos || ('photos: not a fixer — ' + v.reason);
            log(`  C — Auto-Pass — ${why}`);
            runKpi.reviewed++; runKpi.bucketC++; runKpi.dropped++;
            rejects.push(rejectRow({ ...c, mls: h.mls || c.mls }, 'Auto-pass: ' + why, 'Photo review'));
            send('review', { i: i + 1, total: fresh.length, city: area.county, mls: h.mls || 'RF' + c.homeId, addr: c.addr, price: c.price,
              sqft: c.sqft, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '', photos: urls.length, remarks: h.remarks || '', details: {},
              verdict: 'drop', why });
            ledgerRecord('RF' + c.homeId, 'dropped', { addr: c.addr, city, mls: h.mls || h.mlsDigits || '' });
            continue;
          } else { aiFailStreak = 0; aiKept = true; aiWhy = v.reason; log(`  photos: fixer — ${v.reason}`, 'good'); }
        }
        // No photo verdict (too few photos posted, AI failed, photos would
        // not download): the house cannot be shown to be a fixer, so it is NOT
        // a lead. It is held and opened again in a couple of days. With no
        // AI check at all (noAI) the description decides instead (fixer gate below).
        if (!aiKept && !noAI && !core.isConfirmed(c.addr)) {
          // The description alone can still rule a house OUT for good (renovated,
          // fire, tenant, structural) — no point rechecking those.
          const pre = core.qualify({ addr: c.addr, remarks: h.remarks, propClass: h.propClass, photos: urls.length,
            photosReliable: false, dom: h.dom, yearBuilt: h.year, price: c.price, whenUnsure: cfg.whenUnsure, comingSoon: true });
          if (pre.hard) {
            log(`  C — Auto-Pass — ${pre.why}`);
            runKpi.reviewed++; runKpi.bucketC++; runKpi.dropped++;
            rejects.push({ mls: sheetId, addr: c.addr, city, zip: '', price: c.price, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '',
              sqft: c.sqft, dom: h.dom, reason: 'Auto-pass: ' + pre.why, score: pre.score, why: pre.why, stage: 'Qualification gate', link: c.url });
            ledgerRecord('RF' + c.homeId, 'dropped', { addr: c.addr, city, mls: h.mls || h.mlsDigits || '' });
            continue;
          }
          const why = tooFew ? `only ${urls.length} photo(s) posted so far` : 'photos could not be judged';
          log(`  held — ${why}; not added until the photos show it is a fixer`, 'warn');
          runKpi.reviewed++;
          send('review', { i: i + 1, total: fresh.length, city: area.county, mls: h.mls || 'RF' + c.homeId, addr: c.addr, price: c.price,
            sqft: c.sqft, ppsf: c.sqft ? Math.round(c.price / c.sqft) : '', photos: urls.length, remarks: h.remarks || '', details: {},
            verdict: 'drop', why: 'held — ' + why });
          recordComingSoon('RF' + c.homeId, { provisional: true, decision: 'drop', extra: { addr: c.addr, city, mls: h.mls || h.mlsDigits || '' } });
          clearRecheck([sheetId]);
          continue;
        }
        const ag = core.parseRedfinAgent(await rfJs(JS_REDFIN_AGENT(Number(cfg.scrollPauseMs) || 700)).catch(() => null));
        log(ag.name || ag.phone || ag.email
          ? `  listing agent: ${[ag.name, ag.brokerage, ag.phone, ag.email].filter(Boolean).join(' · ')}`
          : '  listing agent contact not shown on Redfin — call the brokerage', ag.phone || ag.email ? 'good' : 'info');
        const q = core.qualify({
          addr: c.addr, remarks: h.remarks, propClass: h.propClass,
          photos: urls.length, photosReliable: false, dom: h.dom, yearBuilt: h.year,
          price: c.price, whenUnsure: cfg.whenUnsure, comingSoon: true,
        });
        // The photo verdict goes FIRST: the Lead Board shortens the why to 240
        // characters, and a verdict at the end was cut off.
        q.why = 'Redfin ' + c.badge + ' · ' + (aiKept ? 'photos show a fixer: ' + String(aiWhy).slice(0, 90) + ' · ' : '') + q.why;
        if (!aiKept && noAI) q.why += ' + photos NOT checked (AI photo check off) — look at them before calling';
        if (tooFew) q.why += ' + photos not posted on Redfin yet — check them before offering';
        // Fixers only (Bryan, 2 Oct: "on early access make sure only fixer").
        // A Coming Soon / Early Access home stays only if its description says
        // it needs work, or the AI saw the wear in its photos.
        // The photos showed a fixer: the text score can no longer drop it — only
        // a hard exclusion (renovated wording, fire, tenant, structural) can. A
        // low score from "staged" or "newer build" used to make it a final C.
        if (aiKept && !q.hard && q.decision !== 'keep') {
          Object.assign(q, { bucket: 'B', label: core.BUCKET_LABEL.B, decision: 'keep', score: Math.max(q.score, 35),
            why: q.why + ' (kept: the photos show a fixer)' });
        }
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
        // No photo verdict (photos not posted, AI off or unable) = a first look
        // only; it is opened again in a couple of days.
        recordComingSoon('RF' + c.homeId, { decision: q.decision, extra: { addr: c.addr, city, mls: h.mls || h.mlsDigits || '' },
          provisional: !aiKept && !q.hard && !core.isConfirmed(c.addr) });
        } catch (e) {
          log(`  ${c.addr || c.url}: ${e.message} — skipped, tried again next run`, 'warn');
          if (!rfWin || rfWin.isDestroyed()) { log('  the Redfin window was closed — stopping here; what was found so far is saved', 'warn'); break; }
        }
      }
      found += kept.length;
      let synced = false;
      if (kept.length || rejects.length) {
        const rows = kept.map(toSheetRow);
        if (googleReady() && googleCfg().autoSync) {
          const r = await googleSync(rows, rejects);
          if (r.ok) { synced = true; runKpi.pushed += r.leads.added; log(`[Redfin ${area.county}] sheet: ${r.leads.added} new lead(s)`, 'good'); }
          else log(`[Redfin ${area.county}] sheet write failed: ${r.error} — kept in the local backup`, 'warn');
        }
        writeBackup(rows, rejects);
        if (kept.length) {
          const b = writeBoardScan(kept);
          log(b.ok ? `[Redfin ${area.county}] ${kept.length} lead(s) added to today's Lead Board file` : `could not write the Lead Board file: ${b.error}`, b.ok ? 'good' : 'warn');
        }
      }
      clearRecheck(rrIds);   // idempotent: what the sheet took is already off
      allKept.push(...kept);
      send('report', { leads: allKept.slice(), generatedAt: new Date().toString(), partial: ai + 1 < areas.length });
    }
    return { ok: true, found };
  } catch (e) {
    log('Redfin scan error: ' + e.message, 'error'); return { ok: false, error: e.message };
  } finally {
    cfg.useAI = useAiBefore;
    try {
    clearRecheck(runRR);
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
    } catch (e) { log('Redfin wrap-up: ' + e.message, 'warn'); send('done', { stopped: control.stopped, summary: 'Redfin scan finished (wrap-up error: ' + e.message + ')', redfin: true }); }
    finally { control.running = false; }   // only now — see the MLS scan's finally
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
  if (!g.refreshToken) throw new Error('not signed in to Google yet — section 8');
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
  // Comps (v1.73) — also at the END, for the same reason. "Comps" is the
  // sold homes as compact JSON: [{mls, addr, price, sqft, ppsf, sold, bd, ba,
  // yr, use, why}], use 1 = counted in the ARV. The boards read it through
  // flipscout-board/test/comps.py.
  'ARV', 'ARV $/SqFt', 'Comp Confidence', 'Comps', 'Comps Run On',
  // The listing's public remarks ("Public:" on Client Full) — read on every
  // review but never written until v1.73, so the boards saw none.
  'Public Remarks',
];
// Remarks are capped like the parsers cap them (privateRemarks, parseDetail).
const REMARKS_MAX = 1500;
// Read fresh off the listing on every review, so a re-review replaces them —
// an offer date goes from "TBD" to a real date, remarks get edited. The comps
// too: a re-review's comps replace the old ones (a blank never wipes them).
const GATE_HEADERS = ['Bucket', 'Opportunity Score', 'Why', 'Price Cut', 'Offer Due', 'Private Remarks', 'Occupied By', 'MLS Status',
  'Agent Phone', 'Agent Email', 'Showing', 'Disclosures',
  'ARV', 'ARV $/SqFt', 'Comp Confidence', 'Comps', 'Comps Run On', 'Public Remarks'];
// Facts re-read by "Refresh leads on the board" — the listing's own data, never
// the reviewer's columns. Bucket / score are only filled where still blank.
const FACT_HEADERS = ['Price Cut', 'Listing Agent', 'Offer Due', 'Private Remarks', 'Occupied By', 'MLS Status',
  'Agent Phone', 'Agent Email', 'Showing', 'Disclosures', 'Public Remarks'];
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

const today = () => todayKey();   // local day, like the ledger (toISOString is UTC: an evening scan was stamped tomorrow)
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
  'ARV': r.arv || '', 'ARV $/SqFt': r.arvPpsf || '', 'Comp Confidence': r.compConf || '',
  'Comps': r.comps || '', 'Comps Run On': r.compsAt || '',
  'Public Remarks': String(r.remarks || '').slice(0, REMARKS_MAX),
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
  if (!g.refreshToken) return { ok: false, unconfigured: true, error: 'not signed in to Google — section 8' };
  if (!g.sheetId) return { ok: false, unconfigured: true, error: 'no spreadsheet URL yet — section 8' };
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
    // A listing a PERSON rejected is never re-written (its By would become FlipScout).
    const rrRejects = (rejects || []).filter(r => isRR(r) && !dead[String(r.mls || '').trim().toUpperCase()]);
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
        await gsheets.syncRows(token, g.sheetId, g.leadTab, LEAD_HEADERS, 'MLS #', down, { overwrite: ['Bucket', 'Opportunity Score', 'Why'], patchOnly: true });
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
    return { ok: true, leads: L, rejects: R, blocked, dead };
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
    remarks: c._remarks || g.remarks || '', redfin: c._redfin || '',
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
    arvPpsf: l.arvPpsf || '', compConf: l.compConf || '', comps: l.comps || '', compsAt: l.compsAt || '',
    rehabLight: l.rehabLight || '', rehabHeavy: l.rehabHeavy || '',
    holding: l.holding || '', maxOffer: l.recommendedMaxOffer || '',
    score: l.score || '', recommendation: l.recommendation || '', flipQuality: l.flipQuality || '',
    bucket: l.bucketLabel || '', oppScore: l.oppScore, why: l.why || '',
    priceCut: l.priceCut || '', listedBy: l.listedBy || '',
    offerDue: l.offerDue || '', privateRemarks: l.privateRemarks || '', occupiedBy: l.occupiedBy || '',
    remarks: l.remarks || '',
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
      // RF<homeId> ids are left to the Redfin scan's own ledger: its buy-box
      // skips must stay re-checkable after a price cut, and 🧹 frees them to be
      // judged again — a blanket "scan-dropped" here would lock them out.
      const isRF = k => /^RF\d+$/.test(k);
      const ids = rgrid.slice(1).map(r => String((r && r[iM]) || '').trim().toUpperCase())
        .filter(k => k && !rrSet[k] && !isRF(k));
      // A scan's buy-box drop (over the cap, no real sqft…) is not final: a
      // price cut or a corrected sqft must let it back in. Ledgered "buybox",
      // which ledgerSkips never treats as checked.
      const iS = ((rgrid[0]) || []).indexOf('Stage'), buyBox = {};
      rgrid.slice(1).forEach(r => { const k = String((r && r[iM]) || '').trim().toUpperCase();
        if (k && iS >= 0 && /buy-?box/i.test(String(r[iS] || ''))) buyBox[k] = true; });
      const seen = loadLedger();
      // A PERSON's rejection also replaces a verdict already in the ledger that
      // is not one (a Coming Soon "recheck" would otherwise re-open it later).
      const fresh = ids.filter(m => { const e = seen[String(m).trim().toUpperCase()]; return m && (!e || (people[m] && e.verdict !== 'reviewer-rejected')); });
      if (fresh.length) {
        ledgerRecordMany(fresh.map(m => ({ mls: m, verdict: people[m] ? 'reviewer-rejected' : buyBox[m] ? 'buybox' : 'scan-dropped' })));
        log(`Rejections synced: ${fresh.length} new (won't be checked again unless you re-review their scan).`);
      }
      // Leads already on the board are not re-reviewed by a scan either — that
      // was 15 of 16 listings on the first test run, re-reviewed for nothing.
      // "Refresh leads on the board" is what keeps their facts current.
      const lcol = gsheets.colName(LEAD_HEADERS.indexOf('MLS #'));
      const onBoard = info.tabs.indexOf(g.leadTab) < 0 ? []
        : await gsheets.readCol(token, g.sheetId, g.leadTab, `${lcol}2:${lcol}`);
      const seen2 = loadLedger(), rr = loadRereview().mls;
      const freshBoard = onBoard.filter(m => m && !isRF(String(m).trim().toUpperCase()) && !seen2[String(m).trim().toUpperCase()] && !rr[String(m).trim().toUpperCase()]);
      const rrLeft = Object.keys(rr).length;
      if (rrLeft) log(`Re-review: ${rrLeft} listing(s) from ${loadRereview().date} will be judged again by this scan (if they are still in the areas you picked).`, 'warn');
      if (freshBoard.length) {
        ledgerRecordMany(freshBoard.map(m => ({ mls: m, verdict: 'on-board' })));
        log(`Leads already on the sheet: ${freshBoard.length} (skipped by scans — use "Refresh leads on the board").`);
      }
      return { ok: true, total: ids.length, added: fresh.length, onBoard: freshBoard.length };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, unconfigured: true, error: 'connect your Google Sheet in section 8 first' };
}


// ---------- past deals: the second look (v1.74) ----------
// The "Past Deals" tab on the sheet, kept by Cherry and Juan: one row per house
// we bought and sold (Address · City · Bought · Sold · Net …). Read once at the
// start of each MLS scan. No tab, no Google, or an unreadable tab = no second
// look, said once in the log; it never stops a scan.
async function loadPastDeals() {
  const tab = core.PAST_DEALS_TAB;
  if (!googleReady()) { log(`Second look is off — connect the Google Sheet (section 8) so the scan can read its "${tab}" tab.`, 'warn'); return []; }
  try {
    const g = googleCfg();
    const token = await googleToken();
    const info = await gsheets.listTabs(token, g.sheetId);
    if (info.tabs.indexOf(tab) < 0) {
      log(`Second look is off — the sheet has no "${tab}" tab. Add one with the columns ${core.PAST_DEAL_HEADERS.join(' · ')} `
        + '(one row per house we bought and sold) and low-score listings near a past win go to B instead of being dropped.', 'warn');
      return [];
    }
    const p = core.pastDealsFromGrid(await gsheets.readAll(token, g.sheetId, tab));
    if (p.error) { log(`Second look is off — "${tab}": ${p.error}.`, 'warn'); return []; }
    const won = p.deals.filter(d => d.net > 0).length;
    log(`Second look: ${p.deals.length} past deal(s) from "${tab}" (${won} made money, ${p.deals.length - won} lost)`
      + (p.left.length ? ` · ${p.left.length} left out (${p.left.slice(0, 3).map(x => x.addr + ': ' + x.why).join('; ')}${p.left.length > 3 ? '; …' : ''})` : ''),
      p.deals.length ? 'good' : 'warn');
    return p.deals;
  } catch (e) {
    log(`Second look is off — could not read "${tab}": ${e.message}`, 'warn');
    return [];
  }
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
  if (control.running) return { ok: false, error: 'already running', message: 'Refresh NOT started — another run is still finishing. Wait for its "Finished" message, then try again.' };
  if (!googleReady()) return { ok: false, error: 'connect your Google Sheet in section 8 first' };
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
    // A Redfin-only lead (RF<homeId>, or Redfin's own long listing id) has no
    // MLS # to look up — it would only ever come back "Not found".
    const isMlsId = m => /^[A-Z]{2,6}\d{5,}$/.test(String(m || '').trim().toUpperCase());
    const redfinOnly = all.filter(x => !isMlsId(val(x.r, 'MLS #'))).length;
    const todo = all
      .filter(x => isMlsId(val(x.r, 'MLS #')) && !core.PASSED_NOTE.test(val(x.r, 'Notes')) && !core.CLOSED_STATUS.test(val(x.r, 'MLS Status'))
        && !/^C/.test(val(x.r, 'Bucket')))
      .sort((a, b) => rankOf(a.r) - rankOf(b.r) || b.i - a.i)
      .map(x => x.r);
    log(`Refreshing ${todo.length} lead(s), A first then B (reports only, no photos) — `
      + `skipping ${closedN} closed, ${passedN} passed in Notes and ${redfinOnly} Redfin-only (no MLS # to look up)…`, 'good');

    let batch = [];
    // Old broken Portal.aspx links on the rows we are NOT re-reading (closed,
    // passed) are fixed in the same write — no MLS lookup needed for that.
    const skipped = all.map(x => x.r).filter(r => todo.indexOf(r) < 0 && /Portal\.aspx/i.test(val(r, 'MLS Link')));
    const flush = async () => {
      if (!batch.length) return;
      await gsheets.syncRows(await googleToken(), g.sheetId, g.leadTab, LEAD_HEADERS, 'MLS #', batch,
        { overwrite: [...FACT_HEADERS, 'Bucket', 'Opportunity Score', 'Why', 'MLS Link'], patchOnly: true });
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
      const gal = await showGallery(mls, { factsOnly: true }).catch(e => ({ failed: true, error: e.message }));
      if (gal.failed) {
        // The page did not load — that says nothing about the listing. Leave the row as it is.
        log(`    could not read its report${gal.error ? ' (' + gal.error + ')' : ''} — row left as is`, 'warn');
        continue;
      }
      if (gal.mismatch || gal.notFound) {
        // Either it left the Active search (pending / sold / withdrawn) or
        // Matrix showed another listing. Say so; never guess.
        notFound++;
        batch.push({ 'MLS #': mls, 'MLS Status': 'Not found in the MLS — check' });
        log('    not found in the MLS by its number — check it by hand', 'warn');
      } else {
        const list = core.num(gal.listPrice) || core.num(val(r, 'Purchase Price'));
        const orig = core.num(gal.origPrice);
        const offer = core.offerDue([gal.privateRemarks, gal.remarks].filter(Boolean).join(' \n '));
        const rec = {
          'MLS #': mls,
          'Price Cut': orig > list && list ? `-$${Math.round((orig - list) / 1000)}k (${Math.round(100 * (orig - list) / orig)}%)` : '',
          'Listing Agent': gal.listedBy || '', 'Offer Due': offer,
          'Private Remarks': gal.privateRemarks || '', 'Occupied By': gal.occupiedBy || '',
          'Public Remarks': String(gal.remarks || '').slice(0, REMARKS_MAX),
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
              condition: gal.condition, propClass: gal.propClass, occupiedBy: gal.occupiedBy || val(r, 'Occupied By'),
              // The report's own year only: older sheet rows can carry a bogus
              // "2026" (age read blank), which would drop an old house as new.
              yearBuilt: gal.yearBuilt || '' })
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
            dom: val(r, 'DOM'), yearBuilt: gal.yearBuilt || '',
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
    if (started) closeMlsWindow();
    send('done', started
      ? { stopped: control.stopped, summary: `Refresh finished — ${done} updated, ${notFound} not found.` }
      : { neverStarted: true, summary: 'Refresh NOT started — sign in to the MLS first (section 1), then press ↻ Refresh again.' });
    control.running = false;
  }
});

ipcMain.handle('ledger-stats', () => {
  const e = loadLedger();
  const byVerdict = {};
  Object.keys(e).forEach(k => { const v = e[k].verdict || '?'; byVerdict[v] = (byVerdict[v] || 0) + 1; });
  return { total: Object.keys(e).length, byVerdict, file: LEDGER_FILE() };
});

// ---------- 🧹 Clear cache & clean up (v1.61, Bryan 10 Oct) ----------
// Stored pages and old verdicts from earlier builds were carrying their bugs
// forward. This clears the browser caches (sign-ins kept), forgets the Redfin
// verdicts and leftover re-review entries so those homes are judged again by
// today's rules, takes old Redfin leads out of today's Lead Board file, and
// moves every Redfin lead on the sheet that today's rules reject to C — with
// the reason — instead of leaving it on the board.
async function clearBrowserCaches() {
  const parts = [session.defaultSession, session.fromPartition('persist:mls'), session.fromPartition('persist:redfin')];
  for (const ses of parts) {
    try { await ses.clearCache(); } catch (_) {}
    // Everything but cookies: the MLS and Redfin sign-ins stay.
    try { await ses.clearStorageData({ storages: ['shadercache', 'serviceworkers', 'cachestorage', 'filesystem', 'indexdb', 'localstorage', 'websql'] }); } catch (_) {}
  }
}

ipcMain.handle('clear-cache', async () => {
  if (control.running) return { ok: false, error: 'already running', message: 'Clean up NOT started — another run is still finishing. Wait for its "Finished" message, then try again.' };
  control.running = true;
  const out = { cache: false, ledger: 0, rereview: 0, boardFile: 0, sheet: 0, sheetChecked: 0 };
  try {
    log('🧹 Clearing the cache and cleaning up…', 'good');
    await clearBrowserCaches(); out.cache = true;
    log('  browser caches cleared for the app, the MLS and the Redfin windows (sign-ins kept)');
    // Old Redfin verdicts and every pending recheck: judged again by today's rules.
    const e = loadLedger();
    Object.keys(e).forEach(k => { if (/^RF\d+$/.test(k) || ['recheck', 'buybox'].includes(e[k].verdict)) { delete e[k]; out.ledger++; } });
    saveLedger(e);
    log(`  forgot ${out.ledger} old Redfin / recheck verdict(s) — those homes will be judged again`);
    const rr = loadRereview(); out.rereview = Object.keys(rr.mls).length; saveRereview({ date: '', mls: {} });
    if (out.rereview) log(`  cleared ${out.rereview} leftover re-review entr${out.rereview === 1 ? 'y' : 'ies'}`);
    // Today's Lead Board file: Redfin leads made by an older build come out.
    const bs = readBoardScan();
    if (bs) {
      // Hard facts only here (price, unit, age): this file shortens the why, so
      // "never photo-checked" is judged on the sheet, where the why is whole.
      const keep = bs.leads.filter(l => !/^(?:[ABC][^·]*· score \d+ · )?Redfin/i.test(String(l.why || ''))
        || !core.oldRedfinLeadProblem({ addr: l.addr, price: l.price, year: l.year, why: 'photos show a fixer · ' + String(l.why || '') }));
      out.boardFile = bs.leads.length - keep.length;
      if (out.boardFile) { bs.leads = keep; fs.writeFileSync(BOARD_FILE(), JSON.stringify(bs, null, 1)); }
      log(`  took ${out.boardFile} old Redfin lead(s) out of today's Lead Board file`);
    }
    // The sheet: every Redfin lead today's rules reject goes to C, with why.
    if (googleReady()) {
      const g = googleCfg(), token = await googleToken();
      const rows = await gsheets.readAll(token, g.sheetId, g.leadTab);
      const head = (rows[0] || []).map(h => String(h).trim());
      const val = (r, h) => { const i = head.indexOf(h); return i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); };
      const down = [];
      rows.slice(1).forEach(r => {
        const why = val(r, 'Why');
        if (!/^Redfin/i.test(why) || /^C/.test(val(r, 'Bucket')) || core.PASSED_NOTE.test(val(r, 'Notes'))) return;
        out.sheetChecked++;
        const bad = core.oldRedfinLeadProblem({ addr: val(r, 'Address'), price: core.num(val(r, 'Purchase Price')), year: core.num(val(r, 'Year Built')), why });
        if (bad) down.push({ 'MLS #': val(r, 'MLS #'), 'Bucket': core.BUCKET_LABEL.C, 'Opportunity Score': 0, 'Why': `${why} (cleanup ${todayKey()}: ${bad})` });
      });
      if (down.length) await gsheets.syncRows(await googleToken(), g.sheetId, g.leadTab, LEAD_HEADERS, 'MLS #', down, { overwrite: ['Bucket', 'Opportunity Score', 'Why'], patchOnly: true });
      out.sheet = down.length;
      log(`  checked ${out.sheetChecked} Redfin lead(s) on the sheet — moved ${out.sheet} to C (over the cap, a unit, too new, or never photo-checked); the rest still qualify`, 'good');
      await rebuildBoard().catch(() => {});
      log('  On the Lead Board, press "↻ Refresh from sheet" to pick the cleanup up.', 'good');
    } else log('  Google Sheet not connected — the sheet was not cleaned (connect it in section 8 and run this again).', 'warn');
    log('🧹 Done.', 'good');
    return { ok: true, ...out };
  } catch (err) { log('Clean-up failed: ' + err.message, 'error'); return { ok: false, error: err.message, ...out }; }
  finally { control.running = false; }
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
  if (!googleReady()) return { ok: false, error: 'connect your Google Sheet in section 8 first' };
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
  const cols = ['bucketLabel', 'oppScore', 'offerDue', 'agentPhone', 'agentEmail', 'showing', 'disclosures', 'why', 'priceCut', 'listedBy', 'occupiedBy', 'privateRemarks', 'score', 'recommendation', 'flipQuality', 'mls', 'address', 'city', 'zip', 'beds', 'sqft', 'yearBuilt', 'dom', 'price', 'arv', 'arvPpsf', 'compConf', 'compsAt', 'arvBasis'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [cols.join(',')].concat(leads.map(l => cols.map(c => esc(l[c])).join(','))).join('\n');
  fs.writeFileSync(filePath, csv);
  return { ok: true, filePath };
});

app.whenReady().then(async () => {
  // A new version starts with clean browser caches, so pages stored by an
  // older build can't carry its bugs forward. Sign-ins (cookies) are kept.
  try {
    const f = path.join(app.getPath('userData'), 'last-version.txt');
    const last = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
    if (last !== app.getVersion()) { await clearBrowserCaches(); fs.writeFileSync(f, app.getVersion()); }
  } catch (_) {}
  createControlWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createControlWindow(); });
