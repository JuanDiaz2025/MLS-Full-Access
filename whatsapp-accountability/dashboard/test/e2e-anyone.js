// A question anyone can answer: "who is tracking this?" is settled by the first answer.
const { chromium } = require('playwright');
const fs = require('fs');
process.chdir(__dirname);
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 60 * M;
const G1 = '120363000000000001@g.us';
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = {
  [G1]: { name: '972 Norton', participants: [P('1000', 'Seth'), P('1001', 'Juan Diaz'), P('2001', 'Vannessa'), P('2002', 'era'), P('2003', 'Gio'), P('2004', 'Issy')], msgs: [
    { id: 'Q1', at: t0, sender_id: '1001', kind: 'text', text: 'who is trackignt hsi' },
    { id: 'V1', at: t0 + 1 * M, sender_id: '2001', kind: 'text', text: "I'm the one tracking it, Juan." },
    { id: 'E1', at: t0 + 6 * M, sender_id: '2002', kind: 'text', text: 'Quick update: Internet service installed.' },
    { id: 'Q2', at: t0 + 10 * M, sender_id: '1001', kind: 'text', text: 'Anyone know where the ladder is?' },
    { id: 'Q3', at: t0 + 12 * M, sender_id: '1001', kind: 'text', text: 'Everyone confirm the walkthrough at 9' },
    { id: 'G1', at: t0 + 14 * M, sender_id: '2003', kind: 'text', text: 'Confirmed' },
    { id: 'I1', at: t0 + 20 * M, sender_id: '2004', kind: 'text', text: 'Ladder is in the garage' },
  ] },
};
const ANALYSIS = {
  Q1: { title: 'Who is tracking Home Depot order', type: 'Question', needs_reply: true, required: 'any', priority: 'Normal', task: null, follow_up_of: null },
  Q2: { title: 'Where is the ladder', type: 'Question', needs_reply: true, required: 'any', priority: 'Normal', task: null, follow_up_of: null },
  Q3: { title: 'Confirm the walkthrough', type: 'Instruction', needs_reply: true, required: 'all', priority: 'Normal', task: null, follow_up_of: null },
};
const mock = `<script>
(function(){
  const MODE = new URLSearchParams(location.search).get('mode');
  const GROUPS = ${JSON.stringify(groups)}, ANALYSIS = ${JSON.stringify(ANALYSIS)};
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
  const mcp = { async callTool(server, tool, input) { return { content: [], payload: reader[tool](input || {}) }; } };
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
  sample.json = async prompt => {
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
fs.writeFileSync('shots/e2e-anyone.html', html);
const url = 'file://' + process.cwd() + '/shots/e2e-anyone.html';
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1360, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url + '?mode=laptop');
  await p.evaluate(g1 => { localStorage.clear(); localStorage.setItem('mockdb', JSON.stringify({ 'settings/tracking': { groups: [{ groupId: g1, groupName: '972 Norton', bossIds: ['1000', '1001'] }], me: '1000' } })); }, G1);
  await p.reload(); await p.waitForTimeout(2500);

  // dashboard: only the everyone-message puts people behind
  const owes = await p.$$eval('#v-dashboard .card:nth-of-type(2) tbody tr td:first-child', xs => xs.map(x => x.innerText.trim()));
  // Gio confirmed, and Issy's later message counts for the everyone-message too
  check('people behind: only those who owe Q3', owes.map(n => n.split('\n').pop()).join(',') === 'Vannessa,era', owes.join(', '));
  const unresolved = await text(p, '#v-dashboard');
  check('Q2 listed as waiting for anyone', /Where is the ladder.*Anyone can answer.*Waiting for anyone/.test(unresolved));

  await p.evaluate(() => { location.hash = 'messages'; }); await p.waitForTimeout(300);
  const item = async id => text(p, `[data-sel="${id}"]`);
  check('Q1 answered in the list', /Answered/.test(await item('Q1')) && /answered by Vannessa/.test(await item('Q1')), await item('Q1'));
  check('Q2 waiting in the list', /Waiting for anyone/.test(await item('Q2')) && /anyone can answer/.test(await item('Q2')), await item('Q2'));
  check('Q3 still counts everyone', /2 pending/.test(await item('Q3')) && /2\/4 replied/.test(await item('Q3')), await item('Q3'));

  await p.click('[data-sel="Q1"]'); await p.waitForTimeout(200);
  const d1 = await text(p, '#v-messages .msgs > .card:nth-child(2)');
  check('Q1 needs one answer', d1.includes('Anyone (one answer is enough)') && d1.includes('Answer (one is enough)'));
  const rows1 = await p.$$eval('.inset tbody tr', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  check('Q1 shows only Vannessa', rows1.length === 1 && /Vannessa Replied 1 min/.test(rows1[0]), rows1.join(' || '));
  await p.screenshot({ path: 'shots/anyone-answered.png' });

  await p.click('[data-sel="Q2"]'); await p.waitForTimeout(200);
  check('Q2 nobody is blamed', !(await p.$('.inset tbody tr')) && (await text(p, '.any-wait')).includes('nobody has yet'), await text(p, '.any-wait'));
  check('Q2 flagged for a reminder', /Needs 2nd reminder/.test(await text(p, '.any-wait')));
  await p.click('[data-action="open-draft"]'); await p.waitForTimeout(400);
  const ask = await p.evaluate(() => window.__drafts[window.__drafts.length - 1].prompt.split('\n').pop());
  check('draft asks the whole group', /to the whole group: nobody has answered after .* one answer from anyone is enough/.test(ask), ask);
  await p.keyboard.press('Escape');
  await p.screenshot({ path: 'shots/anyone-waiting.png' });

  await p.click('[data-action="open-link"][data-pid="*"]'); await p.waitForTimeout(200);
  check('dialog title', (await text(p, '#link-h')) === 'Mark as answered');
  const opts = await p.$$eval('input[name="link-pick"]', xs => xs.map(x => x.closest('label').innerText.replace(/\s+/g, ' ').trim()));
  check('lists anyone in the group, with names, not managers', opts.length === 2 && /^Gio: Confirmed/.test(opts[0]) && /^Issy: Ladder is in the garage/.test(opts[1]), opts.join(' || '));
  await p.check('input[name="link-pick"][value="I1"]');
  await p.click('[data-action="link-save"]'); await p.waitForTimeout(900);
  check('Q2 answered by Issy', /answered by Issy/.test(await item('Q2')), await item('Q2'));
  const rows2 = await p.$$eval('.inset tbody tr', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()));
  check('linked answer shown with who linked it', rows2.length === 1 && /Issy/.test(rows2[0]) && /Linked by you/.test(rows2[0]), rows2.join(' || '));
  const saved = await p.evaluate(() => Object.entries(JSON.parse(localStorage.getItem('mockdb'))).filter(([k]) => k.startsWith('fixes/')).map(([k, v]) => k.split('/').pop() + '=' + v.person));
  check('stored under the person who answered', saved.length === 1 && /Q2~2004=2004/.test(saved[0]), saved.join(', '));

  // a wrong first answer can be swapped
  await p.click('[data-sel="Q1"]'); await p.waitForTimeout(200);
  await p.click('[data-action="open-link"][data-pid="*"]'); await p.waitForTimeout(200);
  await p.check('input[name="link-pick"][value="E1"]');
  await p.click('[data-action="link-save"]'); await p.waitForTimeout(900);
  check('Pick a different answer works', /answered by era/.test(await item('Q1')), await item('Q1'));

  check('no page errors', !errs.length, errs.join(' || '));
  console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
  await b.close(); process.exit(fails.length ? 1 : 0);
})();
