// The Deadlines tab's numbers, from rows shaped like the deadline agent's log.
const assert = require('assert');
const fs = require('fs'), vm = require('vm');
const dir = require('path').join(__dirname, '..');
const ctx = { module: { exports: {} }, Intl };
vm.runInNewContext(fs.readFileSync(dir + '/model.js', 'utf8').replace(/if \(typeof module[^\n]*\n/, '') + '\n' + fs.readFileSync(dir + '/email.js', 'utf8').replace(/if \(typeof module[^\n]*\n/, '') + '\n' + fs.readFileSync(dir + '/deadlines.js', 'utf8'), ctx);
const D = ctx.module.exports;
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const H = 3600e3, now = Date.UTC(2026, 9, 30, 18, 0); // Fri Oct 30, 11:00 AM Pacific
const iso = h => (h == null ? '' : new Date(now - h * H).toISOString());
const HEAD = ['Assigned', 'Subject', 'Owner', 'Owner name', 'Due', 'Status', 'Delivered', 'Chased', 'Note', 'Thread', 'Link'];
const row = (subject, owner, name, dueH, status, delivH, chasedH, note, link) =>
  [iso(dueH + 2), subject, owner ? owner + '@twinhomebuyer.com' : '', name, iso(dueH), status, iso(delivH), iso(chasedH), note || '', 't-' + subject, link == null ? 'https://mail.google.com/mail/#search/rfc822msgid%3Ax' : link];
const A = [HEAD,
  row('Fence quote', 'bryan', 'Bryan Cadahing', 2, 'missed', null, 1.8),
  row('Lockbox', 'bryan', 'Bryan Cadahing', 30, 'missed', null, 29),
  row('Permit', 'lawrence', 'Lawrence Oliveros', -3, 'blocked'),
  row('Comps', 'cherry', '', -1, 'open', null, null, '', 'javascript:alert(1)'),
  row('Relay', 'lawrence', 'Lawrence Oliveros', 1, 'delivered', 1.5),
  row('AmEx', 'bryan', 'Bryan Cadahing', 3, 'delivered', 2.5, null, 'late'),
  row('Yesterday', 'cherry', 'Cherry Ann', 40, 'delivered', 41),
  ['', 'Bad line', '', 'Bob', '', 'unclear', '', '', 'not on the email: Bob', 't9', ''],
  ['', '', '', '', '', '', '', '', '', '', ''],
];
const rows = D.parseAssignments(A);
same(rows.length, 8, 'blank rows skipped');
same(rows.map(r => r.result), ['missed', 'missed', 'blocked', 'open', 'done', 'late', 'done', 'unread']);
same(rows[3].name, 'Cherry', 'a name from the address when blank');
same(rows[3].link, '', 'only Gmail links are kept');
same(rows[0].link, 'https://mail.google.com/mail/#search/rfc822msgid%3Ax');
// columns found by name, wherever they are
same(D.parseAssignments(A.map(r => r.slice().reverse())).map(r => r.result), rows.map(r => r.result), 'moved columns still read');
same(D.parseAssignments([['x']]), [], 'not the Assignments tab');
same(D.parseAssignments([HEAD]), []);

const MH = ['Missed on', 'Owner', 'Owner name', 'Subject', 'Deadline', 'Chased', 'Thread'];
const miss = (owner, name, h) => ['2026-10-30', owner + '@twinhomebuyer.com', name, 'x', iso(h), '', 't'];
const misses = D.parseMisses([MH, miss('bryan', 'Bryan Cadahing', 2), miss('bryan', 'Bryan Cadahing', 30), miss('bryan', 'Bryan Cadahing', 24 * 12),
  miss('bryan', 'Bryan Cadahing', 24 * 40), miss('leo', '', 24 * 3), ['', '', '', '', 'bad', '', '']]);
same(misses.length, 5, 'a row without an owner or deadline is skipped');

const d = D.deriveDeadlines(rows, misses, now);
same([d.missed, d.blocked, d.open, d.unread], [2, 1, 1, 1]);
same([d.deliveredToday, d.lateToday], [2, 1], 'today is the Pacific day: Relay and AmEx, not yesterday’s');
same(d.list.map(r => r.subject), ['Lockbox', 'Fence quote', 'Permit', 'Comps', 'Bad line', 'AmEx', 'Relay', 'Yesterday'], 'overdue first (oldest deadline first), then blocked, open, unread, then delivered (latest first)');
same(d.people.map(p => `${p.name} ${p.missed}/${p.blocked}/${p.open}/${p.done}/${p.late} ${p.misses30}`),
  ['Bryan Cadahing 2/0/0/0/1 3', 'Leo 0/0/0/0/0 1', 'Lawrence Oliveros 0/1/0/1/0 0', 'Cherry Ann 0/0/1/1/0 0'],
  'per person; misses in the last 30 days from the Misses tab, so Leo shows up with no current task; a real name wins');
same(d.atLimit, 1, 'Bryan has 3 misses in 30 days');
same(D.deriveDeadlines([], [], now).people, []);
// midnight Pacific, across the clock change on Sun Nov 1
same(new Date(D.pacificDayStart(now)).toISOString(), '2026-10-30T07:00:00.000Z');
same(new Date(D.pacificDayStart(Date.UTC(2026, 10, 2, 18))).toISOString(), '2026-11-02T08:00:00.000Z');
console.log('all checks passed');
