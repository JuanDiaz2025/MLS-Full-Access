// Claude reads plain replies: which request each one answers, and who took on the work.
// Uses Claude's real answers to the sample thread (judge-sample.json).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildFromRaw, cleanReply, replyPrompt, REPLY_VERSION, ANALYSIS_VERSION } = require('../live.js');
const { derive } = require('../model.js');
const M = 60000, now = Date.now(), t0 = now - 90 * M;
const cfg = { first: 15, second: 30, escalate: 60 };
const JUAN = '1001', VAN = '2001', ERA = '2002', GIO = '2003', ISSY = '2004', MARK = '2005';
const names = { [JUAN]: 'Juan Diaz', [VAN]: 'Vannessa', [ERA]: 'era', [GIO]: 'Gio', [ISSY]: 'Issy', [MARK]: 'Mark' };
const A = (required, extra) => ({ title: 't', type: 'Question', needs_reply: true, required, priority: 'Normal', task: null, follow_up_of: null, by: 'claude', v: ANALYSIS_VERSION, ...extra });
const raw = {
  group: { id: 'g', name: 'Ops' }, participants: Object.keys(names).map(id => ({ id, name: names[id] })), members: {}, names: {}, bossIds: [JUAN],
  messages: [
    { i: 'R1', t: t0, s: JUAN, x: 'who is tracking the Home Depot order?' },
    { i: 'm1', t: t0 + 1 * M, s: VAN, x: "I'm the one tracking it, Juan." },
    { i: 'm2', t: t0 + 6 * M, s: ERA, x: 'Quick update: Internet service installed.' },
    { i: 'R2', t: t0 + 7 * M, s: JUAN, x: 'Everyone confirm the walkthrough tomorrow at 9' },
    { i: 'm3', t: t0 + 8 * M, s: GIO, x: 'noted po' },
    { i: 'm4', t: t0 + 12 * M, s: ISSY, x: "copy, I'll be there" },
    { i: 'm5', t: t0 + 17 * M, s: MARK, x: 'Ako na po mag follow up sa Home Depot delivery bukas' },
    { i: 'm6', t: t0 + 19 * M, s: ERA, x: 'sorry late, confirmed for 9' },
  ],
  analysis: { R1: A('any', { title: 'Who is tracking Home Depot order' }), R2: A('all', { type: 'Instruction', title: 'Confirm the walkthrough' }) },
};

// 1. before Claude has read anything: the six replies are queued, each with what it could answer
const before = buildFromRaw(raw, now);
const queued = Object.fromEntries(before.unjudged.map(u => [u.m.i, u.requests]));
console.log('queued for Claude:', JSON.stringify(queued));
assert.deepStrictEqual(Object.keys(queued), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
assert.deepStrictEqual(queued.m1, ['R1']);
assert.deepStrictEqual(queued.m3, ['R1', 'R2']);
// the rules meanwhile: Vannessa answered first, so the question is closed
assert.deepStrictEqual(derive(before, cfg, now).messages.find(m => m.id === 'R1').req, [VAN]);

// 2. the prompt carries the requests, the replies and what each could answer
const prompt = replyPrompt([{ id: 'R1', from: 'Juan Diaz', text: 'who is tracking the Home Depot order?', needs: 'one answer from anyone' }],
  [{ id: 'm1', from: 'Vannessa', text: "I'm the one tracking it, Juan.", could_answer: ['R1'] }], before.people, ['Juan Diaz']);
assert.ok(prompt.includes('"could_answer":["R1"]') && prompt.includes('takes_task') && prompt.includes('Taglish'));

// 3. Claude's real answers, cleaned the way the page cleans them
const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'judge-sample.json'), 'utf8')).results;
const replies = {};
before.unjudged.forEach(u => { replies[u.m.i] = cleanReply(results.find(r => r.id === u.m.i), u.requests); });
const S = buildFromRaw({ ...raw, replies }, now);
const D = derive(S, cfg, now);
const msg = id => D.messages.find(m => m.id === id);
assert.strictEqual(S.unjudged.length, 0, 'nothing left to read');

const r1 = msg('R1');
console.log('R1:', r1.resolved ? 'answered by ' + r1.rows[0].name : 'open', '|', r1.rows[0].why);
assert.ok(r1.resolved && r1.rows[0].pid === VAN && r1.rows[0].why);

const r2 = msg('R2');
const replied = r2.rows.filter(r => r.replied).map(r => r.name).sort();
const pending = r2.pending.map(r => r.name).sort();
console.log('R2 replied:', replied.join(', '), '| still owe:', pending.join(', '));
assert.deepStrictEqual(replied, ['Gio', 'Issy', 'era']);
assert.deepStrictEqual(pending, ['Mark', 'Vannessa'], "Vannessa and Mark talked about Home Depot, not the walkthrough");
assert.strictEqual(r2.rows.find(r => r.pid === ERA).delay, 12 * M, "era's walkthrough answer is her 'confirmed for 9', not the internet update");

const tasks = D.tasks.map(t => `${t.title} -> ${t.ownerName} (${t.status})`);
console.log('tasks:', tasks.join(' | '));
assert.ok(D.tasks.some(t => t.owner === VAN && /Home Depot/.test(t.title) && t.claimed && t.status === 'Acknowledged'));
assert.ok(D.tasks.some(t => t.owner === MARK && /delivery/i.test(t.title) && t.claimed));
assert.strictEqual(r1.task, D.tasks.find(t => t.owner === VAN).id, 'the question now shows its task');

// 4. a claimed task is done when the owner posts a photo or says done
const doneRaw = { ...raw, replies, messages: raw.messages.concat({ i: 'm7', t: t0 + 40 * M, s: VAN, k: 'image', x: 'receipt' }) };
const doneTask = derive(buildFromRaw(doneRaw, now), cfg, now).tasks.find(t => t.owner === VAN);
assert.strictEqual(doneTask.status, 'Completed');

// 5. cleaning Claude's answer: only allowed ids, a task only for an allowed request
assert.deepStrictEqual(cleanReply({ answers: ['R2', 'R9'], takes_task: { request: 'R9', title: 'x' }, why: 'w' }, ['R2']), { answers: ['R2'], task: null, why: 'w', by: 'claude', v: REPLY_VERSION });
assert.strictEqual(cleanReply(null, ['R1']), null);

// 6. "Claude couldn't tell" falls back to the rules, and is not asked again
const unclear = buildFromRaw({ ...raw, replies: { ...replies, m2: { answers: null, task: null, why: '', by: 'claude', v: REPLY_VERSION } } }, now);
assert.ok(!unclear.unjudged.some(u => u.m.i === 'm2'));
// 7. an answer from an older version is read again
const stale = buildFromRaw({ ...raw, replies: { ...replies, m3: { ...replies.m3, v: REPLY_VERSION - 1 } } }, now);
assert.deepStrictEqual(stale.unjudged.map(u => u.m.i), ['m3']);
// 8. a swipe-reply is certain and never sent to Claude
const sw = buildFromRaw({ ...raw, messages: raw.messages.concat({ i: 'm8', t: t0 + 30 * M, s: MARK, x: 'confirmed', q: 'R2' }) }, now);
assert.ok(!sw.unjudged.some(u => u.m.i === 'm8'));
// 9. replies older than a week aren't sent to Claude
const old = buildFromRaw({ ...raw, messages: raw.messages.map(m => ({ ...m, t: m.t - 8 * 24 * 60 * M })) }, now);
assert.strictEqual(old.unjudged.length, 0);
console.log('all checks passed');
