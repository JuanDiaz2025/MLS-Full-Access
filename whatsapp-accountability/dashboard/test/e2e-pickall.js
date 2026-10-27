const { chromium } = require('playwright');
const fs = require('fs');
process.chdir(__dirname);
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8').replace('  state.view = VIEWS[location', '  window.__dbg = { src, live, saved, state, trackedGroups };\n  state.view = VIEWS[location');
const M = 60000, t0 = Date.now() - 120 * M;
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = {};
const mk = (id, name, people, msgs) => { groups[id] = { name, participants: people, msgs }; return id; };
const SETH = P('1000', 'Office phone'), JUAN = P('1001', 'Juan'), CHERRY = P('2001', 'Cherry');
const crew = n => Array.from({ length: n }, (_, k) => P(String(3000 + k), 'Crew ' + (k + 1)));
// 30 groups with people in them (plus the mock's "Family" group), and 3 the phone left (0 members)
for (let k = 1; k <= 30; k++) mk(`1203630000000001${String(k).padStart(2, '0')}@g.us`, `${100 + k} Oak Street, Site ${k}`, [SETH, JUAN, ...crew(2)], []);
for (let k = 1; k <= 3; k++) mk(`1203630000000009${String(k).padStart(2, '0')}@g.us`, `${k} Old Lane (left)`, [], []);
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
fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('shots/e2e-pickall.html', html);
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const url = 'file://' + process.cwd() + '/shots/e2e-pickall.html';
  await p.goto(url + '?mode=laptop'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  const visible = () => p.$$eval('#group-choices .choice:not([hidden])', xs => xs.length);
  check('0-member groups hidden by default', (await visible()) === 31 && await p.isChecked('#hide-empty'), await visible());
  check('filter says how many it hides', (await text(p, 'label.check-l')) === 'Hide groups with 0 members (3)', await text(p, 'label.check-l'));
  check('count leaves them out', (await text(p, '#group-q-count')) === '31 groups', await text(p, '#group-q-count'));
  await p.uncheck('#hide-empty'); await p.waitForTimeout(200);
  check('untick shows them', (await visible()) === 34 && (await text(p, '#group-q-count')) === '34 groups');
  await p.check('#hide-empty'); await p.waitForTimeout(200);
  // search, then select all shown
  await p.fill('#group-q', 'site 1'); await p.waitForTimeout(150);
  check('search narrows the button', (await text(p, '#pick-all')) === 'Select all 11 shown', await text(p, '#pick-all'));
  await p.click('#pick-all'); await p.waitForTimeout(300);
  check('ticks the 11 shown', (await text(p, '#pick-count')) === '11 groups selected', await text(p, '#pick-count'));
  // 0-member groups are never ticked by select all
  await p.fill('#group-q', ''); await p.waitForTimeout(150);
  check('button follows the cleared search', (await text(p, '#pick-all')) === 'Select all 31 shown', await text(p, '#pick-all'));
  await p.click('#pick-all'); await p.waitForTimeout(300);
  check('more than 20 asks again', (await text(p, '#pick-all')) === 'Click again to tick 31 groups' && (await text(p, '#pick-count')) === '11 groups selected', await text(p, '#pick-all'));
  await p.screenshot({ path: 'shots/pickall-confirm.png' });
  await p.click('#pick-all'); await p.waitForTimeout(300);
  check('second click ticks all 31', (await text(p, '#pick-count')) === '31 groups selected', await text(p, '#pick-count'));
  const left = await p.$$eval('input[name="pick-group"]', xs => xs.filter(x => x.checked && x.closest('label').dataset.empty).length);
  check('no 0-member group ticked', left === 0, left);
  // remembered on this computer
  await p.uncheck('#hide-empty'); await p.waitForTimeout(150); await p.reload(); await p.waitForTimeout(1500);
  check('filter choice remembered', !(await p.isChecked('#hide-empty')));
  check('no page errors', !errs.length, errs.join(' || '));
  console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
  await b.close(); process.exit(fails.length ? 1 : 0);
})();
