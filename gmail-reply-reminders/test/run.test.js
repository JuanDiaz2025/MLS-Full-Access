// run() end to end against a stand-in for Google: sign-in, reading Juan's
// sent threads (headers only), sending reminders into the threads,
// remembering what was sent.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const HOUR = 3600e3;
let now = Date.UTC(2026, 9, 28, 3, 0); // 11 AM Manila, 8 PM California

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const props = { LOG_SHEET_ID: 'log1', SA_KEY: JSON.stringify({ client_email: 'reader@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
const cache = {};
const calls = [], sent = [];
// the log sheet: tab name -> rows, and how often each tab was written
const tabs = {}, tabWrites = {};
let logBroken = false;
const sheet = n => ({ clearContents: () => { tabs[n] = []; },
  getDataRange: () => ({ getValues: () => tabs[n].map(r => r.slice()) }),
  getRange: (r, c, h, w) => ({ setNumberFormat() { return this; },
    setValues(v) {
      assert.ok(v.length === h && v.every(x => x.length === w), 'range fits the values');
      v.forEach((row, i) => { tabs[n][r - 1 + i] = row.slice(); });
      tabWrites[n] = (tabWrites[n] || 0) + 1; return this;
    } }) });
const H = (n, v) => ({ name: n, value: v });
let seq = 0;
let owner = 'seth@twinhomebuyer.com'; // the account running the script
const juanMsg = (id, to, hoursAgo, extra = {}) => ({ id, internalDate: String(now - hoursAgo * HOUR), labelIds: ['SENT'], payload: { headers: [
  H('From', 'Juan Diaz <juan@twinhomebuyer.com>'), H('To', to), H('Cc', extra.cc || ''), H('Subject', extra.subject || 'Fence quote'), H('Message-ID', `<${id}@mail.gmail.com>`)] } });
const reply = (id, from, hoursAgo) => ({ id, internalDate: String(now - hoursAgo * HOUR), labelIds: ['INBOX'], payload: { headers: [
  H('From', from), H('To', 'juan@twinhomebuyer.com'), H('Message-ID', `<${id}@mail.gmail.com>`)] } });
const threads = {
  t1: [juanMsg('m1', 'Cherry Ann <cherry@twinhomebuyer.com>', 6, { cc: 'vannessa@twinhomebuyer.com, Leo <leo@twinhomebuyer.com>' }), reply('m2', 'vannessa@twinhomebuyer.com', 5)],
  t2: [juanMsg('m3', 'seller@gmail.com', 7)],
  t3: [juanMsg('m4', 'mike@twinhomebuyer.com', 2)],
  t4: [juanMsg('m5', 'cherry@twinhomebuyer.com', 30, { subject: 'Señora – permit' })],
  t6: [juanMsg('m7', 'Bryan <bryan@twinhomebuyer.com>', 6)],
  t5: [juanMsg('m6', 'old@twinhomebuyer.com', 10 * 24)],
};
const order = ['t3', 't1', 't2', 't4', 't6', 't5'];
const hist = id => 'h' + threads[id].length;
const parseMail = raw => {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const [head, ...rest] = text.split('\r\n\r\n');
  const h = Object.fromEntries(head.split('\r\n').map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
  const body = Buffer.from(rest.join('\r\n\r\n').split('\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
  const subject = /^=\?UTF-8\?B\?(.*)\?=$/.exec(h.Subject);
  return { ...h, Subject: subject ? Buffer.from(subject[1], 'base64').toString('utf8') : h.Subject, body };
};
const ctx = {
  module: undefined, console: { log: (...a) => ctx.__log.push(a.join(' ')) }, __log: [],
  Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(now); } static now() { return now; } },
  Utilities: {
    Charset: { UTF_8: 'utf8' },
    base64Encode: (s, cs) => Buffer.from(s, cs || 'utf8').toString('base64'),
    base64EncodeWebSafe: (s, cs) => Buffer.from(typeof s === 'string' ? Buffer.from(s, cs || 'utf8') : Buffer.from(s)).toString('base64url') + '=',
    computeRsaSha256Signature: (input, key) => [...crypto.sign('RSA-SHA256', Buffer.from(input), key)],
    formatDate: (d, tz, f) => String(Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(d))),
    getUuid: () => '0000-' + (++seq),
    sleep: () => {},
    DigestAlgorithm: { MD5: 'md5' },
    computeDigest: (alg, s) => [...crypto.createHash(alg).update(s).digest()],
  },
  SpreadsheetApp: { openById(id) {
    if (logBroken) throw new Error('sheet unavailable');
    assert.strictEqual(id, 'log1');
    return { getSheetByName: n => (n in tabs ? sheet(n) : null), insertSheet: n => { tabs[n] = []; return sheet(n); } };
  } },
  Session: { getEffectiveUser: () => ({ getEmail: () => owner }) },
  ScriptApp: { getOAuthToken: () => 'owner-token' },
  UrlFetchApp: {
    fetch(url, opt) {
      calls.push(url);
      const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
      if (url === 'https://oauth2.googleapis.com/token') {
        const [h, c, sig] = opt.payload.assertion.split('.');
        const claim = JSON.parse(Buffer.from(c, 'base64url'));
        assert.ok(crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), crypto.createPublicKey(privateKey), Buffer.from(sig, 'base64url')), 'signed with the key');
        assert.strictEqual(claim.scope, 'https://www.googleapis.com/auth/gmail.metadata');
        return res(200, { access_token: 'tok' });
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
        assert.strictEqual(opt.headers.Authorization, 'Bearer owner-token', 'sent from the script owner, not through the read-only key');
        const body = JSON.parse(opt.payload);
        sent.push({ ...parseMail(body.raw), threadId: body.threadId });
        return res(200, { id: 'x' });
      }
      assert.strictEqual(opt.headers.Authorization, 'Bearer tok');
      const u = new URL(url);
      assert.ok(!u.searchParams.has('q'), 'the header-only scope cannot search');
      if (u.pathname.endsWith('/labels')) return res(200, { labels: [] });
      if (u.pathname.endsWith('/threads')) {
        const start = Number(u.searchParams.get('pageToken') || 0);
        const page = order.slice(start, start + 2);
        return res(200, { threads: page.map(id => ({ id, historyId: hist(id) })), nextPageToken: start + 2 < order.length ? String(start + 2) : undefined });
      }
      const m = /\/threads\/(\w+)$/.exec(u.pathname);
      assert.deepStrictEqual(u.searchParams.getAll('metadataHeaders'), ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'X-Reply-Reminder']);
      return res(200, { id: m[1], messages: threads[m[1]] });
    },
  },
  CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => props[k] ?? null, getProperties: () => ({ ...props }),
    setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
};
vm.runInNewContext(src + '\n;this.CONFIG = CONFIG; this.run = run;', ctx);
// the test's own settings, whatever Code.gs is set to
Object.assign(ctx.CONFIG, { WATCH: ['juan@twinhomebuyer.com'], REMIND_AFTER_MINUTES: [240, 1440, 2880], CHECK_EVERY_MINUTES: 5, QUIET_FROM_HOUR: 0, QUIET_TO_HOUR: 0, DRY_RUN: true });
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) process.exitCode = 1; };
const to = m => m.To.split(', ').map(e => e.split('@')[0]).sort().join(',');

