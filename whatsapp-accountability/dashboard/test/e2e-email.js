// The Email tab: connecting the reply-reminder sheet, the team view, Reports,
// "Your inbox" from the viewer's own Gmail, and every way a connector can fail.
const { chromium } = require('playwright');
const fs = require('fs');
process.chdir(__dirname);
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 120 * M;
const G1 = '120363000000000001@g.us';
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = { [G1]: { name: 'Ops', participants: [P('1000', 'Seth'), P('1001', 'Juan'), P('1002', 'Mike')], msgs: [
  { id: 'A1', at: t0, sender_id: '1001', kind: 'text', text: 'Everyone confirm you saw the schedule for tomorrow' },
  { id: 'A2', at: t0 + 4 * M, sender_id: '1002', kind: 'text', text: 'Seen' }] } };
const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const mock = `<script>
(function(){
  const Q = new URLSearchParams(location.search);
  const SHEETS = Q.get('sheets') || 'ok', GMAIL = Q.get('gmail') || 'ok', PERM = Q.get('perm') || 'prompt', EDIT = Q.get('edit') !== '0', STALE = Q.get('stale') === '1';
  const GROUPS = ${JSON.stringify(groups)};
  const load = () => { try { return JSON.parse(localStorage.getItem('mockdb') || '{}'); } catch (e) { return {}; } };
  const save = d => localStorage.setItem('mockdb', JSON.stringify(d));
  const subs = [];
  const notify = () => setTimeout(() => subs.forEach(f => f()), 10);
  const snapDoc = path => { const d = load()[path]; return { id: path.split('/').pop(), exists: !!d, data: () => d, metadata: {} }; };
  const db = {
    doc(path) { return {
      get: async () => snapDoc(path),
      set: async data => { const d = load(); d[path] = JSON.parse(JSON.stringify(data)); save(d); notify(); },
      delete: async () => { const d = load(); delete d[path]; save(d); notify(); },
      onSnapshot(next) { const f = () => next(snapDoc(path)); subs.push(f); setTimeout(f, 20); return () => {}; },
    }; },
    collection(path) { return { onSnapshot(next) { const f = () => { const d = load(); const docs = Object.keys(d).filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(k => snapDoc(k)); next({ docs, size: docs.length, empty: !docs.length }); }; subs.push(f); setTimeout(f, 20); return () => {}; } }; },
  };
  const all = Object.values(GROUPS).flatMap(g => g.msgs);
  const reader = {
    status: () => ({ linked: true, connected: true, phone: '1000', messages_stored: all.length, groups_known: 1, last_message_at: Math.max(...all.map(m => m.at)), version: '1.0.3' }),
    list_groups: () => ({ groups: Object.entries(GROUPS).map(([id, g]) => ({ id, name: g.name, members: g.participants.length, message_count: g.msgs.length, last_message_at: Math.max(...g.msgs.map(m => m.at)) })), me: '1000' }),
    get_group: ({ group_id }) => { const g = GROUPS[group_id]; return { id: group_id, name: g.name, me: '1000', participants: g.participants }; },
    get_messages: ({ group_id, since }) => ({ messages: (GROUPS[group_id] || { msgs: [] }).msgs.filter(m => m.at >= (since || 0)), more: false, me: '1000' }),
  };
  const H = 3600e3, now = Date.now(), iso = h => new Date(now - h * H).toISOString();
  const HEAD = ['Thread', 'Subject', 'From', 'From name', 'Sent', 'Person', 'Name', 'On', 'Group', 'Replied', 'Status', 'Reminders', 'Message ID'];
  const row = (t, s, h, p, n, on, g, r, rem, id) => [t, s, 'juan@twinhomebuyer.com', 'Juan Diaz', iso(h), p + '@twinhomebuyer.com', n, on, g ? 'yes' : 'no', r == null ? '' : iso(r), r == null ? 'Waiting' : 'Replied', String(rem), id];
  const LOG = [HEAD,
    row('t1', 'Fence quote', 6, 'cherry', 'Cherry Ann', 'To', true, null, 2, 'a@mail.gmail.com'),
    row('t1', 'Fence quote', 6, 'leo', '', 'CC', true, 5, 0, 'a@mail.gmail.com'),
    row('t1', 'Fence quote', 6, 'tin', 'Tin', 'CC', true, 2, 1, 'a@mail.gmail.com'),
    row('t1', 'Fence quote', 3, 'leo', '', 'To', false, null, 0, 'f@mail.gmail.com'),
    row('t2', 'Permit <img src=x onerror=alert(1)>', 30, 'bryan', 'Bryan', 'To', false, null, 3, 'b@mail.gmail.com'),
    row('t3', 'Lockbox code', 4, 'cherry', '', 'To', false, 3.5, 0, 'c@mail.gmail.com'),
    ['t9', 'Seth Concepcion is waiting for your reply', 'juan@twinhomebuyer.com', 'Reply reminders', iso(20), 'bryan@twinhomebuyer.com', '', 'To', 'no', '', 'Waiting', '3', 'r@m']];
  const STATUS = [['Updated', iso(STALE ? 2 : 0.05)], ['Watching', 'juan@twinhomebuyer.com'], ['Look-back days', '7'], ['Reminders after (minutes)', '240, 1440, 2880'], ['Reminders', 'on']];
  const fail = (code, message) => Promise.reject({ code, message, retryable: false });
  window.__calls = [];
  const mcp = { async callTool(server, tool, input) {
    window.__calls.push({ server, tool, input });
    if (server === 'host:whatsapp-reader') return { content: [], payload: reader[tool](input || {}) };
    if (server === 'Google Sheets') {
      if (SHEETS === 'notconnected') return fail('server_not_connected', 'not connected');
      if (SHEETS === 'denied') return fail('not_in_manifest', 'declined');
      if (SHEETS === 'toolerror') return fail('tool_error', 'The caller does not have permission');
      if (input.spreadsheetId !== '${SHEET}') return fail('tool_error', 'Requested entity was not found.');
      const tab = input.range.split('!')[0];
      return { content: [], payload: { range: input.range, values: tab === 'Emails' ? LOG : STATUS } };
    }
    if (server === 'Gmail') {
      if (GMAIL === 'notconnected') return fail('server_not_connected', 'not connected');
      if (tool === 'search_threads') return { content: [], payload: { threads: [
        { id: 'g1', messages: [{ id: 'x', sender: 'juan@twinhomebuyer.com', subject: 'Re: Fence quote', snippet: 'SECRET CONTENT' }] },
        { id: 'g2', messages: [{ id: 'y', sender: 'juan@twinhomebuyer.com', subject: 'Permit', snippet: 'SECRET CONTENT' }] }] } };
      const m = (sender, h, sent) => ({ sender, internalDate: String(now - h * H), labelIds: sent ? ['SENT'] : ['INBOX'] });
      const T = { g1: [m('juan@twinhomebuyer.com', 6)], g2: [m('juan@twinhomebuyer.com', 30), m('me@twinhomebuyer.com', 29, true)] };
      return { content: [], payload: { id: input.threadId, viewUrl: 'https://mail.google.com/mail/#all/' + input.threadId, messages: T[input.threadId] } };
    }
    return fail('not_in_manifest', 'unknown server');
  } };
  const caps = { db, mcp, sample: null, permissions: { state: async n => n === 'mcp:Google Sheets' ? PERM : 'prompt' },
    user: { canEdit: async () => EDIT, isOwner: async () => EDIT, can: async () => true, id: async () => 'u1', profiles: async () => ({}) } };
  window.claude = { use: async n => { await new Promise(r => setTimeout(r, 30)); return caps[n] ?? null; } };
})();
</script>`;
const html = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${mock}${body}</body></html>`;
fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('shots/e2e-email.html', html);
const url = 'file://' + process.cwd() + '/shots/e2e-email.html';
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const open = async (q, conf, hash, viewport) => {
    const p = await b.newPage({ viewport: viewport || { width: 1360, height: 900 } });
    p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    p.on('dialog', d => { errs.push('dialog: ' + d.message()); d.dismiss(); });
    await p.goto(url + '?' + q);
    await p.evaluate(([g1, conf]) => { localStorage.clear(); const d = { 'settings/tracking': { groups: [{ groupId: g1, groupName: 'Ops', bossIds: ['1001'] }], me: '1000' } }; if (conf) d['settings/email'] = conf; localStorage.setItem('mockdb', JSON.stringify(d)); }, [G1, conf]);
    await p.goto(url + '?' + q + (hash ? '#' + hash : '')); await p.reload(); await p.waitForTimeout(2200);
    return p;
  };
  const sheetCalls = p => p.evaluate(() => window.__calls.filter(c => c.server === 'Google Sheets').length);
  const text = (p, sel) => p.$eval(sel, e => e.innerText);

  // A. an editor connects the sheet
  let p = await open('perm=prompt', null, 'email');
  check('A: Email in the nav', (await p.$$eval('#nav a', a => a.map(x => x.textContent))).some(t => t.startsWith('Email')));
  check('A: setup card with the link box', await p.isVisible('#email-link'));
  check('A: nothing read before a sheet is set', (await sheetCalls(p)) === 0);
  check('A: WhatsApp filters hidden on this tab', await p.$eval('#group-filter', e => e.hidden) && await p.$eval('#refresh', e => e.hidden));
  await p.fill('#email-link', 'not a link'); await p.click('[data-action="email-save-link"]'); await p.waitForTimeout(200);
  check('A: a bad link is refused', (await text(p, '#v-email')).includes('isn’t a Google Sheets link'));
  await p.fill('#email-link', `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`);
  await p.click('[data-action="email-save-link"]'); await p.waitForTimeout(900);
  const conf = await p.evaluate(() => JSON.parse(localStorage.getItem('mockdb'))['settings/email']);
  check('A: link saved as the sheet id', conf && conf.sheetId === SHEET, JSON.stringify(conf));
  check('A: whose emails remembered from the Status tab', conf && JSON.stringify(conf.watch) === '["juan@twinhomebuyer.com"]');
  const tilesT = await p.$$eval('#v-email .tile', t => t.map(x => x.innerText.replace(/\s+/g, ' ')));
  check('A: tiles', tilesT[0].startsWith('3 People who owe a reply') && tilesT[1].startsWith('2 Emails waiting') && /Out of 3 emails/.test(tilesT[1]) && tilesT[3].startsWith('6 Reminders'), tilesT.join(' | '));
  const lrows = () => p.$$eval('#v-email .em-lg .em-gr', r => r.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
  let rows = await lrows();
  check('A: one line per waiting email, longest wait first', rows.length === 2 && rows[0].startsWith('Permit <img src=x') && rows[1].startsWith('Fence quote'), rows.join(' || '));
  check('A: Fence quote: Cherry and Leo waiting, Tin answered', /Cherry 6h/.test(rows[1]) && /Leo 3h/.test(rows[1]) && /Tin 4h/.test(rows[1]) && /2 of 3/.test(rows[1]), rows[1]);
  check('A: old-style reminder emails left out', !(await text(p, '#v-email')).includes('is waiting for your reply'));
  check('A: subjects shown as text, never run', !errs.some(e => e.startsWith('dialog')));
  check('A: Open in Gmail finds the email by its id', (await p.$eval('#v-email .em-lg .em-go', a => a.href)).includes('rfc822msgid%3Ab%40mail.gmail.com'));
  const people = await p.$$eval('#v-email .em-pg .em-gr', r => r.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
  check('A: who owes a reply, longest wait first', people.length === 4 && /^B Bryan 1 1 day 0 of 1 – 3/.test(people[0]) && /^T Tin 0 – 1 of 1 4h 1/.test(people[3]), people.join(' || '));
  // filters
  await p.click('[data-action="email-filter"][data-f="answered"]'); await p.waitForTimeout(150);
  rows = await lrows();
  check('A: Answered shows the fully answered email', rows.length === 1 && rows[0].startsWith('Lockbox code') && /Cherry 30 min/.test(rows[0]), rows.join(' || '));
  await p.click('[data-action="email-filter"][data-f="all"]'); await p.waitForTimeout(150);
  check('A: All shows all three', (await lrows()).length === 3);
  await p.click('[data-action="email-filter"][data-f="waiting"]'); await p.waitForTimeout(150);
  await p.click('.em-pg .em-gr[data-email="leo@twinhomebuyer.com"]'); await p.waitForTimeout(150);
  rows = await lrows();
  check('A: picking Leo shows only his emails', rows.length === 1 && rows[0].startsWith('Fence quote') && await p.isVisible('.em-tools .gchip'), rows.join(' || '));
  check('A: his row is marked', (await p.$eval('.em-pg .em-gr[data-email="leo@twinhomebuyer.com"]', b => b.getAttribute('aria-pressed'))) === 'true');
  await p.click('.em-pg .em-gr[data-email="tin@twinhomebuyer.com"]'); await p.waitForTimeout(150);
  rows = await lrows();
  check('A: someone who owes nothing: their answered emails', rows.length === 1 && rows[0].startsWith('Fence quote') && (await p.$eval('[data-action="email-filter"][aria-pressed="true"]', b => b.dataset.f)) === 'all', rows.join(' || '));
  await p.click('.em-tools .gchip button'); await p.waitForTimeout(150);
  check('A: × shows everyone again', (await lrows()).length === 3 && !(await p.$('.em-tools .gchip')));
  await p.click('[data-action="email-filter"][data-f="waiting"]'); await p.waitForTimeout(150);
  check('A: nav badge counts people who owe a reply', (await p.$eval('#nav a[href="#email"] .count', e => e.textContent)) === '3');
  check('A: header says when the log updated', /Email log · updated/.test(await text(p, '#snap')));
  await p.screenshot({ path: 'shots/email-desktop.png', fullPage: true });
  // Your inbox
  await p.click('[data-action="email-mine"]'); await p.waitForTimeout(700);
  const mine = await text(p, '#v-email');
  check('A: Your inbox lists what waits on me', /Fence quote\s*Juan emailed you 6h ago/.test(mine) && !/Permit\s*Juan emailed you/.test(mine), mine.slice(mine.indexOf('Your inbox'), mine.indexOf('Your inbox') + 200));
  check('A: no email content on the page', !(await p.$eval('#v-email', e => e.innerHTML)).includes('SECRET'));
  const g = await p.evaluate(() => window.__calls.filter(c => c.server === 'Gmail'));
  check('A: Gmail asked for headers only', g[0].input.query === 'from:juan@twinhomebuyer.com newer_than:7d' && g.slice(1).every(c => c.input.messageFormat === 'METADATA_ONLY'), JSON.stringify(g[0].input));
  // Reports
  await p.evaluate(() => { location.hash = 'reports'; }); await p.waitForTimeout(400);
  const bars = await p.$$eval('#v-reports .em-report .bar-row', r => r.map(x => x.innerText.replace(/\s+/g, ' ')));
  check('A: Reports shows email reply time', bars.length === 3 && bars[0].startsWith('T Tin'), bars.join(' | '));
  await p.close();

  // phone width
  p = await open('perm=granted', { sheetId: SHEET, watch: ['juan@twinhomebuyer.com'] }, 'email', { width: 390, height: 844 });
  const wide = await p.evaluate(() => document.documentElement.scrollWidth);
  check('phone: no sideways scroll', wide <= 390, wide);
  await p.screenshot({ path: 'shots/email-phone.png', fullPage: true });
  await p.close();

  // B. a viewer who already allowed Google Sheets: Reports fills in without opening the tab
  p = await open('perm=granted&edit=0', { sheetId: SHEET, watch: ['juan@twinhomebuyer.com'] }, 'reports');
  check('B: loads by itself once allowed', (await sheetCalls(p)) >= 1 && (await p.$$('#v-reports .em-report .bar-row')).length === 3);
  check('B: a viewer doesn’t rewrite settings', await p.evaluate(() => !JSON.parse(localStorage.getItem('mockdb'))['settings/email'].savedAt));
  await p.close();

  // C. not allowed yet: nothing asked until the Email tab is opened
  p = await open('perm=prompt', { sheetId: SHEET, watch: ['juan@twinhomebuyer.com'] }, 'reports');
  check('C: no Sheets call on Reports', (await sheetCalls(p)) === 0);
  check('C: Reports points to the Email tab', (await text(p, '#v-reports')).includes('Open the Email tab to load email reply times'));
  await p.click('#nav a[href="#email"]'); await p.waitForTimeout(600);
  check('C: opening the tab loads it', (await sheetCalls(p)) >= 1 && (await p.$$('#v-email .tile')).length === 4);
  await p.close();

  // D-E. Google Sheets failures, each with its own fix
  p = await open('sheets=notconnected', { sheetId: SHEET, watch: ['juan@twinhomebuyer.com'] }, 'email');
  let t = await text(p, '#v-email');
  check('D: not connected says where to add it', t.includes('Google Sheets isn’t connected') && t.includes('Settings → Connectors') && await p.isVisible('[data-action="email-retry"]'), t.slice(0, 160));
  check('D: Your inbox still offered', t.includes('Your inbox'));
  await p.close();
  p = await open('sheets=denied', { sheetId: SHEET, watch: ['juan@twinhomebuyer.com'] }, 'email');
  check('D: declined says to allow it', (await text(p, '#v-email')).includes('wasn’t allowed for this page'));
  await p.close();
  p = await open('sheets=toolerror', { sheetId: SHEET, watch: ['juan@twinhomebuyer.com'] }, 'email');
  t = await text(p, '#v-email');
  check('E: no access names the cause and who to ask', t.includes('The caller does not have permission') && t.includes('isn’t shared with you'), t.slice(0, 200));
  await p.close();

  // F. the script stopped
  p = await open('stale=1', { sheetId: SHEET, watch: ['juan@twinhomebuyer.com'] }, 'email');
  check('F: stale log flagged', (await text(p, '#v-email')).includes('may have stopped'));
  await p.close();

  // G. a viewer, nothing set up
  p = await open('edit=0', null, 'email');
  t = await text(p, '#v-email');
  check('G: viewer sees “not set up”, no link box', t.includes('Not set up yet') && !(await p.$('#email-link')));
  await p.close();

  // H. Gmail not connected
  p = await open('perm=granted&gmail=notconnected', { sheetId: SHEET, watch: ['juan@twinhomebuyer.com'] }, 'email');
  await p.click('[data-action="email-mine"]'); await p.waitForTimeout(400);
  check('H: Gmail not connected says where to add it', (await text(p, '#v-email')).includes('Gmail isn’t connected'));
  // WhatsApp views still fine
  await p.evaluate(() => { location.hash = 'dashboard'; }); await p.waitForTimeout(300);
  check('H: back on the Dashboard the group pill returns', !(await p.$eval('#group-pill', e => e.hidden)));
  await p.close();

  check('no page errors', !errs.length, errs.join(' || '));
  console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
  await b.close(); process.exit(fails.length ? 1 : 0);
})();
