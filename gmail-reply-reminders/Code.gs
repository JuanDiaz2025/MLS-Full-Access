/**
 * Gmail reply reminders
 *
 * Watches the emails Juan sends to the team and, when someone hasn't replied,
 * reminds them inside that same email thread:
 *  - an email to one person: a private reminder to that person only;
 *  - an email to several people, or with anyone in CC: one reminder to
 *    everyone who still hasn't replied, together. Juan isn't copied.
 * The reminder says "Re: <subject>" so Gmail keeps it in the thread, but its
 * text never says what the email says. Replying to it goes to Juan, in the
 * same thread, and counts as their reply.
 *
 * It reads Juan's mailbox through a service account that a Google Workspace
 * admin allowed to read message headers only (the gmail.metadata scope):
 * who sent it, to whom, when, the subject and the message id. It cannot open
 * bodies or attachments, and Juan installs nothing. The reminders are sent
 * from the account that runs this script. Setup steps are in README.md.
 *
 * It runs every few minutes on Google's servers. No Claude, no WhatsApp.
 */

const CONFIG = {
  // whose sent emails are watched
  WATCH: ['juan@twinhomebuyer.com'],
  // only people at this domain are reminded
  TEAM_DOMAIN: 'twinhomebuyer.com',
  // addresses never reminded, such as group lists
  IGNORE: [],
  // a reminder once each of these waits has passed, in minutes, then no more.
  // 240 = 4 hours, 1440 = 1 day, 2880 = 2 days. For a quick test: [1, 5, 10].
  REMIND_AFTER_MINUTES: [240, 1440, 2880],
  // how often it checks, in minutes: 1, 5, 10, 15 or 30. A reminder goes out
  // within this long of being due. Run installTrigger again after changing it.
  CHECK_EVERY_MINUTES: 5,
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
  // Off (both 0): everyone gets the reminder as soon as it's due, day or
  // night, wherever they are. To hold reminders overnight instead, set for
  // example 20 and 8: nothing between 8 PM and 8 AM in the person's time zone.
  QUIET_FROM_HOUR: 0,
  QUIET_TO_HOUR: 0,
  // time zones for quiet hours, if they're on: everyone not listed below is here
  TIME_ZONE: 'Asia/Manila',
  PEOPLE_TIME_ZONES: {
    'bryan@twinhomebuyer.com': 'America/Los_Angeles',
  },
  // true: write who would be reminded to the log, send nothing
  DRY_RUN: true,
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// marks the reminders this script sends, so they are never counted as emails
const REMINDER_HEADER = 'X-Reply-Reminder';

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
    cc: parseAddresses(headerOf(msg, 'Cc')),
    subject: headerOf(msg, 'Subject'),
    messageId: headerOf(msg, 'Message-ID').replace(/^<|>$/g, ''),
    reminder: !!headerOf(msg, REMINDER_HEADER),
    at: Number(msg.internalDate),
    labelIds: msg.labelIds || [],
  };
}

// Who still owes the watched person a reply in one thread.
// thread: { id, messages: [toMessage(...)] }. A person owes a reply when the
// watched person emailed them (To or Cc) and they haven't written in the
// thread since. The wait counts from the first email they haven't answered.
// Returns [{ email, name, since, messageId, thread, subject, inReplyTo,
// references, group, watch, senderName }]. group: that email went to more
// than one person on the team, so the reminder goes to everyone still owing.
function pendingInThread(thread, watch, cfg, now, skipLabelId) {
  const msgs = thread.messages.filter(m => !m.reminder).sort((a, b) => a.at - b.at);
  const mine = m => m.from.email === watch;
  if (!msgs.some(mine)) return [];
  if (cfg.ONLY_THREADS_STARTED && !mine(msgs[0])) return [];
  if (skipLabelId && msgs.some(m => m.labelIds.indexOf(skipLabelId) >= 0)) return [];
  const first = msgs.find(mine);
  const subject = (first.subject || '').trim().toLowerCase();
  if (cfg.SKIP_SUBJECT_PREFIXES.some(p => subject.indexOf(p.toLowerCase()) === 0)) return [];
  const domain = '@' + cfg.TEAM_DOMAIN.toLowerCase();
  const ignore = cfg.IGNORE.map(x => x.toLowerCase());
  const team = r => r.email !== watch && r.email.endsWith(domain) && ignore.indexOf(r.email) < 0;
  const recipients = m => m.to.concat(m.cc).filter(team);
  const oldest = now - cfg.LOOKBACK_DAYS * DAY;
  const people = {};
  msgs.filter(mine).forEach(m => recipients(m).forEach(r => { if (!(r.email in people)) people[r.email] = r.name; }));
  const lastMine = msgs.filter(mine).pop();
  const references = msgs.map(m => m.messageId).filter(Boolean);
  const out = [];
  Object.keys(people).forEach(email => {
    const lastFromThem = msgs.filter(m => m.from.email === email).reduce((t, m) => Math.max(t, m.at), -Infinity);
    const waiting = msgs.filter(m => mine(m) && m.at > lastFromThem && recipients(m).some(r => r.email === email));
    if (!waiting.length || waiting[0].at < oldest) return;
    const group = new Set(recipients(waiting[0]).map(r => r.email)).size > 1;
    out.push({
      email, name: people[email], since: waiting[0].at, messageId: waiting[0].messageId,
      thread: thread.id, subject: first.subject || '', inReplyTo: lastMine.messageId, references,
      group, watch, senderName: first.from.name || watch,
    });
  });
  return out;
}

