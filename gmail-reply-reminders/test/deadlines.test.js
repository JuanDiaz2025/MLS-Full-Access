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
same(['TEST Comps check, due 4:00 PM today', '364 Madison: disclosures, 3R and value verdict by 12:40 PM', 'New build: automatic deadline watcher, working test by Tue Nov 3, 5:00 PM', 'Paid by card', 'Due diligence checklist']
  .map(D.subjectKey), ['comps check', '364 madison: disclosures, 3r and value verdict', 'new build: automatic deadline watcher, working test', 'paid by card', 'due diligence checklist'], 'the deadline at the end is not part of the subject');
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
same(D.scorecardTable([
  { ownerName: 'Cherry Ann', subject: 'TEST Fence quote', status: 'delivered', due: T, deliveredAt: T - H, late: false },
  { ownerName: 'Leo', subject: 'TEST Fence quote', status: 'missed', due: T, deliveredAt: null },
  { ownerName: 'Mike', subject: 'TEST Permit', status: 'blocked', due: T2, deliveredAt: null },
  { ownerName: 'Tin', subject: 'TEST Lockbox', status: 'delivered', due: T, deliveredAt: T + H, late: true },
  { ownerName: 'Old', subject: 'TEST Yesterday', status: 'delivered', due: T - 30 * H, deliveredAt: T - 30 * H, late: false },
  { ownerName: 'Bob', subject: 'TEST Lockbox', status: 'unclear', due: null, deliveredAt: null, note: 'x' },
], dayStart, dayEnd).map(t => t.person + ' | ' + t.task + ' | ' + t.result), ['Leo | TEST Fence quote | Missed', 'Mike | TEST Permit | Blocked', 'Tin | TEST Lockbox | Delivered late', 'Cherry Ann | TEST Fence quote | Delivered'], 'table: misses first, today only, unreadable ones left out');
const html = D.scorecardHtml([{ ownerName: 'Leo <b>', subject: 'TEST Fence & quote', status: 'missed', due: T, deliveredAt: null }, { ownerName: 'Bob', subject: 'TEST Lockbox', status: 'unclear', note: 'not on the email: Bob' }], dayStart, dayEnd, cfg);
assert.ok(html.includes('<th') && html.includes('Leo &lt;b&gt;') && html.includes('TEST Fence &amp; quote') && html.includes('Oct 29, 3:00 PM PT') && html.includes('>Missed</td>') && html.includes('Missed: <b>1</b>') && html.includes('not on the email: Bob'), 'html table, escaped');
console.log('6 scorecard');

// 7. Juan's own style
const sent3 = PT(2026, 10, 29, 11, 46);
const dp = t => D.deadlinePhrases(t, sent3, cfg).map(iso);
same(dp('URGENT: Load core values + SOPs into the Team Hub, due 3:30 PM today'), [iso(PT(2026, 10, 29, 15, 30))]);
same(dp('364 Madison: disclosures, 3R and value verdict by 12:40 PM'), [iso(PT(2026, 10, 29, 12, 40))]);
same(dp('New build: automatic deadline watcher, working test by Tue Nov 3, 5:00 PM'), [iso(PT(2026, 11, 3, 17))]);
same(dp("Today: what are you working on, and what's done by noon?"), [], 'what’s done by noon is not a deadline');
same(dp("Forward them by 12:15 PM. If you can't get them by then, send BLOCKED by 12:05 PM."), [iso(PT(2026, 10, 29, 12, 15))], 'BLOCKED cut-off and "by then" skipped');
same(dp("Reply DONE by 3:30 PM Pacific with a typed list. If you can't, send BLOCKED by 3:00 PM with the reason."), [iso(PT(2026, 10, 29, 15, 30))]);
same(dp("A working test is due today at 5:00 PM Pacific. Send BLOCKED by 4:30 PM if you can't make it."), [iso(PT(2026, 10, 29, 17))]);
same(dp('Out 4:00-5:00 PM today'), [], 'an announcement has no deadline');
const RJ = [{ email: 'genesis@twinhomebuyer.com', name: 'Genesis' }, { email: 'seth@twinhomebuyer.com', name: 'Seth Concepcion' }, { email: 'marie@twinhomebuyer.com', name: 'Marie' }, { email: 'cherry@twinhomebuyer.com', name: 'Cherry' }];
const madison = { at: sent3, subject: '364 Madison: disclosures, 3R and value verdict by 12:40 PM', to: RJ.slice(0, 3), text: [
  'Team,', '', 'He needs three things within the hour (Pacific Time).', '',
  "1. Genesis: get the full disclosure package and the 3R report. Forward them by 12:15 PM. If you can't get them by then, send BLOCKED by 12:05 PM.", '',
  '2. Seth and Thea: run comps using the 7-step method. Bring:', '- the ARV', '- a THUMBS UP or THUMBS DOWN', 'Due 12:40 PM.', '',
  '3. Genesis: compare the 3R report against the house. Due 12:40 PM.', '', 'Send everything as typed text.', '', 'Juan'].join('\n') };
