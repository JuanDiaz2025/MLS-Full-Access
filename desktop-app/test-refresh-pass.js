// v1.74.1 — Refresh re-checks passed leads for a price cut, and comps live A/B
// leads that have no ARV yet.   node test-refresh-pass.js
const core = require('./scan-core.js');
let fails = 0;
const eq = (got, want, what) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + what + (ok ? '' : '\n     got:  ' + JSON.stringify(got) + '\n     want: ' + JSON.stringify(want)));
};

// --- the case that started it: 1534 Kooser Rd (ML82059011), 21 Oct ---
eq(core.passRecheck({ note: 'PASS-SOLD LAST AUG 17', sheetPrice: '1399888', listPrice: 999999, status: 'Pending' }),
  { flag: true, why: 'PRICE CUT AFTER PASS — $1.40M → $1.00M (−29%), now Pending: look again' },
  'Kooser Rd: passed at $1,399,888, now $999,999 → look again');
eq(core.passRecheck({ note: 'PASS-NOT A FIXER', sheetPrice: '$899,000', listPrice: '799000', status: 'Active' }).why,
  'PRICE CUT AFTER PASS — $899k → $799k (−11%), now Active: look again', 'a condition pass with an 11% cut is flagged too');
eq(core.passRecheck({ note: 'PASS-NOT A FIXER', sheetPrice: 1000000, listPrice: 950000, status: 'Active' }).flag, false,
  'a 5% cut is not enough');
eq(core.passRecheck({ note: 'PASS-APPEARS WELL MAINTAINED', sheetPrice: 1000000, listPrice: 1000000, status: 'Active' }).flag, false,
  'same price, condition pass: nothing to say');
eq(core.passRecheck({ note: 'PASS (Board) — Gen, Oct 20: off-market | …', sheetPrice: 999800, listPrice: 999800, status: 'Active' }),
  { flag: true, why: 'BACK ON THE MARKET AFTER PASS — passed as off the market, the MLS now says Active: look again' },
  'passed as off-market, the MLS says Active again');
eq(core.passRecheck({ note: 'PASS-SOLD', sheetPrice: 950000, listPrice: 950000, status: 'Pending' }).flag, false,
  'passed as sold and still pending: nothing new');
eq(core.passRecheck({ note: 'PASS-NOT A FIXER', sheetPrice: '', listPrice: 700000, status: 'Active' }).flag, false,
  'no price on the sheet: no comparison, no flag');
eq(core.passRecheck({ note: 'PASS-NOT A FIXER', sheetPrice: 700000, listPrice: '', status: 'Active' }).flag, false,
  'no price on the report: no flag');

// --- the flag goes in front of the Why, once ---
eq(core.withPassFlag('needs work — "as is" + vacant', 'PRICE CUT AFTER PASS — $1.40M → $1.00M (−29%): look again'),
  'PRICE CUT AFTER PASS — $1.40M → $1.00M (−29%): look again · needs work — "as is" + vacant', 'flag in front of the old Why');
eq(core.withPassFlag('PRICE CUT AFTER PASS — $1.40M → $1.10M (−21%): look again · needs work', 'PRICE CUT AFTER PASS — $1.40M → $1.00M (−29%): look again'),
  'PRICE CUT AFTER PASS — $1.40M → $1.00M (−29%): look again · needs work', 'a second cut replaces the first flag, never stacks');
eq(core.withPassFlag('PRICE CUT AFTER PASS — $1.40M → $1.10M (−21%): look again', 'BACK ON THE MARKET AFTER PASS — x: look again'),
  'BACK ON THE MARKET AFTER PASS — x: look again', 'a flag that was the whole Why is replaced');
eq(core.withPassFlag('', 'PRICE CUT AFTER PASS — y: look again'), 'PRICE CUT AFTER PASS — y: look again', 'an empty Why');

// --- which passed rows a Refresh re-reads ---
const today = '2026-10-21';
eq(core.passRecheckDue({ notes: 'PASS-SOLD LAST AUG 17', mlsStatus: '', firstAdded: '2026-08-26' }, today), true, 'Kooser: passed, status blank, added Aug 26 → re-read');
eq(core.passRecheckDue({ notes: 'PASS-SOLD LAST AUG 17', mlsStatus: '', firstAdded: '2026-08-26 00:00:00' }, today), true, 'a date with a time');
eq(core.passRecheckDue({ notes: 'PASS-NOT A FIXER', mlsStatus: 'Pending', firstAdded: '8/26/2026' }, today), true, 'pending stays on (it may fall through) · M/D/YYYY date');
eq(core.passRecheckDue({ notes: 'PASS-NOT A FIXER', mlsStatus: 'Sold', firstAdded: '2026-10-01' }, today), false, 'sold: nothing left to check');
eq(core.passRecheckDue({ notes: 'PASS-NOT A FIXER', mlsStatus: 'Withdrawn', firstAdded: '2026-10-01' }, today), false, 'withdrawn: skipped');
eq(core.passRecheckDue({ notes: 'Called agent, offers Friday', mlsStatus: '', firstAdded: '2026-10-01' }, today), false, 'not passed: the normal refresh reads it');
eq(core.passRecheckDue({ notes: 'PASS-NOT A FIXER', mlsStatus: '', firstAdded: '2026-05-01' }, today), false, 'added over 120 days ago: skipped');
eq(core.passRecheckDue({ notes: 'PASS-NOT A FIXER', mlsStatus: '', firstAdded: '2026-06-24' }, today), true, 'added 119 days ago: re-read');
eq(core.passRecheckDue({ notes: 'PASS-NOT A FIXER', mlsStatus: '', firstAdded: '' }, today), true, 'no First Added: check rather than skip');
eq(core.passRecheckDue({ notes: 'PASS-NOT A FIXER', mlsStatus: '', firstAdded: '46260' }, today), true, 'a sheet day number (2026-08-26)');
eq(core.dayKeyOf('46260'), '2026-08-26', 'sheet day number 46260 is 26 Aug 2026');

