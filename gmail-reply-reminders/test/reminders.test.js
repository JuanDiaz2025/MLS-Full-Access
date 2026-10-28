// The reminder rules, run with Node: node gmail-reply-reminders/test/reminders.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const ctx = { module: { exports: {} }, console };
vm.runInNewContext(src, ctx);
const R = ctx.module.exports;
const { MINUTE, HOUR, DAY } = R;
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
const cfg = { ...R.CONFIG, WATCH: ['juan@twinhomebuyer.com'] };
const now = Date.UTC(2026, 9, 28, 3, 0);
const JUAN = { email: 'juan@twinhomebuyer.com', name: 'Juan Diaz' };
const team = e => ({ email: e + '@twinhomebuyer.com', name: '' });
const msg = (from, to, hoursAgo, extra) => ({ from, to: to.map(e => e.includes('@') ? { email: e, name: '' } : team(e)), cc: [], subject: 'Fence quote',
  messageId: 'id-' + hoursAgo + '@mail', reminder: false, at: now - hoursAgo * HOUR, labelIds: [], ...extra });
const cc = list => ({ cc: list.map(team) });
const who = list => list.map(p => p.email.split('@')[0]).sort().join(',');
const pend = (t, c) => R.pendingInThread(t, 'juan@twinhomebuyer.com', c || cfg, now);

// headers
same(R.parseAddresses('"Diaz, Juan" <Juan@TwinHomeBuyer.com>, cherry@twinhomebuyer.com'),
  [{ email: 'juan@twinhomebuyer.com', name: 'Diaz, Juan' }, { email: 'cherry@twinhomebuyer.com', name: '' }]);
const m = R.toMessage({ internalDate: '1793124024000', labelIds: ['SENT'], payload: { headers: [
  { name: 'From', value: 'Juan Diaz <juan@twinhomebuyer.com>' }, { name: 'To', value: 'Cherry <cherry@twinhomebuyer.com>' },
  { name: 'Cc', value: 'leo@twinhomebuyer.com, Tin <tin@twinhomebuyer.com>' },
  { name: 'Message-ID', value: '<CAB123@mail.gmail.com>' }, { name: 'Subject', value: 'x' }] } });
assert.strictEqual(m.messageId, 'CAB123@mail.gmail.com'); assert.strictEqual(m.cc.length, 2); assert.strictEqual(m.reminder, false);
assert.strictEqual(R.toMessage({ internalDate: '1', payload: { headers: [{ name: 'X-Reply-Reminder', value: '1' }] } }).reminder, true);

// 1. Juan emails Cherry alone: private
let p = pend({ id: 't1', messages: [msg(JUAN, ['cherry'], 6)] });
assert.strictEqual(who(p), 'cherry'); assert.strictEqual(p[0].group, false);
// one person on the team plus an outside address in CC is still private
p = pend({ id: 't1b', messages: [msg(JUAN, ['cherry'], 6, { cc: [{ email: 'seller@gmail.com', name: '' }] })] });
assert.strictEqual(p[0].group, false);
console.log('1 one person: private');

// 2. Juan emails Cherry with Leo, Tin, Bryan and Seth in CC; Leo replied: the other four owe it, as a group
let t = { id: 't2', messages: [msg(JUAN, ['cherry'], 6, cc(['leo', 'tin', 'bryan', 'seth'])), msg(team('leo'), ['juan@twinhomebuyer.com'], 5)] };
p = pend(t);
assert.strictEqual(who(p), 'bryan,cherry,seth,tin');
assert.ok(p.every(x => x.group), 'a group email');
assert.strictEqual(p[0].inReplyTo, 'id-6@mail'); same(p[0].references, ['id-6@mail', 'id-5@mail']); assert.strictEqual(p[0].subject, 'Fence quote');
// two people in To is a group too
assert.ok(pend({ id: 't2b', messages: [msg(JUAN, ['cherry', 'tin'], 6)] }).every(x => x.group));
console.log('2 To and CC count; group:', who(p));

