/**
 * Gmail reply reminders
 *
 * Watches the emails Juan sends to the team and, when someone hasn't replied,
 * emails them a short reminder: "Juan sent you an email and is waiting for
 * your reply", with a link that opens it in their own Gmail. The reminder
 * never includes the email's subject or content.
 *
 * It reads Juan's mailbox through a service account that a Google Workspace
 * admin allowed to read message headers only (the gmail.metadata scope):
 * who sent it, to whom, when, and the message id. It cannot open bodies or
 * attachments, and Juan installs nothing. Setup steps are in README.md.
 *
 * It runs every 15 minutes on Google's servers. No Claude, no WhatsApp.
 */

const CONFIG = {
  // whose sent emails are watched
  WATCH: ['juan@twinhomebuyer.com'],
  // only people at this domain are reminded
  TEAM_DOMAIN: 'twinhomebuyer.com',
  // addresses never reminded, such as group lists
  IGNORE: [],
  // a reminder once each of these waits has passed, then no more
  REMIND_AFTER_HOURS: [4, 24, 48],
  // emails older than this are left alone
  LOOKBACK_DAYS: 7,
  // Juan can put this Gmail label on an email that needs no reply
  SKIP_LABEL: 'No reply needed',
  // only emails Juan started count. His replies in threads someone else
  // started are usually answers ("Thanks!"), and only headers are read, so
  // they can't be told apart. Set to false to count them too.
  ONLY_THREADS_STARTED: true,
  // emails whose subject starts with one of these need no reply
  SKIP_SUBJECT_PREFIXES: ['fyi'],
  // no reminders are sent between these hours (they wait until morning)
  QUIET_FROM_HOUR: 20,
  QUIET_TO_HOUR: 8,
  TIME_ZONE: 'Asia/Manila',
  // true: write who would be reminded to the log, send nothing
  DRY_RUN: true,
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---------------- reading the headers (pure, tested in test/) ----------------

// "Juan Diaz <juan@x.com>, cherry@x.com" -> [{ email, name }]. Commas inside
// quotes or <...> don't split ("Diaz, Juan" <juan@x.com> is one address).
function parseAddresses(header) {
  if (!header) return [];
  const parts = [];
  let cur = '', quoted = false, angle = false;
  for (const ch of String(header)) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angle = true;
    else if (ch === '>') angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map(part => {
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(part) || /([^\s<>"]+@[^\s<>"]+)/.exec(part);
    if (!m) return null;
    return { email: m[1].toLowerCase(), name: part.replace(m[0], '').replace(/"/g, '').trim() };
  }).filter(Boolean);
}

function headerOf(msg, name) {
  const h = ((msg.payload && msg.payload.headers) || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// One message from the Gmail API (format=metadata) in the shape used below.
function toMessage(msg) {
  return {
    from: parseAddresses(headerOf(msg, 'From'))[0] || { email: '', name: '' },
    to: parseAddresses(headerOf(msg, 'To')),
    subject: headerOf(msg, 'Subject'),
    messageId: headerOf(msg, 'Message-ID').replace(/^<|>$/g, ''),
    at: Number(msg.internalDate),
    labelIds: msg.labelIds || [],
  };
}

// Who still owes the watched person a reply in one thread.
// thread: { id, messages: [toMessage(...)] }. A person owes a reply when the
// watched person emailed them directly (To, not Cc) and they haven't written
// in the thread since. The wait counts from the first email they haven't
// answered. Returns [{ email, name, since, messageId, senderName }].
function pendingInThread(thread, watch, cfg, now, skipLabelId) {
  const msgs = thread.messages.slice().sort((a, b) => a.at - b.at);
  const mine = m => m.from.email === watch;
  if (!msgs.some(mine)) return [];
  if (cfg.ONLY_THREADS_STARTED && !mine(msgs[0])) return [];
  if (skipLabelId && msgs.some(m => m.labelIds.indexOf(skipLabelId) >= 0)) return [];
  const first = msgs.find(mine);
  const subject = (first.subject || '').trim().toLowerCase();
  if (cfg.SKIP_SUBJECT_PREFIXES.some(p => subject.indexOf(p.toLowerCase()) === 0)) return [];
  const domain = '@' + cfg.TEAM_DOMAIN.toLowerCase();
  const ignore = cfg.IGNORE.map(x => x.toLowerCase());
  const oldest = now - cfg.LOOKBACK_DAYS * DAY;
  const people = {};
  msgs.filter(mine).forEach(m => m.to.forEach(r => {
    if (r.email === watch || !r.email.endsWith(domain) || ignore.indexOf(r.email) >= 0) return;
    if (!people[r.email]) people[r.email] = r.name;
  }));
  const out = [];
  Object.keys(people).forEach(email => {
    const lastFromThem = msgs.filter(m => m.from.email === email).reduce((t, m) => Math.max(t, m.at), -Infinity);
    const waiting = msgs.filter(m => mine(m) && m.at > lastFromThem && m.to.some(r => r.email === email));
    if (!waiting.length || waiting[0].at < oldest) return;
    out.push({ email, name: people[email], since: waiting[0].at, messageId: waiting[0].messageId, senderName: first.from.name || watch });
  });
  return out;
}

// How many reminders are due after waiting this long.
function stageFor(waitMs, cfg) {
  return cfg.REMIND_AFTER_HOURS.filter(h => waitMs >= h * HOUR).length;
}

function isQuietHour(hour, cfg) {
  const a = cfg.QUIET_FROM_HOUR, b = cfg.QUIET_TO_HOUR;
  return a > b ? hour >= a || hour < b : hour >= a && hour < b;
}

// A link that opens the email in the recipient's own Gmail.
function gmailLink(email, messageId) {
  return 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(email) + '#search/rfc822msgid%3A' + encodeURIComponent(messageId);
}

function firstName(person) {
  const n = (person.name || '').trim();
  if (n && n.indexOf('@') < 0) return n.split(/\s+/)[0];
  return person.email.split('@')[0];
}

// The reminder: who is waiting and since when, with links. Never the subject
// or content of the email. items: [{ since, messageId, stage }]
function buildReminder(person, senderName, items, cfg, formatTime) {
  const n = items.length;
  const subject = n === 1 ? senderName + ' is waiting for your reply' : senderName + ' is waiting for your reply to ' + n + ' emails';
  const lines = items.map(it => senderName + ' emailed you on ' + formatTime(it.since) + '. Open it: ' + gmailLink(person.email, it.messageId));
  const total = cfg.REMIND_AFTER_HOURS.length;
  const stage = Math.max.apply(null, items.map(it => it.stage));
  const body = 'Hi ' + firstName(person) + ',\n\n'
    + (n === 1 ? senderName + ' sent you an email and is still waiting for your reply.\n\n' : senderName + ' sent you ' + n + ' emails that are still waiting for your reply.\n\n')
    + lines.join('\n') + '\n\n'
    + 'Please reply to ' + senderName + ' in Gmail. This is reminder ' + stage + ' of ' + total + '. It was sent automatically and doesn’t include what the email says.';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = '<p>Hi ' + esc(firstName(person)) + ',</p>'
    + '<p>' + esc(n === 1 ? senderName + ' sent you an email and is still waiting for your reply.' : senderName + ' sent you ' + n + ' emails that are still waiting for your reply.') + '</p><ul>'
    + items.map(it => '<li>' + esc(senderName) + ' emailed you on ' + esc(formatTime(it.since)) + '. <a href="' + esc(gmailLink(person.email, it.messageId)) + '">Open the email</a></li>').join('')
    + '</ul><p style="color:#666">Please reply to ' + esc(senderName) + ' in Gmail. This is reminder ' + stage + ' of ' + total
    + '. It was sent automatically and doesn’t include what the email says.</p>';
  return { subject, body, html };
}

// Which reminders are due: pending replies, grouped by person, that have
// reached a stage not yet sent. sent: key -> stage already sent.
function dueReminders(pending, sent, cfg, now) {
  const byPerson = {};
  pending.forEach(p => {
    const stage = stageFor(now - p.since, cfg);
    const key = reminderKey(p);
    if (!stage || stage <= (sent[key] || 0)) return;
    const box = byPerson[p.email] || (byPerson[p.email] = { person: { email: p.email, name: p.name }, senderName: p.senderName, items: [] });
    box.items.push({ since: p.since, messageId: p.messageId, stage, key });
  });
  return Object.keys(byPerson).map(k => byPerson[k]);
}

function reminderKey(p) {
  return p.email + '|' + p.messageId;
}

// ---------------- Google: sign-in, Gmail API, sending ----------------

// An access token for reading one mailbox's headers, from the service account.
function tokenFor(user) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('tok:' + user);
  if (hit) return hit;
  const raw = PropertiesService.getScriptProperties().getProperty('SA_KEY');
  if (!raw) throw new Error('The service account key is missing. Add it under Project Settings > Script properties as SA_KEY.');
  const key = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const b64 = s => Utilities.base64EncodeWebSafe(s).replace(/=+$/, '');
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({
    iss: key.client_email, sub: user, scope: 'https://www.googleapis.com/auth/gmail.metadata',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const sig = b64(Utilities.computeRsaSha256Signature(head + '.' + claim, key.private_key));
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig },
  });
  const out = JSON.parse(res.getContentText());
  if (!out.access_token) {
    throw new Error('Google refused the sign-in for ' + user + ': ' + (out.error_description || out.error || res.getResponseCode())
      + '. Check that the admin approved the service account for the gmail.metadata scope.');
  }
  cache.put('tok:' + user, out.access_token, 3300);
  return out.access_token;
}

function gmailGet(user, path) {
  const url = 'https://gmail.googleapis.com/gmail/v1/users/' + encodeURIComponent(user) + path;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + tokenFor(user) }, muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 429 || code >= 500) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    throw new Error('Gmail answered ' + code + ' for ' + user + ': ' + res.getContentText().slice(0, 300));
  }
  throw new Error('Gmail kept saying it was busy for ' + user + '. It will try again next run.');
}