// --- which live A/B rows a Refresh comps ---
eq(core.refreshNeedsComps({ bucket: 'A — Work Now', arv: '', compsAt: '', status: 'Active' }, today), true, 'A, no ARV, never comped → comp it');
eq(core.refreshNeedsComps({ bucket: 'B — AI Review', arv: '', compsAt: '', status: '' }, today), true, 'B, no ARV, status blank → comp it');
eq(core.refreshNeedsComps({ bucket: 'A — Work Now', arv: '910000', compsAt: '2026-10-20', status: 'Active' }, today), false, 'already has an ARV');
eq(core.refreshNeedsComps({ bucket: 'C — Auto-Pass', arv: '', compsAt: '', status: 'Active' }, today), false, 'a C is never comped');
eq(core.refreshNeedsComps({ bucket: 'A — Work Now', arv: '', compsAt: '', status: 'Pending' }, today), false, 'pending: not worth a comp run');
eq(core.refreshNeedsComps({ bucket: 'A — Work Now', arv: '', compsAt: '', status: 'Sold' }, today), false, 'sold: skipped');
eq(core.refreshNeedsComps({ bucket: 'A — Work Now', arv: '', compsAt: '2026-10-16', status: 'Active' }, today), false, 'found no comps 5 days ago: not again yet');
eq(core.refreshNeedsComps({ bucket: 'A — Work Now', arv: '', compsAt: '2026-10-01', status: 'Active' }, today), true, 'found no comps 20 days ago: try again');
eq(core.REFRESH_COMPS_MAX, 25, 'at most 25 comp runs per Refresh');

// --- v1.74.2: the private remarks reader (136 Rae Ave, SF426167828) ---
const PR = core.privateRemarks;
eq(PR('Public:\tNice house.\nPrivate:\tsupra now is on the property. Offer date to be 10/28/2026 by 2:00pm.\nShowing & Location\nShowing Information\nOccupied By:\tVacant'),
  'supra now is on the property. Offer date to be 10/28/2026 by 2:00pm.', '136 Rae: the remark on the label\'s own line is read, up to the next section');
eq(core.offerDue(PR('Private:\tsupra now is on the property. Offer date to be 10/28/2026 by 2:00pm.\nShowing & Location')), '2026-10-28 (Wed) 2:00 PM',
  '…and its offer date reads Wed 10/28 2:00 PM');
eq(PR('Public:\tNice.\nPrivate:\t\nShowing & Location\nShowing Information\nOccupied By:\tVacant'), '', 'an empty field (tab, then a new line) is empty — not "Showing & Location"');
eq(PR('Public:\tNice.\nPrivate:\nShowing & Location\nOccupied By:\tVacant'), '', 'an empty field with no tab is empty');
eq(PR('Private:\t\nOccupied By:\tVacant\tOwner:'), '', "an empty field never reads the next field's label");
eq(PR('Private:\t\n\nShowing & Location'), '', 'an empty field before a blank line is empty');
eq(PR('Public:\tNice.\nPrivate:'), '', 'an empty field at the very end is empty');
eq(PR('Private:\nSupra on property. Offers due Friday 10/30 by 5pm.\nShowing & Location'), 'Supra on property. Offers due Friday 10/30 by 5pm.',
  'a remark on the line below the label is still read when it is plainly a remark');
eq(PR('Public:\tNice.\nPrivate:\tTenant pays $2,400. Cash only.\n\nFeatures'), 'Tenant pays $2,400. Cash only.', 'the old case still reads the same');
eq(['Showing & Location', ' showing and location ', 'Showing Information'].map(core.isJunkPrivate), [true, true, true], 'the section headings are junk');
eq(['Showings by appointment only.', 'Offer date 10/28', ''].map(core.isJunkPrivate), [false, false, false], 'a real remark (or an empty one) is not');

// --- v1.74.3: the cover photo for the boards ---
const cover = html => { global.document = { body: { innerHTML: html } }; try { return eval(core.JS_COVER); } finally { delete global.document; } };
const G = (n, sz) => `<img src="https://search.mlslistings.com/MediaServer/GetMedia.ashx?Key=77&amp;TableID=9&amp;Type=1&amp;Number=${n}&amp;Size=${sz}">`;
eq(cover(G(2, 2) + G(0, 2) + G(0, 5) + G(1, 5)), 'https://search.mlslistings.com/MediaServer/GetMedia.ashx?Key=77&TableID=9&Type=1&Number=0&Size=5',
  'the cover is photo 0, at the largest size the report has');
