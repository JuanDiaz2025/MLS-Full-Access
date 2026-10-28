// The Email tab's numbers, from rows shaped like the reminder script's log.
const assert = require('assert');
const fs = require('fs'), vm = require('vm');
const dir = require('path').join(__dirname, '..');
const ctx = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(dir + '/model.js', 'utf8').replace(/if \(typeof module[^\n]*\n/, '') + '\n' + fs.readFileSync(dir + '/email.js', 'utf8'), ctx);
const E = ctx.module.exports;
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const H = 3600e3, now = Date.UTC(2026, 9, 28, 10, 0);
const iso = h => new Date(now - h * H).toISOString();
const HEAD = ['Thread', 'Subject', 'From', 'From name', 'Sent', 'Person', 'Name', 'On', 'Group', 'Replied', 'Status', 'Reminders', 'Message ID'];
const row = (thread, subject, sentH, person, name, on, group, repliedH, rem, id) =>
  [thread, subject, 'juan@twinhomebuyer.com', 'Juan Diaz', iso(sentH), person + '@twinhomebuyer.com', name, on, group ? 'yes' : 'no', repliedH == null ? '' : iso(repliedH), repliedH == null ? 'Waiting' : 'Replied', String(rem), id];
const values = [HEAD,
  row('t1', 'Fence quote', 6, 'cherry', 'Cherry Ann', 'To', true, null, 2, 'a@m'),
  row('t1', 'Fence quote', 6, 'leo', '', 'CC', true, 5, 0, 'a@m'),
  row('t1', 'Fence quote', 6, 'tin', 'Tin', 'CC', true, 2, 1, 'a@m'),
  row('t1', 'Fence quote', 3, 'leo', '', 'To', false, null, 0, 'f@m'),
  row('t2', 'Permit', 30, 'bryan', 'Bryan', 'To', false, null, 3, 'b@m'),
  row('t3', 'Lockbox code', 4, 'cherry', '', 'To', false, 3.5, 0, 'c@m'),
  ['', '', '', '', 'not a date', 'x@twinhomebuyer.com'],
  // reminders sent by the first version of the script, as separate emails
  ['t9', 'Juan Diaz is waiting for your reply', 'juan@twinhomebuyer.com', 'Reply reminders', iso(5), 'bryan@twinhomebuyer.com', '', 'To', 'no', '', 'Waiting', '3', 'r@m'],
  ['t8', 'Re: x', 'juan@twinhomebuyer.com', 'Reply reminders', iso(5), 'bryan@twinhomebuyer.com', '', 'To', 'no', '', 'Waiting', '3', 's@m'],
];
const rows = E.parseEmailLog(values);
assert.strictEqual(rows.length, 6, 'bad rows and old-style reminder emails skipped');
same(rows.map(r => r.name), ['Cherry Ann', 'Leo', 'Tin', 'Leo', 'Bryan', 'Cherry'], 'names, from the address when blank');
// columns found by name, wherever they are
const moved = values.map(r => [r[5], r[4], ...r.filter((_, i) => i !== 4 && i !== 5)]);
same(E.parseEmailLog(moved).map(r => r.person + r.sent), rows.map(r => r.person + r.sent), 'moved columns read the same');

const D = E.deriveEmail(rows, now);
same(D.open.map(t => t.subject + ':' + t.waiting.map(p => p.name).join('+')), ['Permit:Bryan', 'Fence quote:Cherry Ann+Leo'], 'longest wait first; Leo waits on the follow-up');
same(D.open[1].replied.map(p => p.name + ' ' + p.delay / H + 'h'), ['Tin 4h'], 'Leo shows once, by his latest wait');
assert.strictEqual(D.open[0].reminders, 3);
same(D.done.map(t => t.subject + ':' + t.replied.map(p => p.name)), ['Lockbox code:Cherry Ann'], 'the same name everywhere');
const cherry = D.people.find(p => p.email === 'cherry@twinhomebuyer.com');
same([cherry.name, cherry.asked, cherry.answered, cherry.waiting, cherry.avg / H], ['Cherry Ann', 2, 1, 1, 0.5], 'per person: every wait counts, the real name wins');
same(D.people.map(p => p.name), ['Bryan', 'Cherry Ann', 'Leo', 'Tin'], 'who has waited longest first');
assert.strictEqual(D.waitingPeople, 3); assert.strictEqual(D.threads, 3); assert.strictEqual(D.reminders, 6);
assert.strictEqual(Math.round(D.avg / 60000), Math.round((1 + 4 + 0.5) / 3 * 60));
same(E.deriveEmail([], now).open, []);

