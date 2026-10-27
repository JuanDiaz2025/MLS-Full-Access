// Juan's "What is this?" right after Cherry sent something is a question for Cherry,
// so Vanessa's reply doesn't close it. Claude sees what everyone said around it.
const assert = require('assert');
const { analysisPrompt, cleanAnalysis, buildFromRaw, ANALYSIS_VERSION } = require('../live.js');
const { derive } = require('../model.js');
const M = 60000, now = Date.now(), t0 = now - 30 * M;
const names = { '1001': 'Juan Diaz', '3001': 'Cherry', '2001': 'Vanessa', '2002': 'era' };
const nameOf = id => names[id];
const people = Object.keys(names).map(id => ({ id, name: names[id], giver: id === '1001' }));
const cherry = { i: 'c1', s: '3001', t: t0, x: 'Juan I have sent something to you' };
const juan = { i: 'j1', s: '1001', t: t0 + 2 * M, x: 'What is this?' };
const van = { i: 'v1', s: '2001', t: t0 + 4 * M, x: 'I have checked the artifact or disclosures sent' };

const p = analysisPrompt([juan], [], people, ['Juan Diaz'], nameOf, [cherry], new Map([[cherry.i, cherry]]));
assert.ok(p.includes('What everyone said around these') && p.includes('"from":"Cherry","sent"') && p.includes('Juan I have sent something to you'));
assert.ok(p.includes('it is for that member: list their id'));
const quoted = analysisPrompt([{ ...juan, q: 'c1' }], [], people, ['Juan Diaz'], nameOf, [], new Map([[cherry.i, cherry]]));
assert.ok(quoted.includes('"replying_to_message":{"from":"Cherry","text":"Juan I have sent something to you"}'));
assert.ok(!analysisPrompt([juan], [], people, ['Juan Diaz'], nameOf).includes('What everyone said around these'), 'no section when there is nothing around');
assert.ok(ANALYSIS_VERSION >= 5);

// Claude's real answer for this prompt (run on Oct 27): required Cherry
const a = cleanAnalysis({ id: 'j1', title: 'Asks Cherry about sent item', type: 'Question', needs_reply: true, required: ['3001'], priority: 'Normal', task: null, follow_up_of: null }, people, new Map([[juan.i, juan.s]]), juan.s);
const S = buildFromRaw({ group: { id: 'g', name: 'Ops' }, participants: people.map(({ id, name }) => ({ id, name })), members: {}, names: {}, bossIds: ['1001'],
  messages: [cherry, juan, van], analysis: { j1: a } }, now);
const m = derive(S, { first: 15, second: 30, escalate: 60 }, now).messages.find(x => x.id === 'j1');
console.log('needs a reply from:', m.req.map(nameOf).join(', '), '| replied:', m.responded, '| pending:', m.pending.map(r => r.name).join(', '));
assert.deepStrictEqual(m.req, ['3001']);
assert.strictEqual(m.responded, 0, "Vanessa's message doesn't answer a question for Cherry");
assert.ok(!S.unjudged.some(u => u.m.i === 'v1'), "Vanessa's message isn't even sent to Claude for it");
console.log('all checks passed');