// 3. the reminders this script sends are never counted as emails
t = { id: 't3', messages: [msg(JUAN, ['cherry'], 6), msg(team('seth'), ['cherry'], 1, { reminder: true, messageId: 'r@m' })] };
p = pend(t);
assert.strictEqual(p.length, 1); assert.strictEqual(p[0].since, now - 6 * HOUR); same(p[0].references, ['id-6@mail']);

// 4. outside addresses, group lists and Juan himself are never reminded
t = { id: 't4', messages: [msg(JUAN, ['seller@gmail.com', 'juan@twinhomebuyer.com', 'team@twinhomebuyer.com'], 6)] };
assert.strictEqual(pend(t, { ...cfg, IGNORE: ['team@twinhomebuyer.com'] }).length, 0);

// 5. a follow-up after Cherry answered: she owes it again, from the follow-up
t = { id: 't5', messages: [msg(JUAN, ['cherry'], 30), msg(team('cherry'), ['juan@twinhomebuyer.com'], 29), msg(JUAN, ['cherry'], 5)] };
p = pend(t);
assert.strictEqual(p[0].since, now - 5 * HOUR); assert.strictEqual(p[0].inReplyTo, 'id-5@mail');

// 6. skipped: threads someone else started, the label, FYI, older than a week
t = { id: 't6', messages: [msg(team('cherry'), ['juan@twinhomebuyer.com'], 8), msg(JUAN, ['cherry'], 7)] };
assert.strictEqual(pend(t).length, 0);
assert.strictEqual(pend(t, { ...cfg, ONLY_THREADS_STARTED: false }).length, 1);
assert.strictEqual(R.pendingInThread({ id: 'l', messages: [msg(JUAN, ['cherry'], 6, { labelIds: ['L9'] })] }, 'juan@twinhomebuyer.com', cfg, now, 'L9').length, 0);
assert.strictEqual(pend({ id: 'f', messages: [msg(JUAN, ['cherry'], 6, { subject: 'FYI: new SOP' })] }).length, 0);
assert.strictEqual(pend({ id: 'o', messages: [msg(JUAN, ['cherry'], 8 * 24)] }).length, 0);
console.log('3-6 own reminders, outside, lists, follow-ups, others\' threads, label, FYI, old');

// 7. stages, in minutes; quiet hours off by default
same([3, 4, 23, 24, 47, 48, 200].map(h => R.stageFor(h * HOUR, cfg)), [0, 1, 1, 2, 2, 3, 3]);
same([0.5, 1, 4, 5, 9, 10].map(x => R.stageFor(x * MINUTE, { ...cfg, REMIND_AFTER_MINUTES: [1, 5, 10] })), [0, 1, 1, 2, 2, 3]);
assert.ok([0, 3, 12, 20, 23].every(h => !R.isQuietHour(h, cfg)));
same([7, 8, 20, 0].map(h => R.isQuietHour(h, { ...cfg, QUIET_FROM_HOUR: 20, QUIET_TO_HOUR: 8 })), [true, false, true, true]);

// 8. one reminder per thread: the group together, private ones alone
const group = pend({ id: 'g', messages: [msg(JUAN, ['cherry'], 6, cc(['leo', 'tin']))] });
const priv = pend({ id: 'p1', messages: [msg(JUAN, ['cherry'], 5, { messageId: 'p1@m' })] })
  .concat(pend({ id: 'p2', messages: [msg(JUAN, ['bryan'], 2, { messageId: 'p2@m' })] }));
let due = R.dueReminders(group.concat(priv), {}, cfg, now);
same(due.map(d => (d.group ? 'group:' : 'private:') + who(d.people)).sort(), ['group:cherry,leo,tin', 'private:cherry']);
const sent = {}; due.forEach(d => d.people.forEach(x => { sent[x.key] = x.stage; }));
assert.strictEqual(R.dueReminders(group.concat(priv), sent, cfg, now).length, 0, 'nothing twice');
// 20 hours later: the group's 2nd, Cherry's private 2nd, and Bryan's 1st
due = R.dueReminders(group.concat(priv), sent, cfg, now + 20 * HOUR);
same(due.map(d => who(d.people) + '@' + Math.max(...d.people.map(x => x.stage))).sort(), ['bryan@1', 'cherry,leo,tin@2', 'cherry@2']);
console.log('7-8 stages, one reminder per thread');

