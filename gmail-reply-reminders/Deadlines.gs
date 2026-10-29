/**
 * Deadline agent
 *
 * Every 15 minutes it reads the assignments Juan sends and every reply to
 * them. An assignment is an email Juan sent with a line like
 *
 *   OWNER: Cherry · DUE: Oct 30, 5 PM PT
 *
 * (several such lines in one email are several assignments). When a deadline
 * passes without DONE, DATE or BLOCKED from the owner, it emails the owner in
 * that thread, as Juan: "The deadline was X. Send it now, plus one line on
 * why you missed it." It never grants extra time. Every miss is logged by
 * name and date, and at 5:00 PM Pacific Juan gets a scorecard: who
 * delivered, who missed, what's still open.
 *
 * The rules:
 *  - Delivered: a reply from the owner that says DONE, or has an attachment
 *    or a link to a file (Docs, Drive, Dropbox and the like). An email the
 *    owner sent elsewhere counts too when its subject contains the
 *    assignment's subject.
 *  - DATE: a DATE sent before the deadline moves it to that date, once.
 *    A DATE after the deadline doesn't stop the chase.
 *  - BLOCKED before the deadline: no chase; it shows as blocked.
 *  - Before chasing it reads the whole thread and the owner's other emails,
 *    so nobody is chased for work they already sent.
 *
 * It lives in the same Apps Script project as Code.gs and uses its sign-in
 * (a service account allowed gmail.readonly and gmail.send by the admin) and
 * its log sheet (tabs "Assignments" and "Misses"). The dashboard's Pause
 * switch stops it too. Setup steps are in README.md.
 */

const DEADLINES = {
  // whose assignments are read; the chases go out as this person.
  // Testing on Seth's emails; change to 'juan@twinhomebuyer.com' when ready.
  ASSIGNER: 'seth@twinhomebuyer.com',
  // only assignments whose subject starts with TEST, while testing
  TEST_ONLY: true,
  // true: write to the log what it would send, send nothing
  DRY_RUN: true,
  // names Juan uses that aren't on the address: nickname -> address
  NICKNAMES: { thea: 'marie@twinhomebuyer.com' },
  // deadlines without a time zone are read in this one
  TIME_ZONE: 'America/Los_Angeles',
  // a DUE with a date but no time means this hour (17 = 5:00 PM)
  DEFAULT_DUE_HOUR: 17,
  // assignments older than this are left alone
  LOOKBACK_DAYS: 7,
  // the scorecard goes out at this hour, in TIME_ZONE, to SCORECARD_TO (blank: the assigner)
  SCORECARD_HOUR: 17,
  SCORECARD_TO: '',
  // {deadline} is filled in
  CHASE_TEXT: 'The deadline was {deadline}. Send it now, plus one line on why you missed it.',
};

const SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPE_SEND = 'https://www.googleapis.com/auth/gmail.send';
// marks the chases this agent sends, so they're never read as replies or assignments
const CHASE_HEADER = 'X-Deadline-Chase';
const ASSIGNMENT_HEADERS = ['Assigned', 'Subject', 'Owner', 'Owner name', 'Due', 'Status', 'Delivered', 'Chased', 'Note', 'Thread'];
const MISS_HEADERS = ['Missed on', 'Owner', 'Owner name', 'Subject', 'Deadline', 'Chased', 'Thread'];

// ---------------- reading assignments and replies (pure, tested in test/) ----------------

// "OWNER: Cherry · DUE: Oct 30, 5 PM PT" lines -> [{ owner, due }].
// OWNER and DUE may be in either order; a line needs both.
function parseAssignmentLines(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const o = /\bOWNER\s*:\s*(.+?)\s*(?:[·•|;]|\bDUE\b|$)/i.exec(line);
    const d = /\bDUE\s*:\s*(.+?)\s*(?:[·•|;]\s*OWNER\b|$)/i.exec(line);
    if (o && d && o[1].trim() && d[1].trim()) out.push({ owner: o[1].trim(), due: d[1].trim().replace(/[.\s]+$/, '') });
  });
  return out;
}

