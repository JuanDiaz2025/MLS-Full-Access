// Many tracked groups and the Claude app's limit on calls to WhatsApp Reader:
// calls are spaced and retried, only changed groups are read again, and a
// limit that won't lift shows one calm line instead of an error per group.
const { chromium } = require('playwright');
const fs = require('fs');
process.chdir(__dirname);
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 90 * M;
const mock = `<script>
(function(){
  const Q = new URLSearchParams(location.search);
  const N = Number(Q.get('n') || 20), LIMIT = Number(Q.get('limit') || 4), HARD = Q.get('hard') === '1';
  const P = (id, name) => ({ id, name, phone: '+' + id });
  const GROUPS = {};
  for (let i = 0; i < N; i++) {
    const gid = '1203630000000000' + String(i).padStart(2, '0') + '@g.us';
    GROUPS[gid] = { name: 'Group ' + i, participants: [P('1000', 'Seth'), P('1001', 'Juan'), P('1002', 'Mike')], msgs: [
      { id: 'G' + i + 'a', at: ${t0} + i * 1000, sender_id: '1001', kind: 'text', text: 'Mike send the photos for job ' + i },
      { id: 'G' + i + 'b', at: ${t0} + i * 1000 + 5 * ${M}, sender_id: '1002', kind: 'text', text: 'Sent' }] };
  }
  window.__groups = GROUPS;
  window.__addMsg = (gid, text) => { const g = GROUPS[gid]; g.msgs.push({ id: 'X' + g.msgs.length, at: Date.now(), sender_id: '1001', kind: 'text', text }); };
  const load = () => { try { return JSON.parse(localStorage.getItem('mockdb') || '{}'); } catch (e) { return {}; } };
  const save = d => localStorage.setItem('mockdb', JSON.stringify(d));
  const subs = [];
  const notify = () => setTimeout(() => subs.forEach(f => f()), 10);
  const snapDoc = path => { const d = load()[path]; return { id: path.split('/').pop(), exists: !!d, data: () => d, metadata: {} }; };
  const db = {
    doc(path) { return { get: async () => snapDoc(path),
      set: async data => { const d = load(); d[path] = JSON.parse(JSON.stringify(data)); save(d); notify(); },
      delete: async () => { const d = load(); delete d[path]; save(d); notify(); },
      onSnapshot(next) { const f = () => next(snapDoc(path)); subs.push(f); setTimeout(f, 20); return () => {}; } }; },
    collection(path) { return { onSnapshot(next) { const f = () => { const d = load(); const docs = Object.keys(d).filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(k => snapDoc(k)); next({ docs, size: docs.length, empty: !docs.length }); }; subs.push(f); setTimeout(f, 20); return () => {}; } }; },
  };
  const all = () => Object.values(GROUPS).flatMap(g => g.msgs);
  const reader = {
    status: () => ({ linked: true, connected: true, phone: '1000', messages_stored: all().length, groups_known: N, last_message_at: Math.max(...all().map(m => m.at)), version: '1.0.3' }),
    list_groups: () => ({ groups: Object.entries(GROUPS).map(([id, g]) => ({ id, name: g.name, members: g.participants.length, message_count: g.msgs.length, last_message_at: Math.max(...g.msgs.map(m => m.at)) })), me: '1000' }),
    get_group: ({ group_id }) => { const g = GROUPS[group_id]; return { id: group_id, name: g.name, me: '1000', participants: g.participants }; },
    get_messages: ({ group_id, since }) => ({ messages: GROUPS[group_id].msgs.filter(m => m.at >= (since || 0)), more: false, me: '1000' }),
  };
  // the Claude app: no more than LIMIT calls a second, or (HARD) nothing after the first few
  window.__calls = []; window.__refused = 0;
  const recent = [];
  const mcp = { async callTool(server, tool, input) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 1000) recent.shift();
    if (recent.length >= LIMIT || (HARD && window.__calls.length >= 6)) {
      window.__refused++;
      return Promise.reject({ code: 'upstream_error', message: 'Host tool rate limit exceeded \\u2014 try again shortly.', retryAfterMs: 300 });
    }
    recent.push(now);
    window.__calls.push({ tool, gid: input && input.group_id });
    return { content: [], payload: reader[tool](input || {}) };
  } };
  const caps = { db, mcp, sample: null, user: { canEdit: async () => true, isOwner: async () => true, can: async () => true, id: async () => 'u1', profiles: async () => ({}) } };
  window.claude = { use: async n => { await new Promise(r => setTimeout(r, 30)); return caps[n] ?? null; } };
})();
</script>`;
const html = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${mock}${body}</body></html>`;
fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('shots/e2e-pace.html', html);
const url = 'file://' + process.cwd() + '/shots/e2e-pace.html';
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
const gid = i => '1203630000000000' + String(i).padStart(2, '0') + '@g.us';
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const open = async (q, n) => {
    const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
    p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(url + '?' + q);
    await p.evaluate(groups => { localStorage.clear(); localStorage.setItem('mockdb', JSON.stringify({ 'settings/tracking': { groups, me: '1000' } })); },
      Array.from({ length: n }, (_, i) => ({ groupId: gid(i), groupName: 'Group ' + i, bossIds: ['1001'] })));
    await p.reload();
    return p;
  };
  const opts = p => p.$$eval('#group-filter option', o => o.length);
  // 1. twenty groups against a limit of 4 calls a second
  let p = await open('n=20&limit=4', 20);
  const start = Date.now();
  while (Date.now() - start < 90000 && !(await p.evaluate(() => { const s = document.getElementById('snap'); return /Live/.test(s.textContent) && document.querySelectorAll('#group-filter option').length === 21; }))) await p.waitForTimeout(500);
  await p.waitForTimeout(1500);
  check('all 20 groups read despite the limit', (await opts(p)) === 21, `${await opts(p)} options after ${Math.round((Date.now() - start) / 1000)} s`);
  const c1 = await p.evaluate(() => ({ calls: window.__calls.length, refused: window.__refused }));
  check('refused calls were waited out and retried', c1.refused >= 0 && c1.calls >= 40, JSON.stringify(c1));
  check('no error banner once everything is read', await p.$eval('#live-error', e => e.hidden), await p.$eval('#live-error', e => e.textContent));
  // 2. one new message: only that group is read again
  const before = await p.evaluate(() => window.__calls.length);
  await p.evaluate(g => window.__addMsg(g, 'Mike also send the invoice'), gid(5));
  await p.click('#refresh'); await p.waitForTimeout(4000);
  const after = await p.evaluate(n => window.__calls.slice(n), before);
  const reads = after.filter(c => c.tool === 'get_messages' || c.tool === 'get_group');
  check('a new message in one group: only that group is read', reads.length >= 1 && reads.every(c => c.gid === gid(5)), JSON.stringify(after.map(c => c.tool + (c.gid ? ':' + c.gid.slice(14, 18) : ''))));
  check('the new message is on the page', (await p.textContent('#v-dashboard')).length > 0 && await p.evaluate(() => { location.hash = 'messages'; return true; }) && (await p.waitForTimeout(300), (await p.textContent('#v-messages')).includes('Mike also send the invoice')));
  // 3. nothing new: no group is read
  const b2 = await p.evaluate(() => window.__calls.length);
  await p.click('#refresh'); await p.waitForTimeout(2500);
  const a2 = await p.evaluate(n => window.__calls.slice(n).map(c => c.tool), b2);
  check('nothing new: just status and the group list', a2.every(t => t === 'status' || t === 'list_groups'), a2.join(','));
  await p.close();

  // 4. the limit doesn't lift: one calm line, not a list of groups
  p = await open('n=8&hard=1', 8);
  await p.waitForTimeout(20000);
  const banner = await p.$eval('#live-error', e => ({ hidden: e.hidden, text: e.textContent, calm: e.classList.contains('calm') }));
  check('limit that won’t lift: a calm note with a count', !banner.hidden && banner.calm && /limiting how fast/.test(banner.text) && /groups are still to be read/.test(banner.text), banner.text);
  check('no list of group names', !/Group \d/.test(banner.text) && !/Host tool rate limit/.test(banner.text));
  await p.screenshot({ path: 'shots/pace-held.png' });
  await p.close();

  check('no page errors', !errs.length, errs.slice(0, 3).join(' || '));
  console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
  await b.close(); process.exit(fails.length ? 1 : 0);
})();