// dry run: logs, sends nothing, records nothing
ctx.run();
check('dry run sends nothing', sent.length === 0 && !Object.keys(props).some(k => k.startsWith('sent:')), ctx.__log.join(' / '));
check('dry run says what it would do', ctx.__log.some(l => l === '[dry run] would reply in "Re: Fence quote" to cherry@twinhomebuyer.com, leo@twinhomebuyer.com (group, reminder 1)'));

// for real
ctx.CONFIG.DRY_RUN = false;
ctx.run();
const g = sent.find(m => /leo/.test(m.To));
check('group email: one reminder to Cherry and Leo together (Vannessa replied)', g && to(g) === 'cherry,leo', g && g.To);
check('in Juan\'s thread', g['In-Reply-To'] === '<m1@mail.gmail.com>' && g.References === '<m1@mail.gmail.com> <m2@mail.gmail.com>' && g.Subject === 'Re: Fence quote', g.Subject);
check('sent from another account: no thread id from Juan\'s mailbox', sent.every(m => m.threadId === undefined));
check('replies go to Juan; Juan not copied', g['Reply-To'] === '"Juan Diaz" <juan@twinhomebuyer.com>' && !/juan/.test(g.To) && !g.Cc, g['Reply-To']);
check('says nothing about the email', !/fence|quote|permit/i.test(g.body) && g.body.startsWith('Hi Cherry and Leo,'), JSON.stringify(g.body.split('\n\n')[1]));
const privates = sent.filter(m => m !== g).map(to).sort();
check('private ones: Cherry (30 h) and Bryan (6 h), each alone; Mike (2 h) not yet', privates.join(' | ') === 'bryan | cherry', privates.join(' | '));
const accent = sent.find(m => /Señora/.test(m.Subject));
check('a subject with accents arrives intact', accent && accent.Subject === 'Re: Señora – permit', accent && accent.Subject);
check('remembered what was sent', props['sent:cherry@twinhomebuyer.com|m1@mail.gmail.com'] && props['sent:leo@twinhomebuyer.com|m1@mail.gmail.com'] && props['sent:cherry@twinhomebuyer.com|m5@mail.gmail.com'].startsWith('2|'));

