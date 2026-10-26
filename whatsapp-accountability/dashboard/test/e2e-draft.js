// "Draft reply as Juan": what Claude is asked, the dialog, Copy, Write another, and who gets the button.
const { chromium } = require('playwright');
const fs = require('fs');
process.chdir(__dirname);
const body = fs.readFileSync(require('path').join(__dirname, '..', 'whatsapp-accountability.html'), 'utf8');
const M = 60000, t0 = Date.now() - 120 * M;
const G1 = '120363000000000001@g.us';
const P = (id, name) => ({ id, name, phone: '+' + id });
const groups = {
  [G1]: { name: 'Ops', participants: [P('1000', 'Seth'), P('1001', 'Juan'), P('1002', 'Mike'), P('1003', 'Lawrence')], msgs: [
    { id: 'A1', at: t0, sender_id: '1001', kind: 'text', text: 'Everyone confirm you saw the schedule for tomorrow' },
    { id: 'A2', at: t0 + 4 * M, sender_id: '1002', kind: 'text', text: 'Seen' },
    { id: 'A3', at: t0 + 10 * M, sender_id: '1001', kind: 'text', text: '@1002 send photos of site A by 5pm', mentions: ['1002'] },
    { id: 'A4', at: t0 + 40 * M, sender_id: '1002', kind: 'image', text: 'site A', quoted_id: 'A3' },
    { id: 'C1', at: t0 + 60 * M, sender_id: '1000', kind: 'text', text: 'Juan can you check the offer on 21 College Terrace?' },
  ] },
};
const ANALYSIS = {
  A1: { title: 'Confirm the schedule', type: 'Instruction', needs_reply: true, required: 'all', priority: 'Normal', task: null, follow_up_of: null },
  A3: { title: 'Site A photos', type: 'Instruction', needs_reply: true, required: ['1002'], priority: 'High', task: { title: 'Send site A photos', owner_id: '1002', due: null }, follow_up_of: null },
  C1: { title: 'Check the College Terrace offer', type: 'Question', needs_reply: true, required: ['1001'], priority: 'Normal', task: null, follow_up_of: null },
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
fs.writeFileSync('shots/e2e-draft.html', html);
const url = 'file://' + process.cwd() + '/shots/e2e-draft.html';
const fails = [];
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${got !== undefined ? ' | ' + got : ''}`); if (!ok) fails.push(label); };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errs = [];
  const open = async mode => {
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(url + '?mode=' + mode);
    await p.evaluate(g1 => { localStorage.clear(); localStorage.setItem('mockdb', JSON.stringify({ 'settings/tracking': { groups: [{ groupId: g1, groupName: 'Ops', bossIds: ['1000', '1001'] }], me: '1000' } })); }, G1);
    await p.reload(); await p.waitForTimeout(2500);
    await p.evaluate(() => { location.hash = 'messages'; }); await p.waitForTimeout(300);
    return p;
  };
  const last = p => p.evaluate(() => window.__drafts[window.__drafts.length - 1]);

  const p = await open('laptop');
  // Juan's instruction, Lawrence hasn't answered
  await p.click('[data-sel="A1"]'); await p.waitForTimeout(200);
  check('button shown', await p.isVisible('[data-action="open-draft"]'));
  await p.click('[data-action="open-draft"]'); await p.waitForTimeout(60);
  check('writing while busy', await p.$eval('#draft-text', t => t.readOnly && t.getAttribute('aria-busy') === 'true'));
  check('copy disabled while busy', await p.isDisabled('[data-action="draft-copy"]'));
  await p.waitForTimeout(400);
  let d = await last(p);
  check('style rules sent', d.prompt.includes('HOW JUAN WRITES') && d.prompt.includes('square brackets'));
  check('thread sent', d.prompt.includes('"Everyone confirm you saw the schedule for tomorrow"') && d.prompt.includes('- Mike, 4 min later: "Seen"') && /NO REPLY YET: Lawrence \(\d/.test(d.prompt));
  check('asks for a follow-up to Lawrence', /WRITE: A follow-up from Juan to Lawrence, who hasn.t answered after/.test(d.prompt), d.prompt.split('\n').pop());
  check('options', d.opts.modelTier === 'default' && d.opts.cache === false && d.opts.signal, JSON.stringify(d.opts));
  const v1 = await p.$eval('#draft-text', t => t.value);
  check('quotes stripped, draft shown', v1 === 'Lawrence, confirm you saw tomorrow’s schedule. I need that back by [time].', v1);
  check('says who it is for', (await p.textContent('#draft-box .dlg-h p')).includes('To Lawrence'));
  check('nothing written to storage', await p.evaluate(() => !Object.keys(JSON.parse(localStorage.getItem('mockdb'))).some(k => /draft/i.test(k))));
  await p.screenshot({ path: 'shots/draft-dialog.png' });
  // edit, then copy: the edited text is what gets copied
  await p.fill('#draft-text', v1.replace('[time]', '3pm'));
  await p.click('[data-action="draft-copy"]'); await p.waitForTimeout(150);
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  check('copies the edited text', clip.endsWith('by 3pm.'), clip);
  check('says copied', (await p.textContent('#draft-box .dlg-msg')).startsWith('Copied'));
  // write another
  await p.click('[data-action="draft-again"]'); await p.waitForTimeout(400);
  check('second draft', (await p.$eval('#draft-text', t => t.value)).startsWith('Lawrence, where are we?'), await p.evaluate(() => window.__drafts.length));
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  check('Escape closes', await p.$eval('#draft-dlg', e => e.hidden));

  // Seth asked Juan: the draft is Juan's answer to Seth
  await p.click('[data-sel="C1"]'); await p.waitForTimeout(200);
  await p.click('[data-action="open-draft"]'); await p.waitForTimeout(400);
  d = await last(p);
  check('answer to the person who asked Juan', d.prompt.includes("WRITE: Juan's answer to Seth, who asked him this."), d.prompt.split('\n').pop());
  await p.click('#draft-dlg', { position: { x: 5, y: 5 } }); await p.waitForTimeout(100);
  check('clicking outside closes', await p.$eval('#draft-dlg', e => e.hidden));

  // everyone answered: Juan acknowledges and gives the next step
  await p.click('[data-sel="A3"]'); await p.waitForTimeout(200);
  await p.click('[data-action="open-draft"]'); await p.waitForTimeout(400);
  d = await last(p);
  check('reply once everyone answered', d.prompt.includes('now that everyone has answered') && d.prompt.includes('TASK: Send site A photos'), d.prompt.split('\n').pop());
  await p.keyboard.press('Escape');

  // no Claude on this page: no button
  const q = await open('nosample');
  await q.click('[data-sel="A1"]'); await q.waitForTimeout(200);
  check('no button without Claude', !(await q.$('[data-action="open-draft"]')));

  // Claude not allowed: says how to fix it
  const r = await open('denied');
  await r.click('[data-sel="A1"]'); await r.waitForTimeout(200);
  await r.click('[data-action="open-draft"]'); await r.waitForTimeout(300);
  const msg = await r.textContent('#draft-box .dlg-msg');
  check('not allowed message', msg.includes('Permissions menu'), msg);
  check('copy disabled with no text', await r.isDisabled('[data-action="draft-copy"]'));

  check('no page errors', !errs.length, errs.join(' || '));
  console.log(fails.length ? `${fails.length} FAILED` : 'all checks passed');
  await b.close();
  process.exit(fails.length ? 1 : 0);
})();
