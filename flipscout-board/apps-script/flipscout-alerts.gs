/**
 * FlipScout — "NEEDS JUAN" Google Chat alerts + the Board's Pass bridge.
 *
 * Lives in the prod sheet ("Updated Flip Scout Agent") next to
 * flip-scout-reject.gs. Everything here is prefixed fs so the two files never
 * collide (they share one namespace, and that file owns onOpen and LEADS_TAB).
 *
 * 1) ALERTS — fsAlertCheck runs at 8:00, 11:15 and 15:00 Pacific on Google's
 *    servers. A lead alerts only if ALL hold:
 *      - Bucket is A ("A — Work Now");
 *      - MLS Status is Active;
 *      - Notes do not start with PASS / passing / rejected (the app's rule)
 *        and do not contain "no alerts";
 *      - Offer Due is a real date (TBD / blank never alerts);
 *      - the deadline is less than 24 hours away and not past.
 *    At most two alerts per lead (inside 24h, then a final call inside 5h),
 *    one message per check with at most 5 leads, and nothing when nothing is
 *    due. What was sent is remembered in Script Properties.
 *
 * 1b) MORNING SUMMARY — fsMorning runs at 8:00: first "📅 OFFERS DUE IN 3
 *    DAYS", then the 8:00 alert check. The list is the Board's "Offers due in
 *    3 days" button: A and B leads, deadline today through 3 days out and not
 *    yet past, not sold / withdrawn / off market, not passed in Notes. One
 *    summary a day (the menu can send it again on purpose); none if the list
 *    is empty.
 *
 * 2) PASS BRIDGE — deployed as a web app, a link like
 *      <web app URL>?action=pass&mls=SF426163762&why=too%20far&by=Seth
 *    writes "PASS (Board) — Seth, Sep 24: too far" at the front of that lead's
 *    Notes, so the app's Refresh and these alerts both skip it.
 *    action=unpass takes that prefix off again.
 *
 * SETUP (once) — see the steps Claude gave you:
 *   Project Settings → Time zone: (GMT-07:00) Pacific Time - Los Angeles
 *   Project Settings → Script Properties → add CHAT_WEBHOOK = <the webhook link>
 *   Run fsSetupSchedule once (approve the permissions it asks for).
 *   Deploy → New deployment → Web app → Execute as: Me,
 *     Who has access: Anyone within twinhomebuyer.com → Deploy → copy the URL.
 *   Optional: run fsSendTest to post a test message.
 *
 * MENU — fsSetupSchedule also adds a "🚨 FlipScout Alerts" menu to the sheet
 * (reload the sheet once to see it): Check now · Preview (sends nothing) ·
 * Send morning summary now · Send test message. It is a separate menu because flip-scout-reject.gs owns
 * onOpen; this one is opened by an installable trigger instead.
 */