function skipLabelId(user) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('lbl:' + user);
  if (hit !== null) return hit || null;
  const labels = gmailGet(user, '/labels').labels || [];
  const found = labels.find(l => l.name.toLowerCase() === CONFIG.SKIP_LABEL.toLowerCase());
  cache.put('lbl:' + user, found ? found.id : '', 21600);
  return found ? found.id : null;
}

// The watched person's threads with sent mail from the last LOOKBACK_DAYS,
// headers only. A thread is read again only when it has changed.
function recentThreads(user, now) {
  const cache = CacheService.getScriptCache();
  const oldest = now - CONFIG.LOOKBACK_DAYS * DAY;
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const list = gmailGet(user, '/threads?labelIds=SENT&maxResults=50' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
    let tooOld = false;
    (list.threads || []).forEach(t => {
      if (tooOld) return;
      const ck = 'th:' + user + ':' + t.id + ':' + t.historyId;
      let thread = null;
      const hit = cache.get(ck);
      if (hit) thread = JSON.parse(hit);
      else {
        const raw = gmailGet(user, '/threads/' + t.id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID');
        thread = { id: t.id, messages: (raw.messages || []).map(toMessage) };
        try { cache.put(ck, JSON.stringify(thread), 21600); } catch (e) { /* too big to cache: read it again next time */ }
      }
      const last = thread.messages.reduce((x, m) => Math.max(x, m.at), 0);
      if (last < oldest) { tooOld = true; return; }
      out.push(thread);
    });
    if (tooOld || !list.nextPageToken) break;
    pageToken = list.nextPageToken;
  }
  return out;
}

function sentRecord() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const sent = {};
  Object.keys(props).forEach(k => { if (k.indexOf('sent:') === 0) sent[k.slice(5)] = Number(props[k].split('|')[0]); });
  return sent;
}

