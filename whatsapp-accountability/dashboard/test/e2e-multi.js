const { chromium } = require('playwright');
const fs = require('fs');
const { compactMessage, dayKey, ANALYSIS_VERSION } = require('../live.js');
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 120 * M;
const G1 = '120363000000000001@g.us', G2 = '120363000000000002@g.us';
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = {
  [G1]: { name: 'Ops', participants: [P('1000', 'Seth'), P('1001', 'Juan'), P('1002', 'Mike'), P('1003', '1003')], msgs: [
    { id: 'A1', at: t0, sender_id: '1001', kind: 'text', text: 'Everyone confirm you saw the schedule for tomorrow' },
    { id: 'A2', at: t0 + 4 * M, sender_id: '1002', kind: 'text', text: 'Seen' },
    { id: 'A3', at: t0 + 10 * M, sender_id: '1001', kind: 'text', text: '@1002 send photos of site A by 5pm', mentions: ['1002'] },
    { id: 'A4', at: t0 + 40 * M, sender_id: '1002', kind: 'image', text: 'site A', quoted_id: 'A3' },
  ] },
  [G2]: { name: 'Sites', participants: [P('1000', 'Seth'), P('2001', 'Cherry'), P('1002', 'Mike'), P('1004', 'Rosa')], msgs: [
    { id: 'B1', at: t0 + 20 * M, sender_id: '2001', kind: 'text', text: 'Everyone confirm the delivery window for 3pm' },
    { id: 'B2', at: t0 + 25 * M, sender_id: '1004', kind: 'text', text: 'Confirmed' },
    { id: 'B3', at: t0 + 70 * M, sender_id: '2001', kind: 'text', text: 'Who can cover Saturday?' },
  ] },
};
// what the page saved before multi-group tracking: one group, Ops
const legacy = {};
legacy['settings/source'] = { groupId: G1, groupName: 'Ops', bossIds: ['1000', '1001'], me: '1000', savedAt: t0 };
legacy['sync/meta'] = { group: { id: G1, name: 'Ops' }, participants: groups[G1].participants, members: {}, names: {}, bossIds: ['1000', '1001'], me: '1000', syncedAt: t0 + 50 * M, messageCount: 4 };
const byDay = {};
groups[G1].msgs.map(compactMessage).forEach(m => (byDay[dayKey(m.t)] ||= []).push(m));
Object.entries(byDay).forEach(([d, list]) => { legacy['sync/meta/days/' + d] = { day: d, messages: list }; });
legacy['sync/analysis'] = { byId: {
  A1: { title: 'Confirm the schedule', type: 'Instruction', needs_reply: true, required: 'all', priority: 'Normal', task: null, follow_up_of: null, by: 'claude', v: ANALYSIS_VERSION },
  A3: { title: 'Site A photos', type: 'Instruction', needs_reply: true, required: ['1002'], priority: 'High', task: { title: 'Send site A photos', owner_id: '1002', due: null }, follow_up_of: null, by: 'claude', v: ANALYSIS_VERSION },
} };

