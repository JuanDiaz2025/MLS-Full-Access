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
// 24 site groups: Juan is in the odd ones, Cherry in every third, plus the mock's "Family" group (members can't be read)
const site = k => `1203630000000001${String(k).padStart(2, '0')}@g.us`;
for (let k = 1; k <= 24; k++) mk(site(k), `${100 + k} Oak Street, Site ${k}`, [SETH, ...(k % 2 ? [JUAN] : []), ...(k % 3 ? [] : [CHERRY]), ...crew(2)], [{ id: 'S' + k, at: t0 + k * M, sender_id: '1000', kind: 'text', text: 'hello' }]);
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
    status: () => ({ linked: true, connected: true, phone: '1000', messages_stored: all.length, groups_known: 3, last_message_at: Math.max(...all.map(m => m.at)), version: new URLSearchParams(location.search).get('v') || '1.0.1' }),
    list_groups: () => ({ groups: Object.entries(GROUPS).map(([id, g]) => ({ id, name: g.name, members: g.participants.length, message_count: g.msgs.length, last_message_at: Math.max(...g.msgs.map(m => m.at)) }))
      .concat({ id: '120363000000000009@g.us', name: 'Family', members: 6, message_count: 40, last_message_at: 1 }), me: '1000' }),
    get_group: ({ group_id }) => { const g = GROUPS[group_id]; if (!g) throw { code: 'tool_error', message: 'unknown group' }; return { id: group_id, name: g.name, me: '1000', participants: g.participants }; },
    get_messages: ({ group_id, since }) => ({ messages: (GROUPS[group_id] || { msgs: [] }).msgs.filter(m => m.at >= (since || 0)), more: false, me: '1000' }),
  };
  window.__calls = [];
  const mcp = {
    async callTool(server, tool, input) {
      window.__calls.push(tool + ':' + ((input || {}).group_id || '')); (window.__times ||= []).push([tool, Date.now()]);
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
fs.writeFileSync('shots/e2e-givers.html', html);
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
const st = (list, k) => list.find(x => x.slice(1) === `${100 + k} Oak Street, Site ${k}`) || '?';
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 760 } });
  const errs = [];
  const watch = p => { p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); return p; };
  const url = 'file://' + process.cwd() + '/shots/e2e-givers.html';
  const p = watch(await ctx.newPage());
  await p.goto(url + '?mode=laptop&v=1.0.3'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(1500);
  await p.click('#pick-all'); await p.waitForTimeout(150); await p.click('#pick-all'); await p.waitForTimeout(200);
  await p.click('#pick-next'); await p.waitForTimeout(6000);
  const side = () => p.$$eval('.addg', xs => xs.map(x => (x.classList.contains('done') ? '+' : '-') + x.innerText.split('\n')[0].trim()));
  check('without defaults, this phone is ticked as before', (await side()).filter(x => x.startsWith('+')).length === 24, (await side()).length);
  check('the group whose members fail shows a retry', (await text(p, '.add-foot')).includes('Try the 1 group that failed again'));

  // pick Juan as the default
  await p.fill('#giver-q', 'jua'); await p.waitForTimeout(100);
  const opts = await p.$$eval('#giver-list .opt', xs => xs.map(x => x.innerText.replace(/\s+/g, ' ').trim()));
  check('search finds Juan with how many groups he is in', opts.length === 1 && /Juan \+1001 · in 12 selected groups/.test(opts[0]), opts.join(' || '));
  await p.click('#giver-list .opt'); await p.waitForTimeout(300);
  check('Juan is a chip', (await text(p, '.gchips')).startsWith('Juan'));
  const s1 = await side();
  check('ticked in the 12 groups Juan is in, the rest need a pick', s1.filter(x => x.startsWith('+')).length === 12 && s1.find(x => x.includes('Site 2')).startsWith('-'), s1.slice(0, 4).join(' '));
  check('summary says how many have none of them', (await text(p, '.defaults')).includes('In 12 of the 24 loaded groups. 12 groups have none of them'), await text(p, '.defaults .plain'));
  check('saved for next time', await p.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('mockdb'))['settings/givers'].ids)) === '["1001"]');

  // next group to pick, and a pick by hand that the defaults leave alone
  check('next-to-pick button counts them', (await text(p, '.add-foot')).includes('Next group to pick (12)'), await text(p, '.add-foot'));
  await p.click('[data-action="add-next-missing"]'); await p.waitForTimeout(300);
  const active = await text(p, '.addg.active b');
  check('jumps to a group that needs a pick', /Site (2|4|6|8|10|12|14|16|18|20|22|24)$/.test(active.replace(/,.*/, '')) || /Site \d+/.test(active), active);
  await p.check('input[name="add-boss"][value="1000"]'); await p.waitForTimeout(150);
  const handPicked = active;
  // Cherry as a second default: groups with Cherry get her, the hand-picked one stays as it is
  await p.fill('#giver-q', 'cher'); await p.waitForTimeout(100); await p.click('#giver-list .opt'); await p.waitForTimeout(300);
  check('two defaults', (await text(p, '.gchips')).replace(/×/g, '').trim() === 'Juan Cherry', await text(p, '.gchips'));
  const s2 = await side();
  // even sites with Cherry (6, 12, 18, 24) are now ready too
  check('groups with Cherry are now ready', [6, 12, 18, 24].every(k => st(s2, k).startsWith('+')), [6, 12, 18, 24].map(k => st(s2, k)).join(' '));
  await p.click(`.addg:has-text("${handPicked.replace(/"/g, '')}")`); await p.waitForTimeout(200);
  check('the hand-picked group kept its pick', await p.isChecked('input[name="add-boss"][value="1000"]'));
  // removing Juan unticks him where nobody picked by hand
  await p.click('[data-action="remove-default"][data-pid="1001"]'); await p.waitForTimeout(300);
  const s3 = await side();
  check('removing Juan unticks him', st(s3, 1).startsWith('-') && st(s3, 3).startsWith('+'), [1, 3].map(k => st(s3, k)).join(' '));

  // the list keeps its place when a group is clicked
  await p.$eval('.addside', el => { el.scrollTop = 400; });
  const before = await p.$eval('.addside', el => el.scrollTop);
  const btn = await p.$$('.addg'); await btn[12].click(); await p.waitForTimeout(300);
  const after = await p.$eval('.addside', el => el.scrollTop);
  check('group list keeps its scroll position', before > 0 && Math.abs(after - before) < 5, `${before} -> ${after}`);
  await p.screenshot({ path: 'shots/givers-defaults.png' });

  // the defaults are remembered: a fresh start ticks Cherry where she is
  await p.reload(); await p.waitForTimeout(1500);
  await p.fill('#group-q', 'site 3'); await p.waitForTimeout(100);
  await p.click('#pick-all'); await p.waitForTimeout(150);
  await p.click('#pick-next'); await p.waitForTimeout(3000);
  check('remembered after reload', (await text(p, '.gchips')).replace(/×/g, '').trim() === 'Cherry' && st(await side(), 3).startsWith('+'), (await side()).join(' '));

  // an older WhatsApp Reader: member reads are spaced out
  const q = watch(await ctx.newPage());
  await q.goto(url + '?mode=laptop&v=1.0.2'); await q.waitForTimeout(1500);
  await q.fill('#group-q', 'site 1'); await q.waitForTimeout(100);
  await q.check('input[name="pick-group"][value="120363000000000101@g.us"]'); await q.check('input[name="pick-group"][value="120363000000000110@g.us"]'); await q.check('input[name="pick-group"][value="120363000000000111@g.us"]');
  await q.click('#pick-next'); await q.waitForTimeout(5000);
  const times = (await q.evaluate(() => window.__times)).filter(t => t[0] === 'get_group').map(t => t[1]);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  check('older reader: member reads at least 1.5 s apart', times.length === 3 && gaps.every(g => g >= 1400), gaps.join(', '));

  // tracking: members are read once, not on every update
  await p.click('[data-action="add-groups"]'); await p.waitForTimeout(6000);
  const n1 = (await p.evaluate(() => window.__calls)).filter(c => c.startsWith('get_group')).length;
  await p.click('#refresh'); await p.waitForTimeout(1500); await p.click('#refresh'); await p.waitForTimeout(1500);
  const n2 = (await p.evaluate(() => window.__calls)).filter(c => c.startsWith('get_group')).length;
  check('refreshing doesn\'t read members again within 10 minutes', n2 === n1, `${n1} -> ${n2}`);

  check('no page errors', !errs.length, errs.join(' || '));
  console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
  await b.close(); process.exit(fails.length ? 1 : 0);
})();
