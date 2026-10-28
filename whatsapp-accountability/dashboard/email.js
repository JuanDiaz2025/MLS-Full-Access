
// ---- the Gmail reply log: who Juan emailed, who answered and how fast ----
// The reply-reminder script writes it to a Google Sheet ("Emails" and
// "Status" tabs); headers only, never what an email says.
const EMAIL_STALE = 30 * MIN; // the script checks every few minutes; older than this, it has stopped

const nameFromEmail = e => { const l = String(e || '').split('@')[0]; return l.charAt(0).toUpperCase() + l.slice(1); };

// The Emails tab as objects, found by header name so a moved column still reads right.
function parseEmailLog(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const head = values[0].map(h => String(h || '').trim().toLowerCase());
  const col = {};
  [['thread', 'thread'], ['subject', 'subject'], ['from', 'from'], ['fromName', 'from name'], ['sent', 'sent'], ['person', 'person'],
    ['name', 'name'], ['on', 'on'], ['group', 'group'], ['replied', 'replied'], ['reminders', 'reminders'], ['msgId', 'message id']]
    .forEach(([k, h]) => { col[k] = head.indexOf(h); });
  if (col.person < 0 || col.sent < 0) return [];
  const get = (r, k) => col[k] >= 0 && r[col[k]] != null ? String(r[col[k]]).trim() : '';
  return values.slice(1).map((r, i) => {
    const person = get(r, 'person').toLowerCase();
    const sent = Date.parse(get(r, 'sent'));
    if (!person || !Number.isFinite(sent)) return null;
    const replied = get(r, 'replied') ? Date.parse(get(r, 'replied')) : NaN;
    const name = get(r, 'name');
    return {
      thread: get(r, 'thread') || `row${i}`, subject: get(r, 'subject'), from: get(r, 'from').toLowerCase(),
      fromName: get(r, 'fromName') || nameFromEmail(get(r, 'from')), sent, person,
      name: name && !name.includes('@') ? name : nameFromEmail(person),
      on: get(r, 'on').toUpperCase() === 'CC' ? 'CC' : 'To', group: get(r, 'group').toLowerCase() === 'yes',
      replied: Number.isFinite(replied) ? replied : null, reminders: parseInt(get(r, 'reminders'), 10) || 0, msgId: get(r, 'msgId'),
    };
  }).filter(Boolean);
}

// The Status tab: { updated, watching: [emails], lookbackDays, remindAfter, reminders }.
function parseEmailStatus(values) {
  const kv = {};
  (Array.isArray(values) ? values : []).forEach(r => { if (r && r[0]) kv[String(r[0]).trim().toLowerCase()] = String(r[1] == null ? '' : r[1]).trim(); });
  const updated = Date.parse(kv.updated || '');
  return {
    updated: Number.isFinite(updated) ? updated : null,
    watching: (kv.watching || '').split(/[,\s]+/).map(x => x.toLowerCase()).filter(x => x.includes('@')),
    lookbackDays: parseInt(kv['look-back days'], 10) || null,
    remindAfter: (kv['reminders after (minutes)'] || '').split(/[,\s]+/).map(Number).filter(n => n > 0),
    reminders: kv.reminders || '',
  };
}

