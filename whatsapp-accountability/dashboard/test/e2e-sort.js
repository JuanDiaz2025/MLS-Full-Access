const { chromium } = require('playwright');
const fs = require('fs');
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 120 * M;
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = {};
const D = 86400000;
const CREATED = { '120363000000000001@g.us': 3, '120363000000000002@g.us': 40, '120363000000000003@g.us': 90, '120363000000000004@g.us': 12, '120363000000000005@g.us': 1, '120363000000000006@g.us': 400 };
const mk = (id, name, people, msgs) => { groups[id] = { name, participants: people, msgs, created: Date.now() - CREATED[id] * D }; return id; };
const SETH = P('1000', 'Office phone'), JUAN = P('1001', 'Juan'), CHERRY = P('2001', 'Cherry');
const crew = n => Array.from({ length: n }, (_, k) => P(String(3000 + k), 'Crew ' + (k + 1)));
const G1 = mk('120363000000000001@g.us', '972 Norton Street, San Mateo, CA, 94401', [SETH, JUAN, ...crew(4)], [{ id: 'N1', at: t0, sender_id: '1001', kind: 'text', text: 'Everyone confirm the walkthrough at 9' }]);
const G2 = mk('120363000000000002@g.us', '22496 Avenue 18 3/4, Madera, CA, 93637', [SETH, JUAN, CHERRY, ...crew(3)], [{ id: 'M1', at: t0 + 5 * M, sender_id: '2001', kind: 'text', text: 'Send photos of the roof today' }]);
const G3 = mk('120363000000000003@g.us', '1187 San Moritz Dr, San Jose, CA 95132', [SETH, CHERRY, ...crew(2)], []);
const G4 = mk('120363000000000004@g.us', 'Iriga Office Receipts and Expenses', [SETH, ...crew(2)], []);
const G5 = mk('120363000000000005@g.us', '2 Juri Street, San Francisco, CA, 94110', [SETH, JUAN, ...crew(5)], []);
const G6 = mk('120363000000000006@g.us', 'Compute Office', [SETH, JUAN], []);
const mock = `<script>
(function(){
  const MODE = new URLSearchParams(location.search).get('mode');
  const OLD_READER = new URLSearchParams(location.search).has('old');
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
    list_groups: () => ({ groups: Object.entries(GROUPS).map(([id, g]) => ({ id, name: g.name, members: g.participants.length, message_count: g.msgs.length, last_message_at: g.msgs.length ? Math.max(...g.msgs.map(m => m.at)) : 0, created_at: OLD_READER ? undefined : g.created }))
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
fs.writeFileSync('shots/e2e-sort.html', html);
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  const errs = [];
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const url = 'file://' + process.cwd() + '/shots/e2e-sort.html';
  await p.goto(url + '?mode=laptop'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  const order = () => p.$$eval('#group-choices .choice', xs => xs.map(x => x.querySelector('b').textContent.split(',')[0].slice(0, 20) + ' (' + (x.querySelector('.sub').textContent.match(/Created ([^·]+)/) || [, '-'])[1].trim() + ')').join(' | '));
  console.log('1 sort:', await p.$eval('#group-sort', s => s.value), '->', await order());
  await p.screenshot({ path: 'shots/sort-new.png', clip: { x: 260, y: 180, width: 1040, height: 420 } });
  await p.selectOption('#group-sort', 'name'); await p.waitForTimeout(150);
  console.log('2 name:', await order());
  await p.selectOption('#group-sort', 'active'); await p.waitForTimeout(150);
  console.log('3 activity:', await order());
  await p.selectOption('#group-sort', 'name'); await p.reload(); await p.waitForTimeout(1500);
  console.log('4 after reload keeps:', await p.$eval('#group-sort', s => s.value));
  // ticks survive a re-sort, and the add flow follows the list's order
  await p.check(`input[name="pick-group"][value="${G6}"]`); await p.check(`input[name="pick-group"][value="${G5}"]`);
  await p.selectOption('#group-sort', 'new'); await p.waitForTimeout(150);
  console.log('5 still ticked after re-sort:', await p.isChecked(`input[name="pick-group"][value="${G6}"]`), await p.isChecked(`input[name="pick-group"][value="${G5}"]`), '|', await text(p, '#pick-count'));
  const q = await b.newPage();
  q.on('pageerror', e => errs.push(String(e)));
  await q.goto(url + '?mode=laptop&old=1'); await q.evaluate(() => localStorage.clear()); await q.reload(); await q.waitForTimeout(1500);
  console.log('6 1.0.1 reader:', await q.$eval('#group-sort', s => s.value), '| newest option:', await q.$eval('#group-sort option[value="new"]', o => o.disabled + ' ' + o.textContent));
  console.log('errors:', errs);
  await b.close();
})();