// Owners named in an assignment, matched to the people the email went to.
// "Cherry", "Cherry Ann", "cherry@x.com", "Cherry and Leo". Returns
// { people: [{ email, name }], unknown: ['name not on the email'] }.
function resolveOwners(ownerText, recipients, nicknames) {
  const people = [], unknown = [];
  const nick = nicknames || {};
  String(ownerText).split(/\s*(?:,|&|\/|\band\b)\s*/i).map(s => s.trim()).filter(Boolean).forEach(word => {
    const w = word.toLowerCase().replace(/^@/, '');
    let hits;
    if (nick[w]) hits = recipients.filter(r => r.email === String(nick[w]).toLowerCase());
    else if (w.indexOf('@') > 0) hits = recipients.filter(r => r.email === w);
    else {
      const full = recipients.filter(r => (r.name || '').toLowerCase() === w);
      hits = full.length ? full : recipients.filter(r => {
        const first = (r.name || '').toLowerCase().split(/\s+/)[0];
        return first === w || r.email.split('@')[0] === w;
      });
    }
    if (hits.length === 1) { if (!people.some(p => p.email === hits[0].email)) people.push(hits[0]); }
    else if (w.indexOf('@') > 0 && !hits.length && !nick[w]) people.push({ email: w, name: '' });
    else unknown.push(word);
  });
  return { people, unknown };
}

// ---- Juan's own style ----
// Deadline phrases in some text: "due 3:30 PM today", "by 12:40 PM", "by Tue
// Nov 3, 5:00 PM", "due today at 5:00 PM Pacific", "Reply DONE by 3:30 PM".
// Not "send BLOCKED by 4:30 PM" (the cut-off for saying BLOCKED), not "by
// then", and not "what's done by noon". -> [ms], in order.
function deadlinePhrases(text, sentAt, cfg) {
  const s = String(text || '').replace(/\b([ap])\.m\./gi, '$1m');
  const re = /\b(due|by)\b\s+((?:(?!\b(?:by|due|blocked)\b)[^\n.;!?]){1,45})/gi;
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    if (/blocked\W*(\w+\W*){0,2}$/.test(before)) continue;
    if (/(what'?s|what is|be|been|get it|have it|got it)\s+done\s*$/.test(before)) continue;
    const t = parseDue(m[2], sentAt, cfg);
    if (t != null) out.push(t);
  }
  return out;
}

// Items that open with the people they're for: "1. Genesis: …", "2. Seth and
// Thea: …", "Leo: …". An item runs to the next numbered line.
function namedItems(text) {
  const items = [];
  let cur = null;
  String(text || '').split(/\r?\n/).forEach(line => {
    const m = /^\s*(?:\d+[.)]\s*)?([A-Za-z][A-Za-z .,&'-]{0,50}?)\s*:\s+(\S.*)$/.exec(line);
    if (m) { cur = { who: m[1].trim(), text: m[2] }; items.push(cur); }
    else if (/^\s*\d+[.)]\s/.test(line)) cur = null;
    else if (cur) cur.text += '\n' + line;
  });
  return items;
}

const firstOf = a => (a.length ? a[0] : null);
const stripTest = s => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)*test\b\s*:?\s*/i, '');

// The assignments in one email from the assigner. In order of preference:
// OWNER/DUE lines; items that open with names (each with its own "by"/"Due",
// else the subject's); the subject's deadline for the people in To (only on
// the email that starts the thread). -> [{ people, unknown, due, dueText, explicit }]
function assignmentsIn(msg, starts, recipients, cfg) {
  const text = newText(msg.text);
  const explicit = parseAssignmentLines(text);
  if (explicit.length) {
    return explicit.map(l => Object.assign(resolveOwners(l.owner, recipients, cfg.NICKNAMES), { due: parseDue(l.due, msg.at, cfg), dueText: l.due, ownerText: l.owner, explicit: true }));
  }
  const subjectDue = starts ? firstOf(deadlinePhrases(stripTest(msg.subject), msg.at, cfg)) : null;
  const items = namedItems(text).map(it => ({ it, r: resolveOwners(it.who, recipients, cfg.NICKNAMES) }))
    .filter(x => x.r.people.length && !x.r.unknown.length);
  if (items.length) {
    return items.map(x => ({ people: x.r.people, unknown: [], due: firstOf(deadlinePhrases(x.it.text, msg.at, cfg)) || subjectDue }))
      .filter(a => a.due != null);
  }
  if (subjectDue != null) {
    const to = msg.to.filter(r => recipients.some(p => p.email === r.email));
    if (to.length) return [{ people: to, unknown: [], due: subjectDue }];
  }
  return [];
}