// What the Email tab shows. A thread lists each person once, with their
// latest wait in it; the per-person numbers count every wait.
function deriveEmail(rows, now) {
  // one name per person: a real name from any row beats one made from the address
  const names = new Map();
  rows.forEach(r => { if (!names.has(r.person) || names.get(r.person) === nameFromEmail(r.person)) names.set(r.person, r.name); });
  rows = rows.map(r => ({ ...r, name: names.get(r.person) }));
  const threads = new Map();
  rows.forEach(r => {
    let t = threads.get(r.thread);
    if (!t) threads.set(r.thread, t = { id: r.thread, subject: r.subject, from: r.from, fromName: r.fromName, first: r.sent, msgId: r.msgId, latest: new Map() });
    if (r.sent < t.first) { t.first = r.sent; t.msgId = r.msgId || t.msgId; }
    const prev = t.latest.get(r.person);
    if (!prev || r.sent >= prev.sent) t.latest.set(r.person, r);
  });
  const list = [...threads.values()].map(t => {
    const people = [...t.latest.values()];
    const waiting = people.filter(p => p.replied == null).map(p => ({ ...p, waiting: Math.max(0, now - p.sent) })).sort((a, b) => b.waiting - a.waiting);
    const replied = people.filter(p => p.replied != null).map(p => ({ ...p, delay: Math.max(0, p.replied - p.sent) })).sort((a, b) => a.replied - b.replied);
    const lastReply = replied.length ? replied[replied.length - 1].replied : null;
    return { id: t.id, subject: t.subject, from: t.from, fromName: t.fromName, first: t.first, msgId: t.msgId, waiting, replied,
      longest: waiting.length ? waiting[0].waiting : 0, reminders: waiting.length ? Math.max(...waiting.map(p => p.reminders)) : 0, lastReply };
  });
  const open = list.filter(t => t.waiting.length).sort((a, b) => b.longest - a.longest);
  const done = list.filter(t => !t.waiting.length).sort((a, b) => b.lastReply - a.lastReply);

  const byPerson = new Map();
  rows.forEach(r => {
    let p = byPerson.get(r.person);
    if (!p) byPerson.set(r.person, p = { email: r.person, name: r.name, asked: 0, answered: 0, waiting: 0, delays: [], longest: 0, reminders: 0 });
    p.asked++;
    p.reminders += r.reminders;
    if (r.replied != null) { p.answered++; p.delays.push(Math.max(0, r.replied - r.sent)); }
    else { p.waiting++; p.longest = Math.max(p.longest, now - r.sent); }
  });
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const people = [...byPerson.values()].map(p => ({ ...p, avg: mean(p.delays) }))
    .sort((a, b) => b.waiting - a.waiting || b.longest - a.longest || (b.avg ?? -1) - (a.avg ?? -1) || a.name.localeCompare(b.name));
  return {
    open, done, people, threads: list.length,
    waitingPeople: people.filter(p => p.waiting).length,
    avg: mean(rows.filter(r => r.replied != null).map(r => Math.max(0, r.replied - r.sent))),
    reminders: rows.reduce((n, r) => n + r.reminders, 0),
  };
}

// The viewer's own inbox: threads someone being watched started, where the
// viewer hasn't written since that person's first unanswered email.
// threads: [{ id, subject, url, messages: [{ sender, internalDate | date, labelIds }] }]
function myEmailWaits(threads, watching) {
  const W = new Set((watching || []).map(x => String(x).toLowerCase()));
  return (threads || []).map(t => {
    const msgs = (t.messages || []).map(m => ({
      from: String(m.sender || '').toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1'),
      at: Number(m.internalDate) || Date.parse(m.date || ''),
      mine: (m.labelIds || []).includes('SENT'),
    })).filter(m => Number.isFinite(m.at)).sort((a, b) => a.at - b.at);
    if (!msgs.length || !W.has(msgs[0].from) || msgs[0].mine) return null; // only emails they started, to the viewer
    let since = null, from = null;
    msgs.forEach(m => {
      if (m.mine) since = null;
      else if (W.has(m.from) && since == null) { since = m.at; from = m.from; }
    });
    return since == null ? null : { id: t.id, subject: t.subject || '', url: t.url || '', since, from };
  }).filter(Boolean).sort((a, b) => a.since - b.since);
}

// "https://docs.google.com/spreadsheets/d/<id>/edit#gid=0" or a bare id -> the id
function sheetIdFrom(text) {
  const s = String(text || '').trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{25,}$/.test(s) ? s : null;
}

if (typeof module !== 'undefined') module.exports = { parseEmailLog, parseEmailStatus, deriveEmail, myEmailWaits, sheetIdFrom, nameFromEmail, EMAIL_STALE };