const st = E.parseEmailStatus([['Updated', iso(0.1)], ['Watching', 'Juan@TwinHomeBuyer.com, seth@twinhomebuyer.com'], ['Look-back days', '7'], ['Reminders after (minutes)', '240, 1440, 2880'], ['Reminders', 'on']]);
same([st.updated, st.watching, st.lookbackDays, st.remindAfter, st.reminders], [now - 0.1 * H, ['juan@twinhomebuyer.com', 'seth@twinhomebuyer.com'], 7, [240, 1440, 2880], 'on']);
same(E.parseEmailStatus(undefined).watching, []);

// the viewer's own inbox, shaped like the Gmail connector's get_thread
const m = (sender, h, sent) => ({ sender, internalDate: String(now - h * H), labelIds: sent ? ['SENT'] : ['INBOX'] });
const mine = E.myEmailWaits([
  { id: 'g1', subject: 'Fence quote', url: 'u1', messages: [m('juan@twinhomebuyer.com', 6), m('leo@twinhomebuyer.com', 5)] },
  { id: 'g2', subject: 'Permit', url: 'u2', messages: [m('juan@twinhomebuyer.com', 30), m('me@twinhomebuyer.com', 29, true), m('juan@twinhomebuyer.com', 3), m('juan@twinhomebuyer.com', 1)] },
  { id: 'g3', subject: 'Answered', messages: [m('juan@twinhomebuyer.com', 6), m('me@twinhomebuyer.com', 5, true)] },
  { id: 'g4', subject: 'Someone else started it', messages: [m('cherry@twinhomebuyer.com', 6), m('juan@twinhomebuyer.com', 5)] },
  { id: 'g5', subject: 'I started it', messages: [m('me@twinhomebuyer.com', 6, true), m('juan@twinhomebuyer.com', 5)] },
], ['Juan@twinhomebuyer.com']);
same(mine.map(x => x.subject + ' ' + (now - x.since) / H + 'h'), ['Fence quote 6h', 'Permit 3h'], 'waiting since their first unanswered email');

same([E.sheetIdFrom('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'), E.sheetIdFrom('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), E.sheetIdFrom('hello'), E.sheetIdFrom('')],
  ['1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', null, null]);
// stopped from the dashboard: the Stopped tab, as the sheet returns it
const stops = E.parseEmailStops([['Thread', 'Person', 'Subject', 'Stopped by', 'Stopped at'],
  ['t2', '', 'Permit', 'Seth Concepcion', iso(1)], ['', '', '', '', ''], ['t1', 'Cherry@twinhomebuyer.com', 'Fence quote', 'Seth Concepcion', iso(1)]]);
same(stops.map(x => x.row + ':' + x.thread + ':' + x.person), ['2:t2:everyone', '4:t1:cherry@twinhomebuyer.com'], 'rows kept for Resume, cleared rows skipped');
const S2 = E.deriveEmail(rows, now, stops);
same(S2.open.map(t => t.subject + ':' + t.waiting.map(p => p.name) + ':' + t.stopped.map(p => p.name)), ['Fence quote:Leo:Cherry Ann'], 'Cherry stopped on Fence quote, Leo still waiting');
same(S2.halted.map(t => t.subject), ['Permit'], 'Permit stopped for everyone');
const bryan = S2.people.find(p => p.name === 'Bryan');
same([bryan.waiting, bryan.stopped, S2.waitingPeople], [0, 1, 1], 'stopped is handled: not owed');
// a later email (after the stop) is not covered
assert.strictEqual(E.stopFor({ thread: 't2', person: 'bryan@twinhomebuyer.com', sent: now, replied: null }, stops), null);
// the log's own Status column says Stopped even when the tab can't be read
assert.ok(E.stopFor(E.parseEmailLog([HEAD, row('t5', 'x', 1, 'mike', '', 'To', false, null, 0, 'm@m').map((c, i) => i === 10 ? 'Stopped' : c)])[0], []));
same([E.parseEmailPause([['Paused', 'By', 'At'], ['yes', 'Seth', iso(2)]]), E.parseEmailPause([['Paused', 'By', 'At'], ['no', '', '']]), E.parseEmailPause(undefined)].map(p => p.paused + ':' + p.by), ['true:Seth', 'false:', 'false:']);
console.log('all checks passed');