// Minutes the time zone is ahead of UTC at that moment (Manila +480, California -420 or -480).
function tzOffsetMin(ms, tz) {
  const z = Utilities.formatDate(new Date(ms), tz, 'Z');
  const m = /([+-])(\d\d)(\d\d)/.exec(z);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// A wall-clock time in a time zone -> ms.
function zonedTime(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let t = guess - tzOffsetMin(guess, tz) * 60000;
  t = guess - tzOffsetMin(t, tz) * 60000; // across a daylight-saving change
  return t;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// whole words only, so "month" isn't Monday
const WEEKDAY_WORDS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

// "Oct 30, 5 PM PT", "10/30 17:00", "tomorrow noon", "Friday EOD", "3:30 pm"
// -> ms, read against the email's own date. null when there's no date or time in it.
function parseDue(text, sentAt, cfg) {
  let s = ' ' + String(text || '').toLowerCase().replace(/[,.]/g, ' ') + ' ';
  let tz = cfg.TIME_ZONE;
  if (/\b(pt|pst|pdt|pacific)\b/.test(s)) tz = 'America/Los_Angeles';
  else if (/\b(pht|manila|ph time)\b/.test(s)) tz = 'Asia/Manila';
  s = s.replace(/\b(pt|pst|pdt|pacific|pht|manila|ph time|time)\b/g, ' ');
  const sentLocal = new Date(sentAt + tzOffsetMin(sentAt, tz) * 60000);
  let y = sentLocal.getUTCFullYear(), mo = sentLocal.getUTCMonth(), d = sentLocal.getUTCDate();
  let hasDate = false, hasTime = false, h = cfg.DEFAULT_DUE_HOUR, mi = 0;
  // the time
  let m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(s);
  if (m) { h = Number(m[1]) % 12 + (m[3] === 'pm' ? 12 : 0); mi = Number(m[2] || 0); hasTime = true; s = s.replace(m[0], ' '); }
  else if ((m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s))) { h = Number(m[1]); mi = Number(m[2]); hasTime = true; s = s.replace(m[0], ' '); }
  else if (/\bnoon\b/.test(s)) { h = 12; mi = 0; hasTime = true; }
  else if (/\b(eod|end of day|cob|close of business)\b/.test(s)) { h = cfg.DEFAULT_DUE_HOUR; mi = 0; hasTime = true; }
  // the date
  if (/\btomorrow\b/.test(s)) { d += 1; hasDate = true; }
  else if (/\b(today|tonight)\b/.test(s)) hasDate = true;
  else if ((m = new RegExp('\\b(' + MONTHS.join('|') + ')[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b').exec(s))) {
    mo = MONTHS.indexOf(m[1]); d = Number(m[2]); if (m[3]) y = Number(m[3]); hasDate = true;
  } else if ((m = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MONTHS.join('|') + ')[a-z]*(?:\\s+(\\d{4}))?\\b').exec(s))) {
    mo = MONTHS.indexOf(m[2]); d = Number(m[1]); if (m[3]) y = Number(m[3]); hasDate = true;
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s))) {
    mo = Number(m[1]) - 1; d = Number(m[2]); if (m[3]) y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]); hasDate = true;
  } else if ((m = new RegExp('\\b(' + Object.keys(WEEKDAY_WORDS).join('|') + ')\\b').exec(s))) {
    const want = WEEKDAY_WORDS[m[1]];
    d += (want - sentLocal.getUTCDay() + 7) % 7; hasDate = true;
  }
  if (!hasDate && !hasTime) return null;
  let t = zonedTime(y, mo, d, h, mi, tz);
  // a time alone that had already passed when the email was sent means the next day
  if (!hasDate && t <= sentAt) t = zonedTime(y, mo, d + 1, h, mi, tz);
  // a month-day with no year that is long past means next year
  if (hasDate && !/\d{4}/.test(String(text)) && t < sentAt - 60 * DAY) t = zonedTime(y + 1, mo, d, h, mi, tz);
  return t;
}

// What a reply says that's new, without the email it quotes.
function newText(body) {
  let s = String(body || '').replace(/\r/g, '');
  const cuts = [/\nOn [^\n]{0,200}\n?[^\n]{0,200}wrote:/, /\n-{2,}\s*Original Message\s*-{2,}/i, /\nFrom: [^\n]+\n(Sent|Date): /];
  cuts.forEach(re => { const m = re.exec('\n' + s); if (m) s = s.slice(0, Math.max(0, m.index - 1)); });
  return s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n').trim();
}

// DONE / DATE / BLOCKED at the start of a line of the new text.
function readStatus(text, sentAt, cfg) {
  const m = /^\s*(done|date|blocked)\b\s*:?\s*(.*)$/im.exec(String(text || ''));
  if (!m) return null;
  const kind = m[1].toUpperCase();
  return kind === 'DATE' ? { kind, until: parseDue(m[2], sentAt, cfg) } : { kind };
}

// A link to a file people deliver work in, not a signature's website.
const WORK_LINK = /https?:\/\/(docs\.google|drive\.google|sheets\.google|photos\.app\.goo\.gl|photos\.google|[\w.-]*dropbox\.com|1drv\.ms|[\w.-]*sharepoint\.com|onedrive\.live|[\w.-]*box\.com|[\w.-]*loom\.com|[\w.-]*canva\.com|[\w.-]*figma\.com|we\.tl|[\w.-]*wetransfer\.com)/i;
const hasWork = m => (m.attachments || []).length > 0 || WORK_LINK.test(m.text || '');

