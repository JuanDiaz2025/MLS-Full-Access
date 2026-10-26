const { chromium } = require('playwright');
const fs = require('fs');
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 120 * M;
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = {};
const mk = (id, name, people, msgs) => { groups[id] = { name, participants: people, msgs }; return id; };
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
fs.writeFileSync('shots/e2e-addmany.html', html);
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  const errs = [];
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const url = 'file://' + process.cwd() + '/shots/e2e-addmany.html';
  await p.goto(url + '?mode=laptop'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  const visible = () => p.$$eval('#group-choices .choice:not([hidden]) b', xs => xs.map(x => x.textContent).join(' | '));
  console.log('1 title:', await text(p, '#v-title'), '| count:', await text(p, '#group-q-count'), '| bar:', await text(p, '#pick-count'), '| next disabled:', await p.isDisabled('#pick-next'));
  await p.fill('#group-q', 'san'); await p.waitForTimeout(100);
  console.log('2 search "san":', await text(p, '#group-q-count'), '->', await visible());
  await p.check(`input[name="pick-group"][value="${G1}"]`); await p.check(`input[name="pick-group"][value="${G3}"]`); await p.check(`input[name="pick-group"][value="${G5}"]`);
  console.log('3 bar:', await text(p, '#pick-count'), '| next disabled:', await p.isDisabled('#pick-next'));
  await p.screenshot({ path: 'shots/addmany-pick.png', fullPage: true });
  await p.fill('#group-q', 'madera'); await p.waitForTimeout(100);
  await p.check(`input[name="pick-group"][value="${G2}"]`);
  await p.fill('#group-q', 'zzz'); await p.waitForTimeout(100);
  console.log('4 no match shows note:', !(await p.$eval('#group-q-none', e => e.hidden)), '| selected:', await text(p, '#pick-count'));
  await p.fill('#group-q', ''); await p.waitForTimeout(100);
  await p.click('#pick-next'); await p.waitForTimeout(1500);
  const side = () => p.$$eval('.addg', xs => xs.map(x => x.innerText.replace(/\s+/g, ' ').trim()).join(' || '));
  console.log('5 side:', await side());
  console.log('5 active preset (this phone):', await p.isChecked('input[name="add-boss"][value="1000"]'), '| footer:', await text(p, '.add-foot .plain'));
  // in the first group: Juan gives instructions, not the office phone
  await p.check('input[name="add-boss"][value="1001"]'); await p.waitForTimeout(100);
  await p.uncheck('input[name="add-boss"][value="1000"]'); await p.waitForTimeout(100);
  await p.click('[data-action="add-apply"]'); await p.waitForTimeout(200);
  console.log('6 note:', await text(p, '.apply-all .plain'));
  console.log('6 side:', await side());
  await p.screenshot({ path: 'shots/addmany-setup.png', fullPage: true });
  // San Moritz has no Juan: pick Cherry there
  await p.click(`.addg[data-gid="${G3}"]`); await p.waitForTimeout(200);
  console.log('7 San Moritz givers:', await p.$$eval('input[name="add-boss"]:checked', xs => xs.map(x => x.value).join(',')));
  await p.check('input[name="add-boss"][value="2001"]'); await p.waitForTimeout(100);
  await p.uncheck('input[name="add-boss"][value="1000"]'); await p.waitForTimeout(100);
  console.log('7 footer:', await text(p, '.add-foot .plain'), '| add button:', await text(p, '[data-action="add-groups"]'), '| disabled:', await p.isDisabled('[data-action="add-groups"]'));
  await p.click('[data-action="add-groups"]'); await p.waitForTimeout(2500);
  const tracking = await p.evaluate(() => JSON.parse(localStorage.getItem('mockdb'))['settings/tracking'].groups.map(g => `${g.groupName.slice(0, 18)}: ${g.bossIds.join('+')}`).join(' | '));
  console.log('8 saved:', tracking);
  console.log('8 title:', await text(p, '#v-title'), '| groups:', (await p.$$eval('#group-filter option', o => o.map(x => x.textContent))).join(' / '));
  // a tracked group the phone isn't in
  await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('mockdb')); d['settings/tracking'].groups.push({ groupId: '120363000000000099@g.us', groupName: 'TEST', bossIds: ['1000'] }); localStorage.setItem('mockdb', JSON.stringify(d)); });
  await p.reload(); await p.waitForTimeout(3000);
  console.log('9 error:', await text(p, '#live-error'));
  console.log('errors:', errs);
  await b.close();
})();