same(D.assignmentsIn(madison, true, RJ, cfg).map(a => a.people.map(p => p.email.split('@')[0]).join('+') + ' ' + iso(a.due)),
  ['genesis ' + iso(PT(2026, 10, 29, 12, 15)), 'seth ' + iso(PT(2026, 10, 29, 12, 40)), 'marie ' + iso(PT(2026, 10, 29, 12, 40))], 'numbered items, Thea is Marie, each person’s earliest deadline');
const hub = { at: sent3, subject: 'URGENT: Load core values + SOPs into the Team Hub, due 3:30 PM today', to: [RJ[1]],
  text: "Seth,\n\nLoad the following:\n\n1. Core values: We tell the truth.\n2. Probation rule: 3 misses in 30 days.\n\nReply DONE by 3:30 PM Pacific. If you can't, send BLOCKED by 3:00 PM.\n\nJuan" };
same(D.assignmentsIn(hub, true, RJ, cfg).map(a => a.people.map(p => p.email).join() + ' ' + iso(a.due)), ['seth@twinhomebuyer.com ' + iso(PT(2026, 10, 29, 15, 30))], 'items that aren’t people: the greeting’s');
same(D.assignmentsIn({ ...hub, subject: 'Speed to lead: great job, Thea', text: 'Team,\n\nThea answered within seconds.\n\nJuan' }, true, RJ, cfg), [], 'praise is not an assignment');
same(D.assignmentsIn({ ...hub, text: 'Seth,\n\nThanks, got it.\n\nJuan' }, false, RJ, cfg).length, 0, 'a reply’s subject is never read as a new deadline');
console.log('7 Juan’s style');

// 8. the rest of how Juan writes (made-up emails in his style)
const B = { email: 'bryan@twinhomebuyer.com', name: '' }, L = { email: 'lawrence@twinhomebuyer.com', name: '' }, J = { email: 'rosanes@twinhomebuyer.com', name: '' },
  K8 = { email: 'accounting@twinhomebuyer.com', name: '' }, CJ = { email: 'christinejoy@twinhomebuyer.com', name: '' }, S8 = { email: 'seth@twinhomebuyer.com', name: '' };
const at8 = PT(2026, 10, 29, 14, 40); // Thu 2:40 PM
const read = (text, o) => { o = o || {}; const to = o.to || [B], cc = o.cc || [];
  const r = D.readAssignerEmail({ at: o.at || at8, subject: o.subject || 'Fence', text, to, cc }, !!o.starts, to.concat(cc), cfg);
  return r.found.map(a => a.people[0].email.split('@')[0] + ' ' + D.fmtDeadline(a.due, cfg)).concat(r.cancel.map(p => 'call off ' + p.email.split('@')[0])); };