// Normalized subject for matching: no Re:/Fwd:, no TEST, lower case, single spaces.
const subjectKey = s => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/^\s*test\b\s*:?\s*/i, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Where one assignment stands. a: { due, sentAt, subject }. msgs: the owner's
// messages after the assignment, in its thread and elsewhere with a matching
// subject, each { at, text, attachments }. chases: when this agent already
// chased this owner in the thread. Returns { status: 'delivered' | 'date' |
// 'blocked' | 'open' | 'missed', due, deliveredAt, late, missedDue, chaseDue }.
// chaseDue: the deadline to chase about now, or null.
function assess(a, msgs, chases, now, cfg) {
  let due = a.due, moved = false, blocked = false, missedDue = null;
  const list = msgs.slice().sort((x, y) => x.at - y.at);
  for (const m of list) {
    const st = readStatus(m.text, m.at, cfg);
    if (m.at > due && missedDue == null) missedDue = due;
    if ((st && st.kind === 'DONE') || hasWork(m)) {
      return { status: 'delivered', due, deliveredAt: m.at, late: m.at > due, missedDue, chaseDue: null };
    }
    if (m.at <= due && st && st.kind === 'DATE' && st.until && !moved) { due = Math.max(due, st.until); moved = true; blocked = false; continue; }
    if (m.at <= due && st && st.kind === 'BLOCKED') blocked = true;
  }
  if (now <= due) return { status: blocked ? 'blocked' : moved ? 'date' : 'open', due, deliveredAt: null, late: false, missedDue, chaseDue: null };
  if (blocked) return { status: 'blocked', due, deliveredAt: null, late: false, missedDue, chaseDue: null };
  if (missedDue == null) missedDue = due;
  const chased = chases.some(t => t >= due);
  return { status: 'missed', due, deliveredAt: null, late: false, missedDue, chaseDue: chased ? null : due };
}

// "Oct 30, 5:00 PM PT"
function fmtDeadline(ms, cfg) {
  const tz = cfg.TIME_ZONE;
  const zone = tz === 'America/Los_Angeles' ? ' PT' : tz === 'Asia/Manila' ? ' Manila time' : ' ' + tz;
  return Utilities.formatDate(new Date(ms), tz, "MMM d, h:mm a") + zone;
}

// The 5 PM email: results only. rows: the Assignments rows as objects
// { owner, ownerName, subject, status, due, deliveredAt, late, note }; misses
// today: { ownerName, subject, deadline }.
function scorecardText(rows, missesToday, dayStart, dayEnd, cfg) {
  const name = r => r.ownerName || r.owner;
  const line = (r, rest) => '- ' + name(r) + ': ' + r.subject + (rest ? ' (' + rest + ')' : '');
  const delivered = rows.filter(r => r.deliveredAt != null && r.deliveredAt >= dayStart && r.deliveredAt < dayEnd)
    .map(r => line(r, r.late ? 'late' : 'on time'));
  const missed = missesToday.map(m => '- ' + m.ownerName + ': ' + m.subject + ' (due ' + fmtDeadline(m.deadline, cfg) + ')');
  const open = rows.filter(r => r.deliveredAt == null && r.status !== 'unclear')
    .sort((a, b) => a.due - b.due)
    .map(r => line(r, r.status === 'blocked' ? 'BLOCKED' : r.status === 'missed' ? 'overdue since ' + fmtDeadline(r.due, cfg) : 'due ' + fmtDeadline(r.due, cfg)));
  const unclear = rows.filter(r => r.status === 'unclear').map(r => '- ' + r.subject + ': ' + r.note);
  const block = (title, items) => title + '\n' + (items.length ? items.join('\n') : '- none');
  return [block('DELIVERED TODAY', delivered), block('MISSED TODAY', missed), block('STILL OPEN', open)]
    .concat(unclear.length ? [block('NOT READ (fix the OWNER or DUE line)', unclear)] : []).join('\n\n');
}

// The same scorecard as a table: Person · Task · Due · Result, one row per
// person per task, misses first. Rows: everything delivered today and
// everything not delivered yet. Assignments it couldn't read are listed below.
const RESULT_ORDER = ['Missed', 'Blocked', 'Open', 'Delivered late', 'Delivered'];
const RESULT_COLOR = { 'Missed': '#b42318', 'Blocked': '#b54708', 'Open': '#475467', 'Delivered late': '#b54708', 'Delivered': '#067647' };
function scorecardTable(rows, dayStart, dayEnd) {
  return rows.filter(r => r.status !== 'unclear' && (r.deliveredAt == null || (r.deliveredAt >= dayStart && r.deliveredAt < dayEnd)))
    .map(r => ({
      person: r.ownerName || r.owner, task: r.subject, due: r.due,
      result: r.deliveredAt != null ? (r.late ? 'Delivered late' : 'Delivered') : r.status === 'missed' ? 'Missed' : r.status === 'blocked' ? 'Blocked' : 'Open',
    }))
    .sort((a, b) => RESULT_ORDER.indexOf(a.result) - RESULT_ORDER.indexOf(b.result) || a.person.localeCompare(b.person) || a.due - b.due);
}