// How many reminders are due after waiting this long.
function stageFor(waitMs, cfg) {
  return cfg.REMIND_AFTER_MINUTES.filter(m => waitMs >= m * MINUTE).length;
}

function timeZoneFor(email, cfg) {
  return (cfg.PEOPLE_TIME_ZONES || {})[String(email).toLowerCase()] || cfg.TIME_ZONE;
}

function isQuietHour(hour, cfg) {
  const a = cfg.QUIET_FROM_HOUR, b = cfg.QUIET_TO_HOUR;
  if (a === b) return false; // off
  return a > b ? hour >= a || hour < b : hour >= a && hour < b;
}

function reminderKey(p) {
  return p.email + '|' + p.messageId;
}

// Which reminders are due, one per thread: for a private email the one
// person, for a group email everyone in it whose next reminder is due.
// sent: key -> stage already sent. Returns [{ thread, subject, inReplyTo,
// references, group, watch, senderName, since, people: [{ email, name, stage, key }] }].
function dueReminders(pending, sent, cfg, now) {
  const byThread = {};
  pending.forEach(p => {
    const stage = stageFor(now - p.since, cfg);
    const key = reminderKey(p);
    if (!stage || stage <= (sent[key] || 0)) return;
    const id = p.watch + '|' + p.thread + (p.group ? '' : '|' + p.email);
    const box = byThread[id] || (byThread[id] = {
      thread: p.thread, subject: p.subject, inReplyTo: p.inReplyTo, references: p.references,
      group: p.group, watch: p.watch, senderName: p.senderName, since: p.since, people: [],
    });
    box.since = Math.min(box.since, p.since);
    box.people.push({ email: p.email, name: p.name, stage, key, since: p.since });
  });
  return Object.keys(byThread).map(k => byThread[k]);
}