// Forget reminders for emails older than the look-back, so the record stays small.
function pruneSent(now) {
  const store = PropertiesService.getScriptProperties();
  const props = store.getProperties();
  Object.keys(props).forEach(k => {
    if (k.indexOf('sent:') !== 0) return;
    const since = Number(props[k].split('|')[1] || 0);
    if (since < now - (CONFIG.LOOKBACK_DAYS + 3) * DAY) store.deleteProperty(k);
  });
}

function formatTime(t) {
  return Utilities.formatDate(new Date(t), CONFIG.TIME_ZONE, "EEE, MMM d 'at' h:mm a");
}

// ---------------- what the trigger runs ----------------

function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const now = Date.now();
    const hour = Number(Utilities.formatDate(new Date(now), CONFIG.TIME_ZONE, 'H'));
    const sent = sentRecord();
    let pending = [];
    CONFIG.WATCH.forEach(user => {
      const watch = user.toLowerCase();
      const skip = skipLabelId(user);
      recentThreads(user, now).forEach(t => { pending = pending.concat(pendingInThread(t, watch, CONFIG, now, skip)); });
    });
    const due = dueReminders(pending, sent, CONFIG, now);
    console.log(pending.length + ' replies still owed; ' + due.length + ' people due a reminder' + (isQuietHour(hour, CONFIG) ? ' (quiet hours: sending later)' : ''));
    if (isQuietHour(hour, CONFIG)) return;
    const store = PropertiesService.getScriptProperties();
    due.forEach(d => {
      const mail = buildReminder(d.person, d.senderName, d.items, CONFIG, formatTime);
      if (CONFIG.DRY_RUN) {
        console.log('[dry run] would email ' + d.person.email + ': ' + mail.subject);
        return;
      }
      MailApp.sendEmail({ to: d.person.email, subject: mail.subject, body: mail.body, htmlBody: mail.html, name: 'Reply reminders' });
      d.items.forEach(it => store.setProperty('sent:' + it.key, it.stage + '|' + it.since));
    });
    pruneSent(now);
  } finally {
    lock.releaseLock();
  }
}