const FS_LEADS = 'Leads';
const FS_BOARD_URL = 'https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1';
const FS_FINAL_HOURS = 5;
const FS_MAX_PER_MESSAGE = 5;
const FS_SENT_KEY = 'FS_ALERTS_SENT';
const FS_DIGEST_KEY = 'FS_DIGEST_DAY';
const FS_DIGEST_DAYS = 3;
const FS_CLOSED = /sold|withdrawn|expired|cancel|off.?market|closed|duplicate/i;
const FS_PASSED = /^\s*(?:pass\b|passing\b|passed\b|we'?re passing|rejected\b|not a (?:fit|deal))/i;
const FS_BOARD_PASS = /^PASS \(Board\) — [^|]*?(?:\s\|\s|$)/;

/* ---------------------------------------------------------------- setup -- */

function fsSetupSchedule() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['fsAlertCheck', 'fsOnOpen', 'fsMorning'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('fsOnOpen').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  ScriptApp.newTrigger('fsMorning').timeBased().atHour(8).nearMinute(0).everyDays(1)
    .inTimezone('America/Los_Angeles').create();
  [[11, 15], [15, 0]].forEach(([h, m]) =>
    ScriptApp.newTrigger('fsAlertCheck').timeBased().atHour(h).nearMinute(m).everyDays(1)
      .inTimezone('America/Los_Angeles').create());
  if (!fsWebhook_()) throw new Error('Schedule is on, but CHAT_WEBHOOK is missing — add it under Project Settings → Script Properties.');
  Logger.log('Morning summary + alerts at about 8:00, alerts at 11:15 and 15:00 Pacific. Reload the sheet for the 🚨 FlipScout Alerts menu.');
}

function fsOnOpen() {
  SpreadsheetApp.getUi().createMenu('🚨 FlipScout Alerts')
    .addItem('Check now (send what is due)', 'fsCheckNow')
    .addItem('Preview — show what would send, send nothing', 'fsPreview')
    .addSeparator()
    .addItem('Send morning summary now (offers due in 3 days)', 'fsDigestNow')
    .addItem('Send test message', 'fsSendTest')
    .addToUi();
}

// Same rules as the schedule: only leads that are due and not yet alerted.
function fsCheckNow() {
  const n = fsAlertCheck();
  SpreadsheetApp.getActive().toast(n ? 'Sent 1 message to Google Chat with ' + n + (n === 1 ? ' lead.' : ' leads.')
                                     : 'Nothing due right now — no message sent.', 'FlipScout Alerts', 6);
}

function fsPreview() {
  const got = fsBuild_(new Date());
  const ui = SpreadsheetApp.getUi();
  ui.alert('FlipScout Alerts — preview (nothing sent)',
    got ? got.text.replace(/\*/g, '') : 'Nothing is due right now, so a check would send nothing.', ui.ButtonSet.OK);
}

function fsSendTest() {
  fsPost_('🧪 *TEST — FlipScout alerts from Apps Script*\nThe 8am / 11am / 3pm checks will post here.\n\nBoard: ' + FS_BOARD_URL);
}

/* ------------------------------------------------------ morning summary -- */

// 8:00 — the summary first, then the regular alert check.
function fsMorning() {
  try { fsDigest_(false); } finally { fsAlertCheck(); }
}

function fsDigestNow() {
  const n = fsDigest_(true);
  SpreadsheetApp.getActive().toast(n ? 'Sent the summary with ' + n + (n === 1 ? ' offer.' : ' offers.')
                                     : 'No A or B offers due in the next 3 days — nothing sent.', 'FlipScout Alerts', 6);
}

// Returns how many leads it listed. force = send even if today's already went.
function fsDigest_(force) {
  const now = new Date(), tz = 'America/Los_Angeles';
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty(FS_DIGEST_KEY) === today) return 0;
  const dayNo = d => Math.round(Date.parse(Utilities.formatDate(d, tz, 'yyyy-MM-dd') + 'T00:00:00Z') / 864e5);
  const list = [];
  fsReadLeads_().forEach(l => {
    if (!/^[AB]/i.test(l.bucket)) return;
    if (FS_CLOSED.test(l.mstat)) return;
    if (FS_PASSED.test(l.notes)) return;
    const dl = fsDeadline_(l.due);
    if (!dl || dl.when <= now) return;
    const days = dayNo(dl.when) - dayNo(now);
    if (days < 0 || days > FS_DIGEST_DAYS) return;
    list.push({ l, when: dl.when, stated: dl.stated, days });
  });
  if (!list.length) return 0;
  list.sort((a, b) => a.when - b.when);
  const lines = list.map(d => {
    const l = d.l, day = d.days === 0 ? 'Today' : d.days === 1 ? 'Tomorrow' : Utilities.formatDate(d.when, tz, 'EEE MMM d');
    const time = d.stated ? Utilities.formatDate(d.when, tz, 'h:mm a') : 'time not stated';
    const pend = /pending|contingent/i.test(l.mstat) ? ' · ' + l.mstat.toUpperCase() : '';
    const who = [l.agent, l.phone].filter(Boolean).join(' ');
    return '*' + day + ' · ' + time + '* — ' + l.addr + '\n' +
      l.bucket.charAt(0).toUpperCase() + (l.score ? ' ' + l.score : '') + pend + (who ? ' · ' + who : '');
  });
  fsPost_('📅 *FLIPSCOUT — OFFERS DUE IN 3 DAYS* (' + list.length + ')\n\n' + lines.join('\n\n') + '\n\nBoard: ' + FS_BOARD_URL);
  props.setProperty(FS_DIGEST_KEY, today);
  return list.length;
}

/* --------------------------------------------------------------- alerts -- */

// Returns how many leads it alerted on (0 when nothing was due).
function fsAlertCheck() {
  const now = new Date();
  const got = fsBuild_(now);
  if (!got) return 0;
  fsPost_(got.text);                 // throws on failure, so nothing is marked sent
  const stamp = now.toISOString();
  got.shown.forEach(d => { got.sent[d.l.mls] = Object.assign(got.sent[d.l.mls] || {}, { [d.stage]: stamp }); });
  PropertiesService.getScriptProperties().setProperty(FS_SENT_KEY, JSON.stringify(got.sent));
  return got.shown.length;
}

