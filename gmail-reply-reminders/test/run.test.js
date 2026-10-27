// run() end to end against a stand-in for Google: sign-in, reading Juan's
// sent threads (headers only), sending reminders, remembering what was sent.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const src = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const HOUR = 3600e3;
let now = Date.UTC(2026, 9, 28, 3, 0); // 11:00 AM Manila

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const props = { SA_KEY: JSON.stringify({ client_email: 'reader@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
const cache = {};
const calls = [], sent = [];
const H = (n, v) => ({ name: n, value: v });
const juanMsg = (id, to, hoursAgo, subject) => ({ id, internalDate: String(now - hoursAgo * HOUR), labelIds: ['SENT'], payload: { headers: [H('From', 'Juan Diaz <juan@twinhomebuyer.com>'), H('To', to), H('Subject', subject || 'Fence quote'), H('Message-ID', `<${id}@mail.gmail.com>`)] } });
const reply = (id, from, hoursAgo) => ({ id, internalDate: String(now - hoursAgo * HOUR), labelIds: ['INBOX'], payload: { headers: [H('From', from), H('To', 'juan@twinhomebuyer.com'), H('Message-ID', `<${id}@mail.gmail.com>`)] } });
const threads = {
  t1: [juanMsg('m1', 'Cherry Ann <cherry@twinhomebuyer.com>, vannessa@twinhomebuyer.com', 6), reply('m2', 'vannessa@twinhomebuyer.com', 5)],
  t2: [juanMsg('m3', 'seller@gmail.com', 7)],
  t3: [juanMsg('m4', 'mike@twinhomebuyer.com', 2)],
  t4: [juanMsg('m5', 'cherry@twinhomebuyer.com', 30)],
  t6: [juanMsg('m7', 'Bryan <bryan@twinhomebuyer.com>', 6)], // Bryan is in California
  t5: [juanMsg('m6', 'old@twinhomebuyer.com', 10 * 24)],
};
const order = ['t3', 't1', 't2', 't4', 't6', 't5'];
const ctx = {
  module: undefined, console: { log: (...a) => ctx.__log.push(a.join(' ')) }, __log: [],
  Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(now); } static now() { return now; } },
  Utilities: {
    base64EncodeWebSafe: s => Buffer.from(typeof s === 'string' ? s : Buffer.from(s)).toString('base64url') + '=',
    computeRsaSha256Signature: (input, key) => [...crypto.sign('RSA-SHA256', Buffer.from(input), key)],
    formatDate: (d, tz, f) => f === 'H' ? String(Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(d))) : d.toLocaleString('en-US', { timeZone: tz }),
    sleep: () => {},
  },
  UrlFetchApp: {
    fetch(url, opt) {
      calls.push(url);
      const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
      if (url === 'https://oauth2.googleapis.com/token') {
        const [h, c, sig] = opt.payload.assertion.split('.');
        const claim = JSON.parse(Buffer.from(c, 'base64url'));
        const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + c), crypto.createPublicKey(privateKey), Buffer.from(sig, 'base64url'));
        assert.ok(ok, 'signed with the key'); assert.strictEqual(claim.scope, 'https://www.googleapis.com/auth/gmail.metadata'); assert.strictEqual(claim.sub, 'juan@twinhomebuyer.com');
        return res(200, { access_token: 'tok' });
      }
      assert.strictEqual(opt.headers.Authorization, 'Bearer tok');
      const u = new URL(url);
      assert.ok(!u.searchParams.has('q'), 'the header-only scope cannot search');
      if (u.pathname.endsWith('/labels')) return res(200, { labels: [{ id: 'Label_1', name: 'No reply needed' }] });
      if (u.pathname.endsWith('/threads')) {
        assert.strictEqual(u.searchParams.get('labelIds'), 'SENT');
        const start = Number(u.searchParams.get('pageToken') || 0);
        const page = order.slice(start, start + 2);
        return res(200, { threads: page.map(id => ({ id, historyId: 'h' + threads[id].length })), nextPageToken: start + 2 < order.length ? String(start + 2) : undefined });
      }
      const m = /\/threads\/(\w+)$/.exec(u.pathname);
      assert.strictEqual(u.searchParams.get('format'), 'metadata');
      return res(200, { id: m[1], messages: threads[m[1]] });
    },
  },
  CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => props[k] ?? null, getProperties: () => ({ ...props }),
    setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  MailApp: { sendEmail: o => sent.push(o) },
};
vm.runInNewContext(src + '\n;this.CONFIG = CONFIG; this.run = run;', ctx);
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) process.exitCode = 1; };

// dry run: logs, sends nothing, records nothing
ctx.run();
check('dry run sends nothing', sent.length === 0 && !Object.keys(props).some(k => k.startsWith('sent:')), ctx.__log.join(' / '));
check('dry run says who it would remind', ctx.__log.some(l => /would email cherry@twinhomebuyer.com: Juan Diaz is waiting for your reply to 2 emails/.test(l)));
check('8 PM in California: Bryan waits for his morning', ctx.__log.some(l => /bryan@twinhomebuyer.com: waiting until 8 AM their time \(America\/Los_Angeles\)/.test(l)), ctx.__log.filter(l => /bryan/.test(l)).join(' / '));

// for real
ctx.CONFIG.DRY_RUN = false;
ctx.run();
check('one reminder, to Cherry only', sent.length === 1 && sent[0].to === 'cherry@twinhomebuyer.com', sent.map(s => s.to).join(','));
check('it carries no subject or content', !/fence|quote/i.test(sent[0].subject + sent[0].body + sent[0].htmlBody), sent[0].subject);
check('links to both emails in her Gmail', (sent[0].body.match(/rfc822msgid%3Am(1|5)%40mail.gmail.com/g) || []).length === 2);
check('remembered what was sent', props['sent:cherry@twinhomebuyer.com|m1@mail.gmail.com'].startsWith('1|') && props['sent:cherry@twinhomebuyer.com|m5@mail.gmail.com'].startsWith('2|'));

// 15 minutes later: nothing new to send, and unchanged threads aren't read again
const before = calls.filter(c => /\/threads\/\w+/.test(c)).length;
now += 15 * 60e3; ctx.run();
check('nothing sent twice', sent.length === 1);
check('unchanged threads not read again', calls.filter(c => /\/threads\/\w+/.test(c)).length === before, before);

// 1 AM in Manila is 10 AM in California: Bryan gets his, Mike waits for the Manila morning
now = Date.UTC(2026, 9, 28, 17, 0);
ctx.run();
const night = sent.slice(1).map(s => s.to);
check('Manila night: only Bryan (10 AM his time)', night.join(',') === 'bryan@twinhomebuyer.com', night.join(','));
check('his email shows California time', /10\/27\/2026, 2:00:00 PM/.test(sent[1].body), sent[1].body.split('\n')[4]);
now = Date.UTC(2026, 9, 29, 0, 30); // 8:30 AM Manila, 5:30 PM California
ctx.run();
const morning = sent.slice(2).map(s => s.to).sort().join(',');
check('Manila morning: Mike, Cherry again, and Bryan\'s 24-hour one', morning === 'bryan@twinhomebuyer.com,cherry@twinhomebuyer.com,mike@twinhomebuyer.com', morning);
console.log(process.exitCode ? 'FAILED' : 'all checks passed');