// Run once after setup: checks the key and access, and logs what it finds. Sends nothing.
function checkSetup() {
  const now = Date.now();
  CONFIG.WATCH.forEach(user => {
    const threads = recentThreads(user, now);
    const pending = [].concat.apply([], threads.map(t => pendingInThread(t, user.toLowerCase(), CONFIG, now, skipLabelId(user))));
    console.log(user + ': ' + threads.length + ' threads with sent mail in the last ' + CONFIG.LOOKBACK_DAYS + ' days, '
      + pending.length + ' replies still owed by: ' + (pending.map(p => p.email).join(', ') || 'nobody'));
  });
}

// Sends one sample reminder to you (the account running this script), to see what people get.
function sendSampleToMe() {
  const me = Session.getEffectiveUser().getEmail();
  const mail = buildReminder({ email: me, name: '' }, 'Juan Diaz', [{ since: Date.now() - 5 * HOUR, messageId: 'sample', stage: 1 }], CONFIG, formatTime);
  MailApp.sendEmail({ to: me, subject: '[sample] ' + mail.subject, body: mail.body, htmlBody: mail.html, name: 'Reply reminders' });
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('run').timeBased().everyMinutes(15).create();
  console.log('Running every 15 minutes.');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'run').forEach(t => ScriptApp.deleteTrigger(t));
}

if (typeof module !== 'undefined') {
  module.exports = { CONFIG, parseAddresses, toMessage, pendingInThread, stageFor, isQuietHour, gmailLink, buildReminder, dueReminders, reminderKey, HOUR, DAY };
}
