// "Who is tracking this?": one answer from anyone settles it, and nobody else owes a reply.
const assert = require('assert');
const { buildFromRaw, fallbackAnalysis, cleanAnalysis, analysisPrompt, ANALYSIS_VERSION } = require('../live.js');
const { derive } = require('../model.js');
const M = 60000, now = Date.now(), t0 = now - 60 * M;
const cfg = { first: 15, second: 30, escalate: 60 };
const JUAN = '1001', VAN = '2001', ERA = '2002', GIO = '2003', ISSY = '2004';
const names = { [JUAN]: 'Juan Diaz', [VAN]: 'Vannessa', [ERA]: 'era', [GIO]: 'Gio', [ISSY]: 'Issy' };
const participants = Object.keys(names).map(id => ({ id, name: names[id] }));
const A = (required, extra) => ({ title: 't', type: 'Question', needs_reply: true, required, priority: 'Normal', task: null, follow_up_of: null, by: 'claude', v: ANALYSIS_VERSION, ...extra });
const raw = {
  group: { id: 'g', name: '972 Norton' }, participants, members: {}, names: {}, bossIds: [JUAN],
  messages: [
    { i: 'Q1', t: t0, s: JUAN, x: 'who is trackignt hsi' },
    { i: 'V1', t: t0 + 1 * M, s: VAN, x: "I'm the one tracking it, Juan." },
    { i: 'E1', t: t0 + 6 * M, s: ERA, x: 'Quick update: Internet service installed.' },
    { i: 'Q2', t: t0 + 10 * M, s: JUAN, x: 'Anyone know where the ladder is?' },
    { i: 'Q3', t: t0 + 12 * M, s: JUAN, x: 'Everyone confirm the walkthrough at 9' },
    { i: 'G1', t: t0 + 14 * M, s: GIO, x: 'Confirmed' },
  ],
  analysis: { Q1: A('any'), Q2: A('any'), Q3: A('all', { type: 'Instruction' }) },
};
const S = buildFromRaw(raw, now);
const D = derive(S, cfg, now);
const msg = id => D.messages.find(m => m.id === id);

// Q1: Vannessa answered first; era's unrelated update doesn't count; nobody else owes it
assert.deepStrictEqual(msg('Q1').req, [VAN]);
assert.ok(msg('Q1').resolved && !msg('Q1').waitingAny);
assert.strictEqual(msg('Q1').rows[0].delay, 1 * M);
console.log('Q1 answered by', msg('Q1').rows[0].name, 'in', msg('Q1').rows[0].delay / M, 'min; resolved:', msg('Q1').resolved);

// Q2: nobody answered: still open, but no one person is behind on it
assert.ok(msg('Q2').waitingAny && !msg('Q2').resolved);
assert.strictEqual(msg('Q2').rows.length, 0);
assert.strictEqual(msg('Q2').stage, 2, 'asked 50 minutes ago: past the 15 and 30 minute marks');
console.log('Q2 waiting for anyone; stage', msg('Q2').stage, '; unresolved:', D.unresolved.map(m => m.id).join(','));

// Q3: an everyone-message still counts everyone
assert.deepStrictEqual(msg('Q3').req.slice().sort(), [VAN, ERA, GIO, ISSY].sort());
assert.deepStrictEqual(msg('Q3').pending.map(r => r.pid).sort(), [VAN, ERA, ISSY].sort());

// people: nobody is "behind" because of Q1 or Q2
const owes = D.pendingPeople.map(p => `${p.name}:${p.pending.map(x => x.msg.id).join('+')}`);
console.log('people who owe replies:', owes.join(', '));
assert.ok(D.pendingPeople.every(p => p.pending.every(x => x.msg.id === 'Q3')));
assert.deepStrictEqual(D.unresolved.map(m => m.id).sort(), ['Q2', 'Q3']);
const van = D.people.find(p => p.id === VAN);
assert.strictEqual(van.replied, 1, 'Vannessa gets credit for answering Q1');

// answered later, after someone else's unrelated message: the first answer still wins
const S2 = buildFromRaw({ ...raw, messages: raw.messages.concat({ i: 'I1', t: t0 + 20 * M, s: ISSY, x: 'Ladder is in the garage' }) }, now);
const q2 = derive(S2, cfg, now).messages.find(m => m.id === 'Q2');
console.log('Q2 after Issy answers:', q2.resolved ? 'answered by ' + q2.rows[0].name : 'open');
assert.ok(!q2.resolved, 'Issy answered after a newer request, so the rule can\'t be sure');

// a swipe-reply to the question always counts, and so does an answer linked by hand
const quoted = buildFromRaw({ ...raw, messages: raw.messages.concat({ i: 'I1', t: t0 + 20 * M, s: ISSY, x: 'Ladder is in the garage', q: 'Q2' }) }, now);
const q2q = derive(quoted, cfg, now).messages.find(m => m.id === 'Q2');
assert.ok(q2q.resolved && q2q.rows[0].pid === ISSY);
const linked = buildFromRaw({ ...raw, messages: raw.messages.concat({ i: 'I1', t: t0 + 20 * M, s: ISSY, x: 'Ladder is in the garage' }),
  fixes: { [`Q2~${ISSY}`]: { msg: 'I1', at: t0 + 20 * M, text: 'Ladder is in the garage', by: 'u_seth', on: now } } }, now);
const q2l = derive(linked, cfg, now).messages.find(m => m.id === 'Q2');
assert.ok(q2l.resolved && q2l.rows[0].pid === ISSY && q2l.rows[0].linked);
console.log('Q2 swipe-reply ->', q2q.rows[0].name, '| linked by hand ->', q2l.rows[0].name);

// the rules used without Claude: "who ..." and "anyone ..." questions need one answer
const people = participants.map(p => ({ ...p, giver: p.id === JUAN }));
const fb = x => fallbackAnalysis({ i: 'x', s: JUAN, t: now, x }, people, new Map()).required;
assert.strictEqual(fb('who is trackignt hsi'), 'any');
assert.strictEqual(fb('Sino may hawak ng susi?'), 'any');
assert.strictEqual(fb('Anyone know where the ladder is?'), 'any');
assert.strictEqual(fb('Everyone confirm the walkthrough at 9'), 'all');
console.log('fallback rules: who/sino/anyone -> any, everyone -> all');

// Claude's answer: "any" is kept, nonsense falls back to "all"
assert.strictEqual(cleanAnalysis({ title: 'x', required: 'any' }, people, new Map(), JUAN).required, 'any');
assert.strictEqual(cleanAnalysis({ title: 'x', required: 'whoever' }, people, new Map(), JUAN).required, 'all');
assert.ok(analysisPrompt([], [], people, ['Juan Diaz'], id => names[id]).includes('"any" when one answer from anyone settles it'));
assert.ok(ANALYSIS_VERSION >= 4, 'messages read before this change are read again');
console.log('all checks passed');
