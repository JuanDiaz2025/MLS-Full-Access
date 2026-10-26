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
    { id: 'A5', at: t0 + 12 * M, sender_id: '1003', kind: 'text', text: 'ok noted', quoted_id: 'A3' },
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
  const GROUPS = ${JSON.stringify(groups)}; window.__GROUPS = GROUPS;
  const load = () => { try { return JSON.parse(localStorage.getItem('mockdb') || '{}'); } catch (e) { return {}; } };
  const save = d => localStorage.setItem('mockdb', JSON.stringify(d));
  const subs = [];
  const notify = () => setTimeout(() => subs.forEach(f => f()), 10);
  const snapDoc = (path) => { const d = load()[path]; return { id: path.split('/').pop(), exists: !!d, data: () => d, metadata: {} }; };
  const check = path => { if (!/^[A-Za-z0-9_.@+:~\\/-]+$/.test(path)) throw new TypeError('bad path ' + path); };
  const db = {
    doc(path) { check(path); if (path.split('/').length % 2) throw new TypeError('doc parity ' + path); return {
      get: async () => snapDoc(path),
      set: async (data) => { if (MODE !== 'laptop' && !(MODE === 'member' && path.startsWith('fixes/'))) throw { code: 'invalid_argument' }; const d = load(); d[path] = JSON.parse(JSON.stringify(data)); save(d); notify(); },
      delete: async () => { if (MODE !== 'laptop' && !(MODE === 'member' && path.startsWith('fixes/'))) throw { code: 'invalid_argument' }; const d = load(); delete d[path]; save(d); notify(); },
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
  const caps = { db, mcp: MODE === 'nomcp' ? null : mcp, sample, user: { canEdit: async () => MODE === 'laptop', isOwner: async () => MODE === 'laptop', can: async () => MODE !== 'viewer', id: async () => 'u_' + MODE,
    profiles: async ids => Object.fromEntries([].concat(ids).map(id => [id, { id, name: { u_member: 'Lawrence', u_laptop: 'Seth' }[id] || '' }])) } };
  window.claude = { use: async (n) => { await new Promise(r => setTimeout(r, 30)); return caps[n] ?? null; } };
})();
</script>`;
const html = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${mock}${body}</body></html>`;
process.chdir(__dirname); fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('shots/e2e-delete.html', html);
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  const watch = p => { p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); return p; };
  const url = 'file://' + process.cwd() + '/shots/e2e-delete.html';
  const p = watch(await ctx.newPage());
  await p.goto(url + '?mode=laptop');
  await p.evaluate(([g1, g2]) => { localStorage.clear(); localStorage.setItem('mockdb', JSON.stringify({ 'settings/tracking': { groups: [
    { groupId: g1, groupName: 'Ops', bossIds: ['1000', '1001'] }, { groupId: g2, groupName: 'Sites', bossIds: ['1000', '2001'] }], me: '1000' } })); }, [G1, G2]);
  await p.goto(url + '?mode=laptop#messages'); await p.reload(); await p.waitForTimeout(2500);
  const list = () => p.$$eval('#mlist .mitem .m-t', xs => xs.map(x => x.textContent).join(' | '));
  const unresolved = async () => { await p.goto(url + '?mode=laptop#dashboard'); await p.waitForTimeout(150); const n = await p.$eval('.tile .t-num', e => e.textContent).catch(() => '?'); await p.goto(url + '?mode=laptop#messages'); await p.waitForTimeout(150); return n; };
  console.log('1 list:', await list(), '| hint:', await text(p, '#v-messages .card-h .hint'), '| no-response tile:', await unresolved());
  await p.click('[data-sel="A1"]'); await p.waitForTimeout(150);
  await p.click('[data-action="delete-msg"]'); await p.waitForTimeout(150);
  console.log('2 first click:', await text(p, '[data-action="delete-msg"]'));
  await p.screenshot({ path: 'shots/delete-armed.png', clip: { x: 260, y: 0, width: 1020, height: 420 } });
  await p.click('[data-action="delete-msg"]'); await p.waitForTimeout(800);
  console.log('3 list after delete:', await list(), '| hint:', await text(p, '#v-messages .card-h .hint'), '| no-response tile:', await unresolved());
  console.log('3 saved:', await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('mockdb'))).filter(k => k.includes('/removed/')).join(', ')));
  await p.reload(); await p.waitForTimeout(2500);
  console.log('4 after reload:', await list());
  const v = watch(await ctx.newPage());
  await v.goto(url + '?mode=member#messages'); await v.waitForTimeout(1500);
  console.log('5 company member sees:', await v.$$eval('#mlist .mitem .m-t', xs => xs.map(x => x.textContent).join(' | ')), '| delete buttons:', await v.$$eval('[data-action="delete-msg"], [data-action="open-removed"]', x => x.length));
  await p.click('[data-action="open-removed"]'); await p.waitForTimeout(200);
  console.log('6 deleted list:', (await p.$$eval('#removed-box .clear-row', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()))).join(' || '));
  await p.click('[data-action="restore-msg"]'); await p.waitForTimeout(800);
  console.log('7 after restore:', await text(p, '#removed-box .dlg-b'), '| list:', await list());
  await p.keyboard.press('Escape');
  console.log('7 dialog closed:', await p.$eval('#removed-dlg', e => e.hidden), '| hint:', await text(p, '#v-messages .card-h .hint'));
  console.log('errors:', errs);
  await b.close();
})();