// the log the dashboard reads
const LOG = vm.runInNewContext('LOG_HEADERS', ctx);
const head = tabs.Emails && tabs.Emails[0];
check('log: Emails tab has the headers', JSON.stringify(head) === JSON.stringify(LOG));
const rowOf = (person, msgId) => tabs.Emails.slice(1).find(r => r[5] === person + '@twinhomebuyer.com' && r[12] === msgId + '@mail.gmail.com');
const col = n => LOG.indexOf(n);
const v = rowOf('vannessa', 'm1'), c1 = rowOf('cherry', 'm1');
check('log: Vannessa replied after 1 hour', v && v[col('Status')] === 'Replied' && Date.parse(v[col('Replied')]) - Date.parse(v[col('Sent')]) === HOUR, v && v.join(' '));
check('log: Cherry waiting, 1 reminder, on To', c1 && c1[col('Status')] === 'Waiting' && c1[col('Reminders')] === '1' && c1[col('On')] === 'To' && c1[col('Group')] === 'yes', c1 && c1.join(' '));
check('log: outside and old emails left out', !tabs.Emails.some(r => /seller@|old@/.test(r[5])), tabs.Emails.length - 1 + ' rows');
check('log: Status says when', tabs.Status && tabs.Status[0][0] === 'Updated' && tabs.Status[0][1] === new Date(now).toISOString());
const emailWrites = tabWrites.Emails;

// 15 minutes later: nothing new, and unchanged threads aren't read again
const reads = calls.filter(c => /\/threads\/\w+/.test(c)).length;
now += 15 * 60e3; ctx.run();
check('nothing sent twice', sent.length === 3, sent.length);
check('unchanged threads not read again', calls.filter(c => /\/threads\/\w+/.test(c)).length === reads);
check('log: Emails tab not rewritten when nothing changed, Status is', tabWrites.Emails === emailWrites && tabs.Status[0][1] === new Date(now).toISOString());

// Leo replies; 20 hours on, the group reminder goes to Cherry only
threads.t1.push(reply('m8', 'Leo <leo@twinhomebuyer.com>', 1));
now += 20 * HOUR;
ctx.run();
const g2 = sent.slice(3).find(m => m['In-Reply-To'] === '<m1@mail.gmail.com>');
check('log: Leo shows as replied', rowOf('leo', 'm1')[col('Status')] === 'Replied' && tabWrites.Emails > emailWrites);
check('after Leo replied, only Cherry is reminded in that thread', g2 && to(g2) === 'cherry' && /reminder 2 of 3/.test(g2.body), g2 && g2.To);
check('2nd reminders for Cherry\'s and Bryan\'s private ones, 1st for Mike', sent.slice(3).filter(m => m !== g2).map(m => to(m) + ':' + /reminder (\d)/.exec(m.body)[1]).sort().join(',') === 'bryan:2,cherry:3,mike:1',
  sent.slice(3).filter(m => m !== g2).map(m => to(m) + ':' + /reminder (\d)/.exec(m.body)[1]).sort().join(','));

// quiet hours, when on, hold someone until their own morning
ctx.CONFIG.QUIET_FROM_HOUR = 20; ctx.CONFIG.QUIET_TO_HOUR = 8;
threads.t7 = [juanMsg('m9', 'Bryan <bryan@twinhomebuyer.com>, cherry@twinhomebuyer.com', 5)]; order.unshift('t7');
now = Date.UTC(2026, 9, 30, 6, 0) + 5 * HOUR; // 7 PM Manila, 4 AM California
const before = sent.length;
ctx.run();
const q = sent.slice(before).find(m => m['In-Reply-To'] === '<m9@mail.gmail.com>');
check('quiet hours on: Cherry gets the group reminder, Bryan waits for his morning', q && to(q) === 'cherry' && ctx.__log.some(l => /bryan@twinhomebuyer.com: waiting until 8 AM their time/.test(l)), q && q.To);

