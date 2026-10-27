// The reminder rules, run with Node: node gmail-reply-reminders/test/reminders.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const ctx = { module: { exports: {} }, console };
vm.runInNewContext(src, ctx);
const R = ctx.module.exports;
const { HOUR, DAY } = R;
const cfg = { ...R.CONFIG, WATCH: ['juan@twinhomebuyer.com'] };
const now = Date.UTC(2026, 9, 28, 3, 0); // 11:00 AM in Manila
const JUAN = { email: 'juan@twinhomebuyer.com', name: 'Juan Diaz' };
const msg = (from, to, hoursAgo, extra) => ({ from, to: to.map(e => ({ email: e, name: '' })), subject: 'Fence quote', messageId: 'id-' + hoursAgo + '@mail', at: now - hoursAgo * HOUR, labelIds: [], ...extra });
const who = list => list.map(p => p.email).sort().join(',');

// headers
assert.deepStrictEqual(JSON.parse(JSON.stringify(R.parseAddresses('"Diaz, Juan" <Juan@TwinHomeBuyer.com>, cherry@twinhomebuyer.com'))),
  [{ email: 'juan@twinhomebuyer.com', name: 'Diaz, Juan' }, { email: 'cherry@twinhomebuyer.com', name: '' }]);
const m = R.toMessage({ internalDate: '1793124024000', labelIds: ['SENT'], payload: { headers: [
  { name: 'From', value: 'Juan Diaz <juan@twinhomebuyer.com>' }, { name: 'To', value: 'Cherry <cherry@twinhomebuyer.com>' },
  { name: 'Message-ID', value: '<CAB123@mail.gmail.com>' }, { name: 'Subject', value: 'x' }] } });
assert.strictEqual(m.messageId, 'CAB123@mail.gmail.com'); assert.strictEqual(m.at, 1793124024000); assert.strictEqual(m.from.name, 'Juan Diaz');

// 1. Juan emails Cherry and Vannessa; Vannessa replied, Cherry didn't
let t = { id: 't1', messages: [msg(JUAN, ['cherry@twinhomebuyer.com', 'vannessa@twinhomebuyer.com'], 6), msg({ email: 'vannessa@twinhomebuyer.com' }, ['juan@twinhomebuyer.com'], 5)] };
let p = R.pendingInThread(t, 'juan@twinhomebuyer.com', cfg, now);
assert.strictEqual(who(p), 'cherry@twinhomebuyer.com');
assert.strictEqual(p[0].since, now - 6 * HOUR); assert.strictEqual(p[0].senderName, 'Juan Diaz');
console.log('1 owes a reply:', who(p));

// 2. outside the company, Cc, group lists and Juan himself are never reminded
t = { id: 't2', messages: [msg(JUAN, ['seller@gmail.com', 'juan@twinhomebuyer.com', 'team@twinhomebuyer.com'], 6, { })] };
assert.strictEqual(R.pendingInThread(t, 'juan@twinhomebuyer.com', { ...cfg, IGNORE: ['team@twinhomebuyer.com'] }, now).length, 0);

// 3. Juan follows up after Cherry answered: she owes a reply again, counted from the follow-up
t = { id: 't3', messages: [msg(JUAN, ['cherry@twinhomebuyer.com'], 30), msg({ email: 'cherry@twinhomebuyer.com' }, ['juan@twinhomebuyer.com'], 29), msg(JUAN, ['cherry@twinhomebuyer.com'], 5)] };
p = R.pendingInThread(t, 'juan@twinhomebuyer.com', cfg, now);
assert.strictEqual(p.length, 1); assert.strictEqual(p[0].since, now - 5 * HOUR); assert.strictEqual(p[0].messageId, 'id-5@mail');

// 4. two unanswered emails in a row: the wait counts from the first
t = { id: 't4', messages: [msg(JUAN, ['cherry@twinhomebuyer.com'], 26), msg(JUAN, ['cherry@twinhomebuyer.com'], 2)] };
assert.strictEqual(R.pendingInThread(t, 'juan@twinhomebuyer.com', cfg, now)[0].since, now - 26 * HOUR);

// 5. a thread someone else started (Juan's "Thanks!") doesn't count, unless switched on
t = { id: 't5', messages: [msg({ email: 'cherry@twinhomebuyer.com' }, ['juan@twinhomebuyer.com'], 8), msg(JUAN, ['cherry@twinhomebuyer.com'], 7)] };
assert.strictEqual(R.pendingInThread(t, 'juan@twinhomebuyer.com', cfg, now).length, 0);
assert.strictEqual(R.pendingInThread(t, 'juan@twinhomebuyer.com', { ...cfg, ONLY_THREADS_STARTED: false }, now).length, 1);