same(read('Bryan,\n\nStill due: the fence quote by 4:00, and the permit photos.\n\nJuan'), ['bryan Oct 29, 4:00 PM PT'], 'a deadline in a reply’s body; 4:00 is the afternoon');
same(read('Bryan,\n\nResend within 15 minutes, to me only.\n\nJuan'), ['bryan Oct 29, 2:55 PM PT'], 'within 15 minutes');
same(read('Bryan,\n\nStart with your redo, which is due within 30 minutes. We cover this 24/7.\n\nJuan'), ['bryan Oct 29, 3:10 PM PT'], 'due within 30 minutes; 24/7 is not a date');
same(read('Bryan, correction: the deadline is 12:00 PM Pacific tomorrow, not 5:00 PM. BLOCKED by 11:30.\n\nJuan'), ['bryan Oct 30, 12:00 PM PT'], 'a correction, and not the old time');
same(read('Bryan,\n\nThe deadline was 1:00 PM. The photos were due at 1:00 PM and nothing came in.\n\nJuan'), [], 'past tense is not a new deadline');
same(read('Bryan, skip this one. It is already done. Nothing needed from you on it.\n\nJuan'), ['call off bryan'], 'skip this one: called off');
same(read('Bryan,\n\nThis is a test email. No action needed.\n\nJuan', { starts: true }), [], 'the first email of a thread has nothing to call off');
same(read('Team,\n\nWhoever sees this first, tell Bryan to reply by 3:00 PM.\n\nJuan', { to: [B, L] }), [], 'whoever sees it first: nobody in particular');
same(read('Bryan,\n\nYou run the setup on my computer by AnyDesk, with me watching, at 3:00 PM today.\n\nJuan'), [], 'by AnyDesk … at 3:00 PM is a meeting, not a deadline');
same(read('Team,\n\nThis morning I asked for an update by 11:00 AM. Seth sent it early.\n\nJuan', { to: [B, S8], at: PT(2026, 10, 29, 8, 30) }), [], 'what Juan asked before is not a new ask');
same(read('Team,\n\nThe fix will be up and running by 3:30 PM. No need to report it again.\n\nJuan', { to: [B, S8] }), [], 'what Juan says will happen is not an ask');
same(read('Bryan,\n\nReply DONE or BLOCKED by 4 PM.\n\nJuan'), ['bryan Oct 29, 4:00 PM PT'], 'DONE or BLOCKED by 4 PM counts');
same(read('Bryan,\n\nTomorrow, Fri Oct 30, on my computer:\n1. Change every password.\n\nLawrence: your list (due 12:00 PM) is the setup sheet.\n\nBryan: DONE by 4:45 PM Pacific Friday.\n\nJuan', { cc: [L] }),
  ['lawrence Oct 30, 12:00 PM PT', 'bryan Oct 30, 4:45 PM PT'], 'a time that had passed, in an email about Friday, is Friday');
same(read('Bryan,\n\nTODAY, by 4:45 PM Pacific, only these:\n1. The Relay screenshots.\n\nMOVED:\n- Agent test: tomorrow, Fri Oct 30, by 10:00 AM\nPacific.\n- Lawrence: the Google cost review, by Fri Oct 30, 12:00 PM Pacific.\n- Jonathan: the cancellations, with\nproof, by Fri Oct 30, 12:00 PM Pacific.\n\nBryan, hand Lawrence and Jonathan your notes by 4:00 PM today.\n\nJuan', { cc: [L, J] }).sort(),
  ['bryan Oct 29, 4:00 PM PT', 'lawrence Oct 30, 12:00 PM PT', 'rosanes Oct 30, 12:00 PM PT'], 'bullets that open with names; Jonathan is rosanes@; Bryan’s earliest');
same(read('Bryan, Kristine,\n\nBryan:\n1. Cancel it.\n\nKristine:\n1. Ask for the refund.\n\nBoth of you: reply DONE with proof by 1 PM.\n\nJuan', { to: [B, K8], at: PT(2026, 10, 29, 11, 12) }), ['bryan Oct 29, 1:00 PM PT', 'accounting Oct 29, 1:00 PM PT'], 'both of you; Kristine is accounting@');
same(read('Bryan, Kristine,\n\nBryan:\n1. Cancel it now.\nKristine:\n1. Ask for the refund by 3 PM.\n\nJuan', { to: [B, K8], at: PT(2026, 10, 29, 11, 12) }), ['accounting Oct 29, 3:00 PM PT'], 'a name alone on a line owns the list under it');
same(read('Christine,\n\nReply with the address by 9:00 AM Pacific.\n\nBryan,\n\nShut it off today.\n\nBryan by 3:00 PM Pacific today. Christine\'s full list by Fri Oct 30, 5:00 PM Pacific.\n\nJuan', { to: [CJ, B], at: PT(2026, 10, 29, 5, 49) }),
  ['christinejoy Oct 29, 9:00 AM PT', 'bryan Oct 29, 3:00 PM PT'], 'sections after a name on its own line; Christine is whichever Christine is on the email');
same(read('Team,\n\nThese need an answer by end of day today.\n\nCHERRY\n1. The fence.\n\nBRYAN\n2. The bid desk.\n\nJuan', { to: [{ email: 'cherry@twinhomebuyer.com', name: '' }, B] }),
  ['cherry Oct 29, 5:00 PM PT', 'bryan Oct 29, 5:00 PM PT'], 'end of day; headers in capitals');
same(read('Bryan,\n\nReply DONE with the step 3 screenshot, or BLOCKED. Due today.\n\nJuan'), ['bryan Oct 29, 5:00 PM PT'], 'due today: 5 PM');
same(read('Bryan,\n\nCheck the automations today.\n\nJuan'), [], 'today alone, with no due or by, is not read');
same(read('Bryan,\n\nUse this prompt: "List every subscription we pay for and cancel what we do not use by 3 PM today."\n\nJuan'), [], 'a long quoted prompt is an example');
console.log('8 more of Juan’s style');
console.log('all checks passed');