// The message a check would send now, or null when nothing is due.
function fsBuild_(now) {
  const sent = fsLoadSent_(now);
  const due = [];

  fsReadLeads_().forEach(l => {
    if (!/^A/i.test(l.bucket)) return;
    if (!/^active$/i.test(l.mstat)) return;
    if (FS_PASSED.test(l.notes) || /no alerts/i.test(l.notes)) return;
    const dl = fsDeadline_(l.due);
    if (!dl) return;
    const hours = (dl.when - now) / 36e5;
    if (hours <= 0 || hours > 24) return;
    const stage = hours <= FS_FINAL_HOURS ? 'final' : 'h24';
    const s = sent[l.mls] || {};
    if (s[stage] || (stage === 'h24' && s.final)) return;
    due.push({ l, when: dl.when, stated: dl.stated, stage });
  });

  if (!due.length) return null;
  due.sort((a, b) => a.when - b.when);
  const shown = due.slice(0, FS_MAX_PER_MESSAGE), rest = due.length - shown.length;

  const head = '🚨 *FLIPSCOUT NEEDS JUAN*' + (due.length > 1 ? ' — ' + due.length + ' offers due' : '');
  const blocks = shown.map(d => {
    const l = d.l, tz = 'America/Los_Angeles';
    const day = Utilities.formatDate(d.when, tz, 'EEE MMM d');
    const dueLine = d.stated
      ? '*' + fsLeft_(d.when - now) + '* (' + day + ' ' + Utilities.formatDate(d.when, tz, 'h:mm a') + ')'
      : '*' + (fsSameDay_(d.when, now) ? 'today' : 'tomorrow') + '*, ' + day + ' — time not stated, confirm with the agent';
    const who = [l.agent, l.phone].filter(Boolean).join(' ') || 'no phone on file — see the Board';
    const phrase = fsOfferSentence_(l.remarks);
    return [
      (d.stage === 'final' ? '🔴 *FINAL CALL* — ' : '') + '*' + l.addr + '*',
      'A · Work Now ' + (l.score || '') + (l.price ? ' · $' + Number(l.price).toLocaleString('en-US') : ''),
      '⏰ Offer deadline: ' + dueLine,
      phrase ? '“' + (phrase.length > 140 ? phrase.slice(0, 137).trim() + '…' : phrase) + '”' : '',
      '📞 CALL NOW: ' + who,
      'MLS: https://www.mlslistings.com/Property/' + l.mls
    ].filter(Boolean).join('\n');
  });
  const text = head + '\n\n' + blocks.join('\n\n') +
    (rest ? '\n\n+' + rest + ' more due within 24h — see the Board' : '') + '\n\nBoard: ' + FS_BOARD_URL;

  return { text, shown, sent };
}

/* ---------------------------------------------------------- pass bridge -- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = String(p.action || '');
  const mls = String(p.mls || '').trim().toUpperCase();
  if (!/^(pass|unpass)$/.test(action) || !/^[A-Z0-9]{5,20}$/.test(mls)) {
    return fsPage_('Nothing to do', 'This link is missing the lead or the action. Open it from the FlipScout Board.');
  }
  const email = fsSafeEmail_();
  const by = String(p.by || '').trim().slice(0, 40) || (email ? email.split('@')[0] : 'Someone');
  const why = String(p.why || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(FS_LEADS);
    const values = sh.getDataRange().getValues();
    const head = values[0].map(h => String(h).trim());
    const iM = head.indexOf('MLS #'), iN = head.indexOf('Notes'), iA = head.indexOf('Address');
    if (iM < 0 || iN < 0) return fsPage_('Sheet changed', 'The Leads tab has no "MLS #" or "Notes" column, so nothing was written.');
    const r = values.findIndex((row, i) => i > 0 && String(row[iM]).trim().toUpperCase() === mls);
    if (r < 0) return fsPage_('Lead not on the sheet', mls + ' is not on the Leads tab (it may have been rejected already). The Board still has your pass.');

    const old = String(values[r][iN] || '').replace(FS_BOARD_PASS, '');
    let note;
    if (action === 'pass') {
      const day = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'MMM d');
      note = 'PASS (Board) — ' + by + ', ' + day + (why ? ': ' + why : '') + (old ? ' | ' + old : '');
    } else {
      note = old;
    }
    sh.getRange(r + 1, iN + 1).setValue(note);
    const addr = iA >= 0 ? String(values[r][iA]) : mls;
    return fsPage_(action === 'pass' ? '✓ Passed on the sheet' : '✓ Pass taken off the sheet',
      addr + (action === 'pass' ? ' is marked PASS in Notes. The app and the alerts will skip it.' : ' is back to normal on the sheet.') +
      ' You can close this tab.');
  } finally {
    lock.releaseLock();
  }
}

/* -------------------------------------------------------------- helpers -- */