function scorecardHtml(rows, dayStart, dayEnd, cfg) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const table = scorecardTable(rows, dayStart, dayEnd);
  const count = k => table.filter(t => t.result === k).length;
  const cell = 'padding:6px 10px;border:1px solid #d0d5dd;text-align:left;vertical-align:top;';
  const head = ['Person', 'Task', 'Due', 'Result'].map(h => '<th style="' + cell + 'background:#f2f4f7;font-weight:600">' + h + '</th>').join('');
  const body = table.map(t => '<tr><td style="' + cell + '">' + esc(t.person) + '</td><td style="' + cell + '">' + esc(t.task) + '</td><td style="' + cell + 'white-space:nowrap">'
    + esc(fmtDeadline(t.due, cfg)) + '</td><td style="' + cell + 'font-weight:600;color:' + RESULT_COLOR[t.result] + '">' + t.result + '</td></tr>').join('');
  const unclear = rows.filter(r => r.status === 'unclear');
  return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#101828">'
    + '<p style="margin:0 0 10px">' + ['Delivered', 'Delivered late', 'Missed', 'Blocked', 'Open'].map(k => k + ': <b>' + count(k) + '</b>').join(' &middot; ') + '</p>'
    + (table.length ? '<table style="border-collapse:collapse;font-size:14px">' + '<tr>' + head + '</tr>' + body + '</table>' : '<p>No assignments today.</p>')
    + (unclear.length ? '<p style="margin:14px 0 4px;font-weight:600">Not read (fix the deadline or the name)</p><ul style="margin:0;padding-left:18px">'
      + unclear.map(r => '<li>' + esc(r.subject) + ': ' + esc(r.note) + '</li>').join('') + '</ul>' : '')
    + '</div>';
}

// ---------------- Gmail with the wider permissions ----------------

function b64text(data) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString('UTF-8');
}