function firstName(person) {
  const n = (person.name || '').trim();
  if (n && n.indexOf('@') < 0) return n.split(/\s+/)[0];
  const local = person.email.split('@')[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// "Cherry", "Cherry and Leo", "Cherry, Kristine and Leo"
function listNames(names) {
  return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// "5 minutes ago", "4 hours ago", "2 days ago"
function ago(ms) {
  const unit = (n, w) => n + ' ' + w + (n === 1 ? '' : 's') + ' ago';
  if (ms < HOUR) return unit(Math.max(1, Math.round(ms / MINUTE)), 'minute');
  if (ms < 2 * DAY) return unit(Math.round(ms / HOUR), 'hour');
  return unit(Math.round(ms / DAY), 'day');
}

// The reminder text: who is waiting and since when. Never what the email says.
function buildReminder(r, cfg, now) {
  const names = listNames(r.people.map(firstName));
  const stage = Math.max.apply(null, r.people.map(p => p.stage));
  const total = cfg.REMIND_AFTER_MINUTES.length;
  const sentAgo = ago(now - r.since);
  const ask = r.people.length === 1
    ? r.senderName + ' is still waiting for your reply to this email (sent ' + sentAgo + ').'
    : r.senderName + ' is still waiting for a reply from each of you on this email (sent ' + sentAgo + ').';
  const footer = 'This is reminder ' + stage + ' of ' + total + '. It was sent automatically and doesn’t include what the email says.';
  const text = 'Hi ' + names + ',\n\n' + ask + ' Please reply in this thread.\n\n' + footer;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = '<p>Hi ' + esc(names) + ',</p><p>' + esc(ask) + ' Please reply in this thread.</p><p style="color:#666">' + esc(footer) + '</p>';
  return { text, html, stage };
}

// "Re: Fence quote", keeping one "Re:" if it already has one.
function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : 'Re: ' + s;
}

// A header value safe for an email: words outside plain ASCII are encoded.
function encodeHeader(s, b64) {
  return /[^\x20-\x7e]/.test(s) ? '=?UTF-8?B?' + b64(s) + '?=' : s;
}

// The reminder as an email in Juan's thread. b64: UTF-8 text to base64.
// to: addresses; replyTo: Juan, so a reply goes to him in the same thread.
function mimeMessage(o, b64) {
  const boundary = 'rr' + o.boundary;
  const n = String(o.replyToName || '').replace(/"/g, '');
  const name = !n ? '' : (/[^\x20-\x7e]/.test(n) ? encodeHeader(n, b64) : '"' + n + '"') + ' ';
  const body = s => b64(s).replace(/(.{76})/g, '$1\r\n');
  return [
    'From: Reply reminders <' + o.from + '>',
    'To: ' + o.to.join(', '),
    'Reply-To: ' + name + '<' + o.replyTo + '>',
    'Subject: ' + encodeHeader(replySubject(o.subject), b64),
    o.inReplyTo ? 'In-Reply-To: <' + o.inReplyTo + '>' : '',
    o.references.length ? 'References: ' + o.references.map(id => '<' + id + '>').join(' ') : '',
    REMINDER_HEADER + ': 1',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body(o.text),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body(o.html),
    '--' + boundary + '--',
    '',
  ].filter((line, i, all) => line !== '' || i >= all.indexOf('MIME-Version: 1.0')).join('\r\n');
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
  const headers = ['From', 'To', 'Cc', 'Subject', 'Message-ID', REMINDER_HEADER].map(h => '&metadataHeaders=' + h).join('');
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const list = gmailGet(user, '/threads?labelIds=SENT&maxResults=50' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
    let tooOld = false;
    (list.threads || []).forEach(t => {
      if (tooOld) return;
      const ck = 'th2:' + user + ':' + t.id + ':' + t.historyId;
      let thread = null;
      const hit = cache.get(ck);
      if (hit) thread = JSON.parse(hit);
      else {
        const raw = gmailGet(user, '/threads/' + t.id + '?format=metadata' + headers);
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

// Sends the reminder into the thread, from the account running this script.
function sendInThread(r, mail) {
  const b64 = s => Utilities.base64Encode(s, Utilities.Charset.UTF_8);
  const raw = mimeMessage({
    from: Session.getEffectiveUser().getEmail(), to: r.people.map(p => p.email),
    replyTo: r.watch, replyToName: r.senderName, subject: r.subject,
    inReplyTo: r.inReplyTo, references: r.references, text: mail.text, html: mail.html,
    boundary: Utilities.getUuid().replace(/-/g, ''),
  }, b64);
  const res = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8) }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Sending the reminder failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
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

function hourIn(tz, now) {
  return Number(Utilities.formatDate(new Date(now), tz, 'H'));
}

// ---------------- what the trigger runs ----------------

function run() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const now = Date.now();
    const sent = sentRecord();
    let pending = [];
    CONFIG.WATCH.forEach(user => {
      const watch = user.toLowerCase();
      const skip = skipLabelId(user);
      recentThreads(user, now).forEach(t => { pending = pending.concat(pendingInThread(t, watch, CONFIG, now, skip)); });
    });
    const due = dueReminders(pending, sent, CONFIG, now);
    console.log(pending.length + ' replies still owed; ' + due.length + ' reminder' + (due.length === 1 ? '' : 's') + ' due');
    const store = PropertiesService.getScriptProperties();
    due.forEach(r => {
      // night where someone is: their reminder goes out in their morning
      const awake = r.people.filter(p => {
        const tz = timeZoneFor(p.email, CONFIG);
        if (!isQuietHour(hourIn(tz, now), CONFIG)) return true;
        console.log(p.email + ': waiting until ' + CONFIG.QUIET_TO_HOUR + ' AM their time (' + tz + ')');
        return false;
      });
      if (!awake.length) return;
      const r2 = Object.assign({}, r, { people: awake });
      const mail = buildReminder(r2, CONFIG, now);
      const who = awake.map(p => p.email).join(', ');
      if (CONFIG.DRY_RUN) {
        console.log('[dry run] would reply in "' + replySubject(r.subject) + '" to ' + who + ' (' + (r.group ? 'group' : 'private') + ', reminder ' + mail.stage + ')');
        return;
      }
      sendInThread(r2, mail);
      console.log('Reminded ' + who + ' in "' + replySubject(r.subject) + '"');
      awake.forEach(p => store.setProperty('sent:' + p.key, p.stage + '|' + p.since));
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
      + pending.length + ' replies still owed by: ' + (pending.map(p => p.email + (p.group ? ' (group)' : '')).join(', ') || 'nobody'));
  });
}

// Sends one sample reminder to you (the account running this script), to see what people get.
function sendSampleToMe() {
  const me = Session.getEffectiveUser().getEmail();
  const now = Date.now();
  const mail = buildReminder({ senderName: 'Juan Diaz', since: now - 4 * HOUR, people: [{ email: me, name: '', stage: 1 }] }, CONFIG, now);
  MailApp.sendEmail({ to: me, subject: '[sample] Re: (the subject of Juan’s email)', body: mail.text, htmlBody: mail.html, name: 'Reply reminders' });
}

function installTrigger() {
  const every = CONFIG.CHECK_EVERY_MINUTES;
  if ([1, 5, 10, 15, 30].indexOf(every) < 0) throw new Error('CHECK_EVERY_MINUTES must be 1, 5, 10, 15 or 30.');
  removeTrigger();
  ScriptApp.newTrigger('run').timeBased().everyMinutes(every).create();
  console.log('Checking every ' + every + ' minute' + (every === 1 ? '' : 's') + '.');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'run').forEach(t => ScriptApp.deleteTrigger(t));
}

if (typeof module !== 'undefined') {
  module.exports = { CONFIG, MINUTE, HOUR, DAY, REMINDER_HEADER, parseAddresses, toMessage, pendingInThread, stageFor, timeZoneFor, isQuietHour,
    reminderKey, dueReminders, firstName, listNames, ago, buildReminder, replySubject, encodeHeader, mimeMessage };
}
