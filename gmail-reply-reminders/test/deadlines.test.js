// The deadline agent's rules, run with Node: node gmail-reply-reminders/test/deadlines.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { formatDate } = require('./fakes');
const dir = path.join(__dirname, '..');
const ctx = { module: { exports: {} }, console, Utilities: { formatDate } };
vm.runInNewContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, 'Deadlines.gs'), 'utf8'), ctx);
const D = ctx.module.exports;
const same = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const cfg = { ...D.DEADLINES };
const H = 3600e3, MIN = 60e3;
const PT = (y, mo, d, h, mi = 0) => D.zonedTime(y, mo - 1, d, h, mi, 'America/Los_Angeles');
const iso = t => new Date(t).toISOString();

// 1. the OWNER / DUE line
same(D.parseAssignmentLines('Please get the numbers.\nOWNER: Cherry · DUE: Oct 30, 5 PM PT\nThanks'), [{ owner: 'Cherry', due: 'Oct 30, 5 PM PT' }]);
same(D.parseAssignmentLines('DUE: tomorrow noon | OWNER: Leo'), [{ owner: 'Leo', due: 'tomorrow noon' }], 'either order');
same(D.parseAssignmentLines('Owner: cherry@twinhomebuyer.com; Due: 10/30 17:00\nOWNER: Leo · DUE: Friday EOD.'),
  [{ owner: 'cherry@twinhomebuyer.com', due: '10/30 17:00' }, { owner: 'Leo', due: 'Friday EOD' }], 'two assignments, any case');
same(D.parseAssignmentLines('OWNER: Cherry\nDUE: Oct 30'), [], 'a line needs both');
console.log('1 assignment lines');

// 2. owners matched to the people on the email
const R = [{ email: 'cherry@twinhomebuyer.com', name: 'Cherry Ann' }, { email: 'leo@twinhomebuyer.com', name: 'Leo' }, { email: 'tin@twinhomebuyer.com', name: '' }];
same(D.resolveOwners('Cherry', R).people.map(p => p.email), ['cherry@twinhomebuyer.com']);
same(D.resolveOwners('cherry ann', R).people.map(p => p.email), ['cherry@twinhomebuyer.com']);
same(D.resolveOwners('Tin', R).people.map(p => p.email), ['tin@twinhomebuyer.com'], 'by the address when there is no name');
same(D.resolveOwners('Cherry and Leo', R).people.map(p => p.email), ['cherry@twinhomebuyer.com', 'leo@twinhomebuyer.com']);
same(D.resolveOwners('Cherry, Bob', R), { people: [{ email: 'cherry@twinhomebuyer.com', name: 'Cherry Ann' }], unknown: ['Bob'] }, 'someone not on the email');
same(D.resolveOwners('Leo', [{ email: 'leo@twinhomebuyer.com', name: 'Leo Santos' }, { email: 'leo2@twinhomebuyer.com', name: 'Leo Cruz' }]).unknown, ['Leo'], 'two Leos: not guessed');
same(D.resolveOwners('Leo', R.concat([{ email: 'leo2@twinhomebuyer.com', name: 'Leo Cruz' }])).people.map(p => p.email), ['leo@twinhomebuyer.com'], 'an exact full name wins');
console.log('2 owners');

// 3. deadlines, read against the email's date (sent Thu Oct 29 2026, 9:00 AM Pacific)
const sent = PT(2026, 10, 29, 9);
same([
  'Oct 30, 5 PM PT', 'tomorrow noon', '3 PM', '8 AM', 'Friday EOD', '10/30 17:00', 'Nov 2', 'Oct 30 5 PM Manila', 'Jan 5', '30 Oct 2:30pm',
].map(s => iso(D.parseDue(s, sent, cfg))), [
  iso(PT(2026, 10, 30, 17)), iso(PT(2026, 10, 30, 12)), iso(PT(2026, 10, 29, 15)), iso(PT(2026, 10, 30, 8)), iso(PT(2026, 10, 30, 17)),
  iso(PT(2026, 10, 30, 17)), iso(PT(2026, 11, 2, 17)), iso(Date.UTC(2026, 9, 30, 9)), iso(PT(2027, 1, 5, 17)), iso(PT(2026, 10, 30, 14, 30)),
]);
assert.strictEqual(PT(2026, 11, 2, 17) - Date.UTC(2026, 10, 3, 1), 0, 'Nov 2 is after the clocks change: 5 PM PST is 1:00 UTC');
same(['asap', 'end of month', ''].map(s => D.parseDue(s, sent, cfg)), [null, null, null], 'no date or time: not read');
same(D.fmtDeadline(PT(2026, 10, 30, 17), cfg), 'Oct 30, 5:00 PM PT');
console.log('3 deadlines');