// 6. skipped: the "No reply needed" label, an FYI subject, older than a week
t = { id: 't6', messages: [msg(JUAN, ['cherry@twinhomebuyer.com'], 6, { labelIds: ['SENT', 'Label_9'] })] };
assert.strictEqual(R.pendingInThread(t, 'juan@twinhomebuyer.com', cfg, now, 'Label_9').length, 0);
t = { id: 't7', messages: [msg(JUAN, ['cherry@twinhomebuyer.com'], 6, { subject: 'FYI: new SOP' })] };
assert.strictEqual(R.pendingInThread(t, 'juan@twinhomebuyer.com', cfg, now).length, 0);
t = { id: 't8', messages: [msg(JUAN, ['cherry@twinhomebuyer.com'], 8 * 24)] };
assert.strictEqual(R.pendingInThread(t, 'juan@twinhomebuyer.com', cfg, now).length, 0);
console.log('2-6 outside, Cc, lists, replies to others, label, FYI, old: skipped');

// 7. stages: at 4h, 24h and 48h, then no more; each stage sent once; one email per person
assert.strictEqual(JSON.stringify([3, 4, 23, 24, 47, 48, 200].map(h => R.stageFor(h * HOUR, cfg))), '[0,1,1,2,2,3,3]');
assert.strictEqual(JSON.stringify([0.5, 1, 4, 5, 9, 10].map(m => R.stageFor(m * R.MINUTE, { ...cfg, REMIND_AFTER_MINUTES: [1, 5, 10] }))), '[0,1,1,2,2,3]');
const pend = [
  { email: 'cherry@twinhomebuyer.com', name: 'Cherry Ann', since: now - 5 * HOUR, messageId: 'a@m', senderName: 'Juan Diaz' },
  { email: 'cherry@twinhomebuyer.com', name: 'Cherry Ann', since: now - 30 * HOUR, messageId: 'b@m', senderName: 'Juan Diaz' },
  { email: 'mike@twinhomebuyer.com', name: '', since: now - 2 * HOUR, messageId: 'c@m', senderName: 'Juan Diaz' },
];
let due = R.dueReminders(pend, {}, cfg, now);
assert.strictEqual(due.length, 1, 'Mike has only waited 2 hours');
assert.strictEqual(due[0].items.length, 2, "Cherry's two emails go in one reminder");
const sent = {}; due[0].items.forEach(it => { sent[it.key] = it.stage; });
assert.strictEqual(R.dueReminders(pend, sent, cfg, now).length, 0, 'nothing is sent twice');
// 20 hours later: the 5-hour one passes 24h (2nd reminder), the 30-hour one passes 48h (3rd)
assert.strictEqual(JSON.stringify(R.dueReminders(pend, sent, cfg, now + 20 * HOUR)[0].items.map(it => it.stage)), '[2,3]');
assert.strictEqual(R.dueReminders(pend, { 'cherry@twinhomebuyer.com|a@m': 3, 'cherry@twinhomebuyer.com|b@m': 3, 'mike@twinhomebuyer.com|c@m': 3 }, cfg, now + 500 * HOUR).length, 0, 'no more after the 3rd');
console.log('7 stages 4h/24h/48h (or minutes), once each, one email per person');

// 8. quiet hours are off by default; when set to 8 PM to 8 AM they hold reminders overnight
assert.ok([0, 3, 8, 12, 20, 23].every(h => !R.isQuietHour(h, cfg)), 'off by default');
const night = { ...cfg, QUIET_FROM_HOUR: 20, QUIET_TO_HOUR: 8 };
assert.strictEqual(JSON.stringify([7, 8, 19, 20, 23, 0].map(h => R.isQuietHour(h, night))), '[true,false,false,true,true,true]');

// 9. the reminder never carries the subject or the content
const mail = R.buildReminder({ email: 'cherry@twinhomebuyer.com', name: 'Cherry Ann' }, 'Juan Diaz',
  [{ since: now - 5 * HOUR, messageId: 'CAB123@mail.gmail.com', stage: 1 }], cfg, () => 'Tue, Oct 27 at 6:00 PM');
console.log('9 subject:', mail.subject); console.log(mail.body);
assert.strictEqual(mail.subject, 'Juan Diaz is waiting for your reply');
assert.ok(!/fence|quote/i.test(mail.subject + mail.body + mail.html));
assert.ok(mail.body.startsWith('Hi Cherry,'));
assert.ok(mail.body.includes('https://mail.google.com/mail/?authuser=cherry%40twinhomebuyer.com#search/rfc822msgid%3ACAB123%40mail.gmail.com'));
assert.ok(mail.body.includes('reminder 1 of 3'));
const two = R.buildReminder({ email: 'cherry@twinhomebuyer.com', name: '' }, 'Juan Diaz', [{ since: 1, messageId: 'a', stage: 2 }, { since: 2, messageId: 'b', stage: 1 }], cfg, () => 'x');
assert.strictEqual(two.subject, 'Juan Diaz is waiting for your reply to 2 emails'); assert.ok(two.body.startsWith('Hi cherry,'));
console.log('all checks passed');
