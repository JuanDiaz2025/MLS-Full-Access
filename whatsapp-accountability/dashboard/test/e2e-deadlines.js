// The Deadlines tab: the deadline agent's Assignments and Misses tabs, read
// through the viewer's Google Sheets connection, the Pause switch, and the
// ways the sheet can be missing or unreadable.
const { chromium } = require('playwright');
const fs = require('fs');
process.chdir(__dirname);
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 120 * M;
const G1 = '120363000000000001@g.us';
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = { [G1]: { name: 'Ops', participants: [P('1000', 'Seth'), P('1001', 'Juan')], msgs: [{ id: 'A1', at: t0, sender_id: '1001', kind: 'text', text: 'Everyone confirm the schedule' }] } };
const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const mock = `<script>
(function(){
  const Q = new URLSearchParams(location.search);
  const GROUPS = ${JSON.stringify(groups)};
  const load = () => { try { return JSON.parse(localStorage.getItem('mockdb') || '{}'); } catch (e) { return {}; } };
  const save = d => localStorage.setItem('mockdb', JSON.stringify(d));
  const subs = [];
  const notify = () => setTimeout(() => subs.forEach(f => f()), 10);
  const snapDoc = path => { const d = load()[path]; return { id: path.split('/').pop(), exists: !!d, data: () => d, metadata: {} }; };
  const db = {
    doc(path) { return { get: async () => snapDoc(path), set: async data => { const d = load(); d[path] = JSON.parse(JSON.stringify(data)); save(d); notify(); },
      delete: async () => { const d = load(); delete d[path]; save(d); notify(); }, onSnapshot(next) { const f = () => next(snapDoc(path)); subs.push(f); setTimeout(f, 20); return () => {}; } }; },
    collection(path) { return { onSnapshot(next) { const f = () => { const d = load(); const docs = Object.keys(d).filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(k => snapDoc(k)); next({ docs, size: docs.length, empty: !docs.length }); }; subs.push(f); setTimeout(f, 20); return () => {}; } }; },
  };
  const all = Object.values(GROUPS).flatMap(g => g.msgs);
  const reader = {
    status: () => ({ linked: true, connected: true, phone: '1000', messages_stored: all.length, groups_known: 1, last_message_at: Math.max(...all.map(m => m.at)), version: '1.0.3' }),
    list_groups: () => ({ groups: Object.entries(GROUPS).map(([id, g]) => ({ id, name: g.name, members: g.participants.length, message_count: g.msgs.length, last_message_at: Math.max(...g.msgs.map(m => m.at)) })), me: '1000' }),
    get_group: ({ group_id }) => { const g = GROUPS[group_id]; return { id: group_id, name: g.name, me: '1000', participants: g.participants }; },
    get_messages: ({ group_id, since }) => ({ messages: (GROUPS[group_id] || { msgs: [] }).msgs.filter(m => m.at >= (since || 0)), more: false, me: '1000' }),
  };
  const H = 3600e3, now = Date.now(), iso = h => (h == null ? '' : new Date(now - h * H).toISOString());
  const HEAD = ['Assigned', 'Subject', 'Owner', 'Owner name', 'Due', 'Status', 'Delivered', 'Chased', 'Note', 'Thread', 'Link'];
  const row = (subject, owner, name, dueH, status, delivH, chasedH, note, link) => [iso(dueH + 2), subject, owner + '@twinhomebuyer.com', name, iso(dueH), status, iso(delivH), iso(chasedH), note || '', 't', link == null ? 'https://mail.google.com/mail/#search/rfc822msgid%3A' + encodeURIComponent(subject + '@mail.gmail.com') : link];
  const ASSIGN = [HEAD,
    row('Fence quote', 'bryan', 'Bryan Cadahing', 2, 'missed', null, 1.8),
    row('Re: Lockbox <img src=x onerror=alert(1)>', 'bryan', 'Bryan Cadahing', 30, 'missed', null, 29),
    row('Permit', 'lawrence', 'Lawrence Oliveros', -3, 'blocked'),
    row('Comps', 'cherry', 'Cherry Ann', -1, 'open', null, null, '', 'javascript:alert(1)'),
    row('Relay', 'lawrence', 'Lawrence Oliveros', 0.5, 'delivered', 0.6),
    row('AmEx', 'bryan', 'Bryan Cadahing', 0.2, 'delivered', 0.1, null, 'late')];
  const MH = ['Missed on', 'Owner', 'Owner name', 'Subject', 'Deadline', 'Chased', 'Thread'];
  const MISSES = [MH, ['d', 'bryan@twinhomebuyer.com', 'Bryan Cadahing', 'x', iso(2), '', 't'], ['d', 'bryan@twinhomebuyer.com', 'Bryan Cadahing', 'x', iso(30), '', 't'], ['d', 'bryan@twinhomebuyer.com', 'Bryan Cadahing', 'x', iso(24 * 5), '', 't']];
  const fail = (code, message) => Promise.reject({ code, message, retryable: false });
  window.__calls = [];
  const TABS = window.__tabs = { Stopped: [['Thread', 'Person', 'Subject', 'Stopped by', 'Stopped at']], Pause: [['Paused', 'By', 'At'], ['no', '', '']], Assignments: ASSIGN, Misses: MISSES,
    Emails: [['Thread', 'Subject', 'From', 'From name', 'Sent', 'Person', 'Name', 'On', 'Group', 'Replied', 'Status', 'Reminders', 'Message ID']], Status: [['Updated', iso(0.05)]] };
  const rowsOf = range => { const m = /!A(\\d+):[A-Z](\\d+)/.exec(range); return m ? [Number(m[1]), Number(m[2])] : [1, 1]; };
  const mcp = { async callTool(server, tool, input) {
    window.__calls.push({ server, tool, input });
    if (server === 'host:whatsapp-reader') return { content: [], payload: reader[tool](input || {}) };
    if (server === 'Google Sheets') {
      if (Q.get('sheets') === 'denied') return fail('not_in_manifest', 'declined');
      const tab = input.range.split('!')[0];
      if (Q.get('noagent') === '1' && (tab === 'Assignments' || tab === 'Misses')) return fail('tool_error', 'Unable to parse range: ' + input.range);
      if (tool === 'get_values') { const [a, b] = rowsOf(input.range); return { content: [], payload: { range: input.range, values: TABS[tab].slice(a - 1, b) } }; }
      if (tool === 'update_values') { const [a] = rowsOf(input.range); TABS[tab][a - 1] = input.values[0]; return { content: [], payload: { updatedRows: 1 } }; }
      if (tool === 'append_values') { TABS[tab].push(input.values[0]); return { content: [], payload: {} }; }
    }
    return fail('not_in_manifest', 'unknown');
  } };
  const caps = { db, mcp, sample: null, permissions: { state: async n => n === 'mcp:Google Sheets' ? (Q.get('perm') || 'prompt') : 'prompt' },
    user: { canEdit: async () => Q.get('edit') !== '0', isOwner: async () => true, can: async () => true, id: async () => 'u1', me: async () => ({ id: 'u1', name: 'Seth Concepcion' }), profiles: async () => ({}) } };
  window.claude = { use: async n => { await new Promise(r => setTimeout(r, 30)); return caps[n] ?? null; } };
})();
</script>`;
const html = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>${mock}${body}</body></html>`;
fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('shots/e2e-deadlines.html', html);
const url = 'file://' + process.cwd() + '/shots/e2e-deadlines.html';
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const open = async (q, withSheet, hash, viewport) => {
    const p = await b.newPage({ viewport: viewport || { width: 1360, height: 900 } });
    p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    p.on('dialog', d => { errs.push('dialog: ' + d.message()); d.dismiss(); });
    await p.goto(url + '?' + q);
    await p.evaluate(([g1, sheet, withSheet]) => { localStorage.clear(); const d = { 'settings/tracking': { groups: [{ groupId: g1, groupName: 'Ops', bossIds: ['1001'] }], me: '1000' } };
      if (withSheet) d['settings/email'] = { sheetId: sheet, watch: ['juan@twinhomebuyer.com'] }; localStorage.setItem('mockdb', JSON.stringify(d)); }, [G1, SHEET, withSheet]);
    await p.goto(url + '?' + q + (hash ? '#' + hash : '')); await p.reload(); await p.waitForTimeout(2200);
    return p;
  };
  const text = (p, sel) => p.$eval(sel, e => e.innerText);
  const lrows = p => p.$$eval('#v-deadlines .dl-lg .em-gr', r => r.map(x => x.innerText.replace(/\s+/g, ' ').trim()));

  // A. the tab, read from the sheet
  let p = await open('perm=prompt', true, 'deadlines');
  check('A: Deadlines in the nav, after Email', (await p.$$eval('#nav a', a => a.map(x => x.getAttribute('href')))).join() === '#dashboard,#messages,#tasks,#reports,#email,#deadlines');
  const tilesT = await p.$$eval('#v-deadlines .tile', t => t.map(x => x.innerText.replace(/\s+/g, ' ')));
  check('A: tiles: 2 overdue, 1 blocked, 1 open, 2 delivered today (1 late)', tilesT[0].startsWith('2 Overdue') && tilesT[1].startsWith('1 Blocked') && tilesT[2].startsWith('1 Open') && tilesT[3].startsWith('2 Delivered today') && /1 of them late/.test(tilesT[3]), tilesT.join(' | '));
  let rows = await lrows(p);
  check('A: opens on Overdue, oldest deadline first', rows.length === 2 && rows[0].startsWith('Lockbox <img src=x') && /Missed chased/.test(rows[0]) && rows[1].startsWith('Fence quote'), rows.join(' || '));
  check('A: subjects shown as text, never run', !errs.some(e => e.startsWith('dialog')) && !(await p.$('#v-deadlines img')));
  check('A: Open in Gmail goes to the email', (await p.$eval('#v-deadlines .dl-lg a.em-go', a => a.href)).startsWith('https://mail.google.com/mail/#search/rfc822msgid%3A'));
  const people = await p.$$eval('#v-deadlines .dl-pg .em-gr', r => r.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
  check('A: by person, most overdue first; Bryan flagged at 3 misses in 30 days', people.length === 3 && /^B Bryan Cadahing 2 – – 1 \(1 late\) 3/.test(people[0]) && /3\+ misses in 30 days/.test(await text(p, '#v-deadlines')), people.join(' || '));
  await p.click('[data-action="dl-filter"][data-f="all"]'); await p.waitForTimeout(150);
  rows = await lrows(p);
  check('A: All: overdue, blocked, open, then delivered', rows.length === 6 && rows[2].startsWith('Permit') && rows[3].startsWith('Comps') && /Open due in/.test(rows[3]) && rows[4].startsWith('AmEx') && /Delivered late/.test(rows[4]) && rows[5].startsWith('Relay'), rows.join(' || '));
  check('A: times in Pacific, wherever the viewer is', rows.every(r => / PT/.test(r)), rows[0]);
  check('A: a link that isn’t Gmail is dropped', !(await p.$$eval('#v-deadlines .dl-lg .em-gr', r => r.some(x => x.innerText.includes('Comps') && x.querySelector('a.em-go')))));
  await p.click('.dl-pg .em-gr[data-email="lawrence@twinhomebuyer.com"]'); await p.waitForTimeout(150);
  rows = await lrows(p);
  check('A: picking Lawrence shows only his', rows.length === 2 && rows.every(r => /Lawrence/.test(r)) && await p.isVisible('#v-deadlines .em-tools .gchip'), rows.join(' || '));
  await p.click('#v-deadlines .em-tools .gchip button'); await p.waitForTimeout(150);
  check('A: × shows everyone again', (await lrows(p)).length === 6);
  check('A: nav badge counts overdue', (await p.$eval('#nav a[href="#deadlines"] .count', e => e.textContent)) === '2');
  check('A: header pill and no WhatsApp filters', /Deadline log · read/.test(await text(p, '#snap')) && await p.$eval('#group-filter', e => e.hidden));
  check('A: chases are on', /Chases are on/.test(await text(p, '#v-deadlines .em-bar')));
  await p.screenshot({ path: 'shots/deadlines-desktop.png', fullPage: true });
  // Pause, shared with the reply reminders
  await p.click('#v-deadlines [data-action="email-pause"][data-on="1"]'); await p.waitForTimeout(500);
  const pause = await p.evaluate(() => window.__tabs.Pause[1]);
  check('A: Pause chases writes the Pause tab, with who', pause[0] === 'yes' && pause[1] === 'Seth Concepcion', JSON.stringify(pause));
  check('A: the bar says paused', /Chases are paused by Seth Concepcion/.test(await text(p, '#v-deadlines .em-bar')));
  await p.click('#v-deadlines [data-action="email-pause"][data-on="0"]'); await p.waitForTimeout(500);
  check('A: turned back on', (await p.evaluate(() => window.__tabs.Pause[1][0])) === 'no');
  // only reads: nothing else written
  check('A: only the Pause tab was written', (await p.evaluate(() => window.__calls.filter(c => c.server === 'Google Sheets' && c.tool !== 'get_values').every(c => c.input.range.startsWith('Pause!')))));
  await p.close();

  // B. phone width
  p = await open('perm=prompt', true, 'deadlines', { width: 390, height: 844 });
  check('B: phone: no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), await p.evaluate(() => document.documentElement.scrollWidth));
  check('B: phone: person and due on the line under the task', /Bryan · due/.test((await lrows(p))[0]), (await lrows(p))[0]);
  await p.screenshot({ path: 'shots/deadlines-phone.png', fullPage: true });
  await p.close();

  // C. the agent hasn't written its log yet
  p = await open('perm=prompt&noagent=1', true, 'deadlines');
  check('C: says the agent hasn’t written its log', /hasn’t written its log yet/.test(await text(p, '#v-deadlines')));
  await p.close();

  // D. no sheet connected
  p = await open('perm=prompt', false, 'deadlines');
  check('D: points to the Email tab', /Connect it on the Email tab/.test(await text(p, '#v-deadlines')) && (await p.evaluate(() => window.__calls.filter(c => c.server === 'Google Sheets').length)) === 0);
  await p.close();

  // E. allowed before: the badge loads on the dashboard; not allowed: nothing is read until the tab opens
  p = await open('perm=granted', true, 'dashboard');
  check('E: allowed: the overdue badge shows from the Dashboard', (await p.$eval('#nav a[href="#deadlines"]', a => a.innerText)).includes('2'));
  await p.close();
  p = await open('perm=prompt', true, 'dashboard');
  check('E: not allowed yet: no sheet read on the Dashboard', (await p.evaluate(() => window.__calls.filter(c => c.server === 'Google Sheets').length)) === 0);
  await p.close();

  // F. the connection refused
  p = await open('perm=prompt&sheets=denied', true, 'deadlines');
  check('F: refused: says how to allow it', /wasn’t allowed for this page/.test(await text(p, '#v-deadlines')));
  await p.close();

  check('no page errors', !errs.length, errs.join(' | '));
  await b.close();
  console.log(fails.length ? `FAILED: ${fails.length}` : 'all checks passed');
  process.exitCode = fails.length ? 1 : 0;
})();