// 4. replies: only the new text, then DONE / DATE / BLOCKED at the start of a line
assert.strictEqual(D.newText('DONE, attached.\n\nOn Wed, Oct 28, 2026 at 9:15 AM Seth Concepcion <seth@twinhomebuyer.com> wrote:\n> OWNER: Cherry · DUE: today 3 PM'), 'DONE, attached.');
assert.strictEqual(D.newText('Working on it\nOn Wed, Oct 28, 2026 at 9:15 AM Seth Concepcion <\nseth@twinhomebuyer.com> wrote:\n> old'), 'Working on it');
assert.strictEqual(D.newText('> quoted only\nnew line'), 'new line');
same(['DONE', 'Date: Nov 2 3 PM', 'blocked: waiting on the permit', 'Here it is', 'I am done'].map(t => { const s = D.readStatus(t, sent, cfg); return s && s.kind + (s.until ? ' ' + iso(s.until) : ''); }),
  ['DONE', 'DATE ' + iso(PT(2026, 11, 2, 15)), 'BLOCKED', null, null]);
assert.ok(D.hasWork({ attachments: ['quote.pdf'], text: '' }) && D.hasWork({ attachments: [], text: 'here https://docs.google.com/spreadsheets/d/abc' }));
assert.ok(!D.hasWork({ attachments: [], text: 'Regards\nhttps://www.twinhomebuyer.com' }), 'a signature link is not work');
same([D.subjectKey('Re: TEST Fence quote'), D.subjectKey('FW: re: Fence  Quote')], ['fence quote', 'fence quote']);
console.log('4 replies');

// 5. where an assignment stands
const T = PT(2026, 10, 29, 15), T2 = PT(2026, 10, 30, 12);
const msg = (at, text, attachments) => ({ at, text, attachments: attachments || [] });
const st = (msgs, chases, now) => { const a = D.assess({ due: T }, msgs, chases || [], now, cfg); return [a.status, a.late, a.missedDue && iso(a.missedDue), a.chaseDue && iso(a.chaseDue)].join(' '); };
assert.strictEqual(st([], [], T - H), 'open false  ', 'before the deadline: open');
assert.strictEqual(st([], [], T + 5 * MIN), `missed false ${iso(T)} ${iso(T)}`, 'deadline passed, nothing: chase now');
assert.strictEqual(st([], [T + 10 * MIN], T + H), `missed false ${iso(T)} `, 'already chased: not again');
assert.strictEqual(st([msg(T - H, 'DONE')], [], T + H), 'delivered false  ', 'DONE before: on time');
assert.strictEqual(st([msg(T - H, 'here you go', ['quote.pdf'])], [], T + H), 'delivered false  ', 'an attachment counts');
assert.strictEqual(st([msg(T + H, 'DONE sorry')], [], T + 2 * H), `delivered true ${iso(T)} `, 'DONE after: late, and a miss');
assert.strictEqual(st([msg(T - H, 'DATE: tomorrow noon')], [], T + H), 'date false  ', 'DATE before: the deadline moves');
assert.strictEqual(st([msg(T - H, 'DATE: tomorrow noon'), msg(T - 30 * MIN, 'DATE: Nov 5')], [], T2 + H), `missed false ${iso(T2)} ${iso(T2)}`, 'moves once; then chased at the new deadline');
assert.strictEqual(st([msg(T + H, 'DATE: tomorrow')], [], T + 2 * H), `missed false ${iso(T)} ${iso(T)}`, 'DATE after the deadline: still chased');
assert.strictEqual(st([msg(T - H, 'BLOCKED: no access to the folder')], [], T + H), 'blocked false  ', 'BLOCKED before: not chased');
console.log('5 assess');

// 6. the scorecard: results only
const dayStart = PT(2026, 10, 29, 0), dayEnd = PT(2026, 10, 30, 0);
const card = D.scorecardText([
  { ownerName: 'Cherry Ann', subject: 'TEST Fence quote', status: 'delivered', due: T, deliveredAt: T - H, late: false },
  { ownerName: 'Leo', subject: 'TEST Fence quote', status: 'missed', due: T, deliveredAt: null },
  { ownerName: 'Mike', subject: 'TEST Permit', status: 'blocked', due: T2, deliveredAt: null },
  { ownerName: 'Bob', subject: 'TEST Lockbox', status: 'unclear', due: null, deliveredAt: null, note: 'not on the email: Bob' },
], [{ ownerName: 'Leo', subject: 'TEST Fence quote', deadline: T }], dayStart, dayEnd, cfg);
assert.strictEqual(card, ['DELIVERED TODAY\n- Cherry Ann: TEST Fence quote (on time)', 'MISSED TODAY\n- Leo: TEST Fence quote (due Oct 29, 3:00 PM PT)',
  'STILL OPEN\n- Leo: TEST Fence quote (overdue since Oct 29, 3:00 PM PT)\n- Mike: TEST Permit (BLOCKED)', 'NOT READ (fix the OWNER or DUE line)\n- TEST Lockbox: not on the email: Bob'].join('\n\n'));
console.log('6 scorecard');
console.log('all checks passed');