eq(cover('<p>no photos</p>'), '', 'a report with no MLS photos gives no cover');
eq(core.PUBLIC_NO_PHOTO.test('https://www.mlslistings.com/images/nophoto.png'), true, "the public site's no-photo image is not a photo");
eq(core.PUBLIC_NO_PHOTO.test('https://media.mlslmedia.com/property/MLSL/82065149/0e20df80/2/1'), false, 'a real MLS photo is one');

// --- v1.74.4: Seth's first run (22 Oct) saved a Photo for 5 North Bay leads; 4 had a public photo ---
const T2 = '<img src="https://search.mlslistings.com/MediaServer/GetMedia.ashx?Key=3046380142&amp;TableID=9&amp;Type=2&amp;Number=0&amp;Size=5">';
eq(cover(T2 + G(0, 2)), 'https://search.mlslistings.com/MediaServer/GetMedia.ashx?Key=77&TableID=9&Type=1&Number=0&Size=2',
  'a Type=2 image is never the cover, even at a bigger size');
eq(cover(T2), '', '2613 Sage St: only a Type=2 image (no photos posted yet) → no cover');
const page = (url, img) => `<link rel="canonical" href="${url}">\n<meta property="og:url" content="${url}">\n`
  + '<meta property="og:image:width" content="600"/>\n' + (img ? `<meta property="og:image" content="${img}">` : '');
const VAC = 'https://www.mlslistings.com/property/ba326088771/690-camellia-way-vacaville-ca-95688';
const BARI = 'https://barimedia.rapmls.com/norcalmls/listingpics/bigphoto/2026/10/21/7233452c-aab3-40a2-adb8-6cba69ff557d.jpg';
eq(core.publicPageHasPhoto(page(VAC, BARI), 'BA326088771'), true, '690 Camellia Way: its own page (lower-case id in og:url) with a photo');
eq(core.publicPageHasPhoto(page('https://www.mlslistings.com/property/ba326086547/2613-sage-st-santa-rosa-ca-95405',
  'https://www.mlslistings.com/images/photos_coming_soon.png'), 'BA326086547'), false, '2613 Sage St: "photos coming soon" is not a photo');
eq(core.publicPageHasPhoto('<meta property="og:url" content="https://www.mlslistings.com" />\n<title>MLSListings</title>', 'ML82065149'), false,
  'a hidden listing lands on the home page: no photo');
eq(core.publicPageHasPhoto(page(VAC, BARI), 'BA326088825'), false, "another listing's page is not this one's");
eq(core.publicPageHasPhoto(page(VAC, BARI), 'BA32608877'), false, 'an MLS # that is only the start of the page\'s is not it');
eq(core.publicPageHasPhoto(`<meta property="og:image" content="${BARI}">`, 'BA326088771'), false, 'a page that does not say which listing it is: no');
eq(core.publicPageHasPhoto(page(VAC, BARI), ''), false, 'no MLS #: no');
eq(core.MLS_MEDIA_LINK.test('https://search.mlslistings.com/MediaServer/GetMedia.ashx?Key=3048371939&TableID=9&Type=1&Number=0&Size=2&exk=f8023655b1f7d4476cd321e8efb3da01'), true,
  "v1.74.3's saved address is recognised (a Refresh replaces it)");
eq(['data:image/jpeg;base64,/9j/4AAQ', 'https://media.mlslmedia.com/property/MLSL/82065149/0e20df80/2/1', ''].map(v => core.MLS_MEDIA_LINK.test(v)),
  [false, false, false], 'a copy, a public photo or a blank is not');

// --- v1.74.5: a Refresh run again the same day picks up where it stopped ---
{
  const day = '2026-10-22';
  let p = core.refreshProgressAdd(null, day, ['ml1', 'ML2', '']);
  eq(p, { day, done: ['ML1', 'ML2'] }, 'the saved MLS #s are kept for the day, upper-cased, blanks dropped');
  p = core.refreshProgressAdd(p, day, ['ML2', 'ML3']);
  eq(p.done, ['ML1', 'ML2', 'ML3'], 'a second save adds only the new ones');
  eq([...core.refreshResume(p, day)], ['ML1', 'ML2', 'ML3'], 'the same day: those are skipped');
  eq(core.refreshResume(p, '2026-10-23').size, 0, 'the next day: nothing is skipped — statuses move');
  eq(core.refreshProgressAdd(p, '2026-10-23', ['ML9']), { day: '2026-10-23', done: ['ML9'] }, "yesterday's list is started over");
  eq([core.refreshResume(null, day).size, core.refreshResume({ day }, day).size, core.refreshResume('junk', day).size], [0, 0, 0],
    'no file, or a broken one, skips nothing');
}

console.log(fails ? fails + ' FAILED' : 'ALL PASS');
process.exit(fails ? 1 : 0);
