// runDeadlines end to end against a stand-in for Google: reading the
// assigner's mail in full, chasing as the assigner, the log, Pause, and the
// 5 PM scorecard.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { formatDate } = require('./fakes');
const dir = path.join(__dirname, '..');
const H = 3600e3, MIN = 60e3;
const SETH = 'seth@twinhomebuyer.com', CHERRY = 'cherry@twinhomebuyer.com', LEO = 'leo@twinhomebuyer.com', MIKE = 'mike@twinhomebuyer.com', TIN = 'tin@twinhomebuyer.com';
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) process.exitCode = 1; };

// Seth's mailbox: threads of full messages
const b64u = s => Buffer.from(s, 'utf8').toString('base64url');
const mailbox = { threads: {}, order: [] };
let seq = 0;
function add(thread, { from, to, cc, subject, at, text, attachments, headers, sent }) {
  const id = 'm' + (++seq);
  const parts = [{ mimeType: 'text/plain', body: { data: b64u(text || '') } }]
    .concat((attachments || []).map(f => ({ mimeType: 'application/pdf', filename: f, headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'a' + id } })));
  const msg = { id, threadId: thread, internalDate: String(at), labelIds: sent ? ['SENT'] : ['INBOX'], payload: { mimeType: 'multipart/mixed', parts,
    headers: [{ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Cc', value: cc || '' }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.gmail.com>` }].concat(headers || []) } };
  if (!mailbox.threads[thread]) { mailbox.threads[thread] = []; mailbox.order.unshift(thread); }
  mailbox.threads[thread].push(msg);
  return msg;
}
const hist = t => 'h' + mailbox.threads[t].length;

const T0 = Date.UTC(2026, 9, 29, 16, 0); // Thu Oct 29, 9:00 AM Pacific
let now = T0;
const sentMail = [], mails = [], calls = [];
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const props = { LOG_SHEET_ID: 'log1', SA_KEY: JSON.stringify({ client_email: 'reader@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
const cache = {};
const tabs = { Pause: [['Paused', 'By', 'At'], ['no', '', '']], Stopped: [['Thread', 'Person', 'Subject', 'Stopped by', 'Stopped at']] };
const fills = {};
const sheet = n => ({
  clearContents: () => { tabs[n] = []; }, clear: () => { tabs[n] = []; fills[n] = []; }, getLastRow: () => tabs[n].length,
  getDataRange: () => ({ getValues: () => tabs[n].map(r => r.slice()) }),
  getRange: (r, c, h, w) => ({ setNumberFormat() { return this; }, setValues(v) { assert.ok(v.length === h && v.every(x => x.length === w)); v.forEach((row, i) => { tabs[n][r - 1 + i] = row.slice(); }); return this; },
    setBackgrounds(v) { assert.ok(v.length === h && v.every(x => x.length === w)); (fills[n] = fills[n] || []); v.forEach((row, i) => { fills[n][r - 1 + i] = row[0]; }); return this; } }),
});
const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
const ctx = {
  module: { exports: {} }, __log: [], console: { log: (...a) => ctx.__log.push(a.join(' ')) },
  Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(now); } static now() { return now; } },
  Utilities: {
    formatDate, Charset: { UTF_8: 'utf8' },
    base64Encode: (s, cs) => Buffer.from(s, cs || 'utf8').toString('base64'),
    base64EncodeWebSafe: (s, cs) => Buffer.from(typeof s === 'string' ? Buffer.from(s, cs || 'utf8') : Buffer.from(s)).toString('base64url') + '=',
    base64DecodeWebSafe: s => [...Buffer.from(s, 'base64url')],
    newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
    computeRsaSha256Signature: (input, key) => [...crypto.sign('RSA-SHA256', Buffer.from(input), key)],
    sleep: () => {},
  },
  UrlFetchApp: { fetch(url, opt) {
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claim = JSON.parse(Buffer.from(opt.payload.assertion.split('.')[1], 'base64url'));
      return res(200, { access_token: 'tok-' + claim.scope.split('/').pop() + '-' + claim.sub });
    }
    const u = new URL(url);
    if (u.pathname.endsWith('/messages/send')) {
      assert.strictEqual(opt.headers.Authorization, 'Bearer tok-gmail.send-' + SETH, 'sent as the assigner, with the send permission');
      const body = JSON.parse(opt.payload);
      const text = Buffer.from(body.raw, 'base64url').toString('utf8');
      const [head, b] = text.split('\r\n\r\n');
      const h = Object.fromEntries(head.split('\r\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
      const mail = { ...h, threadId: body.threadId, text: Buffer.from(b.replace(/\r\n/g, ''), 'base64').toString('utf8') };
      sentMail.push(mail);
      add(body.threadId, { from: h.From, to: h.To, subject: h.Subject, at: now, text: mail.text, sent: true, headers: [{ name: 'X-Deadline-Chase', value: '1' }] });
      return res(200, { id: 'sent' });
    }
    assert.strictEqual(opt.headers.Authorization, 'Bearer tok-gmail.readonly-' + SETH, 'reads with the read permission');
    const q = u.searchParams.get('q') || '';
    if (u.pathname.endsWith('/threads')) {
      assert.ok(/in:sent/.test(q) && /subject:TEST/.test(q), q);
      return res(200, { threads: mailbox.order.filter(t => mailbox.threads[t].some(m => m.labelIds.includes('SENT'))).map(id => ({ id, historyId: hist(id) })) });
    }
    let m = /\/threads\/(\w+)$/.exec(u.pathname);
    if (m) return res(200, { id: m[1], messages: mailbox.threads[m[1]] });
    if (u.pathname.endsWith('/messages')) {
      const from = /from:(\S+)/.exec(q)[1];
      const all = Object.values(mailbox.threads).flat().filter(x => x.payload.headers.find(h => h.name === 'From').value.includes(from));
      return res(200, { messages: all.map(x => ({ id: x.id, threadId: x.threadId })) });
    }
    m = /\/messages\/(\w+)$/.exec(u.pathname);
    return res(200, Object.values(mailbox.threads).flat().find(x => x.id === m[1]));
  } },
  CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, getProperties: () => ({ ...props }), setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  SpreadsheetApp: { openById: () => ({ getSheetByName: n => (n in tabs ? sheet(n) : null), insertSheet: n => { tabs[n] = []; return sheet(n); } }) },
  MailApp: { sendEmail: m => mails.push(m) },
};
vm.runInNewContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, 'Deadlines.gs'), 'utf8')
  + '\n;this.DEADLINES = DEADLINES; this.runDeadlines = runDeadlines; this.sendScorecard = sendScorecard; this.checkDeadlines = checkDeadlines;', ctx);
const cfg = ctx.DEADLINES;
const run = () => { ctx.__log.length = 0; ctx.runDeadlines(); return ctx.__log.join(' / '); };

// Seth assigns at 9:00: the fence quote to Cherry and Leo by 3 PM, the permit to Mike by noon
add('t1', { from: 'Seth Concepcion <' + SETH + '>', to: 'Cherry Ann <' + CHERRY + '>, Leo <' + LEO + '>', subject: 'TEST Fence quote', at: T0, sent: true,
  text: 'Get me the fence numbers.\nOWNER: Cherry · DUE: today 3 PM PT\nOWNER: Leo · DUE: today 3 PM PT\nOWNER: Bob · DUE: tomorrow' });
add('t2', { from: 'Seth Concepcion <' + SETH + '>', to: MIKE, cc: CHERRY, subject: 'TEST Permit packet', at: T0 + MIN, sent: true, text: 'OWNER: Mike · DUE: noon' });
add('t3', { from: 'Seth Concepcion <' + SETH + '>', to: TIN, subject: 'Real email: Lockbox', at: T0 + 2 * MIN, sent: true, text: 'OWNER: Tin · DUE: 10 AM' });
// Cherry answers in the thread; Mike sends the permit in a new email with Seth in CC
add('t1', { from: 'Cherry Ann <' + CHERRY + '>', to: SETH, subject: 'Re: TEST Fence quote', at: T0 + 2 * H, text: 'DONE, numbers attached\n\nOn Thu, Oct 29, 2026 at 9:00 AM Seth Concepcion <seth@twinhomebuyer.com> wrote:\n> OWNER: Cherry · DUE: today 3 PM PT', attachments: ['fence.pdf'] });
add('t9', { from: 'Mike <' + MIKE + '>', to: 'county@example.gov', cc: SETH, subject: 'Permit packet for 1187 San Moritz (TEST Permit packet)', at: T0 + 2 * H, text: 'Please find attached.', attachments: ['permit.pdf'] });

// 1. noon: nothing due yet except Mike's, which he sent elsewhere
now = Date.UTC(2026, 9, 29, 19, 5); // 12:05 PM Pacific
let log = run();
check('only TEST assignments are read', !/Lockbox/.test(JSON.stringify(tabs.Assignments)), log);
const rowOf = (owner, subj) => tabs.Assignments.find(r => r[2] === owner && r[1] === subj);
check('Cherry: delivered on time (DONE + attachment in the thread)', rowOf(CHERRY, 'TEST Fence quote')[5] === 'delivered');
check('Mike: delivered by the email he sent elsewhere with Seth in CC', rowOf(MIKE, 'TEST Permit packet')[5] === 'delivered', rowOf(MIKE, 'TEST Permit packet').join(' | '));
check('Leo: still open before 3 PM', rowOf(LEO, 'TEST Fence quote')[5] === 'open');
check('Bob is not on the email: listed, not chased', tabs.Assignments.some(r => r[5] === 'unclear' && /Bob/.test(r[8])));
check('nothing sent yet', sentMail.length === 0);
const rowIndex = (owner, subj) => tabs.Assignments.findIndex(r => r[2] === owner && r[1] === subj);
check('a link to the assignment email, by its Message-ID', rowOf(CHERRY, 'TEST Fence quote')[10] === 'https://mail.google.com/mail/#search/rfc822msgid%3Am1%40mail.gmail.com', rowOf(CHERRY, 'TEST Fence quote')[10]);
check('delivered is green, open is white', fills.Assignments[rowIndex(CHERRY, 'TEST Fence quote')] === '#d1fadf' && fills.Assignments[rowIndex(LEO, 'TEST Fence quote')] === null);

// 2. 3:05 PM, dry run: says what it would send, sends nothing, logs the miss
now = Date.UTC(2026, 9, 29, 22, 5);
log = run();
check('dry run: would chase Leo with the exact words', /\[dry run\] would chase Leo <leo@twinhomebuyer.com> on "TEST Fence quote": The deadline was Oct 29, 3:00 PM PT\. Send it now, plus one line on why you missed it\./.test(log) && sentMail.length === 0, log);
check('missed is red', fills.Assignments[rowIndex(LEO, 'TEST Fence quote')] === '#fee4e2');
check('the miss is logged by name and date', tabs.Misses.length === 2 && tabs.Misses[1][0] === '2026-10-29' && tabs.Misses[1][1] === LEO && tabs.Misses[1][2] === 'Leo');

// 3. for real: the chase goes to Leo only, in the thread, as Seth
cfg.DRY_RUN = false;
now += 15 * MIN;
log = run();
const c = sentMail[0];
check('chased once, to Leo only', sentMail.length === 1 && c.To === LEO, c && c.To);
check('in the assignment thread, as the assigner', c.threadId === 't1' && c['In-Reply-To'] === '<m1@mail.gmail.com>' && /seth@twinhomebuyer.com/.test(c.From) && c.Subject === 'Re: TEST Fence quote');
check('the chase says exactly that', c.text === 'The deadline was Oct 29, 3:00 PM PT. Send it now, plus one line on why you missed it.', c.text);
check('marked so it is never read as an email to chase', c['X-Deadline-Chase'] === '1' && c['X-Reply-Reminder'] === '1');
check('the miss is not logged twice', tabs.Misses.length === 2);
now += 15 * MIN; run();
check('not chased again', sentMail.length === 1);

// 4. a DATE before the deadline moves it once; BLOCKED holds the chase; Pause holds everything
add('t4', { from: 'Seth Concepcion <' + SETH + '>', to: TIN, subject: 'TEST Lockbox codes', at: now, sent: true, text: 'OWNER: Tin · DUE: today 4 PM' });
add('t4', { from: TIN, to: SETH, subject: 'Re: TEST Lockbox codes', at: now + MIN, text: 'DATE: tomorrow 10 AM' });
add('t5', { from: 'Seth Concepcion <' + SETH + '>', to: MIKE, subject: 'TEST Photos', at: now, sent: true, text: 'OWNER: Mike · DUE: today 4 PM' });
add('t5', { from: MIKE, to: SETH, subject: 'Re: TEST Photos', at: now + MIN, text: 'BLOCKED: the site is locked' });
now = Date.UTC(2026, 9, 29, 23, 30); // 4:30 PM Pacific
run();
check('DATE: not chased, shown with the new deadline', rowOf(TIN, 'TEST Lockbox codes')[5] === 'date' && rowOf(TIN, 'TEST Lockbox codes')[4] === new Date(Date.UTC(2026, 9, 30, 17)).toISOString() && sentMail.length === 1);
check('BLOCKED: not chased', rowOf(MIKE, 'TEST Photos')[5] === 'blocked');
check('blocked is yellow', fills.Assignments[rowIndex(MIKE, 'TEST Photos')] === '#fef0c7');
tabs.Pause[1] = ['yes', 'Seth Concepcion', ''];
now = Date.UTC(2026, 9, 30, 17, 5); // Fri 10:05 AM: Tin's moved deadline passes
log = run();
check('paused: not chased, and the log says so', sentMail.length === 1 && /Paused: not chasing Tin/.test(log), log);
tabs.Pause[1] = ['no', 'Seth Concepcion', ''];
now += 15 * MIN; run();
check('back on: chased at the moved deadline', sentMail.length === 2 && sentMail[1].To === TIN && /Oct 30, 10:00 AM PT/.test(sentMail[1].text), sentMail[1] && sentMail[1].text);

// 5. the 5 PM scorecard, once a day, results only
now = Date.UTC(2026, 9, 30, 23, 50); // 4:50 PM Pacific: not yet
run();
check('no scorecard before 5 PM', mails.length === 0);
add('t1', { from: 'Leo <' + LEO + '>', to: SETH, subject: 'Re: TEST Fence quote', at: now, text: 'DONE, sorry. I missed the email.', attachments: ['fence-leo.pdf'] });
now = Date.UTC(2026, 9, 31, 0, 5); // 5:05 PM Pacific
run();
check('scorecard sent at 5 PM to the assigner', mails.length === 1 && mails[0].to === SETH && mails[0].subject === 'Scorecard: Fri, Oct 30', mails[0] && mails[0].subject);
const body = mails[0].body;
check('delivered today: Leo, late', /DELIVERED TODAY\n- Leo: TEST Fence quote \(late\)/.test(body), body);
check('missed today: Tin', /MISSED TODAY\n- Tin: TEST Lockbox codes \(due Oct 30, 10:00 AM PT\)/.test(body));
check('still open: Tin overdue, Mike blocked', /STILL OPEN\n- Mike: TEST Photos \(BLOCKED\)\n- Tin: TEST Lockbox codes \(overdue since Oct 30, 10:00 AM PT\)/.test(body) || /STILL OPEN\n- Tin: TEST Lockbox codes \(overdue since Oct 30, 10:00 AM PT\)\n- Mike: TEST Photos \(BLOCKED\)/.test(body));
now += 15 * MIN; run();
check('scorecard as a table: Person, Task, Due, Result', /<th[^>]*>Person<\/th><th[^>]*>Task<\/th><th[^>]*>Due<\/th><th[^>]*>Result<\/th>/.test(mails[0].htmlBody) && /Leo<\/td><td[^>]*>TEST Fence quote<\/td>.*Delivered late/.test(mails[0].htmlBody));
check('only one scorecard a day', mails.length === 1);

// 6. a day of emails written Juan's way: subject deadlines, named items, Thea, a correction, an announcement
const MARIE = 'marie@twinhomebuyer.com';
now = Date.UTC(2026, 9, 31, 16, 0); // Sat Oct 31, 9:00 AM Pacific
add('t6', { from: 'Seth Concepcion <' + SETH + '>', to: 'Leo <' + LEO + '>', subject: 'TEST Load the rules, due 10:00 AM today', at: now, sent: true,
  text: "Leo,\n\nLoad these:\n1. Core values: We tell the truth.\n2. Probation rule: 3 misses in 30 days.\n\nReply DONE by 10:00 AM. If you can't, send BLOCKED by 9:30 AM.\n\nSeth" });
add('t7', { from: 'Seth Concepcion <' + SETH + '>', to: 'Cherry Ann <' + CHERRY + '>, Mike <' + MIKE + '>, Marie <' + MARIE + '>', subject: 'TEST Madison: verdict by 11:40 AM', at: now, sent: true,
  text: "Team,\n\n1. Cherry: send the disclosures by 10:15 AM. If you can't get them by then, send BLOCKED by 10:05 AM.\n\n2. Mike and Thea: run comps.\n- the ARV\nDue 11:40 AM.\n\nSeth" });
add('t8', { from: 'Seth Concepcion <' + SETH + '>', to: 'Tin <' + TIN + '>', subject: 'TEST New build, working test by Tue Nov 3, 5:00 PM', at: now, sent: true, text: 'Tin,\n\nBuild it.\n\nSeth' });
add('t8', { from: 'Seth Concepcion <' + SETH + '>', to: 'Tin <' + TIN + '>', subject: 'Re: TEST New build, working test by Tue Nov 3, 5:00 PM', at: now + 30 * MIN, sent: true,
  text: "Tin,\n\nCorrection: the working test is due today at 10:30 AM Pacific. Send BLOCKED by 10:00 AM if you can't make it.\n\nSeth\n\nOn Sat, Oct 31, 2026 at 9:00 AM Seth Concepcion <seth@twinhomebuyer.com> wrote:\n> Build it." });
add('t10', { from: 'Seth Concepcion <' + SETH + '>', to: 'Leo <' + LEO + '>, Tin <' + TIN + '>', subject: 'TEST Out 4:00-5:00 PM today', at: now, sent: true, text: "Team,\n\nI'll be out. For anything urgent, go to Cherry.\n\nSeth" });
now = Date.UTC(2026, 9, 31, 18, 45); // 11:45 AM Pacific
const b6 = sentMail.length;
run();
const chased6 = sentMail.slice(b6).map(m => m.To + ' ' + /The deadline was (.*?)\./.exec(m.text)[1]).sort();
check('Juan’s way: everyone who missed is chased, at their own deadline', JSON.stringify(chased6) === JSON.stringify([
  'cherry@twinhomebuyer.com Oct 31, 10:15 AM PT', 'leo@twinhomebuyer.com Oct 31, 10:00 AM PT', 'marie@twinhomebuyer.com Oct 31, 11:40 AM PT',
  'mike@twinhomebuyer.com Oct 31, 11:40 AM PT', 'tin@twinhomebuyer.com Oct 31, 10:30 AM PT']), chased6.join(' | '));
check('Thea is Marie', tabs.Assignments.some(r => r[2] === MARIE && r[1] === 'TEST Madison: verdict by 11:40 AM'));
check('the correction moved Tin’s deadline', rowOf(TIN, 'TEST New build, working test by Tue Nov 3, 5:00 PM')[4] === new Date(Date.UTC(2026, 9, 31, 17, 30)).toISOString());
check('the announcement is not an assignment', !tabs.Assignments.some(r => /Out 4:00/.test(r[1])));
// 7. Leo answers a day later in a new email titled without the deadline
now = Date.UTC(2026, 10, 1, 17, 0);
add('t11', { from: 'Leo <' + LEO + '>', to: SETH, subject: 'Load the rules', at: now - 10 * MIN, text: 'Sorry, here they are.', attachments: ['rules.pdf'] });
run();
const morning = mails.find(m => m.subject === 'Overdue: Sun, Nov 1');
check('8 AM: the overdue list, by name, blocked left off', morning && /OVERDUE\n/.test(morning.body) && /- Tin: TEST Lockbox codes \(due Oct 30, 10:00 AM PT\)/.test(morning.body)
  && /- Cherry Ann: TEST Madison/.test(morning.body) && !/Photos/.test(morning.body) && !/- Leo:/.test(morning.body) && /Overdue: <b>\d+<\/b>/.test(morning.htmlBody), morning && morning.body);
check('work sent the next day in a new email still counts, as late', rowOf(LEO, 'TEST Load the rules, due 10:00 AM today')[5] === 'delivered' && rowOf(LEO, 'TEST Load the rules, due 10:00 AM today')[8] === 'late');
now = Date.UTC(2026, 10, 1, 17, 30); run();
check('one morning email a day', mails.filter(m => /^Overdue:/.test(m.subject)).length === 1);
// 8. called off in the thread, and a new ask in a reply's body
now = Date.UTC(2026, 10, 2, 16, 0); // Mon Nov 2, 8:00 AM Pacific
add('t12', { from: 'Seth Concepcion <' + SETH + '>', to: 'Mike <' + MIKE + '>', subject: 'TEST Directory tab today by 10:00 AM', at: now, sent: true,
  text: 'Mike,\n\nAdd the Directory tab. Reply DONE with a screenshot by 10:00 AM Pacific today, or BLOCKED.\n\nSeth' });
add('t12', { from: 'Seth Concepcion <' + SETH + '>', to: 'Mike <' + MIKE + '>', subject: 'Re: TEST Directory tab today by 10:00 AM', at: now + 5 * MIN, sent: true,
  text: 'Mike, skip this one. The tab is already there. Nothing needed from you on it.\n\nSeth' });
add('t13', { from: 'Seth Concepcion <' + SETH + '>', to: 'Tin <' + TIN + '>', subject: 'TEST Fence photos', at: now, sent: true, text: 'Tin,\n\nThanks for the quote.\n\nSeth' });
add('t13', { from: 'Seth Concepcion <' + SETH + '>', to: 'Tin <' + TIN + '>', subject: 'Re: TEST Fence photos', at: now + 10 * MIN, sent: true,
  text: 'Tin,\n\nStill open: the fence photos. Resend within 30 minutes.\n\nSeth' });
now = Date.UTC(2026, 10, 2, 18, 5); // 10:05 AM Pacific
const b8 = sentMail.length;
run();
const chased8 = sentMail.slice(b8).map(m => m.To + ' ' + /The deadline was (.*?)\./.exec(m.text)[1]);
check('called off: no row, no chase', !tabs.Assignments.some(r => /Directory tab/.test(r[1])) && !chased8.some(c => c.startsWith(MIKE)), chased8.join(' | '));
check('a new ask in a reply’s body is chased at its own time', JSON.stringify(chased8) === JSON.stringify([TIN + ' Nov 2, 8:40 AM PT']), chased8.join(' | '));
console.log(process.exitCode ? 'FAILED' : 'all checks passed');
