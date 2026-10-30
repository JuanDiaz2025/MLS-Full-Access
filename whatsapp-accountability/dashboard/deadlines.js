
// ---- the deadline agent's log: who owes what by when, and who delivered ----
// The deadline agent (gmail-reply-reminders/Deadlines.gs) writes two tabs in
// the same sheet as the reply-reminder log: "Assignments", rewritten every 15
// minutes, and "Misses", one row per miss, never rewritten.

const PT_ZONE = 'America/Los_Angeles';

// Midnight Pacific on the day of t, in ms. Juan's days run on Pacific time.
function pacificDayStart(t) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: PT_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(t)).forEach(x => { p[x.type] = Number(x.value); });
  return t - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - (t % 1000);
}

const timeOf = s => { const t = Date.parse(String(s || '').replace(/^'/, '')); return Number.isFinite(t) ? t : null; };

// The Assignments tab as objects, columns found by header name. result is
// what the dashboard shows: missed, blocked, open, late (delivered after the
// deadline), done, or unread (an OWNER/DUE line the agent couldn't read).
function parseAssignments(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const head = values[0].map(h => String(h || '').trim().toLowerCase());
  const col = {};
  [['assigned', 'assigned'], ['subject', 'subject'], ['owner', 'owner'], ['ownerName', 'owner name'], ['due', 'due'], ['status', 'status'],
    ['delivered', 'delivered'], ['chased', 'chased'], ['note', 'note'], ['thread', 'thread'], ['link', 'link']].forEach(([k, h]) => { col[k] = head.indexOf(h); });
  if (col.owner < 0 || col.status < 0) return [];
  const get = (r, k) => col[k] >= 0 && r[col[k]] != null ? String(r[col[k]]).trim() : '';
  return values.slice(1).map(r => {
    const status = get(r, 'status').toLowerCase();
    if (!status) return null;
    const owner = get(r, 'owner').toLowerCase();
    const due = timeOf(get(r, 'due')), delivered = timeOf(get(r, 'delivered'));
    const note = get(r, 'note');
    const result = status === 'delivered' ? (/\blate\b/i.test(note) || (delivered != null && due != null && delivered > due) ? 'late' : 'done')
      : status === 'missed' ? 'missed' : status === 'blocked' ? 'blocked' : status === 'unclear' ? 'unread' : 'open';
    const link = get(r, 'link');
    return {
      assigned: timeOf(get(r, 'assigned')), subject: get(r, 'subject'), owner, name: get(r, 'ownerName') || (owner ? nameFromEmail(owner) : ''),
      due, status, result, delivered, chased: timeOf(get(r, 'chased')), note, thread: get(r, 'thread'),
      // only a Gmail address: the sheet is never trusted with where a link goes
      link: /^https:\/\/mail\.google\.com\//.test(link) ? link : '',
    };
  }).filter(Boolean);
}

// The Misses tab: { owner, name, subject, deadline, thread }.
function parseMisses(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const head = values[0].map(h => String(h || '').trim().toLowerCase());
  const at = h => head.indexOf(h);
  const c = { owner: at('owner'), name: at('owner name'), subject: at('subject'), deadline: at('deadline'), thread: at('thread') };
  if (c.owner < 0 || c.deadline < 0) return [];
  const get = (r, i) => i >= 0 && r[i] != null ? String(r[i]).trim() : '';
  return values.slice(1).map(r => {
    const owner = get(r, c.owner).toLowerCase(), deadline = timeOf(get(r, c.deadline));
    if (!owner || deadline == null) return null;
    return { owner, name: get(r, c.name) || nameFromEmail(owner), subject: get(r, c.subject), deadline, thread: get(r, c.thread) };
  }).filter(Boolean);
}

const RESULT_RANK = { missed: 0, blocked: 1, open: 2, unread: 3, late: 4, done: 5 };
// Juan's rule: 3 missed deadlines in 30 days puts someone on 30 days of AI coaching
const MISS_LIMIT = 3, MISS_WINDOW = 30 * 24 * 3600e3;

// What the Deadlines tab shows. Everything is per person per email, the same
// rows as the sheet. "Today" is the Pacific day.
function deriveDeadlines(rows, misses, now) {
  const today = pacificDayStart(now);
  const list = rows.slice().sort((a, b) => RESULT_RANK[a.result] - RESULT_RANK[b.result]
    || (a.result === 'done' || a.result === 'late' ? (b.delivered || 0) - (a.delivered || 0) : (a.due || 0) - (b.due || 0)));
  const count = r => list.filter(x => x.result === r).length;
  const deliveredToday = list.filter(x => (x.result === 'done' || x.result === 'late') && x.delivered >= today);
  const people = new Map();
  const person = (email, name) => {
    let p = people.get(email);
    if (!p) people.set(email, p = { email, name, missed: 0, blocked: 0, open: 0, done: 0, late: 0, misses30: 0 });
    if (name && p.name === nameFromEmail(email)) p.name = name;
    return p;
  };
  list.forEach(r => { if (r.owner && r.result !== 'unread') person(r.owner, r.name)[r.result]++; });
  // the Misses tab keeps every miss, even for emails older than the agent's look-back
  misses.forEach(m => { if (m.deadline > now - MISS_WINDOW) person(m.owner, m.name).misses30++; });
  const ppl = [...people.values()].sort((a, b) => b.missed - a.missed || b.misses30 - a.misses30 || b.blocked - a.blocked || b.open - a.open || a.name.localeCompare(b.name));
  return {
    list, people: ppl,
    missed: count('missed'), blocked: count('blocked'), open: count('open'), unread: count('unread'),
    deliveredToday: deliveredToday.length, lateToday: deliveredToday.filter(x => x.result === 'late').length,
    atLimit: ppl.filter(p => p.misses30 >= MISS_LIMIT).length,
  };
}

if (typeof module !== 'undefined') module.exports = Object.assign(module.exports || {}, { parseAssignments, parseMisses, deriveDeadlines, pacificDayStart, MISS_LIMIT });