function fsReadLeads_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(FS_LEADS);
  const values = sh.getDataRange().getDisplayValues();
  const head = values[0].map(h => String(h).trim());
  const col = name => head.indexOf(name);
  const need = ['MLS #', 'Address', 'Notes', 'Bucket', 'Offer Due', 'MLS Status'];
  const missing = need.filter(n => col(n) < 0);
  if (missing.length) throw new Error('Leads tab is missing: ' + missing.join(', '));
  const get = (row, name) => { const i = col(name); return i < 0 ? '' : String(row[i] || '').trim(); };
  return values.slice(1).filter(r => get(r, 'MLS #')).map(r => ({
    mls: get(r, 'MLS #').toUpperCase(), addr: get(r, 'Address'), notes: get(r, 'Notes'),
    bucket: get(r, 'Bucket'), score: get(r, 'Opportunity Score'), due: get(r, 'Offer Due'),
    mstat: get(r, 'MLS Status'), phone: get(r, 'Agent Phone'),
    agent: get(r, 'Listing Agent').split(',')[0].trim(), remarks: get(r, 'Private Remarks'),
    price: get(r, 'Purchase Price').replace(/[^0-9.]/g, '')
  }));
}

// "2026-09-30 (Wed) 12:00 PM" or "2026-09-30 (Wed)" -> {when, stated}; TBD / blank -> null
function fsDeadline_(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s*\(\w+\))?(?:\s+(\d{1,2}):(\d{2}) ([AP]M))?/.exec(v || '');
  if (!m) return null;
  let h = 23, mi = 59, stated = false;
  if (m[4]) { h = (+m[4] % 12) + (m[6] === 'PM' ? 12 : 0); mi = +m[5]; stated = true; }
  const iso = m[1] + '-' + m[2] + '-' + m[3] + 'T' + ('0' + h).slice(-2) + ':' + ('0' + mi).slice(-2) + ':00';
  // the time in the sheet is Pacific; read it as Pacific whatever the project zone is
  const offset = Utilities.formatDate(new Date(iso + 'Z'), 'America/Los_Angeles', 'XXX');
  return { when: new Date(iso + offset), stated };
}

function fsOfferSentence_(text) {
  const m = /[^.!?\n]*\boffers?\b[^.!?\n]*(?:\d|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\bTBD\b)(?:[^!?\n]*?(?:[ap]\.m\.|[.!?](?=\s|$))|[^.!?\n]*)/i.exec(text || '');
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

function fsLeft_(ms) {
  const mins = Math.floor(ms / 60000), h = Math.floor(mins / 60), m = mins % 60;
  return h ? h + 'h ' + ('0' + m).slice(-2) + 'm' : m + 'm';
}

function fsSameDay_(a, b) {
  const f = d => Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
  return f(a) === f(b);
}

// what was sent, forgetting anything older than two weeks so the store stays small
function fsLoadSent_(now) {
  let sent = {};
  try { sent = JSON.parse(PropertiesService.getScriptProperties().getProperty(FS_SENT_KEY) || '{}'); } catch (e) {}
  const cutoff = now.getTime() - 14 * 864e5;
  Object.keys(sent).forEach(k => {
    const t = Math.max(...Object.values(sent[k]).map(x => Date.parse(x) || 0));
    if (t < cutoff) delete sent[k];
  });
  return sent;
}

function fsWebhook_() {
  return PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK') || '';
}

function fsPost_(text) {
  const hook = fsWebhook_();
  if (!hook) throw new Error('CHAT_WEBHOOK is missing — add it under Project Settings → Script Properties.');
  const res = UrlFetchApp.fetch(hook, {
    method: 'post', contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text }), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) throw new Error('Google Chat refused the alert: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
}

function fsSafeEmail_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function fsPage_(title, body) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return HtmlService.createHtmlOutput(
    '<div style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px">' +
    '<h2 style="margin:0 0 8px">' + esc(title) + '</h2><p style="margin:0;color:#444">' + esc(body) + '</p></div>'
  ).setTitle('FlipScout');
}