// A full Gmail message -> { id, at, from, to, cc, subject, messageId, chase, reminder, text, attachments }.
function readFull(msg) {
  const base = toMessage(msg);
  let plain = '', html = '';
  const attachments = [];
  const walk = p => {
    if (!p) return;
    const headers = p.headers || [];
    const h = n => { const x = headers.find(k => k.name.toLowerCase() === n); return x ? x.value : ''; };
    const inline = /inline/i.test(h('content-disposition')) || !!h('content-id');
    if (p.filename && !(inline && /^image\//.test(p.mimeType || ''))) attachments.push(p.filename);
    else if (p.mimeType === 'text/plain' && p.body && p.body.data && !plain) plain = b64text(p.body.data);
    else if (p.mimeType === 'text/html' && p.body && p.body.data && !html) html = b64text(p.body.data);
    (p.parts || []).forEach(walk);
  };
  walk(msg.payload);
  const text = plain || html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return Object.assign(base, { id: msg.id, thread: msg.threadId, chase: !!headerOf(msg, CHASE_HEADER), text, attachments });
}

function dlGet(user, path) {
  return gmailGet(user, path, SCOPE_READ);
}

// The assigner's threads with assignments in the last LOOKBACK_DAYS, read in
// full. A thread is read again only when it changed.
function assignmentThreads(user, cfg) {
  const cache = CacheService.getScriptCache();
  const q = 'in:sent newer_than:' + cfg.LOOKBACK_DAYS + 'd' + (cfg.TEST_ONLY ? ' subject:TEST' : '');
  const list = dlGet(user, '/threads?maxResults=100&q=' + encodeURIComponent(q)).threads || [];
  return list.map(t => {
    const ck = 'dl:' + user + ':' + t.id + ':' + t.historyId;
    const hit = cache.get(ck);
    if (hit) return JSON.parse(hit);
    const raw = dlGet(user, '/threads/' + t.id + '?format=full');
    const thread = { id: t.id, messages: (raw.messages || []).map(readFull) };
    try { cache.put(ck, JSON.stringify(thread), 21600); } catch (e) { /* too big to cache */ }
    return thread;
  });
}

// The owner's emails since the assignment anywhere in the assigner's mailbox
// (Juan in To or CC), for work sent outside the thread.
function ownerMailSince(user, owner, since) {
  const day = Utilities.formatDate(new Date(since - DAY), 'UTC', 'yyyy/MM/dd');
  const q = 'from:' + owner + ' after:' + day;
  const list = dlGet(user, '/messages?maxResults=50&q=' + encodeURIComponent(q)).messages || [];
  return list.map(m => readFull(dlGet(user, '/messages/' + m.id + '?format=full'))).filter(m => m.at > since);
}

// The chase, as the assigner, in the assignment's thread, to the owner only.
function sendChase(cfg, a, owner, deadlineMs) {
  const text = cfg.CHASE_TEXT.replace('{deadline}', fmtDeadline(deadlineMs, cfg));
  const fromName = a.fromName ? '"' + a.fromName.replace(/"/g, '') + '" ' : '';
  const raw = [
    'From: ' + fromName + '<' + cfg.ASSIGNER + '>',
    'To: ' + owner.email,
    'Subject: ' + encodeHeader(replySubject(a.subject), s => Utilities.base64Encode(s, Utilities.Charset.UTF_8)),
    'In-Reply-To: <' + a.messageId + '>',
    'References: ' + a.references.map(id => '<' + id + '>').join(' '),
    CHASE_HEADER + ': 1',
    REMINDER_HEADER + ': 1',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Utilities.base64Encode(text, Utilities.Charset.UTF_8).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
  const res = UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/' + encodeURIComponent(cfg.ASSIGNER) + '/messages/send', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + tokenFor(cfg.ASSIGNER, SCOPE_SEND) },
    payload: JSON.stringify({ raw: Utilities.base64EncodeWebSafe(raw, Utilities.Charset.UTF_8), threadId: a.thread }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Sending the chase failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  return text;
}

// ---------------- one pass ----------------

// Reads everything and works out where each assignment stands. Sends nothing.
function deadlineState(cfg, now) {
  const user = cfg.ASSIGNER.toLowerCase();
  const domain = '@' + CONFIG.TEAM_DOMAIN.toLowerCase();
  const rows = [];
  const otherMail = {};
  assignmentThreads(user, cfg).forEach(thread => {
    const msgs = thread.messages.filter(m => !m.chase && !m.reminder).sort((a, b) => a.at - b.at);
    const references = thread.messages.map(m => m.messageId).filter(Boolean);
    // in this thread: owner -> their current assignment (a newer one replaces it)
    const current = {};
    msgs.filter(m => m.from.email === user).forEach(am => {
      if (cfg.TEST_ONLY && !/^\s*((re|fw|fwd)\s*:\s*)*test\b/i.test(am.subject)) return;
      if (now - am.at > cfg.LOOKBACK_DAYS * DAY) return;
      const recipients = am.to.concat(am.cc).filter(r => r.email !== user && r.email.endsWith(domain));
      const starts = am === msgs[0];
      const found = assignmentsIn(am, starts, recipients, cfg);
      const base = { assignedAt: am.at, subject: (msgs[0] || am).subject, thread: thread.id, messageId: am.messageId, references, fromName: am.from.name };
      if (!found.length) {
        // a later email from the assigner that names a new deadline changes it for the people it's to
        if (starts) return;
        const due = firstOf(deadlinePhrases(newText(am.text), am.at, cfg));
        if (due == null) return;
        am.to.forEach(r => (current[r.email] || []).forEach(x => { x.dueAsked = due; x.note = 'deadline changed ' + fmtDeadline(am.at, cfg); }));
        return;
      }
      found.forEach(a => {
        if (a.explicit && (a.due == null || a.unknown.length)) {
          rows.push(Object.assign({}, base, { owner: '', ownerName: a.ownerText, status: 'unclear', due: null, deliveredAt: null, late: false,
            note: a.due == null ? 'couldn’t read the deadline “' + a.dueText + '”' : 'not on the email: ' + a.unknown.join(', ') }));
        }
        if (a.due == null) return;
        a.people.forEach(owner => {
          const row = Object.assign({}, base, { owner: owner.email, ownerName: owner.name || nameFromAddress(owner.email), dueAsked: a.due, note: '',
            // their messages after the assignment: in the thread, and elsewhere with this subject
            inThread: msgs.filter(m => m.from.email === owner.email && m.at > am.at),
            chases: thread.messages.filter(m => m.chase && m.to.some(r => r.email === owner.email)).map(m => m.at) });
          // an assignment from a later email replaces the earlier ones; items in one email all stand
          const prev = current[owner.email];
          if (prev && prev[0].messageId !== am.messageId) prev.forEach(x => rows.splice(rows.indexOf(x), 1));
          current[owner.email] = prev && prev[0].messageId === am.messageId ? prev.concat([row]) : [row];
          rows.push(row);
        });
      });
    });
  });
  // the owners' other emails, read once each, only when something isn't delivered in its thread
  rows.forEach(r => {
    if (r.status === 'unclear') return;
    let a = assess({ due: r.dueAsked }, r.inThread, r.chases, now, cfg);
    if (a.status !== 'delivered' && now > r.dueAsked - DAY) {
      if (otherMail[r.owner] == null) otherMail[r.owner] = ownerMailSince(user, r.owner, Math.min.apply(null, rows.filter(x => x.owner === r.owner && x.assignedAt).map(x => x.assignedAt)));
      const sk = subjectKey(r.subject);
      const elsewhere = otherMail[r.owner].filter(m => m.at > r.assignedAt && m.thread !== r.thread && sk && subjectKey(m.subject).indexOf(sk) >= 0);
      if (elsewhere.length) a = assess({ due: r.dueAsked }, r.inThread.concat(elsewhere), r.chases, now, cfg);
    }
    Object.assign(r, a);
  });
  return rows;
}

function nameFromAddress(email) {
  const l = String(email).split('@')[0];
  return l.charAt(0).toUpperCase() + l.slice(1);
}

// What the trigger runs every 15 minutes.
function runDeadlines() {
  const cfg = DEADLINES;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const now = Date.now();
    const controls = readControls();
    const rows = deadlineState(cfg, now);
    const store = PropertiesService.getScriptProperties();
    const misses = [];
    rows.filter(r => r.missedDue != null).forEach(r => {
      // every miss once, by name and date
      const mk = 'miss:' + r.thread + '|' + r.owner + '|' + r.missedDue;
      if (store.getProperty(mk)) return;
      store.setProperty(mk, String(now));
      misses.push({ day: Utilities.formatDate(new Date(now), cfg.TIME_ZONE, 'yyyy-MM-dd'), owner: r.owner, ownerName: r.ownerName, subject: r.subject, deadline: r.missedDue, thread: r.thread, chased: '' });
    });
    rows.filter(r => r.chaseDue != null).forEach(r => {
      const who = r.ownerName + ' <' + r.owner + '>';
      if (controls.pause.paused) { console.log('Paused: not chasing ' + who + ' on "' + r.subject + '"'); return; }
      if (cfg.DRY_RUN) { console.log('[dry run] would chase ' + who + ' on "' + r.subject + '": ' + cfg.CHASE_TEXT.replace('{deadline}', fmtDeadline(r.chaseDue, cfg))); return; }
      sendChase(cfg, r, { email: r.owner }, r.chaseDue);
      r.chasedAt = now;
      misses.filter(m => m.thread === r.thread && m.owner === r.owner).forEach(m => { m.chased = new Date(now).toISOString(); });
      console.log('Chased ' + who + ' on "' + r.subject + '"');
    });
    console.log(rows.length + ' assignments: ' + ['delivered', 'open', 'date', 'blocked', 'missed', 'unclear']
      .map(s => rows.filter(r => r.status === s).length + ' ' + s).join(', ') + '; ' + misses.length + ' new misses');
    writeDeadlineLog(rows, misses, cfg);
    if (shouldSendScorecard(cfg, now)) scorecardFrom(rows, cfg, now);
    pruneDeadlineMemory(now);
  } finally {
    lock.releaseLock();
  }
}

// Forget misses and scorecards older than 60 days; the Misses tab keeps the history.
function pruneDeadlineMemory(now) {
  const store = PropertiesService.getScriptProperties();
  const props = store.getProperties();
  Object.keys(props).forEach(k => {
    if ((k.indexOf('miss:') === 0 || k.indexOf('scorecard:') === 0) && Number(props[k]) < now - 60 * DAY) store.deleteProperty(k);
  });
}

// ---------------- the log and the scorecard ----------------

function deadlineSheet() {
  const id = PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : null;
}

function writeDeadlineLog(rows, misses, cfg) {
  try {
    const ss = deadlineSheet();
    if (!ss) { console.log('No log sheet yet: run makeLogSheet to keep the Assignments and Misses tabs.'); return; }
    const iso = t => (t == null ? '' : new Date(t).toISOString());
    const tab = name => ss.getSheetByName(name) || ss.insertSheet(name);
    const a = tab('Assignments');
    const values = [ASSIGNMENT_HEADERS].concat(rows.map(r => [iso(r.assignedAt), r.subject, r.owner, r.ownerName, iso(r.due), r.status,
      iso(r.deliveredAt), iso(r.chasedAt || (r.chases && r.chases.length ? r.chases[r.chases.length - 1] : null)), r.note || (r.late ? 'late' : ''), r.thread]));
    a.clearContents();
    a.getRange(1, 1, values.length, ASSIGNMENT_HEADERS.length).setNumberFormat('@').setValues(values);
    const m = tab('Misses');
    if (m.getLastRow() === 0) m.getRange(1, 1, 1, MISS_HEADERS.length).setNumberFormat('@').setValues([MISS_HEADERS]);
    if (misses.length) {
      m.getRange(m.getLastRow() + 1, 1, misses.length, MISS_HEADERS.length).setNumberFormat('@')
        .setValues(misses.map(x => [x.day, x.owner, x.ownerName, x.subject, iso(x.deadline), x.chased, x.thread]));
    }
  } catch (e) {
    console.log('Couldn’t update the deadline log: ' + (e && e.message || e));
  }
}

// Once a day, on the first pass at or after SCORECARD_HOUR.
function shouldSendScorecard(cfg, now) {
  const hour = Number(Utilities.formatDate(new Date(now), cfg.TIME_ZONE, 'H'));
  if (hour < cfg.SCORECARD_HOUR) return false;
  const key = 'scorecard:' + Utilities.formatDate(new Date(now), cfg.TIME_ZONE, 'yyyy-MM-dd');
  return !PropertiesService.getScriptProperties().getProperty(key);
}

// Builds and sends today's scorecard. Run it by hand to see it any time.
function sendScorecard() {
  scorecardFrom(deadlineState(DEADLINES, Date.now()), DEADLINES, Date.now());
}

function scorecardFrom(rows, cfg, now) {
  const today = Utilities.formatDate(new Date(now), cfg.TIME_ZONE, 'yyyy-MM-dd');
  const [y, mo, d] = today.split('-').map(Number);
  const dayStart = zonedTime(y, mo - 1, d, 0, 0, cfg.TIME_ZONE), dayEnd = zonedTime(y, mo - 1, d + 1, 0, 0, cfg.TIME_ZONE);
  const missesToday = [];
  const ss = deadlineSheet();
  const missTab = ss && ss.getSheetByName('Misses');
  if (missTab && missTab.getLastRow() > 1) {
    missTab.getDataRange().getValues().slice(1).forEach(r => {
      const day = Object.prototype.toString.call(r[0]) === '[object Date]' ? Utilities.formatDate(r[0], cfg.TIME_ZONE, 'yyyy-MM-dd') : String(r[0]);
      if (day === today) missesToday.push({ ownerName: r[2] || r[1], subject: r[3], deadline: cellTime(r[4]) });
    });
  }
  const text = scorecardText(rows, missesToday, dayStart, dayEnd, cfg);
  const to = cfg.SCORECARD_TO || cfg.ASSIGNER;
  const subject = 'Scorecard: ' + Utilities.formatDate(new Date(now), cfg.TIME_ZONE, 'EEE, MMM d');
  if (cfg.DRY_RUN) console.log('[dry run] would email ' + to + ' "' + subject + '":\n' + text);
  else MailApp.sendEmail({ to, subject, body: text, htmlBody: scorecardHtml(rows, dayStart, dayEnd, cfg), name: 'Deadline agent' });
  PropertiesService.getScriptProperties().setProperty('scorecard:' + today, String(now));
}

// ---------------- setup ----------------

// Run once: checks the wider permissions and logs every assignment it finds
// and what it would do. Sends nothing.
function checkDeadlines() {
  const cfg = DEADLINES;
  tokenFor(cfg.ASSIGNER, SCOPE_READ);
  tokenFor(cfg.ASSIGNER, SCOPE_SEND);
  const rows = deadlineState(cfg, Date.now());
  console.log('Reading ' + cfg.ASSIGNER + (cfg.TEST_ONLY ? ' (TEST subjects only)' : '') + ': ' + rows.length + ' assignment(s).');
  rows.forEach(r => console.log('- ' + (r.ownerName || '?') + ' · "' + r.subject + '" · ' + r.status
    + (r.due ? ' · due ' + fmtDeadline(r.due, cfg) : '') + (r.note ? ' · ' + r.note : '') + (r.chaseDue != null ? ' · would chase now' : '')));
}

function installDeadlineTrigger() {
  removeDeadlineTrigger();
  ScriptApp.newTrigger('runDeadlines').timeBased().everyMinutes(15).create();
  console.log('Checking deadlines every 15 minutes' + (DEADLINES.DRY_RUN ? ' (dry run: nothing is sent).' : '.'));
}

function removeDeadlineTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'runDeadlines').forEach(t => ScriptApp.deleteTrigger(t));
}

if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, { DEADLINES, parseAssignmentLines, resolveOwners, parseDue, deadlinePhrases, namedItems, assignmentsIn, newText, readStatus, hasWork,
    subjectKey, assess, scorecardText, scorecardTable, scorecardHtml, fmtDeadline, zonedTime, readFull, ASSIGNMENT_HEADERS, MISS_HEADERS });
}