// a broken log never stops the reminders
logBroken = true;
threads.t9 = [juanMsg('m11', 'Mike <mike@twinhomebuyer.com>', 5)]; order.unshift('t9');
const before9 = sent.length;
ctx.run();
check('log broken: reminder still sent, and the log says why', sent.slice(before9).some(m => m['In-Reply-To'] === '<m11@mail.gmail.com>') && ctx.__log.some(l => /Couldn’t update the email log: sheet unavailable/.test(l)));
logBroken = false;

// a test from the watched account itself: the reminder also lands in that thread there
ctx.CONFIG.QUIET_FROM_HOUR = 0; ctx.CONFIG.QUIET_TO_HOUR = 0;
owner = 'juan@twinhomebuyer.com';
threads.t8 = [juanMsg('m10', 'Bryan <bryan@twinhomebuyer.com>', 5)]; order.unshift('t8');
const before8 = sent.length;
ctx.run();
const own = sent.slice(before8).find(m => m['In-Reply-To'] === '<m10@mail.gmail.com>');
check('run from the watched account: filed in the same thread', own && own.threadId === 't8', own && own.threadId);

// stopped and paused from the dashboard, through the Stopped and Pause tabs
check('control tabs made once, as the dashboard expects', JSON.stringify(tabs.Stopped) === JSON.stringify([vm.runInNewContext('STOP_HEADERS', ctx)]) && JSON.stringify(tabs.Pause) === '[["Paused","By","At"],["no","",""]]');
threads.t10 = [juanMsg('m12', 'Bryan <bryan@twinhomebuyer.com>, cherry@twinhomebuyer.com', 5)]; order.unshift('t10');
tabs.Stopped.push(['t10', 'bryan@twinhomebuyer.com', 'Fence quote', 'Seth Concepcion', new Date(now).toISOString()]);
let b4 = sent.length;
ctx.run();
const s10 = sent.slice(b4).filter(m => m['In-Reply-To'] === '<m12@mail.gmail.com>');
check('stopped for Bryan: the group reminder goes to Cherry only', s10.length === 1 && to(s10[0]) === 'cherry', s10.map(to).join(' | '));
check('log: Bryan shows as stopped, Cherry still waiting', rowOf('bryan', 'm12')[col('Status')] === 'Stopped' && rowOf('cherry', 'm12')[col('Status')] === 'Waiting');
tabs.Stopped[tabs.Stopped.length - 1] = ['', '', '', '', ''];
tabs.Stopped.push(['t10', '', 'Fence quote', 'Seth Concepcion', new Date(now).toISOString()]);
now += 20 * HOUR; b4 = sent.length;
ctx.run();
check('stopped for everyone: nothing more on that email', !sent.slice(b4).some(m => m['In-Reply-To'] === '<m12@mail.gmail.com>') && rowOf('cherry', 'm12')[col('Status')] === 'Stopped');
// once Bryan answers, a new email from Juan in that thread is tracked and reminded again
threads.t10.push(reply('m13', 'Bryan <bryan@twinhomebuyer.com>', 6), juanMsg('m14', 'Bryan <bryan@twinhomebuyer.com>', 5));
b4 = sent.length;
ctx.run();
check('after Bryan replies, a new email in that thread is reminded again', sent.slice(b4).some(m => m['In-Reply-To'] === '<m14@mail.gmail.com>' && to(m) === 'bryan'));
// pause all
tabs.Pause[1] = ['yes', 'Seth Concepcion', new Date(now).toISOString()];
threads.t11 = [juanMsg('m15', 'Mike <mike@twinhomebuyer.com>', 5)]; order.unshift('t11');
b4 = sent.length; ctx.__log.length = 0;
ctx.run();
check('paused: nothing is sent, and the log says who paused it', sent.length === b4 && ctx.__log.some(l => /reminders are paused by Seth Concepcion/.test(l)), ctx.__log.join(' / '));
check('Status says paused', tabs.Status.some(r => r[0] === 'Paused' && r[1] === 'yes, by Seth Concepcion'));
tabs.Pause[1] = ['no', 'Seth Concepcion', new Date(now).toISOString()];
ctx.run();
check('back on: the held reminder goes out', sent.slice(b4).some(m => m['In-Reply-To'] === '<m15@mail.gmail.com>'));
console.log(process.exitCode ? 'FAILED' : 'all checks passed');
