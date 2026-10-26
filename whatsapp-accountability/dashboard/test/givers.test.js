const assert = require('assert');
const { buildFromRaw, fallbackAnalysis, cleanAnalysis } = require('../live.js');
const { derive } = require('../model.js');
const M = 60000, now = Date.now(), t0 = now - 180 * M;
const JUAN = '1001', CHERRY = '1002', MIKE = '1003', ROSA = '1004';
const participants = [JUAN, CHERRY, MIKE, ROSA].map(id => ({ id, name: { [JUAN]: 'Juan', [CHERRY]: 'Cherry', [MIKE]: 'Mike', [ROSA]: 'Rosa' }[id] }));
const A = (required, extra) => ({ title: 't', type: 'Instruction', needs_reply: true, required, priority: 'Normal', task: null, follow_up_of: null, by: 'claude', v: 3, ...extra });
const raw = {
  group: { id: 'g', name: 'Mgmt' }, participants, members: {}, names: {}, bossIds: [JUAN, CHERRY],
  messages: [
    { i: 'J1', t: t0, s: JUAN, x: 'Cherry can you do this?' },
    { i: 'J2', t: t0 + 5 * M, s: JUAN, x: 'Everyone confirm the schedule' },
    { i: 'R1', t: t0 + 8 * M, s: MIKE, x: 'Confirmed' },
    { i: 'C1', t: t0 + 20 * M, s: CHERRY, x: 'Hi Juan check this please?', q: 'J1' },
    { i: 'C2', t: t0 + 40 * M, s: CHERRY, x: 'Juan???', q: 'C1' },
  ],
  analysis: { J1: A([CHERRY]), J2: A('all'), C1: A([JUAN]), C2: A([JUAN], { follow_up_of: 'C1' }) },
};
const S = buildFromRaw(raw, now);
const by = id => S.messages.find(m => m.id === id);
console.log('people:', S.people.map(p => `${p.name}${p.giver ? ' (giver)' : ''}`).join(', '));
console.log('J1 Juan→Cherry: required', by('J1').required, 'replies', Object.keys(by('J1').replies));
console.log('J2 Juan→everyone: required', by('J2').required);
console.log('C1 Cherry→Juan: required', by('C1').required, 'replies', Object.keys(by('C1').replies), 'chases', by('C1').chases.length);
assert.deepStrictEqual(by('J1').required, [CHERRY]);
assert.ok(by('J1').replies[CHERRY], 'Cherry answered J1 by quoting it');
assert.deepStrictEqual(by('J2').required.sort(), [MIKE, ROSA]);
assert.deepStrictEqual(by('C1').required, [JUAN]);
assert.ok(!by('C1').replies[JUAN], 'Juan has not answered Cherry');
assert.strictEqual(by('C1').chases.length, 1, "Cherry's nudge folds into her own request");
assert.ok(!by('C2'), 'nudge is not a separate request');
// Cherry quoting Juan's message is a reply, never a nudge on it
const f = fallbackAnalysis(raw.messages[3], S.people, new Map([['J1', JUAN], ['C1', CHERRY]]));
assert.strictEqual(f.follow_up_of, null);
// Claude can't list the sender, and can't call another manager's message a nudge
const c = cleanAnalysis({ title: 'x', type: 'Question', needs_reply: true, required: [JUAN, CHERRY], follow_up_of: 'J1' }, S.people, new Map([['J1', JUAN]]), CHERRY);
assert.deepStrictEqual(c.required, [JUAN]); assert.strictEqual(c.follow_up_of, null);
const D = derive(S, { first: 15, second: 30, escalate: 60 }, now);
console.log('waiting on:', D.pendingPeople.map(p => `${p.name} (${p.pending.map(x => x.msg.id).join(',')})`).join('; '));
console.log('counted people:', D.people.filter(p => !p.former && (!p.giver || p.required)).map(p => p.name).join(', '));
console.log('all checks passed');