// 9. what the reminder says: never the content
const one = R.buildReminder({ senderName: 'Juan Diaz', since: now - 4 * HOUR, people: [{ email: 'cherry@twinhomebuyer.com', name: 'Cherry Ann', stage: 1 }] }, cfg, now);
assert.strictEqual(one.text.split('\n\n')[0], 'Hi Cherry,');
assert.ok(one.text.includes('Juan Diaz is still waiting for your reply to this email (sent 4 hours ago). Please reply in this thread.'));
assert.ok(one.text.includes('This is reminder 1 of 3.'));
const many = R.buildReminder({ senderName: 'Juan Diaz', since: now - 26 * HOUR, people: ['cherry', 'kristine', 'leo'].map(e => ({ ...team(e), stage: 2 })) }, cfg, now);
assert.ok(many.text.startsWith('Hi Cherry, Kristine and Leo,'));
assert.ok(many.text.includes('waiting for a reply from each of you on this email (sent 26 hours ago)'));
assert.ok(!/fence|quote/i.test(one.text + one.html + many.text + many.html));
console.log('9', JSON.stringify(many.text.split('\n\n').slice(0, 2).join(' ')));
same([R.ago(5 * MINUTE), R.ago(HOUR), R.ago(30 * HOUR), R.ago(3 * DAY)], ['5 minutes ago', '1 hour ago', '30 hours ago', '3 days ago']);
same([R.replySubject('Fence quote'), R.replySubject('Re: Fence quote'), R.replySubject('RE: x')], ['Re: Fence quote', 'Re: Fence quote', 'RE: x']);

// 10. the email itself: in Juan's thread, to the people who owe it, replies go to Juan
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const raw = R.mimeMessage({ from: 'seth@twinhomebuyer.com', to: ['cherry@twinhomebuyer.com', 'leo@twinhomebuyer.com'], replyTo: 'juan@twinhomebuyer.com',
  replyToName: 'Juan Diaz', subject: 'Fence quote', inReplyTo: 'B@m', references: ['A@m', 'B@m'], text: many.text, html: many.html, boundary: 'x' }, b64);
const [head, ...rest] = raw.split('\r\n\r\n');
const H = Object.fromEntries(head.split('\r\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
same([H.To, H['Reply-To'], H.Subject, H['In-Reply-To'], H.References, H['X-Reply-Reminder']],
  ['cherry@twinhomebuyer.com, leo@twinhomebuyer.com', '"Juan Diaz" <juan@twinhomebuyer.com>', 'Re: Fence quote', '<B@m>', '<A@m> <B@m>', '1']);
assert.ok(!/juan@/.test(H.To) && !H.Cc, 'Juan is not copied');
const textPart = rest.join('\r\n\r\n').split('\r\n\r\n')[1].split('\r\n--')[0];
assert.strictEqual(Buffer.from(textPart.replace(/\r\n/g, ''), 'base64').toString('utf8'), many.text);
assert.ok(raw.split('\r\n').every(l => l.length <= 998) && textPart.split('\r\n').every(l => l.length <= 76));
// a subject with accents or dashes is encoded so it arrives intact
assert.ok(R.mimeMessage({ from: 'a@x', to: ['b@x'], replyTo: 'c@x', subject: 'Señora – update', references: [], text: 'x', html: 'x', boundary: 'y' }, b64).includes('Subject: =?UTF-8?B?' + b64('Re: Señora – update') + '?='));
console.log('10 headers:', H.Subject, '| to:', H.To, '| reply-to:', H['Reply-To']);
console.log('all checks passed');
