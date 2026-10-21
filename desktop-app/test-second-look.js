/**
 * The second look (v1.74) — run with `node desktop-app/test-second-look.js`.
 *
 * A listing the gate scores C on a low score is kept as B when we made money
 * on a house in the same city bought within 40% of its price. Nothing else
 * moves: hard exclusions, AI drops, a nearby loss, another city.
 */
const core = require('./scan-core');

let fails = 0;
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { fails++; console.error('FAIL ' + m + '\n  got      ' + A + '\n  expected ' + B); }
  else console.log('ok   ' + m);
};

// 1. Money as the sheet formats it.
eq([core.money('$1,350,000'), core.money('-$71,477'), core.money('($71,477)'), core.money('−$71k'), core.money('1.35M'),
  core.money(850000), core.money(''), core.money('TBD')], [1350000, -71477, -71477, -71000, 1350000, 850000, null, null],
  'money: $, commas, minus signs, brackets, k / M, blanks');

// 2. The tab. Be picky: a blank, over the cap, not Sold or an unresolved note stays out.
const H = ['Address', 'City', 'Bought', 'Sold', 'Net', 'Bought On', 'Sold On', 'Status', 'Notes'];
const grid = [H,
  ['1202 Via Lucas', 'San Lorenzo', '$600,000', '$858,000', '$127,329', '2/23/2026', '3/30/2026', 'Sold', ''],
  ['17221 Via Estrella', 'San Lorenzo, CA 94580', '$550,000', '$800,000', '$65,282', '', '', '', ''],
  ['404 Ridge Gate Rd', 'Orinda', '$1,350,000', '$1,498,000', '-$71,477', '', '', 'Sold', ''],
  ['915 52nd St', 'Oakland', '$440,000', '$825,000', '$267,806', '', '', 'Sold', ''],
  ['1684 Hill Rd', 'Novato', '', '$768,000', '', '', '', 'Sold', ''],
  ['5 Oceanside Way', 'Daly City', '$1,800,000', '$2,100,000', '$90,000', '', '', 'Sold', ''],
  ['519 Orizaba', 'San Francisco', '$1,000,000', '$1,668,000', '$200,000', '', '', 'Held', ''],
  ['255 Amber Dr', 'San Francisco', '$1,200,000', '$2,890,000', '$500,000', '', '', 'Sold', 'NOT AN ACQUISITION — never took title'],
  ['', '', '', '', '', '', '', '', ''],
];
const p = core.pastDealsFromGrid(grid);
eq(p.error, '', 'a tab with the five needed columns reads');
eq(p.deals.map(d => d.addr), ['1202 Via Lucas', '17221 Via Estrella', '404 Ridge Gate Rd', '915 52nd St'], 'only deals with every number known');
eq(p.left.map(x => x.why), ['a blank in Bought / Net', 'bought over the $1.5M cap', 'status "Held", not Sold', 'status unresolved in the notes'],
  'and each one left out says why');
eq(p.deals[1].city, 'San Lorenzo', 'a "City, CA zip" cell is just the city');
eq([p.deals[0].boughtOn, p.deals[0].net], ['2026-02-23', 127329], 'dates and a net read off formatted cells');
eq(core.pastDealsFromGrid([['Address', 'City', 'Price']]).error !== '', true, 'a tab without Bought / Sold / Net is refused, not guessed at');
eq(core.pastDealsFromGrid([]).deals, [], 'an empty tab is no deals');

// 3. The look itself.
const D = p.deals;
const near = core.secondLook({ city: 'San Lorenzo', price: 700000 }, D);
eq([near.keep, near.deals.length], [true, 2], 'San Lorenzo at $700k: both San Lorenzo deals are within 40%');
eq(/^SECOND LOOK — we made \+\$127k on 1202 Via Lucas, San Lorenzo \(bought \$600k, sold \$858k\) and 1 more/.test(near.why), true,
  'and the Why names the closest deal: ' + near.why);
eq(core.secondLook({ city: 'san lorenzo', price: 700000 }, D).keep, true, 'city match ignores case');
eq(core.secondLook({ city: 'San Lorenzo', price: 1200000 }, D), null, 'too far from our prices: nothing to compare');
eq(core.secondLook({ city: 'Hayward', price: 600000 }, D), null, 'another city in the county does not count');
const lost = core.secondLook({ city: 'Orinda', price: 1200000 }, D);
eq([lost.keep, /lost −\$71k on 404 Ridge Gate Rd/.test(lost.why)], [false, true], 'a loss near this price means no second look');
eq(core.secondLook({ city: 'Oakland', price: 0 }, D), null, 'no price: no look');
eq(core.secondLook({ city: 'Oakland', price: 500000 }, []), null, 'no deals: no look');

// 4. On the gate's verdict: only a soft C moves, and only to B.
const Q = m => core.qualify(Object.assign({ photos: 20, photosReliable: true }, m));
const soft = Q({ remarks: 'Professionally staged, quartz counters.', ppsfRatio: 1.3, addr: '1 Test St' });
eq([soft.bucket, soft.hard], ['C', false], 'fixture: a low-score C that is not a hard exclusion');
const s1 = core.applySecondLook(soft, { city: 'Oakland', price: 520000 }, D);
eq([soft.bucket, soft.decision, soft.secondLook, s1.keep], ['B', 'keep', true, true], 'a soft C near a past win in the same city becomes B');
eq(/^SECOND LOOK — we made \+\$268k on 915 52nd St, Oakland .* · the scan scored it \d+: /.test(soft.why), true, 'the Why says so first, then the score');
const hard = Q({ remarks: 'Beautifully renovated turnkey home.' });
core.applySecondLook(hard, { city: 'Oakland', price: 520000 }, D);
eq([hard.bucket, !!hard.secondLook], ['C', false], 'renovated (Rule #0) is never rescued');
const tenant = Q({ remarks: 'Fixer upper, sold as-is. Tenant occupied, do not disturb.' });
core.applySecondLook(tenant, { city: 'Oakland', price: 520000 }, D);
eq(tenant.bucket, 'C', 'nor is any other hard exclusion (tenant)');
const ai = { bucket: 'C', label: 'C — Auto-Pass', decision: 'drop', score: 15, hard: false, why: 'AI (vision): dated but in good condition' };
core.applySecondLook(ai, { city: 'Oakland', price: 520000 }, D);
eq(ai.bucket, 'C', 'nor a house the AI photo check dropped');
const keepB = Q({ remarks: 'Fixer upper, sold as-is.' });
eq([core.applySecondLook(keepB, { city: 'Oakland', price: 520000 }, D), keepB.bucket], [null, 'B'], 'an A or B is left alone');
const orinda = Q({ remarks: 'Professionally staged, quartz counters.', ppsfRatio: 1.3, addr: '2 Test St' });
core.applySecondLook(orinda, { city: 'Orinda', price: 1200000 }, D);
eq(orinda.bucket, 'C', 'a soft C near a past LOSS stays C');
const conf = Q({ addr: '21 College Terrace', remarks: 'Beautifully renovated.' });
eq([core.applySecondLook(conf, { city: 'San Francisco', price: 1000000 }, D), conf.bucket], [null, 'A'], 'a confirmed deal stays A');

console.log(fails ? `\n${fails} failure(s)` : '\nall good');
process.exit(fails ? 1 : 0);
