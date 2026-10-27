// WhatsApp tags by a hidden id: the text says "@120852544774172" while the
// reader saved the person's phone number. The tag must still read as the person.
const assert = require('assert');
const { readableText, analysisPrompt, needsReading, fallbackAnalysis, ANALYSIS_VERSION } = require('../live.js');
const names = { '15108673040': 'Juan Diaz', '639917364165': 'Vannessa', '15106773310': 'Cesar Cuellar', '15105188097': 'Bryan' };
const nameOf = id => names[id] || '+' + id;

// the message from the screenshot
const tagOnly = { i: 'a', s: '15108673040', t: 1, x: '@120852544774172', m: ['639917364165'] };
assert.strictEqual(readableText(tagOnly, nameOf), '@Vannessa');
// two tags, one by phone number and one by hidden id, in order
const two = { i: 'b', s: '15108673040', t: 1, x: '@15105188097 and @83683193139382 check the fence', m: ['15105188097', '15106773310'] };
assert.strictEqual(readableText(two, nameOf), '@Bryan and @Cesar Cuellar check the fence');
// two hidden ids, in the order WhatsApp listed them
assert.strictEqual(readableText({ x: '@111111111 @222222222 ok', m: ['639917364165', '15106773310'] }, nameOf), '@Vannessa @Cesar Cuellar ok');
// an @number that isn't a tag stays as it is
assert.strictEqual(readableText({ x: 'call @5551234567 later' }, nameOf), 'call @5551234567 later');
console.log('text:', readableText(tagOnly, nameOf), '|', readableText(two, nameOf));

// Claude is told who was tagged
const people = Object.keys(names).map(id => ({ id, name: names[id], giver: id === '15108673040' }));
const p = analysisPrompt([tagOnly], [], people, ['Juan Diaz'], nameOf);
assert.ok(p.includes('"text":"@Vannessa"') && p.includes('"tagged":["639917364165"]') && p.includes('A message that tags people is for them'));
// without Claude, the rules already use the tag
assert.deepStrictEqual(fallbackAnalysis(tagOnly, people, new Map()).required, ['639917364165']);

// only tagged messages are read again after this change
assert.strictEqual(ANALYSIS_VERSION, 6);
assert.strictEqual(needsReading({ by: 'claude', v: 5 }, tagOnly), true);
assert.strictEqual(needsReading({ by: 'claude', v: 5 }, { x: 'Everyone confirm' }), false);
assert.strictEqual(needsReading({ by: 'claude', v: 4 }, { x: 'Everyone confirm' }), true);
assert.strictEqual(needsReading({ by: 'rules', v: 6 }, { x: 'x' }), true);
assert.strictEqual(needsReading({ by: 'claude', v: 6 }, tagOnly), false);
console.log('all checks passed');
