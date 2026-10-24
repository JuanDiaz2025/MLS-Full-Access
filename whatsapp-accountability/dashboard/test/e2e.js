const { chromium } = require('playwright');
const fs = require('fs');
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const mock = `<script>
(function(){
  const MODE = new URLSearchParams(location.search).get('mode');
  const load = () => { try { return JSON.parse(localStorage.getItem('mockdb') || '{}'); } catch (e) { return {}; } };
  const save = d => localStorage.setItem('mockdb', JSON.stringify(d));
  const subs = [];
  const notify = () => setTimeout(() => subs.forEach(f => f()), 10);
  const snapDoc = (path) => { const d = load()[path]; return { id: path.split('/').pop(), exists: !!d, data: () => d, metadata: {} }; };
  const db = {
    doc(path) { return {
      get: async () => snapDoc(path),
      set: async (data) => { const d = load(); d[path] = JSON.parse(JSON.stringify(data)); save(d); window.__writes = (window.__writes||0)+1; notify(); },
      delete: async () => { const d = load(); delete d[path]; save(d); notify(); },
      onSnapshot(next) { const f = () => next(snapDoc(path)); subs.push(f); setTimeout(f, 20); return () => {}; },
    }; },
    collection(path) { return { onSnapshot(next) { const f = () => { const d = load(); const docs = Object.keys(d).filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(k => snapDoc(k)); next({ docs, size: docs.length, empty: !docs.length }); }; subs.push(f); setTimeout(f, 20); return () => {}; } }; },
  };
  const t0 = Date.now() - 90 * 60000, M = 60000;
  const G = '120363000000000001@g.us';
  const msgs = [
    {id:'M1',at:t0,sender_id:'15550000001',sender_name:'Seth',kind:'text',text:'Everyone confirm you saw the schedule for tomorrow'},
    {id:'R1',at:t0+4*M,sender_id:'15550000002',sender_name:'Mike',kind:'text',text:'Seen'},
    {id:'M2',at:t0+10*M,sender_id:'15550000001',kind:'text',text:'@15550000002 send photos of site A by 5pm',mentions:['15550000002']},
    {id:'M3',at:t0+20*M,sender_id:'15550000001',kind:'text',text:'Safety meeting tomorrow 7am, everyone confirm'},
    {id:'M4',at:t0+30*M,sender_id:'15550000001',kind:'text',text:'Who can cover Saturday?'},
    {id:'R2',at:t0+35*M,sender_id:'15550000002',kind:'text',text:'On it',quoted_id:'M2'},
    {id:'R3',at:t0+36*M,sender_id:'15550000002',kind:'reaction',text:'👍',reaction_to:'M3'},
    {id:'P1',at:t0+50*M,sender_id:'15550000002',kind:'image',text:'site A',quoted_id:'M2'},
    {id:'X1',at:t0+60*M,sender_id:'15550000001',kind:'text',text:'Thanks!'},
  ];
  const reader = {
    status: () => ({ linked: true, connected: true, phone: '15550000001', messages_stored: msgs.length, groups_known: 2, last_message_at: msgs[msgs.length-1].at, version: '1.0.0' }),
    list_groups: () => ({ groups: [{ id: G, name: 'Test group', members: 3, message_count: 8, last_message_at: msgs[msgs.length-1].at }, { id: '120363000000000002@g.us', name: 'Family', members: 6, message_count: 40, last_message_at: t0 - 86400000 }], me: '15550000001' }),
    get_group: () => ({ id: G, name: 'Test group', me: '15550000001', participants: [
      { id: '15550000001', name: 'Seth', phone: '+15550000001', admin: true }, { id: '15550000002', name: 'Mike', phone: '+15550000002' }, { id: '15550000003', name: 'Ana', phone: '+15550000003' }] }),
    get_messages: (inp) => ({ messages: msgs.filter(m => m.at >= (inp.since || 0)), more: false, me: '15550000001' }),
  };
  window.__calls = [];
  const mcp = {
    async callTool(server, tool, input) {
      window.__calls.push(tool);
      if (MODE !== 'laptop') throw { code: 'server_not_connected', message: 'no host' };
      if (!reader[tool]) throw { code: 'not_in_manifest', message: 'nope' };
      return { content: [], payload: reader[tool](input || {}) };
    },
    watchTool(server, tool, input, handler) {
      const run = () => this.callTool(server, tool, input).then(r => handler({ type: 'data', result: r }), e => handler({ type: 'error', error: e }));
      setTimeout(run, 50); const id = setInterval(run, 3000); return () => clearInterval(id);
    },
  };
  window.__samples = 0;
  const sample = async () => ({ text: '' });
  sample.json = async (prompt) => {
    window.__samples++;
    const arr = JSON.parse(prompt.slice(prompt.lastIndexOf('[{')));
    return { results: arr.map(m => /photos/.test(m.text)
      ? { id: m.id, title: 'Site A photos', type: 'Instruction', needs_reply: true, required: ['15550000002'], priority: 'High', task: { title: 'Send site A photos', owner_id: '15550000002', due: null } }
      : /^Thanks/.test(m.text) ? { id: m.id, title: 'Thanks', type: 'Info', needs_reply: false, required: 'all', priority: 'Normal', task: null }
      : { id: m.id, title: m.text.split(' ').slice(0, 5).join(' '), type: m.text.includes('?') ? 'Question' : 'Instruction', needs_reply: true, required: 'all', priority: 'Normal', task: null }) };
  };
  const caps = { db, mcp: MODE === 'nomcp' ? null : mcp, sample, user: { canEdit: async () => MODE === 'laptop', isOwner: async () => MODE === 'laptop' } };
  window.claude = { use: async (n) => { await new Promise(r => setTimeout(r, 30)); return caps[n] ?? null; } };
})();
</script>`;
const html = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${mock}${body}</body></html>`;
process.chdir(__dirname); fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('shots/e2e.html', html);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const url = 'file://' + process.cwd() + '/shots/e2e.html';
  await p.goto(url + '?mode=laptop'); await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.waitForTimeout(800);
  console.log('A1 title:', await p.textContent('#v-title'));
  await p.check('input[name="setup-group"][value="120363000000000001@g.us"]');
  await p.waitForTimeout(400);
  console.log('A2 boss checked:', await p.isChecked('input[name="setup-boss"][value="15550000001"]'));
  await p.screenshot({ path: 'shots/e2e-setup.png', fullPage: true });
  await p.click('[data-action="save-source"]');
  await p.waitForTimeout(1500);
  console.log('A3 title:', await p.textContent('#v-title'), '| pill:', (await p.textContent('#snap')).trim(), '| group pill:', (await p.textContent('#group-pill')).trim());
  console.log('A3 tiles:', (await p.$$eval('.tile', ts => ts.map(t => t.querySelector('.t-num').textContent + ' ' + t.querySelector('.t-lab').textContent))).join(' | '));
  console.log('A3 not replied:', (await p.$$eval('#v-dashboard table tbody tr', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()))).slice(0, 6).join(' || '));
  await p.screenshot({ path: 'shots/e2e-live-dashboard.png', fullPage: true });
  await p.goto(url + '?mode=laptop#messages'); await p.reload(); await p.waitForTimeout(2000);
  await p.screenshot({ path: 'shots/e2e-live-messages.png', fullPage: true });
  console.log('A4 sample calls after reload:', await p.evaluate(() => window.__samples), '(0 means saved analysis was reused)');
  const store = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('mockdb'))));
  console.log('A5 saved docs:', store.join(', '));
  // Another device: no reader
  const q = await ctx.newPage();
  q.on('pageerror', e => errs.push(String(e)));
  await q.goto(url + '?mode=viewer#tasks'); await q.waitForTimeout(1200);
  console.log('B1 pill:', (await q.textContent('#snap')).trim(), '| title:', await q.textContent('#v-title'));
  console.log('B1 tasks:', (await q.$$eval('#v-tasks tbody tr', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()))).join(' || '));
  await q.goto(url + '?mode=viewer#dashboard'); await q.waitForTimeout(1000);
  await q.screenshot({ path: 'shots/e2e-saved-dashboard.png', fullPage: true });
  console.log('errors:', errs);
  await b.close();
})();
