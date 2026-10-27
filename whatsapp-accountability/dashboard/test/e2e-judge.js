// Claude reads plain replies on the page: which request each answers, and who took on the work.
// Claude's answers are the real ones from the sample thread (judge-sample.json).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
process.chdir(__dirname);
const body = fs.readFileSync(path.join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 90 * M;
const G1 = '120363000000000001@g.us';
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = {
  [G1]: { name: 'Ops', participants: [P('1000', 'Seth'), P('1001', 'Juan Diaz'), P('2001', 'Vannessa'), P('2002', 'era'), P('2003', 'Gio'), P('2004', 'Issy'), P('2005', 'Mark')], msgs: [
    { id: 'R1', at: t0, sender_id: '1001', kind: 'text', text: 'who is tracking the Home Depot order?' },
    { id: 'm1', at: t0 + 1 * M, sender_id: '2001', kind: 'text', text: "I'm the one tracking it, Juan." },
    { id: 'm2', at: t0 + 6 * M, sender_id: '2002', kind: 'text', text: 'Quick update: Internet service installed.' },
    { id: 'R2', at: t0 + 7 * M, sender_id: '1001', kind: 'text', text: 'Everyone confirm the walkthrough tomorrow at 9' },
    { id: 'm3', at: t0 + 8 * M, sender_id: '2003', kind: 'text', text: 'noted po' },
    { id: 'm4', at: t0 + 12 * M, sender_id: '2004', kind: 'text', text: "copy, I'll be there" },
    { id: 'm5', at: t0 + 17 * M, sender_id: '2005', kind: 'text', text: 'Ako na po mag follow up sa Home Depot delivery bukas' },
    { id: 'm6', at: t0 + 19 * M, sender_id: '2002', kind: 'text', text: 'sorry late, confirmed for 9' },
  ] },
};
const ANALYSIS = {
  R1: { title: 'Who is tracking Home Depot order', type: 'Question', needs_reply: true, required: 'any', priority: 'Normal', task: null, follow_up_of: null },
  R2: { title: 'Confirm the walkthrough', type: 'Instruction', needs_reply: true, required: 'all', priority: 'Normal', task: null, follow_up_of: null },
};
const JUDGE = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(__dirname, 'judge-sample.json'), 'utf8')).results.map(r => [r.id, r]));
const mock = `<script>
(function(){
  const MODE = new URLSearchParams(location.search).get('mode');
  const GROUPS = ${JSON.stringify(groups)}, ANALYSIS = ${JSON.stringify(ANALYSIS)}, JUDGE = ${JSON.stringify(JUDGE)};
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
      onSnapshot(next) { const f = () => next(snapDoc(path)); subs.push(f); setTimeout(f, 20); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; },
    }; },
    collection(path) { return { onSnapshot(next) { const f = () => { const d = load(); const docs = Object.keys(d).filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).map(k => snapDoc(k)); next({ docs, size: docs.length, empty: !docs.length }); }; subs.push(f); setTimeout(f, 20); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; } }; },
  };
  const all = Object.values(GROUPS).flatMap(g => g.msgs);
  const reader = {
    status: () => ({ linked: true, connected: true, phone: '1000', messages_stored: all.length, groups_known: 1, last_message_at: Math.max(...all.map(m => m.at)), version: '1.0.2' }),
    list_groups: () => ({ groups: Object.entries(GROUPS).map(([id, g]) => ({ id, name: g.name, members: g.participants.length, message_count: g.msgs.length, last_message_at: Math.max(...g.msgs.map(m => m.at)) })), me: '1000' }),
    get_group: ({ group_id }) => { const g = GROUPS[group_id]; return { id: group_id, name: g.name, me: '1000', participants: g.participants }; },
    get_messages: ({ group_id, since }) => ({ messages: (GROUPS[group_id] || { msgs: [] }).msgs.filter(m => m.at >= (since || 0)), more: false, me: '1000' }),
  };
  const mcp = { async callTool(server, tool, input) { if (MODE === 'member') throw { code: 'server_not_connected', message: 'no host' }; return { content: [], payload: reader[tool](input || {}) }; } };
  window.__drafts = [];
  const REPLIES = ['"Lawrence, confirm you saw tomorrow\\u2019s schedule. I need that back by [time]."', 'Lawrence, where are we? Confirm the schedule back to me by [time].'];
  const sample = async (prompt, opts) => {
    window.__drafts.push({ prompt, opts: { modelTier: opts.modelTier, cache: opts.cache, signal: !!opts.signal } });
    if (MODE === 'denied') throw { code: 'not_granted', message: 'no' };
    const text = REPLIES[(window.__drafts.length - 1) % REPLIES.length];
    opts.onText({ text: text.slice(0, 12), delta: text.slice(0, 12) });
    await new Promise(r => setTimeout(r, 150));
    opts.onText({ text, delta: text.slice(12) });
    return { text, truncated: false };
  };
  window.__judged = [];
  sample.json = async prompt => {
    if (prompt.includes('"could_answer"')) {
      const items = JSON.parse(prompt.split('might be answering:\\n')[1].split('\\n\\nFor every message')[0]);
      window.__judged.push(items.map(i => i.id + ':' + i.could_answer.join('+')).join(' '));
      return { results: items.map(i => JUDGE[i.id]).filter(Boolean) };
    }
    const arr = JSON.parse(prompt.slice(prompt.lastIndexOf('[{')));
    return { results: arr.map(m => ({ id: m.id, ...(ANALYSIS[m.id] || { title: 'Chat', type: 'Chat', needs_reply: false, required: [], priority: 'Normal', task: null, follow_up_of: null }) })) };
  };
  const caps = { db, mcp, sample: MODE === 'nosample' ? null : sample,
    user: { canEdit: async () => true, isOwner: async () => true, can: async () => true, id: async () => 'u_laptop', profiles: async () => ({}) } };
  window.claude = { use: async n => { await new Promise(r => setTimeout(r, 30)); return caps[n] ?? null; } };
})();
</script>`;
const html = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${mock}${body}</body></html>`;
fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync('shots/e2e-judge.html', html);
const url = 'file://' + process.cwd() + '/shots/e2e-judge.html';
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  const open = async (mode, first) => {
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(url + '?mode=' + mode);
    if (first) await p.evaluate(g1 => { localStorage.clear(); localStorage.setItem('mockdb', JSON.stringify({ 'settings/tracking': { groups: [{ groupId: g1, groupName: 'Ops', bossIds: ['1000', '1001'] }], me: '1000' } })); }, G1);
    await p.reload(); await p.waitForTimeout(3000);
    await p.evaluate(() => { location.hash = 'messages'; }); await p.waitForTimeout(300);
    return p;
  };
  const rows = p => p.$$eval('.inset tbody tr', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()));

  const p = await open('laptop', true);
  const asked = await p.evaluate(() => window.__judged);
  check('Claude read the six replies once, with what each could answer', asked.length === 1 && asked[0] === 'm1:R1 m2:R1 m3:R1+R2 m4:R1+R2 m5:R1+R2 m6:R1+R2', asked.join(' / '));
  await p.click('[data-sel="R1"]'); await p.waitForTimeout(200);
  const r1 = await rows(p);
  check('Home Depot: answered by Vannessa, with the reason', r1.length === 1 && /Vannessa Replied 1 min I'm the one tracking it, Juan\. Vannessa says she is the one tracking the order/.test(r1[0]), r1.join(' || '));
  check('Home Depot: shows its task', (await text(p, '.read-grid')).includes('Track Home Depot order') && (await text(p, '.read-grid')).includes('Owner Vannessa'));
  await p.screenshot({ path: 'shots/judge-r1.png' });
  await p.click('[data-sel="R2"]'); await p.waitForTimeout(200);
  const r2 = await rows(p);
  check('walkthrough: Gio, Issy, era replied; Mark and Vannessa still owe', /2 pending/.test(await text(p, '[data-sel="R2"]'))
    && r2.filter(r => /Replied/.test(r)).map(r => r.split(' ')[1]).sort().join(',') === 'Gio,Issy,era'
    && r2.filter(r => /No response/.test(r)).map(r => r.split(' ')[1]).sort().join(',') === 'Mark,Vannessa', r2.join(' || '));
  check("era's reply is her late confirmation, not the internet update", r2.some(r => /era Replied 12 min sorry late, confirmed for 9/.test(r)));
  await p.screenshot({ path: 'shots/judge-r2.png', fullPage: true });
  await p.evaluate(() => { location.hash = 'tasks'; }); await p.waitForTimeout(300);
  const tasks = await p.$$eval('#v-tasks tbody tr', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  check('two tasks people took on in a reply', tasks.length === 2 && tasks.some(t => /Track Home Depot order.*Vannessa took it on in a reply.*Vannessa/.test(t)) && tasks.some(t => /Follow up Home Depot delivery.*Mark took it on in a reply.*Mark/.test(t)), tasks.join(' || '));
  await p.screenshot({ path: 'shots/judge-tasks.png' });
  const stored = await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('mockdb')); const k = Object.keys(d).find(x => x.endsWith('/extra/analysis')); return d[k] && d[k].replies ? Object.keys(d[k].replies).join(',') : 'none'; });
  check('readings saved with the page', stored === 'm1,m2,m3,m4,m5,m6', stored);

  // the next update doesn't ask again
  await p.click('#refresh'); await p.waitForTimeout(2500);
  check('not read twice', (await p.evaluate(() => window.__judged.length)) === 1);

  // another computer, no WhatsApp Reader: same answers from the saved copy
  const q = await open('member', false);
  await q.click('[data-sel="R2"]'); await q.waitForTimeout(200);
  check('other computer sees the same', /2 pending/.test(await text(q, '[data-sel="R2"]')) && /answered by Vannessa/.test(await text(q, '[data-sel="R1"]')));
  check('other computer asked Claude nothing', (await q.evaluate(() => window.__judged.length)) === 0);

  check('no page errors', !errs.length, errs.join(' || '));
  console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
  await b.close(); process.exit(fails.length ? 1 : 0);
})();