const mock = `<script>
(function(){
  const MODE = new URLSearchParams(location.search).get('mode');
  const GROUPS = ${JSON.stringify(groups)};
  const load = () => { try { return JSON.parse(localStorage.getItem('mockdb') || '{}'); } catch (e) { return {}; } };
  const save = d => localStorage.setItem('mockdb', JSON.stringify(d));
  const subs = [];
  const notify = () => setTimeout(() => subs.forEach(f => f()), 10);
  const snapDoc = (path) => { const d = load()[path]; return { id: path.split('/').pop(), exists: !!d, data: () => d, metadata: {} }; };
  const check = path => { if (!/^[A-Za-z0-9_.@+:~\\/-]+$/.test(path)) throw new TypeError('bad path ' + path); };
  const db = {
    doc(path) { check(path); if (path.split('/').length % 2) throw new TypeError('doc parity ' + path); return {
      get: async () => snapDoc(path),
      set: async (data) => { if (MODE !== 'laptop') throw { code: 'invalid_argument' }; const d = load(); d[path] = JSON.parse(JSON.stringify(data)); save(d); notify(); },
      delete: async () => { if (MODE !== 'laptop') throw { code: 'invalid_argument' }; const d = load(); delete d[path]; save(d); notify(); },
      onSnapshot(next) { const f = () => next(snapDoc(path)); subs.push(f); setTimeout(f, 20); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; },
    }; },
    collection(path) { check(path); if (!(path.split('/').length % 2)) throw new TypeError('coll parity ' + path); return { onSnapshot(next) { const f = () => { const d = load(); const docs = Object.keys(d).filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(k => snapDoc(k)); next({ docs, size: docs.length, empty: !docs.length }); }; subs.push(f); setTimeout(f, 20); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; } }; },
  };
  const all = Object.values(GROUPS).flatMap(g => g.msgs);
  const reader = {
    status: () => ({ linked: true, connected: true, phone: '1000', messages_stored: all.length, groups_known: 3, last_message_at: Math.max(...all.map(m => m.at)), version: '1.0.1' }),
    list_groups: () => ({ groups: Object.entries(GROUPS).map(([id, g]) => ({ id, name: g.name, members: g.participants.length, message_count: g.msgs.length, last_message_at: Math.max(...g.msgs.map(m => m.at)) }))
      .concat({ id: '120363000000000009@g.us', name: 'Family', members: 6, message_count: 40, last_message_at: 1 }), me: '1000' }),
    get_group: ({ group_id }) => { const g = GROUPS[group_id]; if (!g) throw { code: 'tool_error', message: 'unknown group' }; return { id: group_id, name: g.name, me: '1000', participants: g.participants }; },
    get_messages: ({ group_id, since }) => ({ messages: (GROUPS[group_id] || { msgs: [] }).msgs.filter(m => m.at >= (since || 0)), more: false, me: '1000' }),
  };
  window.__calls = [];
  const mcp = {
    async callTool(server, tool, input) {
      window.__calls.push(tool + ':' + ((input || {}).group_id || ''));
      if (MODE !== 'laptop') throw { code: 'server_not_connected', message: 'no host' };
      return { content: [], payload: reader[tool](input || {}) };
    },
  };
  window.__samples = 0;
  const sample = async () => ({ text: '' });
  sample.json = async (prompt) => {
    window.__samples++;
    const arr = JSON.parse(prompt.slice(prompt.lastIndexOf('[{')));
    (window.__asked ||= []).push(...arr.map(m => m.id));
    return { results: arr.map(m => ({ id: m.id, title: m.text.split(' ').slice(0, 4).join(' '), type: m.text.includes('?') ? 'Question' : 'Instruction', needs_reply: true, required: 'all', priority: 'Normal', task: null, follow_up_of: null })) };
  };
  const caps = { db, mcp: MODE === 'nomcp' ? null : mcp, sample, user: { canEdit: async () => MODE === 'laptop', isOwner: async () => MODE === 'laptop' } };
  window.claude = { use: async (n) => { await new Promise(r => setTimeout(r, 30)); return caps[n] ?? null; } };
})();
</script>`;
const html = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${mock}${body}</body></html>`;
process.chdir(__dirname); fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('shots/e2e-multi.html', html);
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const rows = (p, sel) => p.$$eval(sel, rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()));
const card = (p, view, h) => p.$$eval(`#${view} .card`, (cs, h) => { const c = cs.find(c => (c.querySelector('h2') || {}).textContent === h); return c ? [...c.querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim()) : ['(no card)']; }, h);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const url = 'file://' + process.cwd() + '/shots/e2e-multi.html';
  await p.goto(url + '?mode=viewer');
  await p.evaluate(d => { localStorage.clear(); localStorage.setItem('mockdb', JSON.stringify(d)); }, legacy);

  // 1. another device, before the laptop has run the new page: old copy still shows
  await p.reload(); await p.waitForTimeout(900);
  console.log('1 viewer on old copy:', await text(p, '#snap'), '|', await text(p, '#brand-sub'), '| unresolved:', (await card(p, 'v-dashboard', 'Unresolved messages')).join(' || '));

  // 2. the laptop opens the new page: the old copy moves to the new layout
  await p.goto(url + '?mode=laptop'); await p.waitForTimeout(2500);
  let keys = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('mockdb'))).sort());
  console.log('2 laptop:', await text(p, '#snap'), '| title:', await text(p, '#v-title'), '| claude calls:', await p.evaluate(() => window.__samples));
  console.log('2 stored:', keys.join(', '));

  // 3. add a second group
  await p.click('#change-group'); await p.waitForTimeout(500);
  console.log('3 setup:', await text(p, '#v-title'), '| tracked:', (await rows(p, '.tracked')).join(' || '));
  console.log('3 can add:', (await p.$$eval('input[name="setup-group"]', xs => xs.map(x => x.value))).join(', '));
  await p.check(`input[name="setup-group"][value="${G2}"]`); await p.waitForTimeout(500);
  console.log('3 givers preset (this phone):', await p.isChecked('input[name="setup-boss"][value="1000"]'));
  await p.check('input[name="setup-boss"][value="2001"]');
  await p.fill('input[data-name-for="1004"]', 'Rosa Reyes');
  await p.screenshot({ path: 'shots/multi-add.png', fullPage: true });
  await p.click('[data-action="add-group"]'); await p.waitForTimeout(2500);
  console.log('3 after add:', await text(p, '#v-title'), '| brand:', await text(p, '#brand-sub'));
  console.log('3 group options:', (await p.$$eval('#group-filter option', o => o.map(x => x.textContent))).join(' / '), '| from:', (await p.$$eval('#sender-filter option', o => o.map(x => x.textContent))).join(' / '));
  const unresolved = async () => (await card(p, 'v-dashboard', 'Unresolved messages')).concat(['PEOPLE:'], await card(p, 'v-dashboard', 'People who haven’t replied'));
  console.log('3 All unresolved:', (await unresolved()).join(' || '));
  await p.screenshot({ path: 'shots/multi-all.png', fullPage: true });

  // 4. filters
  await p.selectOption('#sender-filter', '2001'); await p.waitForTimeout(300);
  console.log('4 From Cherry:', (await unresolved()).join(' || '));
  await p.selectOption('#sender-filter', 'all');
  await p.selectOption('#group-filter', G1); await p.waitForTimeout(300);
  console.log('4 Ops only: brand', await text(p, '#brand-sub'), '| from options:', (await p.$$eval('#sender-filter option', o => o.map(x => x.textContent))).join(' / '), '| hidden:', await p.$eval('#sender-filter', e => e.hidden));
  console.log('4 Ops unresolved:', (await unresolved()).join(' || '));
  await p.selectOption('#group-filter', 'all');
  await p.goto(url + '?mode=laptop#reports'); await p.reload(); await p.waitForTimeout(2500);
  console.log('5 reports people (response time):', (await p.$$eval('#v-reports .bar-row .who', xs => xs.map(x => x.textContent.trim()))).join(', '));
  await p.screenshot({ path: 'shots/multi-reports.png', fullPage: true });
  await p.goto(url + '?mode=laptop#messages'); await p.reload(); await p.waitForTimeout(2500);
  console.log('5 messages list:', (await p.$$eval('#mlist .mitem', xs => xs.map(x => x.innerText.replace(/\s+/g, ' ').trim()))).join(' || '));
  await p.screenshot({ path: 'shots/multi-messages.png', fullPage: true });
  console.log('5 claude calls this load:', await p.evaluate(() => window.__samples));

  // 6. edit Ops: name the unnamed member
  await p.click('#change-group'); await p.waitForTimeout(600);
  await p.click(`[data-action="edit-group"][data-gid="${G1}"]`); await p.waitForTimeout(600);
  await p.fill('input[data-name-for="1003"]', 'Ana Cruz');
  await p.click('[data-action="save-group"]'); await p.waitForTimeout(1500);
  console.log('6 tracked after edit:', (await rows(p, '.tracked')).join(' || '));
  await p.click('[data-action="done-setup"]'); await p.waitForTimeout(300);
  await p.goto(url + '?mode=laptop#dashboard'); await p.waitForTimeout(300);
  console.log('6 dashboard names:', (await unresolved()).join(' || '));

  // 7. another device sees both groups
  const q = await ctx.newPage(); q.on('pageerror', e => errs.push(String(e)));
  await q.goto(url + '?mode=viewer'); await q.waitForTimeout(1200);
  console.log('7 viewer:', await text(q, '#snap'), '| groups:', (await q.$$eval('#group-filter option', o => o.map(x => x.textContent))).join(' / '), '| unresolved:', (await card(q, 'v-dashboard', 'Unresolved messages')).join(' || '));
  await q.close();

  // 8. stop tracking Sites
  await p.click('#change-group'); await p.waitForTimeout(600);
  await p.click(`[data-action="remove-group"][data-gid="${G2}"]`); await p.waitForTimeout(200);
  console.log('8 confirm label:', await text(p, `[data-action="remove-group"][data-gid="${G2}"]`));
  await p.click(`[data-action="remove-group"][data-gid="${G2}"]`); await p.waitForTimeout(1500);
  keys = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('mockdb'))).sort());
  console.log('8 stored:', keys.join(', '));
  await p.click('[data-action="done-setup"]'); await p.waitForTimeout(300);
  console.log('8 after stop:', await text(p, '#brand-sub'), '| group select hidden:', await p.$eval('#group-filter', e => e.hidden), '| pill:', await text(p, '#group-pill'));
  console.log('errors:', errs);
  await b.close();
})();
