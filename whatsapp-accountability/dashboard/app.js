(function () {
  const DEFAULTS = { first: 15, second: 30, escalate: 60 };
  const READER = 'host:whatsapp-reader';
  const DAY_MS = 24 * 60 * MIN;
  // Before any real data has loaded, nothing is shown: no made-up team.
  const SAMPLE_NOW = Date.now();
  const SAMPLE = { people: [], messages: [], tasks: [] };

  let cfg = { ...DEFAULTS };
  let D = null, S = SAMPLE, NOW = SAMPLE_NOW, N = SAMPLE.people.length;
  const state = { view: 'dashboard', sel: null, taskFilter: 'open', groupFilter: 'all', senderFilter: 'all',
    setup: false, editGroup: null, setupBoss: null, setupNames: null, confirmRemove: null,
    // adding groups: the ones ticked, the search, then who gives instructions in each
    pickGroups: new Set(), groupQuery: '', groupSort: null, hideEmpty: true, confirmAll: 0, addManual: new Set(), giverQuery: '', addStep: null, addActive: null, addBoss: {}, addTemplate: null, addNote: '' };
  // how the group list is sorted is remembered on this computer
  try { const v = localStorage.getItem('wa-group-sort'); if (['new', 'active', 'name'].includes(v)) state.groupSort = v; } catch (_) {}
  try { if (localStorage.getItem('wa-hide-empty') === '0') state.hideEmpty = false; } catch (_) {}
  // where the numbers come from: 'sample', 'live' (WhatsApp Reader on this computer) or 'saved' (last copy kept in the page)
  const src = { mode: 'sample', S: SAMPLE, now: SAMPLE_NOW, updatedAt: null, groups: [] };
  const cap = { db: null, mcp: null, sample: null, user: null, perms: null, canEdit: null, isOwner: null, canWrite: null, me: null };
  // tracking: the groups being tracked, each with whose messages are instructions
  // givers: the default instruction-givers, ticked in every group they're in
  const saved = { tracking: null, legacySource: null, names: {}, givers: [], groups: {}, legacy: { meta: null, analysis: {}, days: {} },
    loaded: { tracking: false, source: false, legacyMeta: false, legacyAnalysis: false } };
  const subs = {};
  const live = { on: false, status: null, groups: null, groupInfo: null, groupInfos: {}, busy: false, again: false, lastSig: '', lastSync: 0,
    unwatch: null, diag: null, raws: {}, written: {}, writtenAnalysis: {}, writtenMeta: {}, lastMetaWrite: {}, lastMembersRead: {}, groupSig: {}, retryTimer: null,
    legacyCleared: false, sampleDenied: false, analyzing: 0, error: null, offCode: null };

  const VIEWS = {
    dashboard: { label: 'Dashboard', icon: 'grid', title: 'Dashboard', sub: 'Who hasn’t replied, what’s still open, and who needs a follow-up.' },
    messages: { label: 'Messages', icon: 'chat', title: 'Messages', sub: 'Every instruction and question sent to the group, with who replied and how fast.' },
    tasks: { label: 'Tasks', icon: 'tasks', title: 'Tasks', sub: 'Work the AI found in messages: who owns it, when it’s due, and whether it got done.' },
    reports: { label: 'Reports', icon: 'chart', title: 'Reports', sub: 'Patterns over the last 30 days, so accountability decisions rest on the record.' },
    email: { label: 'Email', icon: 'mail', title: 'Email', sub: 'Emails to the team: who answered, who hasn’t, and how fast. Nothing is sent from here.' },
    deadlines: { label: 'Deadlines', icon: 'cal', title: 'Deadlines', sub: 'Every deadline Juan set by email: who delivered, who is late, who is blocked. The deadline agent sends the chases; nothing is sent from here.' },
  };

  const ICON = {
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    tasks: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
    chart: '<path d="M5 20V11M11 20V5M17 20v-7M3 20h18"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.8-3.2 3.2-5 6-5s5.2 1.8 6 5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14c1.6.6 2.7 2.4 3 5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
    doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M9.5 12h6M9.5 15.5h6"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
    repeat: '<path d="M4 10a8 8 0 0 1 14-4l2 2M20 14a8 8 0 0 1-14 4l-2-2"/><path d="M20 4v4h-4M4 20v-4h4"/>',
    gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
    out: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    bellOff: '<path d="M8.5 5.3A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17"/><path d="M10 20.5a2 2 0 0 0 4 0M3.5 3.5l17 17"/>',
    pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
    cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  };
  const ic = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const initial = name => esc(String(name || '?').replace(/^\+/, '').slice(0, 1).toUpperCase());
  const who = name => `<span class="who"><span class="av" aria-hidden="true">${initial(name)}</span>${esc(name)}</span>`;

  const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const fmtClock = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const fmtDate = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const dayLabel = t => {
    const diff = Math.round((startOfDay(NOW) - startOfDay(t)) / DAY_MS);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff === -1) return 'Tomorrow';
    return new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const fmtWhen = t => `${dayLabel(t)}, ${fmtClock(t)}`;
  const fmtDur = ms => {
    const m = Math.max(0, Math.round(ms / MIN));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
    return plural(Math.floor(h / 24), 'day');
  };
  const fmtAgo = t => {
    const diff = Math.round((startOfDay(NOW) - startOfDay(t)) / DAY_MS);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : `${diff} days ago`;
  };

  const chip = (cls, label, icon) => `<span class="chip ${icon ? '' : 'dot '}${cls}">${icon ? ic(icon) : ''}${esc(label)}</span>`;
  // Nothing is ever sent. These only say what the person is due for.
  const stageChip = (s, m) => {
    if (s === 0) return chip('c-muted', `Waiting until ${fmtClock(m.at + cfg.first * MIN)}`);
    return [null, chip('c-warn', 'Needs 1st reminder'), chip('c-serious', 'Needs 2nd reminder'), chip('c-crit', 'Escalate to manager')][s];
  };
  // A question anyone can answer is open until the first answer, and then done.
  const statusChip = (m, icon) => m.waitingAny ? chip('c-warn', 'Waiting for anyone')
    : m.pending.length ? chip('c-warn', `${m.pending.length} pending`)
    : chip('c-good', m.anyone ? 'Answered' : 'All replied', icon);
  const replyCount = m => m.waitingAny ? 'anyone can answer' : m.anyone ? `answered by ${m.rows[0].name}` : `${m.responded}/${m.req.length} replied`;
  const replyNote = s => [`Within ${cfg.first} min`, `After ${cfg.first} min`, `After ${cfg.second} min`, `After ${cfg.escalate} min (missed)`][s];
  const TASK_TONE = { 'Completed': 'c-good', 'Completed late': 'c-warn', 'Overdue': 'c-crit', 'In progress': 'c-info', 'Acknowledged': 'c-muted', 'Not acknowledged': 'c-serious' };

  const tiles = list => `<div class="tiles">${list.map(t => `
    <div class="tile tone-${t.tone}"><div class="t-ic">${ic(t.icon)}</div>
      <div><div class="t-num">${t.value}</div><div class="t-lab">${esc(t.label)}</div></div>
      <div class="t-sub">${esc(t.sub)}</div></div>`).join('')}</div>`;

  const meter = (a, b) => `<span class="meter"><span class="meter-track"><span class="meter-fill" style="display:block;width:${b ? (a / b * 100).toFixed(1) : 0}%"></span></span><b>${a}/${b}</b></span>`;

  const evidence = t => {
    const e = t.evidence;
    if (!e) return '<span class="plain">None yet</span>';
    if (e.photos) {
      const shown = Math.min(e.photos, 3);
      return `<span class="ev" aria-label="${plural(e.photos, 'photo')}">${Array.from({ length: shown }, () => `<span class="ph">${ic('image')}</span>`).join('')}${e.photos > shown ? `<span class="ph more-ph">+${e.photos - shown}</span>` : ''}</span>`;
    }
    if (e.doc) return `<span class="ev-doc">${ic('doc')}${esc(e.doc)}</span>`;
    return `<span class="ev-reply">“${esc(e.reply)}”</span>`;
  };

  const snippet = text => { const line = String(text || '').split('\n')[0]; return line.length > 72 ? line.slice(0, 70).trimEnd() + '…' : line; };
  const msgLink = (m, label) => `<button class="rowlink" type="button" data-open-msg="${esc(m.id)}">${esc(label || m.title)}</button>`;
  // which group a message came from, shown only when several are tracked and all are on screen
  const groupTag = m => m && m.groupName && src.groups.length > 1 && state.groupFilter === 'all' ? `${esc(m.groupName)} · ` : '';
  // What shows before there is real data, and what to do about it.
  function noDataCard() {
    const loading = cap.db && (!saved.loaded.tracking || (trackedGroups().length && !trackedGroups().every(t => saved.groups[t.groupId] && saved.groups[t.groupId].loaded.meta)));
    const [title, body] = loading ? ['Loading\u2026', 'Getting the latest saved numbers.']
      : !trackedGroups().length ? ['No WhatsApp groups yet', 'No group is being tracked yet. On the computer running WhatsApp Reader, open this page in the Claude desktop app and pick the groups under Groups and names.']
      : ['No numbers yet', 'The groups are picked, but the computer running WhatsApp Reader hasn\u2019t saved its first update yet. It appears here once this page is open in the Claude desktop app on that computer.'];
    return `<div class="card"><div class="empty"><b>${esc(title)}</b><br>${esc(body)}</div></div>`;
  }
  const emptyCard = (title, body) => `<div class="card"><div class="empty"><b>${esc(title)}</b><br>${esc(body)}</div></div>`;

  // ---------------- Dashboard ----------------
  function viewDashboard() {
    const pp = D.pendingPeople;
    const peopleRows = pp.map(p => {
      const top = p.pending[0];
      const extra = p.pending.length - 1;
      return `<tr><td>${who(p.name)}</td>
        <td>${msgLink(top.msg)}${extra ? ` <span class="more">+${extra} more</span>` : ''}<span class="sub">${groupTag(top.msg)}Sent ${esc(fmtWhen(top.msg.at))}</span></td>
        <td class="num">${fmtDur(top.waiting)}</td>
        <td>${stageChip(top.stage, top.msg)}</td></tr>`;
    }).join('');
    const unresolvedRows = D.unresolved.map(m => `<tr>
        <td>${msgLink(m)}<span class="sub">${groupTag(m)}${esc(m.kind)}${m.priority === 'High' ? ' · High priority' : ''}${(m.chases || []).length ? ` · followed up ${m.chases.length}×` : ''}</span></td>
        <td class="nowrap">${esc(fmtWhen(m.at))}</td>
        <td>${m.waitingAny ? `<span class="plain">Anyone can answer · ${fmtDur(NOW - m.at)} so far</span>` : meter(m.responded, m.req.length)}</td>
        <td>${statusChip(m)}</td></tr>`).join('');
    const overdueRows = D.overdue.sort((a, b) => a.due - b.due).map(t => `<tr>
        <td>${msgLink(t.from, t.title)}<span class="sub">Asked ${esc(fmtWhen(t.from.at))}</span></td>
        <td>${who(t.ownerName)}</td>
        <td class="nowrap">${esc(fmtWhen(t.due))}<span class="sub">${fmtDur(NOW - t.due)} late</span></td>
        <td>${t.ackAt ? chip('c-muted', 'Acknowledged') : chip('c-serious', 'Never acknowledged')}</td></tr>`).join('');

    return tiles([
      { tone: 'crit', icon: 'users', value: pp.length, label: 'No response', sub: N ? `${Math.round(pp.length / N * 100)}% of ${plural(N, 'person', 'people')} owe a reply` : 'Nobody to track yet' },
      { tone: 'warn', icon: 'clock', value: D.unresolved.length, label: 'Unresolved messages', sub: 'Still waiting on replies' },
      { tone: 'crit', icon: 'alert', value: D.overdue.length, label: 'Overdue tasks', sub: 'Past their deadline' },
      { tone: 'info', icon: 'flag', value: D.followUp, label: 'Need a follow-up', sub: `${plural(D.toEscalate, 'person', 'people')} to escalate to a manager` },
    ]) + `
    <div class="card" style="margin-top:20px">
      <div class="card-h"><h2>People who haven’t replied</h2><span class="hint">Longest wait first</span></div>
      ${pp.length ? `<div class="tw"><table class="t"><thead><tr><th>Name</th><th>Waiting on</th><th>Waiting</th><th>Follow-up</th></tr></thead><tbody>${peopleRows}</tbody></table></div>`
        : '<div class="empty">Everyone has replied to every message.</div>'}
    </div>
    <div class="card" style="margin-top:20px">
        <div class="card-h"><h2>Unresolved messages</h2><a class="link" href="#messages">All messages</a></div>
        ${D.unresolved.length ? `<div class="tw"><table class="t"><thead><tr><th>Message</th><th>Sent</th><th>Replies</th><th>Status</th></tr></thead><tbody>${unresolvedRows}</tbody></table></div>`
          : '<div class="empty">No message is waiting on a reply.</div>'}
    </div>
    <div class="card" style="margin-top:20px">
        <div class="card-h"><h2>Overdue tasks</h2><a class="link" href="#tasks">All tasks</a></div>
        ${D.overdue.length ? `<div class="tw"><table class="t"><thead><tr><th>Task</th><th>Owner</th><th>Was due</th><th>Owner replied?</th></tr></thead><tbody>${overdueRows}</tbody></table></div>`
          : '<div class="empty">No task is past its deadline.</div>'}
    </div>`;
  }

  // ---------------- Messages ----------------
  function viewMessages() {
    if (!D.messages.length) {
      return emptyCard('No instructions yet', src.mode === 'sample' ? 'Nothing to show.'
        : 'Messages from the people giving instructions that ask others to do or answer something will show here.')
        + (removedCount() ? `<p class="hint-line">${removedLink()}</p>` : '');
    }
    if (!state.sel || !D.messages.find(m => m.id === state.sel)) {
      state.sel = (D.unresolved.slice().sort((a, b) => b.pending.length - a.pending.length)[0] || D.messages[0]).id;
    }
    let lastDay = null;
    const items = D.messages.map(m => {
      const day = dayLabel(m.at);
      const head = day !== lastDay ? `<div class="mday">${esc(day)}</div>` : '';
      lastDay = day;
      const open = m.pending.length > 0 || m.waitingAny;
      return head + `<button class="mitem${open ? ' open' : ''}" type="button" data-sel="${esc(m.id)}" aria-current="${m.id === state.sel}">
        <span class="m-ic">${ic(open ? 'clock' : 'check')}</span>
        <span class="m-t">${esc(m.title)}</span>
        ${statusChip(m)}
        <span class="m-s">${groupTag(m)}${esc(fmtClock(m.at))} · ${esc(replyCount(m))}${(m.chases || []).length ? ` · followed up ${m.chases.length}×` : ''}</span></button>`;
    }).join('');

    const m = D.messages.find(x => x.id === state.sel);
    const task = m.task ? D.tasks.find(t => t.id === m.task) : null;
    const nameById = id => (D.people.find(p => p.id === id) || {}).name || id;
    const reqLabel = m.anyone ? 'Anyone (one answer is enough)' : m.required === 'all' || m.everyone ? `Everyone (${m.req.length})` : m.req.map(nameById).join(', ');
    const chases = m.chases || [];
    const chaseHtml = chases.length ? `<div class="chases"><div class="chases-h">${ic('repeat')}${esc(m.senderName || 'You')} followed up ${chases.length === 1 ? 'once' : chases.length + ' times'}</div>
        ${chases.map(c => `<div class="chase"><span>${esc(c.text)}</span><time>${esc(fmtClock(c.at))}</time></div>`).join('')}</div>` : '';
    const canLink = canLinkReplies();
    const linkedNote = r => {
      if (!r.linked) return '';
      const undo = canLink ? ` \u00B7 <button class="link" type="button" data-action="unlink" data-msg="${esc(m.id)}" data-pid="${esc(r.pid)}">Remove</button>` : '';
      return `<span class="sub">Linked by ${esc(linkerName(r.linked.by))}${r.linked.on ? ` on ${esc(fmtWhen(r.linked.on))}` : ''}${undo}</span>`;
    };
    const rows = m.rows.slice().sort((a, b) => (a.replied - b.replied) || (a.replied ? a.delay - b.delay : a.name.localeCompare(b.name))).map(r => `<tr>
        <td>${who(r.name)}</td>
        <td>${r.replied ? chip('c-good', 'Replied', 'check') : chip('c-crit', 'No response')}</td>
        <td class="num">${r.replied ? fmtDur(r.delay) : `<span class="plain">${fmtDur(r.waiting)} so far</span>`}</td>
        <td>${r.replied ? esc(r.text) + (r.why && !r.linked ? `<span class="sub why">${ic('spark')}${esc(r.why)}</span>` : '') + linkedNote(r)
          : canLink ? `<button class="btn small" type="button" data-action="open-link" data-msg="${esc(m.id)}" data-pid="${esc(r.pid)}">Mark as replied</button>`
          : '<span class="plain">None</span>'}</td>
        <td>${r.replied ? `<span class="plain">${replyNote(r.stage)}</span>` : stageChip(r.stage, m)}</td></tr>`).join('');

    return `<div class="msgs">
      <div class="card"><div class="card-h"><h2>Sent to the group</h2><span class="hint">${plural(D.messages.length, 'message')}, last 30 days${removedCount() ? ' \u00B7 ' + removedLink() : ''}</span></div>
        <div class="mlist" id="mlist">${items}</div></div>
      <div class="card"><div class="card-b">
        <div class="mhead"><div><h2>${esc(m.title)}</h2><p>${esc(fmtWhen(m.at))} · ${groupTag(m)}Sent by ${esc(m.senderName || 'Juan')}</p></div>
          <div class="mhead-a">${statusChip(m, 'check')}${draftButton(m)}${deleteButton(m)}</div></div>
        <div class="bubble">${esc(m.text)}<span class="b-time">${esc(fmtClock(m.at))}</span></div>
        ${chaseHtml}
        <div class="read"><div class="read-cap">${ic('spark')}${m.by === 'rules' ? 'Read with simple rules, because Claude wasn’t available' : 'What the AI picked out of this message'}</div><dl class="read-grid">
          <div><dt>Type</dt><dd>${esc(m.kind)}</dd></div>
          <div><dt>Needs a reply from</dt><dd>${esc(reqLabel)}</dd></div>
          <div><dt>Task</dt><dd>${task ? `${esc(task.title)}<span>Owner ${esc(task.ownerName)} · ${task.due != null ? 'due ' + esc(fmtWhen(task.due)) : 'no deadline given'}</span>` : 'None'}</dd></div>
          <div><dt>Priority</dt><dd>${esc(m.priority)}</dd></div>
        </dl></div>
        ${m.anyone ? `<div class="subh"><h3>Answer (one is enough)</h3>${canLink ? `<button class="${m.waitingAny ? 'btn small' : 'link'}" type="button" data-action="open-link" data-msg="${esc(m.id)}" data-pid="*">${m.waitingAny ? 'Mark as answered' : 'Pick a different answer'}</button>` : ''}</div>` : `<div class="subh"><h3>Replies (${m.req.length} required)</h3>
          <span class="tally"><span class="ok">${m.responded} replied</span><span class="no">${m.pending.length} pending</span></span></div>`}
        ${m.waitingAny ? `<div class="inset any-wait"><p>Anyone in the group can answer this, and nobody has yet. ${fmtDur(NOW - m.at)} so far.</p>${m.stage ? stageChip(m.stage, m) : ''}</div>`
          : `<div class="inset tw"><table class="t"><thead><tr><th>Name</th><th>Status</th><th>Response time</th><th>Reply</th><th>Follow-up</th></tr></thead><tbody>${rows}</tbody></table></div>`}
      </div></div>
    </div>`;
  }

  // ---------------- Tasks ----------------
  function viewTasks() {
    const order = { 'Overdue': 0, 'Not acknowledged': 1, 'Acknowledged': 2, 'In progress': 3, 'Completed late': 4, 'Completed': 5 };
    const isOpen = t => !t.status.startsWith('Completed');
    const dueKey = t => t.due == null ? Infinity : t.due;
    const list = D.tasks.filter(t => state.taskFilter === 'all' ? true : state.taskFilter === 'open' ? isOpen(t) : !isOpen(t))
      .sort((a, b) => isOpen(a) && isOpen(b) ? (order[a.status] - order[b.status]) || (dueKey(a) - dueKey(b)) : isOpen(a) !== isOpen(b) ? (isOpen(a) ? -1 : 1) : (b.doneAt || 0) - (a.doneAt || 0));
    const counts = { open: D.tasks.filter(isOpen).length, done: D.tasks.filter(t => !isOpen(t)).length };
    const rows = list.map(t => {
      let when = '';
      if (t.status === 'Overdue') when = `${fmtDur(NOW - t.due)} late`;
      else if (isOpen(t)) when = t.due != null ? `in ${fmtDur(t.due - NOW)}` : '';
      else when = t.status === 'Completed late' ? `done ${fmtDur(t.doneAt - t.due)} late` : `done ${esc(fmtWhen(t.doneAt))}`;
      return `<tr>
        <td><b>${esc(t.title)}</b></td>
        <td class="from">${msgLink(t.from, '“' + snippet(t.from.text) + '”')}<span class="sub">${groupTag(t.from)}${esc(fmtWhen(t.from.at))} · from ${esc(t.from.senderName || '')}${t.claimed ? ` · ${esc(t.ownerName)} took it on in a reply` : ''}</span></td>
        <td>${who(t.ownerName)}</td>
        <td class="nowrap">${t.due != null ? esc(fmtWhen(t.due)) : '<span class="plain">No deadline</span>'}<span class="sub">${when}</span></td>
        <td>${chip(TASK_TONE[t.status], t.status)}</td>
        <td>${evidence(t)}</td></tr>`;
    }).join('');
    return `<div class="card">
      <div class="card-h"><h2>Tasks</h2>
        <label class="hint" for="task-filter" style="display:flex;align-items:center;gap:8px">Show
          <select class="sel" id="task-filter">
            <option value="open"${state.taskFilter === 'open' ? ' selected' : ''}>Open (${counts.open})</option>
            <option value="done"${state.taskFilter === 'done' ? ' selected' : ''}>Completed (${counts.done})</option>
            <option value="all"${state.taskFilter === 'all' ? ' selected' : ''}>All (${D.tasks.length})</option>
          </select></label></div>
      ${list.length ? `<div class="tw"><table class="t"><thead><tr><th>Task</th><th>From message</th><th>Owner</th><th>Deadline</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">No tasks to show.</div>'}
    </div>`;
  }

  // ---------------- Reports ----------------
  function viewReports() {
    const sent = D.messages.length;
    const c = D.completion;
    const rate = c.due ? Math.round(c.done / c.due * 100) : null;

    const maxMiss = Math.max(1, ...D.repeat.map(p => p.missed));
    const missBars = D.repeat.map(p => `
      <div class="bar-row" tabindex="0" data-tip-t="${esc(p.name)}" data-tip="${esc(`${p.missed} of ${p.required} required replies came after escalation or not at all. Last missed: ${fmtAgo(p.lastMissed).toLowerCase()}.`)}">
        ${who(p.name)}
        <div class="bar-track"><div class="bar" style="width:${(p.missed / maxMiss * 100).toFixed(1)}%;background:var(--crit)"></div></div>
        <div class="bar-val">${plural(p.missed, 'miss', 'misses')}<span>${esc(fmtAgo(p.lastMissed))}</span></div>
      </div>`).join('');

    const chasedList = D.people.filter(p => p.chased > 0).sort((a, b) => b.chased - a.chased);
    const maxChase = Math.max(1, ...chasedList.map(p => p.chased));
    const chaseBars = chasedList.map(p => `
      <div class="bar-row" tabindex="0" data-tip-t="${esc(p.name)}" data-tip="${esc(`${p.name} had to be followed up ${p.chased === 1 ? 'once' : p.chased + ' times'} before answering, in the last 30 days.`)}">
        ${who(p.name)}
        <div class="bar-track"><div class="bar" style="width:${(p.chased / maxChase * 100).toFixed(1)}%;background:var(--serious)"></div></div>
        <div class="bar-val">${p.chased}×</div>
      </div>`).join('');
    const speed = D.people.filter(p => p.avg != null).sort((a, b) => b.avg - a.avg);
    const top = Math.max(cfg.escalate, ...speed.map(p => p.avg / MIN)) * 1.06;
    const tone = m => m < cfg.first ? 'var(--good)' : m < cfg.escalate ? 'var(--warn)' : 'var(--crit)';
    const speedBars = speed.map(p => {
      const m = p.avg / MIN;
      return `<div class="bar-row" tabindex="0" data-tip-t="${esc(p.name)}" data-tip="${esc(`Average ${fmtDur(p.avg)} to reply across ${plural(p.delays.length, 'reply', 'replies')}. ${p.pending.length ? `Owes ${plural(p.pending.length, 'reply', 'replies')} right now.` : 'Nothing pending.'}`)}">
        ${who(p.name)}
        <div class="bar-track"><span class="mark" style="left:${(cfg.first / top * 100).toFixed(1)}%"></span><span class="mark" style="left:${(cfg.escalate / top * 100).toFixed(1)}%"></span>
          <div class="bar" style="width:${(m / top * 100).toFixed(1)}%;background:${tone(m)}"></div></div>
        <div class="bar-val">${fmtDur(p.avg)}</div></div>`;
    }).join('');

    const weekCols = D.weeks.map(w => {
      const pct = w.rate == null ? 0 : Math.round(w.rate * 100);
      const label = `${fmtDate(w.start)}–${fmtDate(w.end - DAY_MS)}`;
      return { label, html: `<div class="col" tabindex="0" data-tip-t="${esc(label)}" data-tip="${w.n ? `${w.ok} of ${w.n} required replies came before escalation.` : 'No replies were due this week.'}"><span class="cv">${w.rate == null ? '–' : pct + '%'}</span><div class="cbar" style="height:${(pct / 100 * 130).toFixed(0)}px"></div></div>` };
    });

    const owners = D.owners.slice().sort((a, b) => b.overdue - a.overdue || b.late - a.late || a.name.localeCompare(b.name));
    const ownerRows = owners.map(o => `<tr><td>${who(o.name)}</td><td class="num">${o.total}</td><td class="num">${o.ontime}</td>
      <td class="num">${o.late ? chip('c-warn', o.late) : '0'}</td><td class="num">${o.overdue ? chip('c-crit', o.overdue) : '0'}</td><td class="num">${o.open}</td></tr>`).join('');

    return tiles([
      { tone: 'crit', icon: 'repeat', value: D.repeat.length, label: 'Repeat non-responders', sub: 'Missed 2 or more replies' },
      { tone: 'info', icon: 'gauge', value: D.avgAck != null ? `${Math.round(D.avgAck / MIN)}<small>min</small>` : '–', label: 'Avg. time to acknowledge', sub: 'From message to first reply' },
      { tone: 'good', icon: 'check', value: rate != null ? `${rate}<small>%</small>` : '–', label: 'Task completion rate', sub: c.due ? `${c.done} of ${c.due} due tasks done, ${c.late} late` : 'No tasks due yet' },
      { tone: 'warn', icon: 'clock', value: D.unresolved.length, label: 'Unresolved messages', sub: `Out of ${sent} sent in 30 days` },
    ]) + `
    <div class="grid2" style="margin-top:20px">
      <div class="stack"><div class="card"><div class="card-h"><h2>Repeat non-responders</h2><span class="hint">Last 30 days</span></div>
        <div class="card-b">${missBars ? `<div class="bars">${missBars}</div>
          <p class="legend">A miss is a reply that didn’t arrive before the ${cfg.escalate}-minute escalation point.</p>`
          : '<div class="empty">Nobody missed more than one reply in the last 30 days.</div>'}</div></div>
      <div class="card"><div class="card-h"><h2>Times people had to be chased</h2><span class="hint">Last 30 days</span></div>
        <div class="card-b">${chaseBars ? `<div class="bars">${chaseBars}</div>
          <p class="legend">Each follow-up counts against the people who still hadn’t answered when it was sent.</p>`
          : '<div class="empty">Nobody had to be chased.</div>'}</div></div>
      <div class="card"><div class="card-h"><h2>Replies before escalation, by week</h2><span class="hint">Share of required replies</span></div>
        <div class="card-b"><div class="cols">${weekCols.map(w => w.html).join('')}</div>
          <div class="col-x">${weekCols.map(w => `<span>${esc(w.label)}</span>`).join('')}</div></div></div></div>
      <div class="card"><div class="card-h"><h2>Response time by person</h2><span class="hint">Average, last 30 days</span></div>
        <div class="card-b">${speedBars ? `
          <div class="scale-head" aria-hidden="true"><span></span><span class="marks"><span style="left:${(cfg.first / top * 100).toFixed(1)}%">${cfg.first}m</span><span style="left:${(cfg.escalate / top * 100).toFixed(1)}%">${cfg.escalate}m escalation</span></span><span></span></div>
          <div class="bars">${speedBars}</div>
          <div class="legend"><span><i style="background:var(--good)"></i>Under ${cfg.first} min</span><span><i style="background:var(--warn)"></i>${cfg.first} to ${cfg.escalate} min</span><span><i style="background:var(--crit)"></i>${cfg.escalate} min or more</span></div>`
          : '<div class="empty">No replies yet.</div>'}
        </div></div>
    </div>
    <div class="card" style="margin-top:20px"><div class="card-h"><h2>Task follow-through</h2><span class="hint">By owner, last 30 days</span></div>
        ${ownerRows ? `<div class="tw"><table class="t"><thead><tr><th>Owner</th><th>Tasks</th><th>On time</th><th>Late</th><th>Overdue</th><th>Open</th></tr></thead><tbody>${ownerRows}</tbody></table></div>`
          : '<div class="empty">No tasks yet.</div>'}</div>` + emailReportCard();
  }

  // ---------------- choosing groups (owner, on the computer running WhatsApp Reader) ----------------
  // The groups being tracked. Older pages saved a single group as settings/source.
  const trackedGroups = () => saved.tracking ? (saved.tracking.groups || [])
    : saved.legacySource ? [{ groupId: saved.legacySource.groupId, groupName: saved.legacySource.groupName, bossIds: saved.legacySource.bossIds || [] }] : [];
  const trackingKnown = () => !cap.db || (saved.loaded.tracking && saved.loaded.source);
  const needsSetup = () => live.on && (!live.status || !live.status.linked || (!trackedGroups().length && trackingKnown() && !state.skipSetup) || state.setup);
  const looksLikeNumber = n => !n || /^\+?[\d\s()-]+$/.test(n);
  const nameFor = (id, fallback) => saved.names[id] || (looksLikeNumber(fallback) ? (fallback || '+' + id) : fallback);

  // Who gives the instructions in one group, and names. inputName tells the
  // change handler which form the ticks belong to.
  function giversBlock(g, boss, inputName, afterGivers) {
    const givers = `<div class="choices">${g.participants.map(p => `
        <label class="choice"><input type="checkbox" name="${inputName}" data-gid="${esc(g.id)}" id="b-${esc(p.id)}" value="${esc(p.id)}"${boss.has(p.id) ? ' checked' : ''}>
          <span><b>${esc(nameFor(p.id, p.name))}${p.id === g.me ? ' (this phone)' : ''}</b><span class="sub">${esc(p.phone || 'Phone number hidden by WhatsApp')}</span></span></label>`).join('')}</div>`;
    const nameValue = p => (state.setupNames && p.id in state.setupNames) ? state.setupNames[p.id]
      : saved.names[p.id] || (looksLikeNumber(p.name) ? '' : p.name);
    const nameRows = g.participants.map(p => `
        <label class="name-row" for="n-${esc(p.id)}"><span class="sub">${esc(p.phone || 'Phone number hidden by WhatsApp')}${p.id === g.me ? ' (this phone)' : ''}</span>
          <input class="name-in" type="text" id="n-${esc(p.id)}" data-name-for="${esc(p.id)}" value="${esc(nameValue(p))}" placeholder="Name" maxlength="60" autocomplete="off"></label>`).join('');
    const left = g.participants.filter(p => !boss.has(p.id));
    // a group where everyone gives instructions has nobody to track
    const who = !boss.size ? '<p class="plain">Tick at least one person who gives instructions.</p>'
      : !left.length ? '<p class="warn">Everyone is ticked. Messages to everyone won\u2019t be tracked, only what one instruction-giver asks another by name. Untick the people who should reply.</p>'
      : `<p class="plain">Tracked for replies: ${esc(left.map(p => nameFor(p.id, p.name)).join(', '))} (${plural(left.length, 'person', 'people')})${boss.size > 1 ? '. The ticked people are tracked too when one of them asks another by name.' : ''}</p>`;
    return `<h3>Who gives the instructions in “${esc(g.name || 'this group')}”?</h3>
      <p class="plain">Tick only the people who give instructions, for example the CEO and the COO. Leave everyone who should reply unticked: they are the ones tracked.</p>${givers}${who}${afterGivers || ''}
      <h3>Names</h3><p class="plain">Optional. Shown on the dashboard instead of phone numbers, in every group.</p><div class="names">${nameRows}</div>`;
  }

  // Editing one tracked group.
  function groupForm(g, action, label) {
    const boss = state.setupBoss || new Set();
    const ready = boss.size;
    return `${giversBlock(g, boss, 'setup-boss')}
      <div class="dlg-f" style="padding:0;margin-top:16px">
        <button class="btn" type="button" data-action="cancel-edit">Cancel</button>
        <button class="btn primary" type="button" data-action="${action}"${ready ? '' : ' disabled'}>${label}</button>
      </div>`;
  }

  // " · tracking 2 people", from the last member list read for that group
  function trackedCount(t) {
    const raw = live.raws[t.groupId] || (savedGroupData(t.groupId) || {}).meta;
    if (!raw || !raw.participants) return '';
    const n = raw.participants.filter(p => !(t.bossIds || []).includes(p.id)).length;
    const since = t.clearedAt ? ` \u00B7 counting since ${fmtWhen(t.clearedAt)}` : '';
    return (n ? ` \u00B7 tracking ${plural(n, 'person', 'people')}` : ' \u00B7 everyone here gives instructions, so only what they ask each other by name is tracked') + since;
  }

  function viewSetup() {
    const st = live.status;
    if (!st || !st.linked) {
      return `<div class="card setup"><div class="card-b">
        <h2>${ic('link')}Link WhatsApp Reader to your phone</h2>
        <p>WhatsApp Reader is running on this computer but isn’t linked to a phone yet.</p>
        <ol class="steps">
          <li>Close the Claude desktop app.</li>
          <li>Double-click <b>whatsapp-reader.exe</b> in its folder.</li>
          <li>On your phone: WhatsApp → Settings → Linked devices → Link a device, and scan the code.</li>
          <li>Open the Claude desktop app and this page again.</li>
        </ol>
        <button class="btn" type="button" data-action="recheck">Check again</button>
      </div></div>`;
    }
    const tracked = trackedGroups();
    const g = live.groupInfo;
    const loaded = id => g && g.id === id;
    const allNames = id => (live.raws[id] ? nameIndex({ ...live.raws[id], overrides: saved.names }) : (x => nameFor(x, '+' + x)));

    const trackedRows = tracked.map(t => {
      const nameOf = allNames(t.groupId);
      const editing = state.editGroup === t.groupId;
      return `<div class="tracked${editing ? ' editing' : ''}">
        <div class="tracked-h"><div><b>${esc(t.groupName || 'Unnamed group')}</b>
          <span class="sub">Instructions from ${esc((t.bossIds || []).map(nameOf).join(', ') || 'nobody yet')}${trackedCount(t)}</span></div>
          ${editing ? '' : `<div class="tracked-a">
            <button class="btn small" type="button" data-action="edit-group" data-gid="${esc(t.groupId)}">Edit</button>
            <button class="btn small danger" type="button" data-action="remove-group" data-gid="${esc(t.groupId)}">${state.confirmRemove === t.groupId ? 'Click again to stop' : 'Stop tracking'}</button></div>`}</div>
        ${editing ? (loaded(t.groupId) ? groupForm(g, 'save-group', 'Save') : '<p class="plain">Loading members…</p>') : ''}
      </div>`;
    }).join('');

    const others = untrackedGroups();
    const adding = !state.editGroup;
    const head = `<div class="setup-top"><h2>${ic('link')}Groups to track</h2>
        <button class="btn small" type="button" data-action="leave-setup">Back to dashboard</button></div>
      <p>WhatsApp Reader is linked to +${esc(st.phone)}. It only reads; nothing is ever sent.</p>`;
    const msg = `<p class="dlg-msg err" id="setup-msg" role="status">${esc(live.setupError || '')}</p>`;
    if (adding && state.addStep === 'setup' && state.pickGroups.size) {
      return `<div class="card setup"><div class="card-b">${head}${addFlow(tracked.length)}${msg}</div></div>`;
    }
    const q = state.groupQuery.trim().toLowerCase();
    // groups with nobody left in them (the phone left, or the group was deleted) can be hidden
    const empty = x => !(x.members > 0);
    const match = x => !(state.hideEmpty && empty(x)) && (!q || (x.name || '').toLowerCase().includes(q));
    const shown = others.filter(match).length;
    const emptyCount = others.filter(empty).length;
    const listed = state.hideEmpty ? others.length - emptyCount : others.length;
    const n = state.pickGroups.size;
    const pick = live.groups == null ? '<p class="plain">Loading your groups…</p>'
      : !others.length ? '<p class="plain">Every group on the linked phone is already tracked.</p>'
      : `<div class="pick-tools">
          <input class="name-in search-in" type="search" id="group-q" value="${esc(state.groupQuery)}" placeholder="Search groups" aria-label="Search groups" autocomplete="off">
          <label class="sort-l" for="group-sort">Sort
            <select class="sel" id="group-sort">
              <option value="new"${groupSort() === 'new' ? ' selected' : ''}${haveCreated() ? '' : ' disabled'}>Newest groups${haveCreated() ? '' : ' (update WhatsApp Reader)'}</option>
              <option value="active"${groupSort() === 'active' ? ' selected' : ''}>Recent activity</option>
              <option value="name"${groupSort() === 'name' ? ' selected' : ''}>Name A\u2013Z</option>
            </select></label>
          <label class="check-l"><input type="checkbox" id="hide-empty"${state.hideEmpty ? ' checked' : ''}>Hide groups with 0 members${emptyCount ? ` (${emptyCount})` : ''}</label>
          <span class="plain" id="group-q-count">${esc(groupCountText(shown, listed))}</span>
          <button class="btn small" type="button" data-action="pick-all" id="pick-all"${shown ? '' : ' disabled'}>${esc(selectAllText(shown))}</button>
        </div>
        <div class="choices" id="group-choices" aria-label="Groups">${others.map(x => `
          <label class="choice" data-gname="${esc((x.name || '').toLowerCase())}"${empty(x) ? ' data-empty="1"' : ''}${match(x) ? '' : ' hidden'}><input type="checkbox" name="pick-group" id="g-${esc(x.id)}" value="${esc(x.id)}"${state.pickGroups.has(x.id) ? ' checked' : ''}>
            <span><b>${esc(x.name || 'Unnamed group')}</b><span class="sub">${x.created_at > 0 ? `Created ${esc(createdDay(x.created_at))} \u00B7 ` : ''}${plural(x.members, 'member')} · ${plural(x.message_count, 'message')} saved${x.last_message_at > 0 ? ` · last ${esc(fmtWhen(x.last_message_at))}` : ''}</span></span></label>`).join('')}</div>
        <p class="plain" id="group-q-none"${shown ? ' hidden' : ''}>No group matches that search.</p>
        <div class="pick-bar" id="pick-bar">
          <span id="pick-count">${esc(pickCountText(n))}</span>
          <span class="pick-bar-a">
            <button class="btn" type="button" data-action="pick-clear" id="pick-clear"${n ? '' : ' disabled'}>Clear</button>
            <button class="btn primary" type="button" data-action="pick-next" id="pick-next"${n ? '' : ' disabled'}>Next: who gives instructions</button>
          </span>
        </div>`;

    return `<div class="card setup"><div class="card-b">${head}
      ${tracked.length ? `<div class="tracked-list">${trackedRows}</div>` : ''}
      ${adding ? `<h3>${tracked.length ? 'Add more groups' : 'Pick the groups to track'}</h3>${pick}` : ''}
      ${msg}
      ${tracked.length && !state.editGroup && !n ? '<div class="dlg-f" style="padding:0"><button class="btn primary" type="button" data-action="done-setup">Done</button></div>' : ''}
    </div></div>`;
  }

  // ---------------- adding several groups at once ----------------
  const trackedIds = () => new Set(trackedGroups().map(t => t.groupId));
  // Newest groups needs WhatsApp Reader 1.0.2 or later, which reports when each group was created.
  const haveCreated = () => (live.groups || []).some(x => x.created_at > 0);
  const groupSort = () => { const s = state.groupSort || 'new'; return s === 'new' && !haveCreated() ? 'active' : s; };
  const SORTS = {
    new: (a, b) => (b.created_at || 0) - (a.created_at || 0) || (b.last_message_at || 0) - (a.last_message_at || 0),
    active: (a, b) => (b.last_message_at || 0) - (a.last_message_at || 0),
    name: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }),
  };
  const createdDay = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  const untrackedGroups = () => { const ids = trackedIds(); return (live.groups || []).filter(x => !ids.has(x.id)).sort(SORTS[groupSort()]); };
  const groupCountText = (shown, all) => state.groupQuery.trim() ? `${shown} of ${plural(all, 'group')}` : plural(all, 'group');
  const pickCountText = n => n ? `${plural(n, 'group')} selected` : 'Tick the groups to track';
  // more than 20 at once asks for a second click: each tracked group is read by Claude
  const selectAllText = n => state.confirmAll && state.confirmAll === n ? `Click again to tick ${n} groups` : `Select all ${n} shown`;
  // the ticked groups, in the order they appear in the list
  const pickedInOrder = () => untrackedGroups().map(x => x.id).filter(id => state.pickGroups.has(id));
  const pickedName = id => ((live.groupInfos[id] || {}).name) || ((live.groups || []).find(x => x.id === id) || {}).name || 'Unnamed group';

  function addFlow(trackedCount) {
    const ids = pickedInOrder();
    if (!ids.includes(state.addActive)) state.addActive = ids[0];
    const active = state.addActive;
    const ready = ids.filter(id => live.groupInfos[id] && state.addBoss[id] && state.addBoss[id].size);
    const side = ids.map(id => {
      const info = live.groupInfos[id], boss = state.addBoss[id];
      const done = !!(info && boss && boss.size);
      const sub = info === undefined ? 'Loading members\u2026' : info === null ? 'Couldn\u2019t read the members'
        : done ? `${plural(boss.size, 'instruction-giver')} \u00B7 ${plural(info.participants.filter(p => !boss.has(p.id)).length, 'person', 'people')} tracked`
        : 'Pick who gives instructions';
      return `<button class="addg${id === active ? ' active' : ''}${done ? ' done' : ''}" type="button" data-action="add-active" data-gid="${esc(id)}"${id === active ? ' aria-current="true"' : ''}>
          <span class="addg-dot" aria-hidden="true"></span><span class="addg-t"><b>${esc(pickedName(id))}</b><span class="sub">${esc(sub)}</span></span></button>`;
    }).join('');
    const info = live.groupInfos[active];
    const main = info === undefined ? '<p class="plain">Loading members\u2026</p>'
      : info === null ? `<p class="plain">WhatsApp Reader couldn\u2019t read this group\u2019s members.</p><button class="btn small" type="button" data-action="add-retry" data-gid="${esc(active)}">Try again</button>`
      : giversBlock(info, state.addBoss[active] || new Set(), 'add-boss',
        ids.length > 1 && state.addBoss[active] && state.addBoss[active].size
          ? `<div class="apply-all"><button class="btn small" type="button" data-action="add-apply" data-gid="${esc(active)}">Use these instruction-givers in every selected group they\u2019re in</button>${state.addNote ? `<span class="plain">${esc(state.addNote)}</span>` : ''}</div>` : '');
    const missing = ids.filter(id => !ready.includes(id) && live.groupInfos[id] !== null).length;
    const failed = ids.filter(id => live.groupInfos[id] === null).length;
    return `<h3>Who gives the instructions in each group?</h3>
      ${defaultsBox(ids)}
      <p class="plain">Pick a group on the left, then tick who gives instructions there. A green dot means it\u2019s ready.</p>
      <div class="addflow">
        <nav class="addside" aria-label="Selected groups">${side}</nav>
        <div class="addmain">${main}</div>
      </div>
      <div class="dlg-f add-foot">
        <span class="plain">${ready.length} of ${plural(ids.length, 'group')} ready</span>
        ${failed ? `<button class="btn small" type="button" data-action="add-retry-all">Try the ${plural(failed, 'group')} that failed again</button>` : ''}
        ${missing ? `<button class="btn small" type="button" data-action="add-next-missing">Next group to pick (${missing})</button>` : ''}
        <button class="btn" type="button" data-action="add-back">Back</button>
        <button class="btn primary" type="button" data-action="add-groups"${ready.length === ids.length ? '' : ' disabled'}>${trackedCount ? 'Add' : 'Start tracking'} ${plural(ids.length, 'group')}</button>
      </div>`;
  }

  // ---------------- default instruction-givers ----------------
  // Everyone in the groups being added (and the tracked ones), once each, with
  // how many of the selected groups they're in.
  function peoplePool(ids) {
    const pool = new Map();
    const add = (p, counted) => {
      const x = pool.get(p.id) || { id: p.id, name: nameFor(p.id, p.name), phone: p.phone || '', groups: 0 };
      if (counted) x.groups++;
      pool.set(p.id, x);
    };
    ids.forEach(id => { const g = live.groupInfos[id]; if (g) g.participants.forEach(p => add(p, true)); });
    trackedGroups().forEach(t => { const raw = live.raws[t.groupId]; if (raw) raw.participants.forEach(p => add(p, false)); });
    saved.givers.forEach(id => { if (!pool.has(id)) pool.set(id, { id, name: nameFor(id, '+' + id), phone: '+' + id, groups: 0 }); });
    return pool;
  }

  function giverOptions(pool, q) {
    q = q.trim().toLowerCase();
    if (!q) return '';
    const digits = q.replace(/\D/g, '');
    const hits = [...pool.values()].filter(p => !saved.givers.includes(p.id)
      && (p.name.toLowerCase().includes(q) || (digits.length >= 3 && p.phone.replace(/\D/g, '').includes(digits))))
      .sort((a, b) => b.groups - a.groups || a.name.localeCompare(b.name)).slice(0, 8);
    return hits.length ? hits.map(p => `<button class="opt" type="button" data-action="add-default" data-pid="${esc(p.id)}">
        <b>${esc(p.name)}</b><span class="sub">${esc(p.phone)}${p.groups ? ` · in ${plural(p.groups, 'selected group')}` : ''}</span></button>`).join('')
      : '<p class="plain">Nobody matches. Members show here once their group has loaded.</p>';
  }

  function defaultsBox(ids) {
    const pool = peoplePool(ids);
    const loaded = ids.filter(id => live.groupInfos[id]);
    const inIt = loaded.filter(id => live.groupInfos[id].participants.some(p => saved.givers.includes(p.id)));
    const chips = saved.givers.map(id => { const p = pool.get(id); return `<span class="gchip">${esc(p ? p.name : '+' + id)}
        <button type="button" data-action="remove-default" data-pid="${esc(id)}" aria-label="Remove ${esc(p ? p.name : id)}">×</button></span>`; }).join('');
    const summary = !saved.givers.length ? 'Pick the people who give instructions in most groups, like Juan. They’re ticked in every group they’re in, and remembered for next time.'
      : `In ${inIt.length} of the ${plural(loaded.length, 'loaded group')}.${loaded.length - inIt.length ? ` ${plural(loaded.length - inIt.length, 'group')} ${loaded.length - inIt.length === 1 ? 'has' : 'have'} none of them: use “Next group to pick” below to go through those.` : ''}`;
    return `<div class="defaults">
        <div class="defaults-top"><b>Default instruction-givers</b>${chips ? `<span class="gchips">${chips}</span>` : ''}</div>
        <div class="combo"><input class="name-in" type="search" id="giver-q" value="${esc(state.giverQuery)}" placeholder="Search people by name or number" aria-label="Search people to add as default instruction-givers" autocomplete="off">
          <div class="combo-list" id="giver-list">${giverOptions(pool, state.giverQuery)}</div></div>
        <p class="plain">${esc(summary)}</p>
      </div>`;
  }

  // ---------------- frame ----------------
  function renderNav() {
    const badge = { dashboard: D.pendingPeople.length, messages: D.unresolved.length, tasks: D.overdue.length, reports: null, email: ED ? ED.waitingPeople : null, deadlines: DL ? DL.missed : null };
    document.getElementById('nav').innerHTML = Object.entries(VIEWS).map(([k, v]) =>
      `<a href="#${k}"${state.view === k ? ' aria-current="page"' : ''}>${ic(v.icon)}${v.label}${badge[k] ? `<span class="count" aria-label="${badge[k]} need attention">${badge[k]}</span>` : ''}</a>`).join('');
    document.getElementById('timing-sum').textContent = `Flags at ${cfg.first} and ${cfg.second} min, escalate at ${cfg.escalate}`;
  }

  // The group switcher and the "From" filter at the top.
  function renderFilters() {
    const groups = src.groups;
    const gSel = document.getElementById('group-filter');
    const fSel = document.getElementById('sender-filter');
    const pill = document.getElementById('group-pill');
    if (src.mode === 'sample' || !groups.length) {
      gSel.hidden = true; fSel.hidden = true; pill.hidden = true;
      return;
    }
    if (state.groupFilter !== 'all' && !groups.some(g => g.id === state.groupFilter)) state.groupFilter = 'all';
    pill.hidden = groups.length > 1;
    gSel.hidden = groups.length < 2;
    if (groups.length < 2) pill.innerHTML = `${ic('users')}${esc(groups[0].name)} · ${plural(N, 'person', 'people')}`;
    else gSel.innerHTML = `<option value="all">All groups (${groups.length})</option>` + groups.map(g =>
      `<option value="${esc(g.id)}"${state.groupFilter === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('');
    // who gives instructions in the groups on screen
    const senders = new Map();
    src.S.messages.forEach(m => { if (state.groupFilter === 'all' || m.groupId === state.groupFilter) senders.set(m.senderId, m.senderName); });
    if (state.senderFilter !== 'all' && !senders.has(state.senderFilter)) state.senderFilter = 'all';
    fSel.hidden = senders.size < 2;
    fSel.innerHTML = `<option value="all">From: everyone</option>` + [...senders].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) =>
      `<option value="${esc(id)}"${state.senderFilter === id ? ' selected' : ''}>From: ${esc(name)}</option>`).join('');
  }

  function renderFrame() {
    const groups = src.groups;
    const current = state.groupFilter !== 'all' ? groups.find(g => g.id === state.groupFilter) : null;
    const label = src.mode === 'sample' ? 'No data yet' : current ? current.name : groups.length === 1 ? groups[0].name : plural(groups.length, 'group');
    const named = groups.length === 1 ? `“${groups[0].name}”` : plural(groups.length, 'group');
    document.getElementById('brand-sub').textContent = label;
    const pill = document.getElementById('snap');
    const note = document.getElementById('side-note');
    const foot = document.getElementById('foot');
    document.getElementById('change-group').hidden = !(live.on && live.status && live.status.linked);
    // clearing is for the page's owner and editors only
    document.getElementById('open-clear').hidden = !(cap.canEdit === true && src.mode !== 'sample' && trackedGroups().length);
    // only the computer running WhatsApp Reader can read it right away; elsewhere the saved copy updates by itself
    const refresh = document.getElementById('refresh');
    refresh.hidden = !(src.mode === 'live' && live.on);
    refresh.disabled = !!live.refreshing;
    refresh.setAttribute('aria-busy', live.refreshing ? 'true' : 'false');
    document.getElementById('refresh-t').textContent = live.refreshing ? 'Refreshing\u2026' : 'Refresh';
    if (src.mode === 'live') {
      pill.className = 'pill live';
      pill.innerHTML = `<i class="dot"></i>Live · updated ${esc(fmtClock(src.updatedAt))}${live.analyzing ? ' · reading new messages…' : ''}`;
      note.textContent = 'Reading the groups on this computer. Nothing is sent to WhatsApp.';
      foot.textContent = `Reading ${named} through WhatsApp Reader on this computer. Nothing is ever sent to WhatsApp. Each update is saved into this page, so everyone in the company with the link sees the same numbers on any device.`;
    } else if (src.mode === 'saved') {
      pill.className = 'pill';
      pill.innerHTML = `${ic('clock')}Saved · as of ${esc(fmtDate(src.updatedAt))}, ${esc(fmtClock(src.updatedAt))}`;
      note.textContent = 'Showing the last saved copy. Nothing is sent to WhatsApp.';
      foot.textContent = `These numbers were saved at ${fmtClock(src.updatedAt)} on ${fmtDate(src.updatedAt)}, the last time this page was open in the Claude desktop app on the computer running WhatsApp Reader. Response times are counted up to that moment. Nothing is ever sent to WhatsApp.`;
    } else {
      pill.className = 'pill sample';
      pill.innerHTML = `${ic('clock')}No data yet`;
      note.textContent = 'No WhatsApp data yet. Nothing is sent to WhatsApp.';
      foot.textContent = 'Numbers appear once this page has been opened in the Claude desktop app on the computer running WhatsApp Reader. Nothing is ever sent to WhatsApp.';
    }
    const conn = document.getElementById('conn');
    // only the owner can connect, so only the owner sees why it isn't connected
    conn.hidden = live.on || !live.diag || cap.isOwner === false;
    if (!conn.hidden) {
      const d = live.diag;
      document.getElementById('conn-text').textContent = connMessage(d);
      document.getElementById('conn-code').textContent = d.code === 'connecting' ? '' : `Code: ${d.code}`;
      document.getElementById('conn-btn').disabled = d.code === 'connecting';
    }
    const err = document.getElementById('live-error');
    const held = live.on && live.held ? `The Claude app is limiting how fast this page can ask WhatsApp Reader, so ${live.held === 1 ? '1 group is' : live.held + ' groups are'} still to be read. They\u2019ll be read automatically in a minute; nothing needs doing.` : '';
    const msg = [live.on && live.error ? `WhatsApp Reader couldn\u2019t read a group: ${live.error.message || String(live.error)}` : (state.notice || ''), held].filter(Boolean).join(' ');
    err.hidden = !msg;
    err.textContent = msg;
    // only "still to be read": a heads-up, not an error
    err.classList.toggle('calm', !!held && !(live.on && live.error) && !state.notice);
  }

  // Why this window isn't reading WhatsApp Reader, in words that say what to do.
  function connMessage(d) {
    switch (d.code) {
      case 'connecting': return 'Connecting to WhatsApp Reader…';
      case 'no-mcp': return 'This window can’t reach programs on your computer. Open this page in the Claude desktop app.';
      case 'server_not_connected': return 'The Claude app showing this page didn’t connect it to WhatsApp Reader. Check that Settings → Developer lists whatsapp-reader as running. If this page is open in a side panel, open it in its own window and press Connect.';
      case 'not_in_manifest': case 'not_granted': case 'approval_required': case 'cancelled': case 'consent_required':
        return 'Access to WhatsApp Reader wasn’t allowed. Press Connect and choose Allow.';
      case 'blocked_by_policy': return 'Your organization’s settings block this page from using WhatsApp Reader.';
      case 'tool_error': return `WhatsApp Reader answered with an error: ${d.message || 'no details'}`;
      default: return `Couldn’t reach WhatsApp Reader${d.message ? ': ' + d.message : '.'}`;
    }
  }

  // What's on screen: all groups or one, everyone's instructions or one person's.
  function filtered(all) {
    if (src.mode === 'sample') return all;
    let messages = all.messages;
    if (state.groupFilter !== 'all') messages = messages.filter(m => m.groupId === state.groupFilter);
    if (state.senderFilter !== 'all') messages = messages.filter(m => m.senderId === state.senderFilter);
    const ids = new Set(messages.map(m => m.id));
    const g = state.groupFilter;
    const people = g === 'all' ? all.people : all.people.filter(p => p.groups.includes(g))
      .map(p => ({ ...p, former: p.formerIn.includes(g), giver: p.giverIn.includes(g) }));
    return { people, messages, tasks: all.tasks.filter(t => ids.has(t.msg)) };
  }

  function render() {
    S = filtered(src.S);
    NOW = src.mode === 'live' ? Date.now() : src.now;
    D = derive(S, cfg, NOW);
    ED = (email.status === 'ok' || email.status === 'loading') && email.loadedAt ? deriveEmail(email.rows, Date.now(), email.stops) : null;
    DL = (dl.status === 'ok' || dl.status === 'loading') && dl.loadedAt ? deriveDeadlines(dl.rows, dl.misses, Date.now()) : null;
    // instruction-givers count only when someone asked them for something
    N = D.people.filter(p => !p.former && (!p.giver || p.required)).length;
    renderNav();
    renderFilters();
    renderFrame();
    emailFrame();
    dlFrame();
    const setup = needsSetup();
    const v = VIEWS[state.view];
    document.getElementById('v-title').textContent = setup ? 'Groups to track' : v.title;
    document.getElementById('v-sub').textContent = setup ? 'Set up on this computer. Change it any time from the sidebar.' : v.sub;
    const setupEl = document.getElementById('v-setup');
    setupEl.hidden = !setup;
    const typing = document.activeElement && setupEl.contains(document.activeElement) && document.activeElement.matches('input[type="text"], input[type="search"]');
    const focusId = document.activeElement && setupEl.contains(document.activeElement) ? document.activeElement.id : '';
    if (setup && !typing) {
      const side = setupEl.querySelector('.addside');
      const sideTop = side ? side.scrollTop : 0;
      setupEl.innerHTML = viewSetup();
      const side2 = setupEl.querySelector('.addside');
      if (side2 && sideTop) side2.scrollTop = sideTop;
      const again = focusId && document.getElementById(focusId);
      if (again) again.focus();
    }
    const list = document.getElementById('mlist');
    const keepScroll = list ? list.scrollTop : 0;
    const builders = { dashboard: viewDashboard, messages: viewMessages, tasks: viewTasks, reports: viewReports, email: viewEmail, deadlines: viewDeadlines };
    for (const k of Object.keys(VIEWS)) {
      const el = document.getElementById('v-' + k);
      el.hidden = setup || k !== state.view;
      if (el.hidden) continue;
      // don't redraw under someone typing the sheet link
      if (k === 'email' && el.contains(document.activeElement) && document.activeElement.matches('input')) continue;
      // the email and deadline logs don't depend on WhatsApp data
      el.innerHTML = src.mode === 'sample' && k !== 'email' && k !== 'deadlines' ? noDataCard() : builders[k]();
    }
    if (state.view === 'email' && !setup) maybeLoadEmail(true);
    if (state.view === 'deadlines' && !setup) maybeLoadDl(true);
    const list2 = document.getElementById('mlist');
    if (list2 && keepScroll) list2.scrollTop = keepScroll;
  }

  function go(view) {
    if (!VIEWS[view]) view = 'dashboard';
    if (state.view !== view) { state.view = view; render(); window.scrollTo(0, 0); }
  }

  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  document.addEventListener('click', e => {
    const open = e.target.closest('[data-open-msg]');
    if (open) { state.sel = open.dataset.openMsg; if (state.view === 'messages') render(); else location.hash = 'messages'; return; }
    const sel = e.target.closest('[data-sel]');
    if (sel) { state.sel = sel.dataset.sel; state.confirmDelete = null; render(); return; }
    const act = e.target.closest('[data-action]');
    if (act) onAction(act.dataset.action, act.dataset.gid, act.dataset);
  });
  document.addEventListener('input', e => {
    const id = e.target.dataset && e.target.dataset.nameFor;
    if (id) { state.setupNames = state.setupNames || {}; state.setupNames[id] = e.target.value; }
    if (e.target.id === 'giver-q') {
      state.giverQuery = e.target.value;
      document.getElementById('giver-list').innerHTML = giverOptions(peoplePool(pickedInOrder()), state.giverQuery);
    }
    // filter the group list as you type, without redrawing it
    if (e.target.id === 'group-q') {
      state.groupQuery = e.target.value;
      const q = state.groupQuery.trim().toLowerCase();
      const labels = [...document.querySelectorAll('#group-choices .choice')].filter(l => !(state.hideEmpty && l.dataset.empty));
      let shown = 0;
      labels.forEach(l => { const hit = !q || l.dataset.gname.includes(q); l.hidden = !hit; if (hit) shown++; });
      document.getElementById('group-q-count').textContent = groupCountText(shown, labels.length);
      document.getElementById('group-q-none').hidden = shown > 0;
      state.confirmAll = 0;
      const all = document.getElementById('pick-all');
      if (all) { all.textContent = selectAllText(shown); all.disabled = !shown; }
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'task-filter') { state.taskFilter = e.target.value; render(); }
    if (e.target.id === 'group-filter') { state.groupFilter = e.target.value; state.sel = null; render(); }
    if (e.target.id === 'sender-filter') { state.senderFilter = e.target.value; state.sel = null; render(); }
    if (e.target.id === 'hide-empty') {
      state.hideEmpty = e.target.checked; state.confirmAll = 0;
      try { localStorage.setItem('wa-hide-empty', state.hideEmpty ? '1' : '0'); } catch (_) {}
      render();
    }
    if (e.target.id === 'group-sort') {
      state.groupSort = e.target.value;
      try { localStorage.setItem('wa-group-sort', state.groupSort); } catch (_) {}
      render();
    }
    if (e.target.name === 'pick-group') {
      if (e.target.checked) state.pickGroups.add(e.target.value); else state.pickGroups.delete(e.target.value);
      const n = state.pickGroups.size;
      document.getElementById('pick-count').textContent = pickCountText(n);
      document.getElementById('pick-next').disabled = !n;
      document.getElementById('pick-clear').disabled = !n;
    }
    if (e.target.name === 'add-boss') {
      const gid = e.target.dataset.gid;
      state.addManual.add(gid);
      state.addBoss[gid] = new Set([...document.querySelectorAll('input[name="add-boss"]:checked')].map(x => x.value));
      state.addNote = '';
      render();
    }
    if (e.target.name === 'setup-boss') {
      state.setupBoss = new Set([...document.querySelectorAll('input[name="setup-boss"]:checked')].map(x => x.value));
      render();
    }
  });

  // tooltip for chart marks (plain text only)
  const tip = document.getElementById('tip');
  const placeTip = (x, y) => {
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - r.width - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(y + 14, innerHeight - r.height - 8)) + 'px';
  };
  const showTip = (el, x, y) => {
    const b = document.createElement('b'); b.textContent = el.dataset.tipT || '';
    tip.replaceChildren(b, document.createTextNode(el.dataset.tip)); tip.hidden = false; placeTip(x, y);
  };
  document.addEventListener('pointerover', e => { const el = e.target.closest('[data-tip]'); if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true; });
  document.addEventListener('pointermove', e => { if (!tip.hidden) placeTip(e.clientX, e.clientY); });
  document.addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.bottom); } else tip.hidden = true; });
  document.addEventListener('focusout', () => { tip.hidden = true; });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  // ---------------- follow-up timing ----------------
  const dlg = document.getElementById('timing');
  const fFirst = document.getElementById('t-first'), fSecond = document.getElementById('t-second'), fEsc = document.getElementById('t-esc');
  const tMsg = document.getElementById('timing-msg');
  const saveBtn = document.getElementById('save-timing');
  let lastFocus = null;
  const say = (text, kind) => { tMsg.textContent = text; tMsg.className = 'dlg-msg' + (kind ? ' ' + kind : ''); };
  const valid = v => [v.first, v.second, v.escalate].every(n => Number.isInteger(n) && n >= 1 && n <= 1440) && v.first < v.second && v.second < v.escalate;

  function openTiming() {
    lastFocus = document.activeElement;
    fFirst.value = cfg.first; fSecond.value = cfg.second; fEsc.value = cfg.escalate;
    const locked = cap.canEdit === false;
    [fFirst, fSecond, fEsc].forEach(f => { f.disabled = locked; });
    saveBtn.disabled = locked;
    if (locked) say('Only editors of this page can change the timing.');
    else if (!cap.db) say('This view can’t save settings, so a change applies only until you leave the page.');
    else say('');
    dlg.hidden = false;
    (locked ? document.getElementById('close-timing') : fFirst).focus();
  }
  function closeTiming() { dlg.hidden = true; if (lastFocus) lastFocus.focus(); }
  document.getElementById('open-timing').addEventListener('click', openTiming);
  document.getElementById('close-timing').addEventListener('click', closeTiming);
  document.getElementById('cancel-timing').addEventListener('click', closeTiming);
  dlg.addEventListener('click', e => { if (e.target === dlg) closeTiming(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.hidden) closeTiming(); });

  document.getElementById('timing-form').addEventListener('submit', async e => {
    e.preventDefault();
    const v = { first: Number(fFirst.value), second: Number(fSecond.value), escalate: Number(fEsc.value) };
    if (![v.first, v.second, v.escalate].every(n => Number.isInteger(n) && n >= 1 && n <= 1440)) { say('Use whole minutes between 1 and 1440.', 'err'); return; }
    if (!(v.first < v.second && v.second < v.escalate)) { say('Each step has to come after the one before it: first reminder, then second, then escalation.', 'err'); return; }
    if (!cap.db) { cfg = v; render(); say('Applied to this view. It isn’t saved for anyone else.', 'ok'); return; }
    saveBtn.disabled = true; say('Saving…');
    try {
      await cap.db.doc('settings/followup').set({ ...v, updatedAt: Date.now() });
      cfg = v; render();
      say('Saved. Everyone who opens this page now sees this timing.', 'ok');
    } catch (err) {
      if (err && err.code === 'invalid_argument') { cap.canEdit = false; say('Only editors of this page can change the timing.', 'err'); }
      else if (err && (err.code === 'resource_exhausted' || err.code === 'unavailable')) say('Couldn’t save just now. Try again in a minute.', 'err');
      else say('Couldn’t save the timing on this page.', 'err');
    } finally { saveBtn.disabled = cap.canEdit === false; }
  });

  // ---------------- drafting a reply in Juan's voice ----------------
  // Claude writes it on the viewer's own Claude account. Nothing is sent:
  // the person reads it, copies it and sends it from their own WhatsApp.
  // How Juan writes comes from the team's "Ask Juan" page (built from his voice notes).
  const JUAN_STYLE = `You write one WhatsApp message for Juan Diaz, CEO of Twin Home Buyer, to send in a work group with his team (acquisitions reps, callers, VAs on the Philippines team). Write it exactly as Juan would type it himself: first person, to people by first name. You are not an assistant; never mention Claude, AI or a draft.

HOW JUAN WRITES
- Direct and fast. Point first. No warm-up, no "hope you're well", no "great question", no cheerleading.
- Friendly but demanding. He pushes people to own it. Short sentences, plain words.
- Spoken feel, like a voice note from the car. He may open with "Okay so", "Alright", "Look" or the person's name. Fillers he really uses: "right?", "you know what I mean?", "For sure.", "Let's go.", "Make sense?" Use one at most, often none.
- Every task has a who and a when. End with who's doing what by when.
- He likes a confirm-back: "Confirm it back to me so I know we're on the same page."
- Bad news early: "I never want to be surprised." Don't bring him a problem without options.
- Lines he uses, only when one truly fits: "If it's not on the calendar, it doesn't get done." "One brick at a time."
- A WhatsApp message, not an email: usually 1 to 3 sentences, under 50 words. No headers, no bold, no sign-off. A short list only for 2 to 4 steps. No emojis unless the thread uses them.

RULES
- Use only facts in the thread below. Never invent numbers, prices, addresses, deal status, dates or names. If something Juan has to decide or look up isn't in the thread, put a short placeholder in square brackets, like [time] or [price], for the sender to fill in.
- Don't approve or commit to an offer price, contract, payment, hire, fire or legal step. Say how he's leaning and "send it to me and I'll sign off".
- Match the thread's language: English, or Taglish if the team writes in Taglish.
- Reply with the message text only. No quotes around it, no explanation.`;

  const isJuan = name => /\bjuan\b/i.test(String(name || ''));
  const canDraft = () => !!cap.sample;
  const draftButton = m => canDraft()
    ? `<button class="btn small" type="button" data-action="open-draft" data-msg="${esc(m.id)}">Draft reply as Juan</button>` : '';
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

  // Who the draft is for, and what Juan is doing in it.
  function draftSituation(m) {
    const sender = m.senderName || 'the sender';
    const waiting = m.pending.filter(r => !isJuan(r.name));
    const names = waiting.map(r => r.name).join(', ');
    const pushes = (m.chases || []).length;
    if (m.waitingAny) {
      return { to: 'the group', ask: `A follow-up from ${isJuan(m.senderName) ? 'Juan' : `Juan, backing up ${sender},`} to the whole group: nobody has answered after ${fmtDur(NOW - m.at)}, and one answer from anyone is enough.` };
    }
    if (!isJuan(m.senderName) && m.pending.some(r => isJuan(r.name))) {
      return { to: sender, ask: `Juan's answer to ${sender}, who asked him this. Answer what the thread lets him answer, and put anything he has to decide or look up in [brackets].` };
    }
    if (waiting.length) {
      const how = isJuan(m.senderName) ? 'A follow-up from Juan' : `Juan backing up ${sender}'s request with a follow-up`;
      const firmer = pushes ? ` ${sender} already followed up ${pushes === 1 ? 'once' : pushes + ' times'}, so be firmer.` : '';
      return { to: names, ask: `${how} to ${names}, who ${waiting.length === 1 ? 'hasn’t' : 'haven’t'} answered after ${fmtDur(Math.max(...waiting.map(r => r.waiting)))}.${firmer}` };
    }
    const answered = m.anyone && m.rows[0] ? `${m.rows[0].name} answered` : 'everyone has answered';
    return { to: m.anyone && m.rows[0] ? m.rows[0].name : 'the group', ask: `Juan’s short reply now that ${answered}: acknowledge it in a few words and give the next step with who and when, if there is one.` };
  }

  function draftPrompt(m, sit) {
    const task = m.task ? D.tasks.find(t => t.id === m.task) : null;
    const lines = [`GROUP: ${m.groupName || 'team group'}`, `MESSAGE from ${m.senderName || 'unknown'}, ${fmtWhen(m.at)}:`, `"${clip(m.text, 1500)}"`];
    (m.chases || []).forEach(c => lines.push(`Follow-up from ${m.senderName || 'them'}, ${fmtClock(c.at)}: "${clip(c.text, 300)}"`));
    if (task) lines.push(`TASK: ${task.title} · owner ${task.ownerName} · ${task.due != null ? 'due ' + fmtWhen(task.due) : 'no deadline given'} · ${task.status}`);
    const replied = m.rows.filter(r => r.replied);
    lines.push(replied.length ? 'REPLIES:' : 'REPLIES: none yet');
    replied.forEach(r => lines.push(`- ${r.name}, ${fmtDur(r.delay)} later: "${clip(r.text || 'reacted', 300)}"`));
    if (m.pending.length) lines.push(`NO REPLY YET: ${m.pending.map(r => `${r.name} (${fmtDur(r.waiting)})`).join(', ')}`);
    lines.push(`NOW: ${fmtWhen(NOW)}`, '', `WRITE: ${sit.ask}`);
    return `${JUAN_STYLE}\n\nTHE THREAD\n${lines.join('\n')}`;
  }

  const cleanDraft = s => String(s || '').trim().replace(/^["“]([\s\S]*)["”]$/, '$1').trim();
  const draftError = e => e && e.code === 'not_granted' ? 'Claude wasn’t allowed on this page. Allow it from the page’s Permissions menu, then press Write another.'
    : e && e.code === 'rate_limited' ? 'Claude is busy. Wait a minute, then press Write another.'
    : `Couldn’t write a draft${e && e.message ? ': ' + e.message : '.'}`;

  const draftDlg = document.getElementById('draft-dlg');
  const draftBox = document.getElementById('draft-box');
  function renderDraft() {
    const R = state.draft;
    draftDlg.hidden = !R;
    if (!R) return;
    const note = R.error || (R.copied ? 'Copied. Paste it into WhatsApp and send it from your phone.' : '');
    draftBox.innerHTML = `<div class="dlg-h"><div><h2 id="draft-h">Reply as Juan</h2>
        <p>To ${esc(R.to)}, about “${esc(R.title)}”. Claude writes it the way Juan texts, on your Claude account. Nothing is sent: edit it, copy it and send it from WhatsApp yourself.</p></div>
        <button class="x" type="button" data-action="draft-close" aria-label="Close"><svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="dlg-b"><textarea id="draft-text" class="draft-in" rows="6" aria-label="Draft message" placeholder="Writing…"${R.busy ? ' readonly aria-busy="true"' : ''}>${esc(R.text)}</textarea></div>
      <p class="dlg-msg ${R.error ? 'err' : 'ok'}" role="status">${esc(note)}</p>
      <div class="dlg-f"><button class="btn" type="button" data-action="draft-close">Close</button>
        <button class="btn" type="button" data-action="draft-again"${R.busy ? ' disabled' : ''}>Write another</button>
        <button class="btn primary" type="button" data-action="draft-copy"${R.busy || !R.text.trim() ? ' disabled' : ''}>Copy</button></div>`;
  }

  function openDraft(msgId) {
    const m = D && D.messages.find(x => x.id === msgId);
    if (!m || !canDraft()) return;
    const sit = draftSituation(m);
    state.draft = { msgId, title: m.title, to: sit.to, prompt: draftPrompt(m, sit), text: '', busy: false, error: '', copied: false, ctrl: null };
    writeDraft();
  }

  function closeDraft() {
    if (state.draft && state.draft.ctrl) state.draft.ctrl.abort();
    state.draft = null; renderDraft();
  }

  async function writeDraft() {
    const R = state.draft;
    if (!R || R.busy) return;
    const ctrl = R.ctrl = new AbortController();
    R.busy = true; R.error = ''; R.copied = false; R.text = '';
    renderDraft();
    try {
      const out = await cap.sample(R.prompt, { modelTier: 'default', cache: false, signal: ctrl.signal, onText: ({ text }) => {
        if (state.draft !== R) return;
        const ta = document.getElementById('draft-text');
        if (ta) ta.value = text;
      } });
      if (state.draft !== R) return;
      R.text = cleanDraft(out && out.text);
      if (!R.text) R.error = 'Claude didn’t write anything. Press Write another.';
    } catch (e) {
      if (state.draft !== R || ctrl.signal.aborted) return;
      R.text = cleanDraft(e && e.text);
      R.error = draftError(e);
    }
    R.busy = false; R.ctrl = null;
    renderDraft();
    const ta = document.getElementById('draft-text');
    if (ta) ta.focus();
  }

  async function copyDraft() {
    const R = state.draft;
    const ta = document.getElementById('draft-text');
    if (!R || !ta) return;
    R.text = ta.value;
    let ok = false;
    try { await navigator.clipboard.writeText(R.text); ok = true; } catch (_) {
      ta.select();
      try { ok = document.execCommand('copy'); } catch (_) {}
    }
    R.copied = ok;
    R.error = ok ? '' : 'Couldn’t copy here. The text is selected: press Ctrl+C (or ⌘C) to copy it.';
    renderDraft();
    const again = document.getElementById('draft-text');
    if (!ok && again) again.select();
  }

  draftDlg.addEventListener('click', e => { if (e.target === draftDlg) closeDraft(); });
  document.addEventListener('input', e => { if (e.target.id === 'draft-text' && state.draft) { state.draft.text = e.target.value; state.draft.copied = false; } });


  // ---------------- Email (the reply-reminder log, and the viewer's own inbox) ----------------
  // The team view reads the Google Sheet the reply-reminder script writes,
  // through the viewer's own Google Sheets connection. "Your inbox" reads the
  // viewer's own Gmail. Nothing is sent from here, and no email's content is shown.
  const SHEETS = 'Google Sheets', GMAIL = 'Gmail';
  const EMAIL_EVERY = 5 * MIN;
  const email = { conf: null, confLoaded: false, status: 'idle', code: null, message: '', rows: [], info: null, loadedAt: null,
    editing: false, linkError: '', saving: false,
    // stopping reminders: what the Stopped and Pause tabs say; 'missing' when the script hasn't made them yet
    stops: [], pause: { paused: false, by: '', at: null }, controls: 'unknown', busy: false, ctlError: '',
    mine: { status: 'idle', items: [], done: 0, total: 0, code: null, message: '', at: null } };
  let ED = null;

  const sheetUrl = id => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
  const gmailLink = msgId => `https://mail.google.com/mail/#search/rfc822msgid%3A${encodeURIComponent(msgId)}`;
  const cleanSubject = s => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim() || '(no subject)';
  const emailWatching = () => (email.info && email.info.watching.length ? email.info.watching : (email.conf && email.conf.watch) || []);
  // "Juan" for juan@…, from the names in the log when there are any
  const watchedName = () => {
    const w = emailWatching();
    if (!w.length) return 'Juan';
    const r = email.rows.find(x => x.from === w[0]);
    return r && r.fromName ? r.fromName.split(/\s+/)[0] : nameFromEmail(w[0]);
  };
  const remindTotal = () => (email.info && email.info.remindAfter.length) || 3;

  function subscribeEmail(db) {
    db.doc('settings/email').onSnapshot(snap => {
      email.conf = snap.exists ? snap.data() : null;
      email.confLoaded = true;
      maybeLoadEmail(false);
      maybeLoadDl(false);
      render();
    }, () => { email.confLoaded = true; render(); });
  }

  // Loads by itself only once the viewer has allowed Google Sheets for this
  // page, or when the Email tab is open; otherwise the first read would ask
  // everyone who opens the dashboard.
  async function maybeLoadEmail(onTab) {
    if (!cap.mcp || !email.conf || !email.conf.sheetId || email.status !== 'idle') return;
    if (onTab) { loadEmail(); return; }
    let s = 'prompt';
    try { s = cap.perms ? await cap.perms.state('mcp:' + SHEETS) : 'prompt'; } catch (_) { s = 'prompt'; }
    if (s === 'granted' && email.status === 'idle') loadEmail();
  }

  const DENIED = ['needs_reauth', 'server_not_connected', 'selection_required', 'blocked_by_policy', 'approval_required', 'not_in_manifest', 'consent_required', 'not_granted', 'capability_disabled', 'capability_removed'];
  async function sheetRead(range, retried) {
    try {
      return (await cap.mcp.callTool(SHEETS, 'get_values', { spreadsheetId: email.conf.sheetId, range }, { cache: false })).payload || {};
    } catch (e) {
      // a busy connector gets one more try, a little later
      if (!retried && e && e.retryable) {
        await new Promise(r => setTimeout(r, Math.min(e.retryAfterMs || 0, 20000) + 1500 + Math.random() * 1500));
        return sheetRead(range, true);
      }
      throw e;
    }
  }

  async function loadEmail() {
    if (!cap.mcp || !email.conf || !email.conf.sheetId || email.status === 'loading') return;
    const was = email.status;
    email.status = 'loading';
    if (was !== 'ok') render();
    try {
      const log = await sheetRead('Emails!A1:M5000');
      let info = null;
      try { info = parseEmailStatus((await sheetRead('Status!A1:B20')).values); } catch (_) { /* an older sheet without a Status tab still shows its rows */ }
      email.rows = parseEmailLog(log.values);
      email.info = info;
      await loadControls(false);
      email.status = 'ok'; email.code = null; email.message = ''; email.loadedAt = Date.now();
      keepWatchCurrent();
    } catch (e) {
      email.status = 'error';
      email.code = (e && e.code) || 'upstream_error';
      email.message = (e && e.message) || String(e || '');
      // no access any more: take down what was shown
      if (DENIED.includes(email.code)) { email.rows = []; email.info = null; }
    }
    render();
  }

  // The Stopped and Pause tabs. An older script didn't make them: then the
  // controls stay hidden and editors are told to update the script.
  async function loadControls(andRender) {
    try {
      email.stops = parseEmailStops((await sheetRead('Stopped!A1:E1000')).values);
      email.pause = parseEmailPause((await sheetRead('Pause!A1:C2')).values);
      email.controls = 'ok';
    } catch (e) {
      email.controls = e && e.code === 'tool_error' ? 'missing' : 'error';
      email.stops = []; email.pause = { paused: false, by: '', at: null };
    }
    if (andRender) render();
  }
  const canControl = () => cap.canEdit === true && !!cap.mcp && email.controls === 'ok';
  const sheetWrite = (tool, input) => cap.mcp.callTool(SHEETS, tool, { spreadsheetId: email.conf.sheetId, ...input }, { cache: false });
  async function myName() {
    try { const me = cap.user && await cap.user.me(); return (me && me.name) || 'Someone on the dashboard'; } catch (_) { return 'Someone on the dashboard'; }
  }
  // A write to the sheet, then a fresh read so every number agrees with it.
  async function controlWrite(fn) {
    if (email.busy) return;
    email.busy = true; email.ctlError = '';
    render(); renderStop();
    try { await fn(); await loadControls(false); if (state.stop) state.stop.done = true; }
    catch (e) {
      const [t, b] = e && e.code === 'moved' ? ['The sheet changed since it was read.', 'It has been reloaded; try again.'] : connectorTrouble((e && e.code) || 'upstream_error', (e && e.message) || '', SHEETS);
      email.ctlError = `${t} ${b}${e && e.code === 'tool_error' ? ' To stop reminders you need edit access to the log sheet.' : ''}`.trim();
      if (e && e.code === 'moved') await loadControls(false);
    }
    email.busy = false;
    render(); renderStop();
  }
  const stopReminders = (thread, person, subject) => controlWrite(async () => {
    await sheetWrite('append_values', { range: 'Stopped!A1', values: [[thread, person, subject, await myName(), new Date().toISOString()]] });
  });
  const resumeStop = row => controlWrite(async () => {
    const s = email.stops.find(x => x.row === row);
    if (!s) throw { code: 'moved' };
    // make sure that row is still this stop before clearing it
    const range = `Stopped!A${row}:E${row}`;
    const cur = ((await sheetRead(range)).values || [])[0] || [];
    if (String(cur[0] || '').trim() !== s.thread || (String(cur[1] || '').trim().toLowerCase() || 'everyone') !== s.person) throw { code: 'moved' };
    await sheetWrite('update_values', { range, values: [['', '', '', '', '']] });
  });
  const setPause = on => controlWrite(async () => {
    await sheetWrite('update_values', { range: 'Pause!A2:C2', values: [[on ? 'yes' : 'no', await myName(), new Date().toISOString()]] });
  });

  // ---- the stop dialog: who to stop, and the stops already on this email ----
  const stopDlg = document.getElementById('stop-dlg');
  const stopBox = document.getElementById('stop-box');
  function openStop(thread) { state.stop = { thread, done: false }; email.ctlError = ''; renderStop(); const b = stopBox.querySelector('input, button.primary, button'); if (b) b.focus(); }
  function closeStop() { state.stop = null; email.ctlError = ''; renderStop(); }
  function renderStop() {
    const S = state.stop;
    const E = S && ED;
    const t = E && E.open.concat(E.halted, E.done).find(x => x.id === S.thread);
    stopDlg.hidden = !t;
    if (!t) { if (S) state.stop = null; return; }
    const subject = cleanSubject(t.subject);
    const people = new Map(E.people.map(p => [p.email, p.name]));
    const current = email.stops.filter(s => s.thread === t.id);
    const curRows = current.map(s => `<div class="clear-row"><div><b>${esc(s.person === 'everyone' ? 'Everyone on this email' : people.get(s.person) || s.person)}</b>
        <span class="sub">Stopped${s.by ? ` by ${esc(s.by)}` : ''}${Number.isFinite(s.at) ? `, ${esc(fmtWhen(s.at))}` : ''}</span></div>
        <button class="btn small" type="button" data-action="email-resume" data-row="${s.row}"${email.busy ? ' disabled' : ''}>Resume</button></div>`).join('');
    const w = t.waiting;
    const choices = w.length ? `<p class="note">Stop reminders for:</p><div class="pick-list">
        <label class="choice"><input type="radio" name="stop-who" value="everyone" checked><span><b>Everyone on this email</b><span class="sub">${esc(w.map(p => p.name).join(', '))}</span></span></label>
        ${w.length > 1 ? w.map(p => `<label class="choice"><input type="radio" name="stop-who" value="${esc(p.person)}"><span><b>${esc(p.name)} only</b><span class="sub">Waiting ${esc(fmtDur(p.waiting))}</span></span></label>`).join('') : ''}</div>`
      : '<p class="plain">Nobody on this email is waiting for a reminder.</p>';
    const msg = email.ctlError || (email.busy ? 'Saving to the log sheet…' : S.done ? 'Saved. The reminder script picks it up at its next check.' : '');
    stopBox.innerHTML = `<div class="dlg-h"><div><h2 id="stop-h">Reminders for “${esc(subject)}”</h2>
        <p>A stopped person isn’t counted as owing a reply. If they answer and a new email comes, it’s tracked again.</p></div>
        <button class="x" type="button" data-action="stop-close" aria-label="Close"><svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="dlg-b">${curRows ? `<div class="stop-cur">${curRows}</div>` : ''}${choices}</div>
      <p class="dlg-msg ${email.ctlError ? 'err' : 'ok'}" role="status">${esc(msg)}</p>
      <div class="dlg-f"><button class="btn" type="button" data-action="stop-close">Close</button>
        ${w.length ? `<button class="btn primary" type="button" data-action="email-stop-save"${email.busy ? ' disabled' : ''}>Stop reminders</button>` : ''}</div>`;
  }
  function saveStop() {
    const S = state.stop, t = S && ED && ED.open.concat(ED.halted, ED.done).find(x => x.id === S.thread);
    if (!t) return;
    const pick = stopBox.querySelector('input[name="stop-who"]:checked');
    stopReminders(t.id, pick && pick.value !== 'everyone' ? pick.value : '', cleanSubject(t.subject));
  }
  stopDlg.addEventListener('click', e => { if (e.target === stopDlg) closeStop(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.stop) closeStop(); });

  // The dashboard remembers whose emails the log watches, so "Your inbox"
  // works for people who can't open the sheet.
  function keepWatchCurrent() {
    const w = email.info && email.info.watching;
    if (!w || !w.length || cap.canEdit !== true || !cap.db || !email.conf) return;
    if (JSON.stringify(w) === JSON.stringify(email.conf.watch || [])) return;
    cap.db.doc('settings/email').set({ ...email.conf, watch: w, savedAt: Date.now() }).catch(() => {});
  }

  async function saveEmailLink() {
    const input = document.getElementById('email-link');
    const id = sheetIdFrom(input && input.value);
    if (!id) { email.linkError = 'That isn’t a Google Sheets link. Copy it from the sheet’s address bar, starting with https://docs.google.com/spreadsheets/'; render(); return; }
    email.saving = true; email.linkError = ''; render();
    try {
      await cap.db.doc('settings/email').set({ sheetId: id, watch: (email.conf && email.conf.sheetId === id && email.conf.watch) || [], savedAt: Date.now() });
      email.editing = false;
      email.status = 'idle'; email.rows = []; email.info = null;
      dl.status = 'idle'; dl.rows = []; dl.misses = []; dl.loadedAt = null;
    } catch (e) {
      email.linkError = `Couldn’t save the link: ${(e && e.message) || e}`;
    }
    email.saving = false;
    render();
  }

  // ---- the viewer's own inbox ----
  async function checkMine() {
    const M = email.mine;
    if (M.status === 'busy' || !cap.mcp) return;
    const watch = emailWatching();
    if (!watch.length) { M.status = 'error'; M.code = 'no-watch'; render(); return; }
    Object.assign(M, { status: 'busy', items: [], done: 0, total: 0, code: null, message: '' });
    render();
    try {
      const days = (email.info && email.info.lookbackDays) || 7;
      const from = watch.length === 1 ? `from:${watch[0]}` : `{${watch.map(w => 'from:' + w).join(' ')}}`;
      const found = (await cap.mcp.callTool(GMAIL, 'search_threads', { query: `${from} newer_than:${days}d`, pageSize: 25, view: 'THREAD_VIEW_MINIMAL' }, { cache: false })).payload || {};
      const list = (found.threads || []).slice(0, 25);
      M.total = list.length;
      render();
      const threads = [];
      for (const t of list) {
        const full = (await cap.mcp.callTool(GMAIL, 'get_thread', { threadId: t.id, messageFormat: 'METADATA_ONLY' }, { cache: false })).payload || {};
        const withSubject = (t.messages || []).find(m => m.subject);
        threads.push({ id: t.id, subject: cleanSubject(withSubject && withSubject.subject), url: full.viewUrl || t.viewUrl || '', messages: full.messages || [] });
        M.done++;
        const p = document.getElementById('mine-progress');
        if (p) p.textContent = `Checking ${M.done} of ${M.total}…`;
      }
      M.items = myEmailWaits(threads, watch);
      M.status = 'ok'; M.at = Date.now();
    } catch (e) {
      M.status = 'error'; M.code = (e && e.code) || 'upstream_error'; M.message = (e && e.message) || String(e || '');
      M.items = [];
    }
    render();
  }

  // What went wrong with a connector, and what to do about it.
  function connectorTrouble(code, message, server) {
    switch (code) {
      case 'server_not_connected': return [`${server} isn’t connected to your Claude account.`, 'Add it in claude.ai under Settings → Connectors, then press Try again.'];
      case 'selection_required': return [`You have more than one ${server} connection.`, 'Choose which one this page should use when Claude asks, then press Try again.'];
      case 'needs_reauth': return [`${server} needs you to sign in again.`, 'Reconnect it in claude.ai under Settings → Connectors, then press Try again.'];
      case 'not_in_manifest': case 'approval_required': case 'consent_required': return [`${server} wasn’t allowed for this page.`, 'Press Try again and choose Allow when Claude asks.'];
      case 'blocked_by_policy': return [`Your organization doesn’t allow ${server} here.`, ''];
      case 'not_granted': case 'capability_disabled': case 'capability_removed': return ['This view can’t use your connectors.', 'Open the page on claude.ai or in the Claude app.'];
      case 'tool_error': return [`${server} answered with an error.`, message || ''];
      default: return [`Couldn’t reach ${server}.`, message || 'Try again in a moment.'];
    }
  }

  // ---- the view ----
  // First names keep the list short, unless two people share one.
  function shortNames(people) {
    const first = n => String(n).split(/\s+/)[0];
    const count = {};
    people.forEach(p => { count[first(p.name)] = (count[first(p.name)] || 0) + 1; });
    const out = {};
    people.forEach(p => { out[p.email] = count[first(p.name)] > 1 ? p.name : first(p.name); });
    return out;
  }
  // How long a wait is, against the reminder times: before the 1st, after it, after the last.
  function waitTone(ms) {
    const after = (email.info && email.info.remindAfter.length ? email.info.remindAfter : [240, 1440, 2880]).map(m => m * MIN);
    return ms >= after[after.length - 1] ? 'c-crit' : ms >= after[0] ? 'c-serious' : 'c-warn';
  }

  function viewEmail() {
    if (!email.confLoaded) return emptyCard(cap.db ? 'Loading…' : 'Open this page in Claude', cap.db ? 'Getting the email settings.' : 'The email log shows when this page is open on claude.ai or in the Claude app.');
    if (!email.conf || !email.conf.sheetId || email.editing) return emailSetupCard();
    if (email.status === 'idle' || (email.status === 'loading' && !email.loadedAt)) return emptyCard('Loading the email log…', 'Reading the reply-reminder sheet through your Google Sheets connection.') + emailMineCard();
    if (email.status === 'error') {
      const [t, b] = connectorTrouble(email.code, email.message, SHEETS);
      const noAccess = email.code === 'tool_error' ? ' If the sheet isn’t shared with you, ask whoever set this up to share it, or use Your inbox below.' : '';
      return `<div class="card"><div class="empty"><b>${esc(t)}</b><br>${esc(b + noAccess)}
        <div class="em-actions"><button class="btn small" type="button" data-action="email-retry">Try again</button>${cap.canEdit === true ? '<button class="btn small" type="button" data-action="email-edit">Change the sheet link</button>' : ''}</div></div></div>` + emailMineCard();
    }
    const E = ED || deriveEmail(email.rows, Date.now(), email.stops);
    const info = email.info;
    const stale = info && info.updated && Date.now() - info.updated > EMAIL_STALE
      ? `<p class="em-note">The email log last updated ${esc(fmtWhen(info.updated))}. The reply-reminder script may have stopped, so these numbers may be out of date.</p>` : '';
    const dry = info && /dry run/i.test(info.reminders) ? '<p class="em-note">The reminder script is in dry-run mode: it logs who would be reminded but sends nothing.</p>' : '';
    const days = (info && info.lookbackDays) || 7;
    return stale + dry + emailPauseBar() + tiles([
      { tone: 'crit', icon: 'users', value: E.waitingPeople, label: 'People who owe a reply', sub: `To ${watchedName()}’s emails` },
      { tone: 'warn', icon: 'clock', value: E.open.length, label: 'Emails waiting', sub: `Out of ${plural(E.threads, 'email')} in ${days} days` },
      { tone: 'info', icon: 'gauge', value: E.avg != null ? esc(fmtDur(E.avg)) : '–', label: 'Average reply time', sub: 'From the email to the reply' },
      { tone: 'good', icon: 'mail', value: E.reminders, label: 'Reminders sent', sub: 'In the email thread, by the script' },
    ]) + `<div class="em-top">${emailPeopleCard(E, days)}${emailMineCard(true)}</div>` + emailListCard(E) + emailSourceLine();
  }

  // Reminders on or paused, with the switch for people who can change the sheet.
  function emailPauseBar() {
    const P = email.pause || {};
    const can = canControl();
    const after = email.info && email.info.remindAfter.length ? email.info.remindAfter.map(m => fmtDur(m * MIN)) : [];
    const when = after.length > 1 ? `${after.slice(0, -1).join(', ')} and ${after[after.length - 1]}` : after.join('');
    const err = email.ctlError && !state.stop ? `<span class="em-bar-err" role="status">${esc(email.ctlError)}</span>` : '';
    if (P.paused) {
      return `<div class="em-bar paused" role="status">${ic('pause')}<span><b>All reminders are paused</b>${P.by ? ` by ${esc(P.by)}` : ''}${P.at ? `, ${esc(fmtWhen(P.at))}` : ''}. Nothing is sent until they’re turned back on.</span>
        ${can ? `<button class="btn small" type="button" data-action="email-pause" data-on="0"${email.busy ? ' disabled' : ''}>Turn reminders back on</button>` : ''}${err}</div>`;
    }
    const note = email.controls === 'missing' && cap.canEdit === true ? ' To stop or pause them from here, paste the latest Code.gs into the reminder script.' : '';
    return `<div class="em-bar">${ic('bell')}<span>Reminders are on${when ? `: they go out ${esc(when)} after an email, in its thread` : ''}.${esc(note)}</span>
      ${can ? `<button class="btn small" type="button" data-action="email-pause" data-on="1"${email.busy ? ' disabled' : ''}>Pause all reminders</button>` : ''}${err}</div>`;
  }

  // One row per person: what they owe now, and their record over the look-back.
  function emailPeopleCard(E, days) {
    const sel = state.emailPerson;
    const rows = E.people.map(p => {
      const summary = [p.waiting ? `longest wait ${fmtDur(p.longest)}` : 'nothing waiting', `${p.answered} of ${p.asked} answered`, p.stopped ? `${p.stopped} stopped` : '',
        p.avg != null ? `avg. ${fmtDur(p.avg)}` : '', plural(p.reminders, 'reminder')].filter(Boolean).join(' · ');
      return `<button class="em-gr" type="button" data-action="email-person" data-email="${esc(p.email)}" aria-pressed="${sel === p.email}" title="${esc(p.email)}" aria-label="${esc(`${p.name}: owes ${p.waiting}, ${summary}`)}">
        <span>${who(p.name)}</span>
        <span>${p.waiting ? chip(waitTone(p.longest), String(p.waiting)) : '<span class="plain">0</span>'}</span>
        <span class="em-d num">${p.waiting ? esc(fmtDur(p.longest)) : '<span class="plain">–</span>'}</span>
        <span class="em-d num">${p.answered} of ${p.asked}</span>
        <span class="em-d num">${p.avg != null ? esc(fmtDur(p.avg)) : '<span class="plain">–</span>'}</span>
        <span class="em-d num">${p.reminders}</span>
        <span class="em-m">${esc(summary)}</span></button>`;
    }).join('');
    return `<div class="card"><div class="card-h"><h2>Who owes a reply</h2><span class="hint">Last ${days} days · pick a name to see their emails</span></div>
      ${rows ? `<div class="em-grid em-pg"><div class="em-gh" aria-hidden="true"><span>Person</span><span>Owes</span><span class="em-d">Longest wait</span><span class="em-d">Answered</span><span class="em-d">Avg. reply</span><span class="em-d">Reminders</span></div>${rows}</div>`
        : '<div class="empty">No emails in the log yet.</div>'}</div>`;
  }

  // One line per email, waiting ones first; Waiting / Answered / All, and one person's.
  function emailListCard(E) {
    const f = state.emailFilter || 'waiting';
    const person = state.emailPerson && E.people.find(p => p.email === state.emailPerson);
    const mine = t => !person || t.waiting.some(p => p.person === person.email) || t.replied.some(p => p.person === person.email);
    const sets = { waiting: E.open.filter(mine), stopped: E.halted.filter(mine), answered: E.done.filter(mine), all: E.open.concat(E.halted, E.done).filter(mine) };
    const list = sets[f] || sets.waiting;
    const can = canControl();
    const short = shortNames(E.people);
    const nm = p => short[p.person] || p.name;
    const limit = state.emailAll ? list.length : 12;
    const total = remindTotal();
    const rows = list.slice(0, limit).map(t => {
      const subject = cleanSubject(t.subject);
      const waiting = t.waiting.map(p => chip(waitTone(p.waiting), `${nm(p)} ${fmtDur(p.waiting)}`)).join('')
        + t.stopped.map(p => chip('c-muted', `${nm(p)} stopped`, 'bellOff')).join('');
      const answered = t.replied.map(p => `${esc(nm(p))} ${esc(fmtDur(p.delay))}`).join(', ');
      return `<div class="em-gr">
        <span class="em-c-subj" title="${esc(subject)}">${esc(subject)}</span>
        <span class="em-d em-sent">${esc(fmtWhen(t.first))}</span>
        <span class="em-c-wait em-chips">${waiting || '<span class="plain">Nobody</span>'}</span>
        <span class="em-d em-ans">${answered ? `${ic('check')}<span>${answered}</span>` : '<span class="plain">–</span>'}</span>
        <span class="num em-c-rem">${t.waiting.length && t.reminders ? `${t.reminders} of ${total}` : '<span class="plain">–</span>'}</span>
        <span class="em-acts">${can && (t.waiting.length || t.stopped.length) ? `<button class="em-go" type="button" data-action="email-stop-open" data-thread="${esc(t.id)}" title="${t.waiting.length ? 'Stop reminders' : 'Resume reminders'}" aria-label="${esc(`${t.waiting.length ? 'Stop' : 'Resume'} reminders for “${subject}”`)}">${ic(t.waiting.length ? 'bellOff' : 'bell')}</button>` : ''}${t.msgId ? `<a class="em-go" href="${esc(gmailLink(t.msgId))}" target="_blank" rel="noopener" title="Open in Gmail" aria-label="${esc(`Open “${subject}” in Gmail`)}">${ic('out')}</a>` : ''}</span>
        <span class="em-m">Sent ${esc(fmtWhen(t.first))}${answered ? ` · <span class="em-ok">answered: ${answered}</span>` : ''}</span></div>`;
    }).join('');
    const label = { waiting: 'Waiting', stopped: 'Stopped', answered: 'Answered', all: 'All' };
    // Stopped shows only when something is stopped
    const seg = Object.keys(label).filter(k => k !== 'stopped' || sets.stopped.length || f === 'stopped').map(k => `<button type="button" data-action="email-filter" data-f="${k}" aria-pressed="${f === k}">${label[k]} <b>${sets[k].length}</b></button>`).join('');
    const empty = f === 'waiting' ? (person ? `${person.name} doesn’t owe a reply right now.` : 'Everyone has answered.')
      : f === 'answered' ? 'No email has been fully answered yet.' : f === 'stopped' ? 'No reminders are stopped.' : 'No emails yet.';
    return `<div class="card" style="margin-top:20px"><div class="card-h"><h2>Emails</h2>
        <div class="em-tools">${person ? `<span class="gchip">${esc(person.name)}<button type="button" data-action="email-person" data-email="${esc(person.email)}" aria-label="Show everyone’s emails">×</button></span>` : ''}
          <span class="seg" role="group" aria-label="Which emails">${seg}</span></div></div>
      ${rows ? `<div class="em-grid em-lg"><div class="em-gh" aria-hidden="true"><span>Subject</span><span class="em-d">Sent</span><span>Waiting on</span><span class="em-d">Answered</span><span>Reminder</span><span></span></div>${rows}</div>`
        : `<div class="empty">${esc(empty)}</div>`}
      ${list.length > limit ? `<div class="em-more"><button class="link" type="button" data-action="email-all">Show all ${list.length}</button></div>` : ''}</div>`;
  }

  function emailSourceLine() {
    const info = email.info;
    const when = info && info.updated ? `updated ${fmtWhen(info.updated)}` : 'not updated yet';
    return `<p class="hint-line">From the reply-reminder log (${esc(when)}). <a class="link" href="${esc(sheetUrl(email.conf.sheetId))}" target="_blank" rel="noopener">Open the sheet</a>
      · <button class="link" type="button" data-action="email-retry">Reload</button>${cap.canEdit === true ? ' · <button class="link" type="button" data-action="email-edit">Change the sheet link</button>' : ''}</p>`;
  }

  function emailSetupCard() {
    const canSet = cap.canEdit === true && !!cap.db;
    const cur = email.conf && email.conf.sheetId ? sheetUrl(email.conf.sheetId) : '';
    const body = canSet ? `
      <p>The reply-reminder script writes who Juan emailed, who answered and when to a Google Sheet. Run <b>makeLogSheet</b> once in the script, then paste the link it logs here.</p>
      <p class="plain">The sheet holds subjects and addresses, never what the emails say. Share it only with people who should see it. Each viewer reads it through their own Google Sheets connection.</p>
      <div class="em-link-row"><input class="name-in" id="email-link" type="url" value="${esc(cur)}" placeholder="https://docs.google.com/spreadsheets/d/…" aria-label="Link to the reply-reminder sheet">
        <button class="btn primary small" type="button" data-action="email-save-link"${email.saving ? ' disabled' : ''}>${email.saving ? 'Saving…' : 'Save link'}</button>
        ${email.editing ? '<button class="btn small" type="button" data-action="email-cancel">Cancel</button>' : ''}</div>
      ${email.linkError ? `<p class="dlg-msg err" role="status">${esc(email.linkError)}</p>` : ''}`
      : '<p>Not set up yet. Someone who can edit this page adds the link to the reply-reminder sheet here.</p>';
    return `<div class="card setup"><div class="card-b"><h2>${ic('mail')}Connect the email log</h2>${body}</div></div>` + (email.editing ? '' : emailMineCard());
  }

  function emailMineCard(inGrid) {
    const M = email.mine;
    const name = watchedName();
    const can = !!cap.mcp && emailWatching().length > 0;
    let body;
    if (M.status === 'busy') body = `<p class="plain" id="mine-progress" role="status">${M.total ? `Checking ${M.done} of ${M.total}…` : 'Searching your Gmail…'}</p>`;
    else if (M.status === 'error') {
      const [t, b] = M.code === 'no-watch' ? ['The dashboard doesn’t know whose emails to look for yet.', 'It learns that from the reply-reminder sheet once someone who can edit this page opens the Email tab.'] : connectorTrouble(M.code, M.message, GMAIL);
      body = `<p><b>${esc(t)}</b> ${esc(b)}</p>`;
    } else if (M.status === 'ok') {
      body = M.items.length ? `<div class="em-list flush">${M.items.map(x => `<div class="em-row"><div class="em-h"><b>${esc(cleanSubject(x.subject))}</b>
          <span class="sub">${esc(nameFromEmail(x.from) === name ? name : nameFromEmail(x.from))} emailed you ${esc(fmtDur(Date.now() - x.since))} ago${x.url ? ` · <a class="link" href="${esc(x.url)}" target="_blank" rel="noopener">Open</a>` : ''}</span></div></div>`).join('')}</div>`
        : `<p><b>You’re all caught up.</b> Nothing from ${esc(name)} in the last ${(email.info && email.info.lookbackDays) || 7} days is waiting on you.</p>`;
    } else body = `<p class="em-intro">Emails from ${esc(name)} you haven’t answered yet, checked in your own Gmail. Subjects and times only, never what the emails say.</p>`;
    const label = M.status === 'busy' ? 'Checking…' : M.status === 'idle' ? 'Check my Gmail' : 'Check again';
    return `<div class="card"${inGrid ? '' : ' style="margin-top:20px"'}><div class="card-h"><h2>Your inbox</h2><span class="hint">Only you see this</span></div>
      <div class="card-b">${body}<div class="em-actions"><button class="btn small" type="button" data-action="email-mine"${!can || M.status === 'busy' ? ' disabled' : ''}>${label}</button></div></div></div>`;
  }

  // On Reports: email reply time next to the WhatsApp numbers.
  function emailReportCard() {
    if (!email.conf || !email.conf.sheetId) return '';
    const head = '<div class="card-h"><h2>Email reply time by person</h2><span class="hint">From the reply-reminder log</span></div>';
    if (!ED) {
      return `<div class="card em-report" style="margin-top:20px">${head}<div class="empty">${email.status === 'loading' ? 'Loading…' : 'Open the <a class="link" href="#email">Email tab</a> to load email reply times.'}</div></div>`;
    }
    const after = (email.info && email.info.remindAfter.length ? email.info.remindAfter : [240, 1440, 2880]).map(m => m * MIN);
    const speed = ED.people.filter(p => p.avg != null).sort((a, b) => b.avg - a.avg);
    if (!speed.length) return `<div class="card em-report" style="margin-top:20px">${head}<div class="empty">No email replies yet.</div></div>`;
    const top = Math.max(after[0], ...speed.map(p => p.avg)) * 1.06;
    const tone = ms => ms < after[0] ? 'var(--good)' : ms < after[after.length - 1] ? 'var(--warn)' : 'var(--crit)';
    const bars = speed.map(p => `<div class="bar-row" tabindex="0" data-tip-t="${esc(p.name)}" data-tip="${esc(`Average ${fmtDur(p.avg)} to answer ${plural(p.answered, 'email')}. ${p.waiting ? `Owes ${plural(p.waiting, 'reply', 'replies')} right now.` : 'Nothing waiting.'}`)}">
        ${who(p.name)}<div class="bar-track"><span class="mark" style="left:${(after[0] / top * 100).toFixed(1)}%"></span>
        <div class="bar" style="width:${(p.avg / top * 100).toFixed(1)}%;background:${tone(p.avg)}"></div></div>
        <div class="bar-val">${esc(fmtDur(p.avg))}</div></div>`).join('');
    return `<div class="card em-report" style="margin-top:20px">${head}<div class="card-b"><div class="bars">${bars}</div>
      <div class="legend"><span><i style="background:var(--good)"></i>Before the 1st reminder (${esc(fmtDur(after[0]))})</span><span><i style="background:var(--warn)"></i>After it</span><span><i style="background:var(--crit)"></i>After the last reminder</span></div></div></div>`;
  }

  // The top of the page on the Email tab: no WhatsApp group filters.
  function emailFrame() {
    if (state.view !== 'email') return;
    ['group-filter', 'sender-filter', 'group-pill', 'refresh'].forEach(id => { document.getElementById(id).hidden = true; });
    const pill = document.getElementById('snap');
    const info = email.info;
    if (email.status === 'ok' && info && info.updated) {
      const stale = Date.now() - info.updated > EMAIL_STALE;
      pill.className = stale ? 'pill sample' : 'pill live';
      pill.innerHTML = `${stale ? ic('clock') : '<i class="dot"></i>'}Email log · updated ${esc(fmtClock(info.updated))}`;
    } else {
      pill.className = 'pill';
      pill.innerHTML = `${ic('mail')}${email.status === 'loading' ? 'Loading the email log…' : 'Email log'}`;
    }
    document.getElementById('foot').textContent = 'The email numbers come from the reply-reminder script, which reads only who sent what to whom and when. Each viewer opens the log through their own Google Sheets connection, and Your inbox through their own Gmail. Nothing is sent from this page.';
  }

  // keep it current while the Email tab or Reports is open
  setInterval(() => {
    if (document.visibilityState !== 'visible' || (state.view !== 'email' && state.view !== 'reports')) return;
    if (email.status === 'ok' && Date.now() - email.loadedAt > EMAIL_EVERY) loadEmail();
    else if (state.view === 'email' && email.status === 'ok') render();
  }, 60000);
  // ---------------- Deadlines (the deadline agent's log) ----------------
  // The Assignments and Misses tabs the deadline agent writes into the same
  // sheet as the email log, read through the viewer's own Google Sheets
  // connection. The agent sends the chases; this page only shows them, and
  // the Pause switch it shares with the reply reminders.
  const dl = { status: 'idle', code: null, message: '', rows: [], misses: [], loadedAt: null };
  let DL = null;

  async function maybeLoadDl(onTab) {
    if (!cap.mcp || !email.conf || !email.conf.sheetId || dl.status !== 'idle') return;
    if (onTab) { loadDl(); return; }
    let s = 'prompt';
    try { s = cap.perms ? await cap.perms.state('mcp:' + SHEETS) : 'prompt'; } catch (_) { s = 'prompt'; }
    if (s === 'granted' && dl.status === 'idle') loadDl();
  }

  async function loadDl() {
    if (!cap.mcp || !email.conf || !email.conf.sheetId || dl.status === 'loading') return;
    const was = dl.status;
    dl.status = 'loading';
    if (was !== 'ok') render();
    try {
      const rows = parseAssignments((await sheetRead('Assignments!A1:K2000')).values);
      let misses = [];
      try { misses = parseMisses((await sheetRead('Misses!A1:G5000')).values); } catch (_) { /* no Misses tab yet: nobody has missed */ }
      dl.rows = rows; dl.misses = misses;
      await loadControls(false);
      dl.status = 'ok'; dl.code = null; dl.message = ''; dl.loadedAt = Date.now();
    } catch (e) {
      dl.status = 'error';
      dl.code = (e && e.code) || 'upstream_error';
      dl.message = (e && e.message) || String(e || '');
      // no access any more: take down what was shown
      if (DENIED.includes(dl.code)) { dl.rows = []; dl.misses = []; }
    }
    render();
  }

  // Juan: "We operate on Pacific Time only." Deadlines show in Pacific, wherever the viewer is.
  const fmtPT = t => `${new Date(t).toLocaleString('en-US', { timeZone: PT_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} PT`;
  const RESULT_CHIP = { missed: ['c-crit', 'Missed'], blocked: ['c-warn', 'Blocked'], open: ['c-info', 'Open'], unread: ['c-muted', 'Not read'], late: ['c-good', 'Delivered late'], done: ['c-good', 'Delivered'] };

  function viewDeadlines() {
    if (!email.confLoaded) return emptyCard(cap.db ? 'Loading…' : 'Open this page in Claude', cap.db ? 'Getting the settings.' : 'The deadline log shows when this page is open on claude.ai or in the Claude app.');
    if (!email.conf || !email.conf.sheetId) {
      return `<div class="card"><div class="empty"><b>The log sheet isn’t connected yet.</b><br>The deadline agent writes to the same sheet as the email log. ${cap.canEdit === true ? 'Connect it on the <a class="link" href="#email">Email tab</a>.' : 'Someone who can edit this page connects it on the Email tab.'}</div></div>`;
    }
    if (dl.status === 'idle' || (dl.status === 'loading' && !dl.loadedAt)) return emptyCard('Loading the deadline log…', 'Reading the Assignments tab through your Google Sheets connection.');
    if (dl.status === 'error') {
      const missing = dl.code === 'tool_error' && /parse range|unable to parse/i.test(dl.message);
      const [t, b] = missing ? ['The deadline agent hasn’t written its log yet.', 'Its Assignments tab appears in the log sheet after its first check. Run checkDeadlines in the reminder script, then try again.']
        : connectorTrouble(dl.code, dl.message, SHEETS);
      return `<div class="card"><div class="empty"><b>${esc(t)}</b><br>${esc(b)}<div class="em-actions"><button class="btn small" type="button" data-action="dl-retry">Try again</button></div></div></div>`;
    }
    const L = DL || deriveDeadlines(dl.rows, dl.misses, Date.now());
    return dlPauseBar() + tiles([
      { tone: 'crit', icon: 'alert', value: L.missed, label: 'Overdue', sub: 'Past the deadline, not delivered' },
      { tone: 'warn', icon: 'flag', value: L.blocked, label: 'Blocked', sub: 'BLOCKED sent before the deadline' },
      { tone: 'info', icon: 'clock', value: L.open, label: 'Open', sub: 'Not due yet' },
      { tone: 'good', icon: 'check', value: L.deliveredToday, label: 'Delivered today', sub: L.deliveredToday ? (L.lateToday ? `${L.lateToday} of them late` : 'All on time') : 'Pacific time' },
    ]) + dlPeopleCard(L) + dlListCard(L) + dlSourceLine();
  }

  // The chases are on or paused. The switch is the same one that pauses the reply reminders.
  function dlPauseBar() {
    const P = email.pause || {};
    const can = canControl();
    const err = email.ctlError && !state.stop ? `<span class="em-bar-err" role="status">${esc(email.ctlError)}</span>` : '';
    if (P.paused) {
      return `<div class="em-bar paused" role="status">${ic('pause')}<span><b>Chases are paused</b>${P.by ? ` by ${esc(P.by)}` : ''}${P.at ? `, ${esc(fmtWhen(P.at))}` : ''}. Misses are still logged, but nobody is emailed until they’re turned back on.</span>
        ${can ? `<button class="btn small" type="button" data-action="email-pause" data-on="0"${email.busy ? ' disabled' : ''}>Turn chases back on</button>` : ''}${err}</div>`;
    }
    return `<div class="em-bar">${ic('bell')}<span>Chases are on: when a deadline passes with no DONE, DATE or BLOCKED, the deadline agent emails that person once, in the email’s thread.</span>
      ${can ? `<button class="btn small" type="button" data-action="email-pause" data-on="1" title="Also pauses the email reply reminders"${email.busy ? ' disabled' : ''}>Pause chases</button>` : ''}${err}</div>`;
  }

  // One row per person: what's overdue, blocked, open and delivered, and their misses over 30 days.
  function dlPeopleCard(L) {
    const sel = state.dlPerson;
    const n = v => (v ? `<span class="num">${v}</span>` : '<span class="plain">–</span>');
    const rows = L.people.map(p => {
      const delivered = p.done + p.late;
      const summary = [p.missed ? `${p.missed} overdue` : 'nothing overdue', p.blocked ? `${p.blocked} blocked` : '', p.open ? `${p.open} open` : '',
        delivered ? `${delivered} delivered${p.late ? ` (${p.late} late)` : ''}` : '', `${plural(p.misses30, 'miss', 'misses')} in 30 days`].filter(Boolean).join(' · ');
      return `<button class="em-gr" type="button" data-action="dl-person" data-email="${esc(p.email)}" aria-pressed="${sel === p.email}" title="${esc(p.email)}" aria-label="${esc(`${p.name}: ${summary}`)}">
        <span>${who(p.name)}</span>
        <span>${p.missed ? chip('c-crit', String(p.missed)) : '<span class="plain">0</span>'}</span>
        <span class="em-d">${n(p.blocked)}</span>
        <span class="em-d">${n(p.open)}</span>
        <span class="em-d">${delivered ? `<span class="num">${delivered}</span>${p.late ? ` <span class="plain">(${p.late} late)</span>` : ''}` : '<span class="plain">–</span>'}</span>
        <span class="em-d">${p.misses30 >= MISS_LIMIT ? chip('c-crit', `${p.misses30}`, 'flag') : n(p.misses30)}</span>
        <span class="em-m">${esc(summary)}</span></button>`;
    }).join('');
    const limit = L.atLimit ? ` · ${plural(L.atLimit, 'person has', 'people have')} ${MISS_LIMIT}+ misses in 30 days` : '';
    return `<div class="card" style="margin-top:20px"><div class="card-h"><h2>By person</h2><span class="hint">Pick a name to see their deadlines${esc(limit)}</span></div>
      ${rows ? `<div class="em-grid dl-pg"><div class="em-gh" aria-hidden="true"><span>Person</span><span>Overdue</span><span class="em-d">Blocked</span><span class="em-d">Open</span><span class="em-d">Delivered</span><span class="em-d">Misses (30 days)</span></div>${rows}</div>`
        : '<div class="empty">No deadlines in the log yet.</div>'}</div>`;
  }

  // One line per person per deadline, overdue first; Overdue / Blocked / Open / Delivered / All, and one person's.
  function dlListCard(L) {
    const person = state.dlPerson && L.people.find(p => p.email === state.dlPerson);
    const mine = r => !person || r.owner === person.email;
    const sets = {
      overdue: L.list.filter(r => r.result === 'missed' && mine(r)),
      blocked: L.list.filter(r => r.result === 'blocked' && mine(r)),
      open: L.list.filter(r => (r.result === 'open' || r.result === 'unread') && mine(r)),
      delivered: L.list.filter(r => (r.result === 'done' || r.result === 'late') && mine(r)),
      all: L.list.filter(mine),
    };
    const f = sets[state.dlFilter] ? state.dlFilter : sets.overdue.length ? 'overdue' : 'all';
    const list = sets[f];
    const limit = state.dlAll ? list.length : 15;
    const now = Date.now();
    const short = shortNames(L.people);
    const rows = list.slice(0, limit).map(r => {
      const task = cleanSubject(r.subject);
      const nm = short[r.owner] || r.name || '–';
      const [cls, label] = RESULT_CHIP[r.result];
      const detail = r.result === 'missed' ? (r.chased ? `chased ${fmtPT(r.chased)}` : 'not chased yet')
        : r.result === 'open' ? (r.due ? `due in ${fmtDur(Math.max(0, r.due - now))}` : '')
        : r.result === 'done' || r.result === 'late' ? (r.delivered ? fmtPT(r.delivered) : '')
        : r.result === 'unread' ? r.note : '';
      return `<div class="em-gr">
        <span class="em-c-subj" title="${esc(task)}">${esc(task)}</span>
        <span class="em-d">${esc(nm)}</span>
        <span class="em-d em-sent">${r.due ? esc(fmtPT(r.due)) : '<span class="plain">–</span>'}</span>
        <span class="dl-res">${chip(cls, label)}${detail ? `<span class="sub">${esc(detail)}</span>` : ''}</span>
        <span class="em-acts">${r.link ? `<a class="em-go" href="${esc(r.link)}" target="_blank" rel="noopener" title="Open in Gmail" aria-label="${esc(`Open “${task}” in Gmail`)}">${ic('out')}</a>` : ''}</span>
        <span class="em-m">${esc(nm)}${r.due ? ` · due ${esc(fmtPT(r.due))}` : ''}</span></div>`;
    }).join('');
    const label = { overdue: 'Overdue', blocked: 'Blocked', open: 'Open', delivered: 'Delivered', all: 'All' };
    const seg = Object.keys(label).map(k => `<button type="button" data-action="dl-filter" data-f="${k}" aria-pressed="${f === k}">${label[k]} <b>${sets[k].length}</b></button>`).join('');
    const who1 = person ? person.name : 'Nobody';
    const empty = { overdue: `${who1} has nothing overdue.`, blocked: 'Nothing is blocked.', open: 'Nothing is waiting on a deadline.', delivered: 'Nothing delivered yet.', all: 'No deadlines yet.' }[f];
    return `<div class="card" style="margin-top:20px"><div class="card-h"><h2>Deadlines</h2>
        <div class="em-tools">${person ? `<span class="gchip">${esc(person.name)}<button type="button" data-action="dl-person" data-email="${esc(person.email)}" aria-label="Show everyone’s deadlines">×</button></span>` : ''}
          <span class="seg" role="group" aria-label="Which deadlines">${seg}</span></div></div>
      ${rows ? `<div class="em-grid dl-lg"><div class="em-gh" aria-hidden="true"><span>Task</span><span class="em-d">Person</span><span class="em-d">Due</span><span>Result</span><span></span></div>${rows}</div>`
        : `<div class="empty">${esc(empty)}</div>`}
      ${list.length > limit ? `<div class="em-more"><button class="link" type="button" data-action="dl-all">Show all ${list.length}</button></div>` : ''}</div>`;
  }

  function dlSourceLine() {
    return `<p class="hint-line">From the deadline agent’s log, the Assignments and Misses tabs (read ${esc(fmtWhen(dl.loadedAt))}). It checks every 15 minutes. <a class="link" href="${esc(sheetUrl(email.conf.sheetId))}" target="_blank" rel="noopener">Open the sheet</a>
      · <button class="link" type="button" data-action="dl-retry">Reload</button></p>`;
  }

  // The top of the page on the Deadlines tab: no WhatsApp group filters.
  function dlFrame() {
    if (state.view !== 'deadlines') return;
    ['group-filter', 'sender-filter', 'group-pill', 'refresh'].forEach(id => { document.getElementById(id).hidden = true; });
    const pill = document.getElementById('snap');
    if (dl.status === 'ok' && dl.loadedAt) { pill.className = 'pill live'; pill.innerHTML = `<i class="dot"></i>Deadline log · read ${esc(fmtClock(dl.loadedAt))}`; }
    else { pill.className = 'pill'; pill.innerHTML = `${ic('cal')}${dl.status === 'loading' ? 'Loading the deadline log…' : 'Deadline log'}`; }
    document.getElementById('foot').textContent = 'The deadlines come from the deadline agent, which reads the deadlines Juan sets by email and the replies to them. Each viewer opens its log through their own Google Sheets connection. Nothing is sent from this page.';
  }

  // keep it current while the Deadlines tab is open
  setInterval(() => {
    if (document.visibilityState !== 'visible' || state.view !== 'deadlines') return;
    if (dl.status === 'ok' && Date.now() - dl.loadedAt > EMAIL_EVERY) loadDl();
    else if (dl.status === 'ok') render();
  }, 60000);
  // ---------------- saved copy (any device) ----------------
  // where a group's copy is kept in the page's storage
  const gkey = gid => String(gid).replace(/[^A-Za-z0-9_.@+:~-]/g, '_');
  // when a group was last cleared: messages before it no longer count
  const startOf = gid => ((trackedGroups().find(t => t.groupId === gid) || {}).clearedAt) || 0;

  // Several groups' messages, people and tasks put together. People are
  // matched by phone number, so someone in two groups has one record.
  function combine(parts, now) {
    const people = new Map(), messages = [], tasks = [];
    parts.forEach(({ id, name, raw }) => {
      const start = startOf(id);
      const Sg = buildFromRaw({ ...raw, messages: start ? (raw.messages || []).filter(m => m.t >= start) : raw.messages, removed: removedFor(id) }, now);
      Sg.people.forEach(p => {
        const q = people.get(p.id);
        if (!q) people.set(p.id, { ...p, groups: [id], formerIn: p.former ? [id] : [], giverIn: p.giver ? [id] : [] });
        else {
          q.groups.push(id);
          if (p.former) q.formerIn.push(id);
          if (p.giver) q.giverIn.push(id);
          q.former = q.former && p.former;
          q.giver = q.giver && p.giver;
          if (looksLikeNumber(q.name) && !looksLikeNumber(p.name)) q.name = p.name;
        }
      });
      Sg.messages.forEach(m => messages.push({ ...m, groupId: id, groupName: name }));
      Sg.tasks.forEach(t => tasks.push({ ...t, groupId: id }));
    });
    return { people: [...people.values()], messages: messages.sort((a, b) => b.at - a.at), tasks };
  }

  function showSample() {
    src.mode = 'sample'; src.S = SAMPLE; src.now = SAMPLE_NOW; src.groups = []; src.updatedAt = null;
    render();
  }

  function show(parts, mode, updatedAt) {
    src.mode = mode;
    src.groups = parts.map(p => ({ id: p.id, name: p.name }));
    src.updatedAt = updatedAt;
    src.now = mode === 'live' ? Date.now() : updatedAt;
    src.S = combine(parts, src.now);
    render();
  }

  // A tracked group's saved data, or the older single-group copy if it hasn't moved yet.
  function savedGroupData(gid) {
    const g = saved.groups[gid];
    if (g && g.meta) return g;
    const L = saved.legacy;
    if (L.meta && L.meta.group && L.meta.group.id === gid) return { meta: L.meta, analysis: L.analysis || {}, replies: {}, days: L.days, legacy: true };
    return null;
  }

  function rawFromSaved(gid) {
    const d = savedGroupData(gid);
    if (!d) return null;
    const messages = Object.values(d.days || {}).flatMap(x => (x && x.messages) || []);
    return { ...d.meta, analysis: d.analysis || {}, replies: d.replies || {}, messages, overrides: saved.names, fixes: fixesFor(gid) };
  }

  function applySaved() {
    if (src.mode === 'live') { render(); return; }
    const parts = trackedGroups().map(t => {
      const raw = rawFromSaved(t.groupId);
      return raw ? { id: t.groupId, name: (raw.group && raw.group.name) || t.groupName, raw } : null;
    }).filter(Boolean);
    if (!parts.length) { if (src.mode === 'saved') showSample(); else render(); return; }
    show(parts, 'saved', Math.max(...parts.map(p => p.raw.syncedAt || 0)));
  }

  // Groups read live, and the saved copy of any not read yet on this computer
  // (still waiting their turn), so no group drops off the screen meanwhile.
  function applyLive() {
    const parts = trackedGroups().map(t => {
      const raw = live.raws[t.groupId] ? { ...live.raws[t.groupId], overrides: saved.names, fixes: fixesFor(t.groupId) } : rawFromSaved(t.groupId);
      return raw ? { id: t.groupId, name: (raw.group && raw.group.name) || t.groupName, raw } : null;
    }).filter(Boolean);
    if (!parts.length) { if (!trackedGroups().length) showSample(); return; }
    show(parts, 'live', Math.max(...parts.map(p => p.raw.syncedAt || 0)));
    checkAlerts();
  }

  // ---------------- Google Chat alerts ----------------
  // When a new instruction lands (or a reminder/escalation stage is reached),
  // fire the "WhatsApp → Google Chat alert relay" scheduled task, which posts
  // an @all message to the team's Google Chat space. Each alert is recorded in
  // db "alerts/" so it is sent once, whichever computer sees it first.
  const ALERT_SERVER = 'Claude Code Remote', ALERT_TRIGGER = 'trig_01WNupfiAPiLBBWCmFesgasF', ALERT_SINCE = 0;
  const ALERT_STAGE = ['🔔 NEW message', '⏰ 1st reminder', '⏰ 2nd reminder', '🚨 ESCALATION'];
  const alertSent = new Set();
  let alertBusy = false;
  async function checkAlerts() {
    if (alertBusy || src.mode !== 'live' || !cap.db) return;
    alertBusy = true;
    try {
      const Dx = derive(src.S, cfg, Date.now());
      for (const m of Dx.messages) {
        // everything still pending on "Sent to the group"
        if (m.at < ALERT_SINCE || m.resolved) continue;
        if (!m.waitingAny && !m.pending.length) continue;
        const lvl = m.waitingAny ? (m.stage || 0) : Math.max(0, ...m.pending.map(r => r.stage));
        const key = `a_${String(m.id).replace(/[^A-Za-z0-9_\-]/g, '_')}_${lvl}`;
        if (alertSent.has(key)) continue;
        alertSent.add(key);
        const ref = cap.db.doc(`alerts/${key}`);
        const who = m.pending.length ? m.pending.map(r => r.name).join(', ') : 'anyone in the group';
        const text = `${ALERT_STAGE[Math.min(lvl, 3)]} from ${m.senderName || 'Juan'} in "${m.groupName || 'WhatsApp group'}" (${fmtWhen(m.at)}):\n"${String(m.text || '').slice(0, 600)}"\n\nNo reply yet: ${who}. Please reply in WhatsApp now.`;
        // queue it; Claude's watcher posts queued alerts to Google Chat (no prompt on this page)
        try { if ((await ref.get()).exists) continue; await ref.set({ msg: String(m.id), lvl, at: Date.now(), st: 'queued', text }); }
        catch (_) { alertSent.delete(key); }
      }
    } finally { alertBusy = false; }
  }
  setInterval(checkAlerts, 60000);

  function refreshShown() { if (src.mode === 'live') applyLive(); else applySaved(); }

  // Listen to each tracked group's saved data; stop listening when it's no longer tracked.
  function syncSubscriptions() {
    const db = cap.db;
    if (!db) return;
    const want = new Set(trackedGroups().map(t => t.groupId));
    Object.keys(subs).forEach(gid => {
      if (!want.has(gid)) { subs[gid].forEach(off => off()); delete subs[gid]; delete saved.groups[gid]; }
    });
    want.forEach(gid => {
      if (subs[gid]) return;
      const box = saved.groups[gid] = { meta: null, analysis: {}, replies: {}, days: {}, fixes: {}, removed: {}, loaded: { meta: false, analysis: false } };
      const fail = () => {};
      const k = gkey(gid);
      subs[gid] = [
        db.doc(`sync/${k}`).onSnapshot(snap => { box.meta = snap.exists ? snap.data() : null; box.loaded.meta = true; applySaved(); }, fail),
        // what Claude read: the instructions (byId) and the replies to them (replies)
        db.doc(`sync/${k}/extra/analysis`).onSnapshot(snap => { const v = snap.exists ? snap.data() : {}; box.analysis = v.byId || {}; box.replies = v.replies || {}; box.loaded.analysis = true; applySaved(); }, fail),
        db.collection(`sync/${k}/days`).onSnapshot(q => { const days = {}; q.docs.forEach(d => { days[d.id] = d.data(); }); box.days = days; applySaved(); }, fail),
        // replies people linked by hand, written by anyone in the company who can use the page
        db.collection(`fixes/${k}/links`).onSnapshot(q => {
          const fixes = {};
          q.docs.forEach(d => { const v = d.data(); if (v && v.request && v.person) fixes[`${v.request}~${v.person}`] = { ...v, docId: d.id }; });
          box.fixes = fixes; refreshShown();
        }, fail),
        // messages the owner or an editor deleted from the dashboard
        db.collection(`sync/${k}/removed`).onSnapshot(q => {
          const removed = {};
          q.docs.forEach(d => { const v = d.data(); if (v && v.msg) removed[v.msg] = { ...v, docId: d.id }; });
          box.removed = removed; refreshShown(); if (state.removedOpen) renderRemoved();
        }, fail),
      ];
    });
  }

  function onTrackingChanged() {
    syncSubscriptions();
    if (live.on && live.status && live.status.linked) {
      if (trackedGroups().length) syncNow(); else if (trackingKnown()) loadGroups();
    }
    refreshShown();
  }

  function subscribeSaved(db) {
    const fail = () => {};
    db.doc('settings/followup').onSnapshot(snap => {
      if (!snap.exists) return;
      const d = snap.data();
      const v = { first: d.first, second: d.second, escalate: d.escalate };
      if (valid(v) && (v.first !== cfg.first || v.second !== cfg.second || v.escalate !== cfg.escalate)) { cfg = v; render(); }
    }, fail);
    db.doc('settings/tracking').onSnapshot(snap => {
      saved.tracking = snap.exists ? snap.data() : null;
      saved.loaded.tracking = true;
      onTrackingChanged();
    }, fail);
    db.doc('settings/source').onSnapshot(snap => {
      saved.legacySource = snap.exists ? snap.data() : null;
      saved.loaded.source = true;
      onTrackingChanged();
    }, fail);
    db.doc('settings/givers').onSnapshot(snap => {
      saved.givers = snap.exists ? (snap.data().ids || []).map(String) : [];
      render();
    }, fail);
    db.doc('settings/names').onSnapshot(snap => {
      saved.names = snap.exists ? (snap.data().byId || {}) : {};
      refreshShown();
    }, fail);
    // the older single-group copy, read until it has been moved
    db.doc('sync/meta').onSnapshot(snap => { saved.legacy.meta = snap.exists ? snap.data() : null; saved.loaded.legacyMeta = true; applySaved(); }, fail);
    db.doc('sync/analysis').onSnapshot(snap => { saved.legacy.analysis = snap.exists ? (snap.data().byId || {}) : {}; saved.loaded.legacyAnalysis = true; applySaved(); }, fail);
    db.collection('sync/meta/days').onSnapshot(q => { const days = {}; q.docs.forEach(d => { days[d.id] = d.data(); }); saved.legacy.days = days; applySaved(); }, fail);
  }

  // ---------------- linking a reply by hand (anyone in the company who can use the page) ----------------
  // When someone did answer but the rules counted it somewhere else (a swipe-reply
  // to another message, the wrong group), they or anyone else can link one of
  // that person's own messages from the half hour after the request.
  const LINK_WINDOW = 30 * MIN;
  const fixesFor = gid => (saved.groups[gid] && saved.groups[gid].fixes) || {};
  const canLinkReplies = () => src.mode !== 'sample' && !!cap.db && cap.canWrite !== false;
  const linkers = { names: {}, asked: new Set() };
  function linkerName(id) {
    if (!id) return 'someone';
    if (id === cap.me) return 'you';
    if (linkers.names[id]) return linkers.names[id];
    if (cap.user && !linkers.asked.has(id)) {
      linkers.asked.add(id);
      cap.user.profiles([id]).then(ps => { const n = ps && ps[id] && ps[id].name; if (n) { linkers.names[id] = n; render(); } }, () => {});
    }
    return 'someone';
  }

  // The person's own messages, in any tracked group, from the half hour after the request.
  // pid '*': a question anyone can answer, so anyone's messages in that group except the managers'.
  function linkCandidates(m, pid) {
    const out = [];
    const anyone = pid === '*';
    trackedGroups().forEach(t => {
      if (anyone && t.groupId !== m.groupId) return;
      const bosses = new Set(t.bossIds || []);
      const raw = src.mode === 'live' ? live.raws[t.groupId] : rawFromSaved(t.groupId);
      if (!raw) return;
      const nameOf = nameIndex({ ...raw, overrides: saved.names });
      (raw.messages || []).forEach(c => {
        if ((anyone ? bosses.has(c.s) || c.s === m.senderId : c.s !== pid) || c.d || c.k === 'joined' || c.k === 'left' || c.i === m.id) return;
        if (c.t < m.at || c.t > m.at + LINK_WINDOW) return;
        const text = c.k === 'reaction' ? `Reacted ${c.x || ''}` : replyText(c, nameOf);
        out.push({ id: c.i, at: c.t, group: t.groupId, groupName: (raw.group && raw.group.name) || t.groupName, text: (text || 'Message').slice(0, 300), sender: c.s, senderName: nameOf(c.s) });
      });
    });
    return out.sort((a, b) => a.at - b.at);
  }

  const linkDlg = document.getElementById('link-dlg');
  const linkBox = document.getElementById('link-box');
  function renderLink() {
    const L = state.link;
    linkDlg.hidden = !L;
    if (!L) return;
    const multi = trackedGroups().length > 1;
    const list = L.items.length ? `<div class="pick-list" role="radiogroup" aria-label="${esc(L.name)}\u2019s messages">${L.items.map(c => `
        <label class="choice"><input type="radio" name="link-pick" value="${esc(c.id)}"${L.pick === c.id ? ' checked' : ''}>
          <span><b>${L.anyone ? esc(c.senderName) + ': ' : ''}${esc(c.text)}</b><span class="sub">${multi && !L.anyone ? esc(c.groupName) + ' \u00B7 ' : ''}${esc(fmtWhen(c.at))} \u00B7 ${fmtDur(c.at - L.at)} after the message</span></span></label>`).join('')}</div>`
      : L.anyone ? `<p class="plain">Nobody sent anything in the 30 minutes after this message. Whoever answered can swipe-reply to the question in WhatsApp and it will count.</p>`
      : `<p class="plain">${esc(L.name)} didn\u2019t send anything in the 30 minutes after this message. If they answered later or somewhere else, they can react \u{1F44D} to the message in WhatsApp and it will count.</p>`;
    linkBox.innerHTML = `<div class="dlg-h"><div><h2 id="link-h">${L.anyone ? 'Mark as answered' : `Mark ${esc(L.name)} as replied`}</h2>
        <p>${L.anyone ? `Pick the message that answers \u201C${esc(L.title)}\u201D. Messages from anyone in the group, from the 30 minutes after it was sent, are listed.` : `Pick the message ${esc(L.name)} sent that answers \u201C${esc(L.title)}\u201D. Only their own messages from the 30 minutes after it was sent are listed.`} Everyone can see who linked it.</p></div>
        <button class="x" type="button" data-action="link-cancel" aria-label="Close">${'<svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'}</button></div>
      <div class="dlg-b">${list}</div>
      <p class="dlg-msg err" role="status">${esc(L.error || '')}</p>
      <div class="dlg-f"><button class="btn" type="button" data-action="link-cancel">Cancel</button>
        ${L.items.length ? `<button class="btn primary" type="button" data-action="link-save"${L.pick && !L.saving ? '' : ' disabled'}>${L.saving ? 'Saving\u2026' : 'Link reply'}</button>` : ''}</div>`;
  }

  function openLink(msgId, pid) {
    const m = src.S.messages.find(x => x.id === msgId);
    if (!m) return;
    const person = src.S.people.find(p => p.id === pid);
    state.link = { msgId, pid, anyone: pid === '*', groupId: m.groupId, at: m.at, title: m.title, name: (person && person.name) || 'this person',
      items: linkCandidates(m, pid), pick: null, saving: false, error: '' };
    renderLink();
    const first = linkBox.querySelector('input, button.btn');
    if (first) first.focus();
  }

  function closeLink() { state.link = null; renderLink(); }

  const linkError = e => e && e.code === 'invalid_argument' ? 'You can\u2019t change this page. Ask the owner to give you access.'
    : `Couldn\u2019t save the link${e && e.message ? ': ' + e.message : '.'}`;

  async function saveLink() {
    const L = state.link;
    const c = L && L.items.find(x => x.id === L.pick);
    if (!c || L.saving || !cap.db) return;
    L.saving = true; L.error = ''; renderLink();
    const person = L.anyone ? c.sender : L.pid;
    const doc = { request: L.msgId, person, msg: c.id, group: c.group, at: c.at, text: c.text, by: cap.me || null, on: Date.now() };
    try {
      await cap.db.doc(`fixes/${gkey(L.groupId)}/links/${gkey(`${L.msgId}~${person}`)}`).set(doc);
      closeLink();
    } catch (e) {
      if (e && e.code === 'invalid_argument') cap.canWrite = false;
      L.saving = false; L.error = linkError(e); renderLink();
    }
  }

  async function unlink(msgId, pid) {
    const m = src.S.messages.find(x => x.id === msgId);
    const f = m && fixesFor(m.groupId)[`${msgId}~${pid}`];
    if (!f || !cap.db) return;
    try { await cap.db.doc(`fixes/${gkey(m.groupId)}/links/${f.docId}`).delete(); }
    catch (e) { notify(linkError(e)); }
  }

  linkDlg.addEventListener('click', e => { if (e.target === linkDlg) closeLink(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (state.draft) closeDraft();
    else if (state.link) closeLink();
    else if (state.removedOpen) { state.removedOpen = false; renderRemoved(); }
    else if (state.clear && !state.clear.busy) { state.clear = null; renderClear(); }
  });

  // ---------------- deleting a message from the dashboard (owner and editors) ----------------
  // Hides one request, with its nudges, replies and task. Nothing in WhatsApp
  // changes, and it can be brought back from the deleted list.
  const removedFor = gid => (saved.groups[gid] && saved.groups[gid].removed) || {};
  const canDelete = () => cap.canEdit === true && src.mode !== 'sample';
  const allRemoved = () => trackedGroups().flatMap(t => Object.values(removedFor(t.groupId))
    .map(r => ({ ...r, gid: t.groupId, groupName: t.groupName }))).sort((a, b) => (b.on || 0) - (a.on || 0));
  const removedCount = () => canDelete() ? allRemoved().length : 0;
  const removedLink = () => `<button class="link" type="button" data-action="open-removed">${plural(removedCount(), 'deleted message')}</button>`;
  const deleteButton = m => canDelete() && m.groupId
    ? `<button class="btn small danger${state.confirmDelete === m.id ? ' armed' : ''}" type="button" data-action="delete-msg" data-msg="${esc(m.id)}">${state.confirmDelete === m.id ? 'Click again to delete' : 'Delete'}</button>` : '';
  let noticeTimer = 0;
  function notify(text) {
    state.notice = text; renderFrame();
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { state.notice = ''; renderFrame(); }, 9000);
  }
  const removeError = e => e && e.code === 'invalid_argument' ? 'Only the owner and editors of this page can delete messages.'
    : `Couldn\u2019t delete that message${e && e.message ? ': ' + e.message : '.'}`;

  async function removeMessage(msgId) {
    const m = src.S.messages.find(x => x.id === msgId);
    if (!m || !m.groupId || !cap.db || !canDelete()) return;
    const id = gkey(m.id), box = saved.groups[m.groupId];
    const doc = { msg: m.id, title: m.title, text: String(m.text || '').slice(0, 160), at: m.at, group: m.groupId, by: cap.me || null, on: Date.now() };
    state.confirmDelete = null; state.sel = null;
    // gone from the screen straight away; the saved copy follows
    if (box) box.removed = { ...(box.removed || {}), [m.id]: { ...doc, docId: id } };
    refreshShown();
    try { await cap.db.doc(`sync/${gkey(m.groupId)}/removed/${id}`).set(doc); }
    catch (e) {
      if (box) { const r = { ...box.removed }; delete r[m.id]; box.removed = r; }
      notify(removeError(e)); refreshShown();
    }
  }

  async function restoreMessage(gid, msgId) {
    const box = saved.groups[gid], r = removedFor(gid)[msgId];
    if (!r || !cap.db || !canDelete()) return;
    if (box) { const next = { ...box.removed }; delete next[msgId]; box.removed = next; }
    refreshShown(); renderRemoved();
    try { await cap.db.doc(`sync/${gkey(gid)}/removed/${r.docId}`).delete(); }
    catch (e) { if (box) box.removed = { ...box.removed, [msgId]: r }; notify(removeError(e)); refreshShown(); renderRemoved(); }
  }

  const removedDlg = document.getElementById('removed-dlg');
  const removedBox = document.getElementById('removed-box');
  removedDlg.addEventListener('click', e => { if (e.target === removedDlg) { state.removedOpen = false; renderRemoved(); } });
  function renderRemoved() {
    removedDlg.hidden = !state.removedOpen;
    if (!state.removedOpen) return;
    const list = allRemoved();
    const multi = trackedGroups().length > 1;
    const rows = list.length ? list.map(r => `<div class="clear-row"><div><b>${esc(r.title || 'Message')}</b>
        <span class="sub">${multi ? esc(r.groupName) + ' \u00B7 ' : ''}sent ${esc(fmtWhen(r.at))} \u00B7 deleted by ${esc(linkerName(r.by))}${r.on ? ' ' + esc(fmtWhen(r.on)) : ''}</span></div>
        <button class="btn small" type="button" data-action="restore-msg" data-gid="${esc(r.gid)}" data-msg="${esc(r.msg)}">Restore</button></div>`).join('')
      : '<p class="plain">Nothing has been deleted.</p>';
    removedBox.innerHTML = `<div class="dlg-h"><div><h2 id="removed-h">Deleted messages</h2>
        <p>These no longer count anywhere on the dashboard. Restore one to count it again.</p></div>
        <button class="x" type="button" data-action="removed-close" aria-label="Close"><svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="dlg-b">${rows}</div>
      <div class="dlg-f"><button class="btn" type="button" data-action="removed-close">Done</button></div>`;
  }

  // ---------------- clearing a group's data (owner and editors) ----------------
  // WhatsApp Reader keeps the last 30 days, so deleting the page's copy alone would
  // bring everything back on the next update. Clearing also records a start time:
  // from then on only messages sent after it count, on every device.
  const clearDlg = document.getElementById('clear-dlg');
  const clearBox = document.getElementById('clear-box');
  clearDlg.addEventListener('click', e => { if (e.target === clearDlg && state.clear && !state.clear.busy) { state.clear = null; renderClear(); } });

  function renderClear() {
    const C = state.clear;
    clearDlg.hidden = !C;
    if (!C) return;
    const rows = trackedGroups().map(t => {
      const raw = live.raws[t.groupId], d = savedGroupData(t.groupId);
      const n = raw ? raw.messages.filter(m => m.t >= (t.clearedAt || 0)).length : d && d.meta ? d.meta.messageCount : null;
      const sub = C.done[t.groupId] ? `<span class="sub ok">Cleared. Counting from ${esc(fmtWhen(C.done[t.groupId]))}.</span>`
        : `<span class="sub">${[n != null ? plural(n, 'message') + ' saved' : '', t.clearedAt ? 'counting since ' + fmtWhen(t.clearedAt) : 'counting the last 30 days'].filter(Boolean).map(esc).join(' \u00B7 ')}</span>`;
      const armed = C.confirm === t.groupId;
      const btn = C.busy === t.groupId ? '<button class="btn small danger" type="button" disabled>Clearing\u2026</button>'
        : `<button class="btn small danger${armed ? ' armed' : ''}" type="button" data-action="clear-group" data-gid="${esc(t.groupId)}"${C.busy ? ' disabled' : ''}>${armed ? 'Click again to clear' : 'Clear'}</button>`;
      return `<div class="clear-row"><div><b>${esc(t.groupName || 'Unnamed group')}</b>${sub}</div>${btn}</div>`;
    }).join('');
    clearBox.innerHTML = `<div class="dlg-h"><div><h2 id="clear-h">Clear data</h2>
        <p>Deletes a group's saved messages, replies, tasks and linked replies from this page. The dashboard then counts only messages sent after that moment. WhatsApp and WhatsApp Reader keep their own copy. This can\u2019t be undone.</p></div>
        <button class="x" type="button" data-action="clear-close" aria-label="Close"><svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="dlg-b">${rows}</div>
      <p class="dlg-msg err" role="status">${esc(C.error || '')}</p>
      <div class="dlg-f"><button class="btn" type="button" data-action="clear-close"${C.busy ? ' disabled' : ''}>Done</button></div>`;
  }

  async function clearGroup(gid) {
    const C = state.clear, db = cap.db;
    if (!C || !db || cap.canEdit !== true) return;
    const k = gkey(gid), at = Date.now();
    const groups = trackedGroups().map(t => t.groupId === gid ? { ...t, clearedAt: at } : t);
    C.busy = gid; C.error = ''; renderClear();
    // count from now on this computer straight away, so an update running meanwhile saves nothing older
    const before = saved.tracking;
    saved.tracking = { ...(saved.tracking || {}), groups };
    Object.keys(live.written).forEach(key => { if (key.startsWith(gid + '|')) delete live.written[key]; });
    delete live.writtenAnalysis[gid]; delete live.writtenMeta[gid];
    const box = saved.groups[gid] || {};
    try {
      for (const day of Object.keys(box.days || {})) await db.doc(`sync/${k}/days/${day}`).delete();
      for (const f of Object.values(box.fixes || {})) await db.doc(`fixes/${k}/links/${f.docId}`).delete();
      for (const r of Object.values(box.removed || {})) await db.doc(`sync/${k}/removed/${r.docId}`).delete();
      await db.doc(`sync/${k}/extra/analysis`).delete();
      await db.doc(`sync/${k}`).delete();
      // then tell every other computer, the one running WhatsApp Reader included
      await db.doc('settings/tracking').set({ groups, me: (before && before.me) || (live.status && live.status.phone) || null, savedAt: Date.now() });
      C.done[gid] = at;
    } catch (e) {
      C.error = e && e.code === 'invalid_argument' ? 'Only the owner and editors of this page can clear data.'
        : `Couldn\u2019t finish clearing${e && e.message ? ': ' + e.message : ''}. Press Clear again to retry.`;
    }
    C.busy = null; C.confirm = null;
    renderClear();
    onTrackingChanged();
  }
  document.addEventListener('change', e => { if (e.target.name === 'link-pick' && state.link) { state.link.pick = e.target.value; renderLink(); } });

  // ---------------- live reading (Claude desktop app on the computer running WhatsApp Reader) ----------------
  // The Claude app limits how fast a page may call programs on the computer
  // ("Host tool rate limit exceeded"). Calls go one at a time, spaced out; a
  // refused call waits and tries again, and the spacing widens until calls
  // stop being refused, then narrows again.
  const pace = { gap: 150, last: 0, ok: 0, chain: Promise.resolve() };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isRateLimit = e => !!e && (e.code === 'rate_limited' || /rate limit/i.test(String(e.message || '')));
  function readerSlot() {
    const turn = pace.chain.then(async () => {
      const wait = pace.last + pace.gap - Date.now();
      if (wait > 0) await sleep(wait);
      pace.last = Date.now();
    });
    pace.chain = turn.catch(() => {});
    return turn;
  }
  async function callReader(tool, input) {
    for (let attempt = 0; ; attempt++) {
      await readerSlot();
      try {
        const out = (await cap.mcp.callTool(READER, tool, input || {}, { cache: false })).payload;
        if (++pace.ok >= 20 && pace.gap > 150) { pace.gap = Math.max(150, Math.round(pace.gap * 0.8)); pace.ok = 0; }
        return out;
      } catch (e) {
        if (!isRateLimit(e) || attempt >= 2) throw e;
        pace.ok = 0;
        pace.gap = Math.min(4000, pace.gap * 2);
        await sleep(Math.min(e.retryAfterMs > 0 ? e.retryAfterMs : 15000, 60000) + Math.random() * 1000);
      }
    }
  }

  async function startLive() {
    if (!cap.mcp) { live.diag = { code: 'no-mcp' }; render(); return; }
    let st;
    live.diag = { code: 'connecting' }; renderFrame();
    try { st = await callReader('status'); }
    catch (e) { live.on = false; live.offCode = e && e.code; live.diag = { code: (e && e.code) || 'unknown', message: e && e.message }; render(); return; }
    live.on = true; live.status = st; live.diag = null;
    render();
    if (live.unwatch) return;
    // Ask the reader for news every 30 seconds. A plain timer keeps going
    // while the window is minimized (the browser slows it to about once a
    // minute), so the shared copy stays current in the background.
    live.unwatch = setInterval(async () => {
      if (!live.on || live.polling) return;
      live.polling = true;
      try { onStatus(await callReader('status')); }
      catch (e) {
        const code = e && e.code;
        if (['server_not_connected', 'not_in_manifest', 'blocked_by_policy', 'approval_required', 'not_granted'].includes(code)) {
          live.on = false; live.offCode = code; live.diag = { code, message: e.message };
          if (src.mode === 'live') { src.mode = 'sample'; src.S = SAMPLE; src.now = SAMPLE_NOW; src.groups = []; applySaved(); } else render();
        }
      } finally { live.polling = false; }
    }, 30000);
    onStatus(st);
  }

  function onStatus(st) {
    if (!st) return;
    const wasLinked = live.status && live.status.linked;
    live.status = st;
    if (!st.linked) { render(); return; }
    if (!trackedGroups().length || state.setup) {
      if (trackingKnown() && (!live.groups || !wasLinked)) loadGroups(); // otherwise the saved choice is still loading
      if (!trackedGroups().length) { render(); return; }
    }
    const sig = `${st.messages_stored}|${st.last_message_at}|${st.groups_known}`;
    if (sig !== live.lastSig || Date.now() - live.lastSync > 10 * MIN) { live.lastSig = sig; syncNow(); }
    else if (src.mode === 'live') { src.now = Date.now(); render(); }
  }

  async function loadGroups() {
    try { live.groups = ((await callReader('list_groups')) || {}).groups || []; live.setupError = ''; }
    catch (e) { live.groups = []; live.setupError = e.message || 'Couldn’t list the groups.'; }
    render();
  }

  // Reads a group's members for the setup form.
  async function loadGroupInfo(id) {
    try {
      const g = await callReader('get_group', { group_id: id });
      if (state.editGroup !== id) return null;
      live.groupInfo = g; live.setupError = '';
      return g;
    } catch (e) { live.setupError = e.message || 'Couldn’t read that group.'; return null; }
    finally { render(); }
  }

  // WhatsApp Reader 1.0.3 answers member lists from its own saved copy. An
  // older one asks WhatsApp each time, so those requests are spaced out.
  const readerAtLeast = v => {
    const have = String((live.status && live.status.version) || '0').split('.').map(Number);
    const want = v.split('.').map(Number);
    for (let i = 0; i < want.length; i++) { if ((have[i] || 0) !== want[i]) return (have[i] || 0) > want[i]; }
    return true;
  };
  const pause = ms => new Promise(r => setTimeout(r, ms));

  // Who starts ticked in a group being added: the default instruction-givers
  // who are in it (none if none are), else the ones used for the others, else this phone.
  function presetGivers(g) {
    const ids = new Set(g.participants.map(p => p.id));
    if (saved.givers.length) return new Set(saved.givers.filter(x => ids.has(x)));
    const fromTemplate = state.addTemplate ? [...state.addTemplate].filter(x => ids.has(x)) : [];
    return new Set(fromTemplate.length ? fromTemplate : g.me && ids.has(g.me) ? [g.me] : []);
  }

  // Members of a group being added, read one group at a time.
  async function loadAddInfo(id, force) {
    if (!force && live.groupInfos[id]) return;
    try {
      const g = await callReader('get_group', { group_id: id });
      live.groupInfos[id] = g;
      if (!state.addBoss[id]) state.addBoss[id] = presetGivers(g);
    } catch (e) { live.groupInfos[id] = null; }
    render();
  }
  async function loadAddInfos(first) {
    const gap = readerAtLeast('1.0.3') ? 0 : 1500;
    if (first) await loadAddInfo(first);
    for (const id of pickedInOrder()) {
      if (state.addStep !== 'setup') return;
      if (live.groupInfos[id] !== undefined) continue;
      if (gap) await pause(gap);
      await loadAddInfo(id);
    }
  }
  function resetAdding() {
    state.pickGroups = new Set(); state.groupQuery = ''; state.addStep = null; state.addActive = null;
    state.addBoss = {}; state.addTemplate = null; state.addNote = ''; state.addManual = new Set(); state.giverQuery = '';
  }

  // The default instruction-givers changed: tick them again in every group
  // nobody has picked for by hand, and save them for next time.
  async function setDefaultGivers(ids) {
    saved.givers = [...new Set(ids)];
    pickedInOrder().forEach(id => {
      const g = live.groupInfos[id];
      if (g && !state.addManual.has(id)) state.addBoss[id] = presetGivers(g);
    });
    state.giverQuery = '';
    render();
    const q = document.getElementById('giver-q');
    if (q) q.focus();
    if (cap.db && cap.canEdit !== false) {
      try { await cap.db.doc('settings/givers').set({ ids: saved.givers, savedAt: Date.now() }); }
      catch (e) { notify('Couldn\u2019t save the default instruction-givers for next time. They still apply now.'); }
    }
  }

  // The names typed into the setup form, merged into the saved list.
  function namesFromForm(g) {
    const names = { ...saved.names };
    g.participants.forEach(p => {
      if (!state.setupNames || !(p.id in state.setupNames)) return;
      const v = state.setupNames[p.id].trim();
      if (v) names[p.id] = v; else delete names[p.id];
    });
    return names;
  }
  function namesFromEdits() {
    const names = { ...saved.names };
    Object.entries(state.setupNames || {}).forEach(([id, v]) => { v = v.trim(); if (v) names[id] = v; else delete names[id]; });
    return names;
  }

  async function saveTracking(groups, names) {
    const tracking = { groups, me: live.status && live.status.phone, savedAt: Date.now() };
    saved.tracking = tracking;
    if (names) saved.names = names;
    if (cap.db) {
      try {
        await cap.db.doc('settings/tracking').set(tracking);
        if (names) await cap.db.doc('settings/names').set({ byId: names });
      } catch (e) { live.setupError = 'Couldn’t save the change on this page.'; }
    }
    onTrackingChanged();
  }

  // Removes a group's saved copy from the page (the reader keeps its own).
  async function forgetGroup(gid) {
    const db = cap.db;
    delete live.raws[gid];
    if (!db || cap.canEdit === false) return;
    const box = saved.groups[gid];
    const days = Object.keys((box && box.days) || {});
    const k = gkey(gid);
    try {
      for (const day of days) await db.doc(`sync/${k}/days/${day}`).delete();
      for (const f of Object.values((box && box.fixes) || {})) await db.doc(`fixes/${k}/links/${f.docId}`).delete();
      for (const r of Object.values((box && box.removed) || {})) await db.doc(`sync/${k}/removed/${r.docId}`).delete();
      await db.doc(`sync/${k}/extra/analysis`).delete();
      await db.doc(`sync/${k}`).delete();
    } catch (_) { /* nothing else to do; it is no longer shown */ }
  }

  async function onAction(action, gid, data) {
    const tracked = trackedGroups();
    if (action === 'open-link') openLink(data.msg, data.pid);
    else if (action === 'open-draft') openDraft(data.msg);
    else if (action === 'draft-close') closeDraft();
    else if (action === 'draft-again') writeDraft();
    else if (action === 'draft-copy') copyDraft();
    else if (action === 'delete-msg') {
      if (state.confirmDelete !== data.msg) { state.confirmDelete = data.msg; render(); return; }
      removeMessage(data.msg);
    }
    else if (action === 'open-removed') { state.removedOpen = true; renderRemoved(); const b = removedBox.querySelector('button'); if (b) b.focus(); }
    else if (action === 'removed-close') { state.removedOpen = false; renderRemoved(); }
    else if (action === 'restore-msg') restoreMessage(gid, data.msg);
    else if (action === 'open-clear') { state.clear = { confirm: null, done: {}, busy: null, error: '' }; renderClear(); const b = clearBox.querySelector('button'); if (b) b.focus(); }
    else if (action === 'clear-close') { state.clear = null; renderClear(); }
    else if (action === 'clear-group') {
      if (!state.clear || state.clear.busy) return;
      if (state.clear.confirm !== gid) { state.clear.confirm = gid; renderClear(); return; }
      clearGroup(gid);
    }
    else if (action === 'link-cancel') closeLink();
    else if (action === 'link-save') saveLink();
    else if (action === 'unlink') unlink(data.msg, data.pid);
    else if (action === 'refresh') refreshNow();
    else if (action === 'email-retry') { if (email.status !== 'loading') { email.status = 'idle'; loadEmail(); } }
    else if (action === 'email-edit') { email.editing = true; email.linkError = ''; render(); const i = document.getElementById('email-link'); if (i) i.focus(); }
    else if (action === 'email-cancel') { email.editing = false; email.linkError = ''; render(); }
    else if (action === 'email-save-link') saveEmailLink();
    else if (action === 'email-mine') checkMine();
    else if (action === 'email-filter') { state.emailFilter = data.f; state.emailAll = false; render(); }
    else if (action === 'email-all') { state.emailAll = true; render(); }
    else if (action === 'email-stop-open') openStop(data.thread);
    else if (action === 'stop-close') closeStop();
    else if (action === 'email-stop-save') saveStop();
    else if (action === 'email-resume') resumeStop(Number(data.row));
    else if (action === 'email-pause') setPause(data.on === '1');
    else if (action === 'dl-retry') { if (dl.status !== 'loading') { dl.status = 'idle'; loadDl(); } }
    else if (action === 'dl-filter') { state.dlFilter = data.f; state.dlAll = false; render(); }
    else if (action === 'dl-all') { state.dlAll = true; render(); }
    else if (action === 'dl-person') {
      state.dlPerson = state.dlPerson === data.email ? null : data.email;
      // someone with nothing overdue: show everything of theirs
      const p = state.dlPerson && DL && DL.people.find(x => x.email === state.dlPerson);
      if (p && !p.missed && (state.dlFilter || 'overdue') === 'overdue') state.dlFilter = 'all';
      state.dlAll = false; render();
    }
    else if (action === 'email-person') {
      state.emailPerson = state.emailPerson === data.email ? null : data.email;
      // someone who owes nothing: show what they did answer
      const p = state.emailPerson && ED && ED.people.find(x => x.email === state.emailPerson);
      if (p && !p.waiting && (state.emailFilter || 'waiting') === 'waiting') state.emailFilter = 'all';
      state.emailAll = false; render();
    }
    else if (action === 'connect') {
      startLive();
    } else if (action === 'recheck') {
      try { onStatus(await callReader('status')); } catch (e) { live.on = false; render(); }
    } else if (action === 'change-group') {
      state.setup = true; state.editGroup = null; state.setupBoss = null; state.setupNames = null; state.confirmRemove = null;
      resetAdding(); render(); loadGroups();
    } else if (action === 'leave-setup') {
      // nothing tracked yet: stay off this screen until Groups and names is opened again
      if (!trackedGroups().length) state.skipSetup = true;
      state.setup = false; state.editGroup = null; state.setupBoss = null; state.setupNames = null; state.confirmRemove = null;
      resetAdding(); render(); window.scrollTo(0, 0);
    } else if (action === 'done-setup') {
      state.setup = false; state.editGroup = null; resetAdding(); render();
    } else if (action === 'cancel-edit') {
      state.editGroup = null; state.setupBoss = null; state.setupNames = null; render();
    } else if (action === 'pick-all') {
      // tick every group showing right now (after the search and the 0-member filter)
      const ids = [...document.querySelectorAll('#group-choices .choice:not([hidden]) input[name="pick-group"]')].map(x => x.value);
      if (!ids.length) return;
      if (ids.length > 20 && state.confirmAll !== ids.length) { state.confirmAll = ids.length; render(); return; }
      state.confirmAll = 0; ids.forEach(id => state.pickGroups.add(id)); render();
    } else if (action === 'pick-clear') {
      state.pickGroups = new Set(); render();
    } else if (action === 'pick-next') {
      if (!state.pickGroups.size) return;
      state.addStep = 'setup'; state.addActive = pickedInOrder()[0]; state.addNote = '';
      render(); window.scrollTo(0, 0); loadAddInfos(state.addActive);
    } else if (action === 'add-back') {
      state.addStep = null; render();
    } else if (action === 'add-active') {
      state.addActive = gid; state.addNote = ''; render(); loadAddInfo(gid);
    } else if (action === 'add-default') {
      setDefaultGivers(saved.givers.concat(data.pid));
    } else if (action === 'remove-default') {
      setDefaultGivers(saved.givers.filter(x => x !== data.pid));
    } else if (action === 'add-next-missing') {
      // the next group after this one that still needs someone ticked
      const ids = pickedInOrder(), at = ids.indexOf(state.addActive);
      const need = id => !(live.groupInfos[id] && state.addBoss[id] && state.addBoss[id].size);
      const next = ids.slice(at + 1).concat(ids.slice(0, at + 1)).find(need);
      if (!next) return;
      state.addActive = next; state.addNote = ''; render(); loadAddInfo(next);
      const el = document.querySelector(`.addg[data-gid="${CSS.escape(next)}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else if (action === 'add-retry-all') {
      const failed = pickedInOrder().filter(id => live.groupInfos[id] === null);
      failed.forEach(id => { live.groupInfos[id] = undefined; });
      render(); loadAddInfos();
    } else if (action === 'add-retry') {
      live.groupInfos[gid] = undefined; render(); loadAddInfo(gid, true);
    } else if (action === 'add-apply') {
      // the same people give instructions across most groups: tick them everywhere they're members
      const chosen = state.addBoss[gid];
      if (!chosen || !chosen.size) return;
      state.addTemplate = new Set(chosen);
      let applied = 0, missing = 0;
      pickedInOrder().filter(id => id !== gid).forEach(id => {
        const info = live.groupInfos[id];
        if (!info) return;
        const here = info.participants.filter(p => chosen.has(p.id)).map(p => p.id);
        if (here.length) { state.addBoss[id] = new Set(here); applied++; } else missing++;
      });
      state.addNote = `Applied to ${plural(applied, 'other group')}.${missing ? ` ${plural(missing, 'group')} ${missing === 1 ? 'doesn\u2019t' : 'don\u2019t'} have these people; pick for ${missing === 1 ? 'it' : 'those'} yourself.` : ''} Groups still loading will use them too.`;
      render();
    } else if (action === 'add-groups') {
      const ids = pickedInOrder();
      if (!ids.length || !ids.every(id => live.groupInfos[id] && state.addBoss[id] && state.addBoss[id].size)) return;
      const groups = tracked.concat(ids.map(id => ({ groupId: id, groupName: live.groupInfos[id].name || pickedName(id), bossIds: [...state.addBoss[id]] })));
      const names = namesFromEdits();
      resetAdding(); state.setupNames = null; state.setup = false;
      live.lastSig = '';
      await saveTracking(groups, names);
    } else if (action === 'edit-group') {
      const t = tracked.find(x => x.groupId === gid);
      if (!t) return;
      state.editGroup = gid; state.setupNames = null; state.confirmRemove = null;
      state.setupBoss = new Set(t.bossIds || []);
      render(); loadGroupInfo(gid);
    } else if (action === 'save-group') {
      const g = live.groupInfo;
      if (!g || g.id !== state.editGroup || !state.setupBoss || !state.setupBoss.size) return;
      const groups = tracked.map(t => t.groupId === g.id ? { ...t, groupId: g.id, groupName: g.name || t.groupName, bossIds: [...state.setupBoss] } : t);
      const names = namesFromForm(g);
      state.editGroup = null; state.setupBoss = null; state.setupNames = null;
      live.lastSig = '';
      await saveTracking(groups, names);
    } else if (action === 'remove-group') {
      if (state.confirmRemove !== gid) { state.confirmRemove = gid; render(); return; }
      state.confirmRemove = null;
      if (state.groupFilter === gid) state.groupFilter = 'all';
      await forgetGroup(gid);
      await saveTracking(tracked.filter(t => t.groupId !== gid), null);
    }
  }

  // Read WhatsApp Reader now instead of waiting for the next 30-second check.
  async function refreshNow() {
    if (!live.on || live.refreshing) return;
    live.refreshing = true; renderFrame();
    try {
      const st = await callReader('status');
      live.status = st;
      if (st && st.linked && trackedGroups().length) {
        live.lastSig = `${st.messages_stored}|${st.last_message_at}|${st.groups_known}`;
        if (live.busy) { live.again = true; await waitFor(() => !live.busy, 60000); }
        else await syncNow();
      } else render();
    } catch (e) {
      live.error = { message: `couldn\u2019t refresh (${(e && (e.message || e.code)) || 'no answer'})` };
    } finally {
      live.refreshing = false; renderFrame();
    }
  }

  const waitFor = (test, ms) => new Promise(resolve => {
    const start = Date.now();
    const tick = () => (test() || Date.now() - start > ms) ? resolve() : setTimeout(tick, 200);
    tick();
  });

  // Reads one tracked group from WhatsApp Reader.
  // Members are read again at most every 10 minutes: with an older WhatsApp
  // Reader each read is a request to WhatsApp, and messages don't need it.
  const MEMBERS_EVERY = 10 * MIN;
  async function readGroup(t) {
    const gid = t.groupId;
    const before = live.raws[gid];
    const reuse = before && before.participants && Date.now() - (live.lastMembersRead[gid] || 0) < MEMBERS_EVERY;
    const g = reuse ? { id: gid, name: before.group.name, me: before.me, participants: before.participants }
      : await callReader('get_group', { group_id: gid });
    const windowStart = Date.now() - (WINDOW_DAYS + 1) * DAY_MS;
    let since = windowStart;
    const seen = new Map();
    for (let i = 0; i < 25; i++) {
      const page = await callReader('get_messages', { group_id: gid, since, limit: 2000 });
      const list = (page && page.messages) || [];
      list.forEach(m => seen.set(m.id, m));
      if (!page.more || !list.length || list[list.length - 1].at === since) break;
      since = list[list.length - 1].at;
    }
    const all = [...seen.values()];
    const participants = (g.participants || []).map(p => ({ id: p.id, name: p.name, phone: p.phone || '' }));
    const ids = new Set(participants.map(p => p.id));
    const names = {};
    all.forEach(m => { if (m.sender_name && !ids.has(m.sender_id)) names[m.sender_id] = m.sender_name; });
    const prev = savedGroupData(gid);
    const prevRaw = live.raws[gid];
    const now = Date.now();
    // A newly linked reader (another computer, or after relinking) only gets
    // part of the history from WhatsApp, so messages already saved in the page
    // that it doesn't have are kept rather than dropped.
    const start = startOf(gid);
    const fromReader = all.map(compactMessage).filter(m => m.t >= start);
    const have = new Set(fromReader.map(m => m.i));
    const kept = prev ? Object.values(prev.days || {}).flatMap(d => (d && d.messages) || [])
      .filter(m => m && m.i && !have.has(m.i) && m.t >= Math.max(windowStart, start)) : [];
    const members = reuse ? prevRaw.members : updateMembers(prevRaw ? prevRaw.members : prev ? prev.meta.members : null, participants,
      live.lastMembersRead[gid] || (prev ? prev.meta.syncedAt : 0), now);
    if (!reuse) live.lastMembersRead[gid] = now;
    return {
      group: { id: g.id, name: g.name || t.groupName }, participants, members, names, bossIds: t.bossIds || [], me: g.me,
      messages: fromReader.concat(kept).sort((a, b) => a.t - b.t),
      analysis: { ...(prevRaw ? prevRaw.analysis : prev ? prev.analysis : {}) },
      replies: { ...(prevRaw ? prevRaw.replies : prev ? prev.replies : {}) },
      overrides: saved.names,
      syncedAt: now,
    };
  }

  // Whether the linked phone is in a group, from the reader's group list (null if unknown).
  async function phoneHasGroup(gid) {
    if (!live.groups) { try { live.groups = ((await callReader('list_groups')) || {}).groups || null; } catch (_) { return null; } }
    return live.groups ? live.groups.some(x => x.id === gid) : null;
  }

  // Which tracked groups to read on this pass. One list_groups call says,
  // for every group, how many messages it has, when the last one came and how
  // many members it has; only groups where that changed are read, plus a few
  // not read for a while (edits and deletions don't change those numbers).
  // Reading all of them every time is what ran into the Claude app's limit.
  const FULL_EVERY = 30 * MIN, STALE_PER_PASS = 8;
  const groupSig = g => `${g.message_count}|${g.last_message_at}|${g.members}`;
  async function groupsToRead() {
    let list = null;
    try { list = ((await callReader('list_groups')) || {}).groups || null; if (list) live.groups = list; } catch (_) { list = null; }
    const by = new Map((list || []).map(g => [g.id, g]));
    const now = Date.now();
    const out = [], stale = [];
    trackedGroups().forEach(t => {
      const raw = live.raws[t.groupId], g = by.get(t.groupId);
      const sig = g ? groupSig(g) : null;
      if (!raw) out.push({ t, sig });
      else if (!list) return; // couldn't ask: keep what's on screen, try again next pass
      else if (sig && sig !== live.groupSig[t.groupId]) out.push({ t, sig });
      else if (now - raw.syncedAt > FULL_EVERY) stale.push({ t, sig, at: raw.syncedAt });
    });
    stale.sort((a, b) => a.at - b.at);
    return out.concat(stale.slice(0, STALE_PER_PASS));
  }

  async function syncNow() {
    if (live.busy) { live.again = true; return; }
    if (!live.on || !trackedGroups().length) return;
    live.busy = true; live.again = false;
    try {
      if (cap.db) {
        await waitFor(() => saved.loaded.tracking && saved.loaded.source && saved.loaded.legacyMeta && saved.loaded.legacyAnalysis
          && trackedGroups().every(t => saved.groups[t.groupId] && saved.groups[t.groupId].loaded.meta && saved.groups[t.groupId].loaded.analysis), 6000);
      }
      const errors = [], held = [], read = [];
      const queue = await groupsToRead();
      for (let i = 0; i < queue.length; i++) {
        const { t, sig } = queue[i];
        try {
          const raw = await readGroup(t);
          await analyze(raw);
          live.raws[t.groupId] = raw;
          if (sig) live.groupSig[t.groupId] = sig;
          read.push(t.groupId);
          // a long first pass shows its progress every 10 groups
          if (read.length % 10 === 0) applyLive();
        } catch (e) {
          // the Claude app still says slow down after waiting: stop this pass
          // and read this group and the rest on the next one
          if (isRateLimit(e)) { held.push(...queue.slice(i).map(q => q.t)); break; }
          const inPhone = await phoneHasGroup(t.groupId);
          errors.push(`${t.groupName || 'a group'}: ${inPhone === false
            ? 'the linked phone isn\u2019t in this group, so it can\u2019t be read. Add that phone to the group, or stop tracking it in Groups and names'
            : (e.message || e.code || e)}`);
        }
      }
      live.error = errors.length ? { message: errors.join('; ') } : null;
      live.held = held.length;
      if (held.length && !live.retryTimer) live.retryTimer = setTimeout(() => { live.retryTimer = null; syncNow(); }, 60000);
      live.lastSync = Date.now();
      applyLive();
      for (const gid of read) if (live.raws[gid]) await persist(live.raws[gid]);
      await clearLegacy();
    } catch (e) {
      live.error = e; render();
    } finally {
      live.busy = false;
      if (live.again) syncNow();
    }
  }

  // Claude reads each new instruction once to see who must answer and whether
  // it carries a task. Without Claude, simple rules are used instead.
  async function analyze(raw) {
    const S0 = buildFromRaw({ ...raw, analysis: {} }, Date.now());
    const people = S0.people;
    const nameOf = nameIndex(raw);
    const canAsk = cap.sample && !live.sampleDenied;
    const senderOf = new Map(S0.bossMessages.map(m => [m.i, m.s]));
    const fallback = m => fallbackAnalysis(m, people, senderOf);
    const todo = S0.bossMessages.filter(m => {
      const a = raw.analysis[m.i];
      return !a || (canAsk && needsReading(a, m));
    });
    const bosses = (raw.bossIds || []).map(nameOf);
    if (!canAsk) { todo.forEach(m => { if (!raw.analysis[m.i]) raw.analysis[m.i] = fallback(m); }); return; }
    if (!todo.length) { await judgeReplies(raw, people, bosses, nameOf); return; }
    live.analyzing = todo.length; renderFrame();
    const byId = new Map(raw.messages.map(m => [m.i, m]));
    for (let i = 0; i < todo.length; i += 12) {
      const batch = todo.slice(i, i + 12);
      // the ten instruction-giver messages before this batch, from the last day
      const context = S0.bossMessages.filter(m => m.t < batch[0].t && m.t > batch[0].t - DAY_MS).slice(-10);
      const earlier = new Map([...context, ...batch].map(m => [m.i, m.s]));
      // what anyone said in the two hours before the batch and between its messages
      const inBatch = new Set(batch.map(m => m.i));
      const around = raw.messages.filter(m => !inBatch.has(m.i) && !m.d && !['reaction', 'joined', 'left'].includes(m.k)
        && m.t >= batch[0].t - 2 * 60 * MIN && m.t <= batch[batch.length - 1].t).slice(-40);
      try {
        const out = await cap.sample.json(analysisPrompt(batch, context, people, bosses, nameOf, around, byId), { modelTier: 'default' });
        const results = out && Array.isArray(out.results) ? out.results : [];
        batch.forEach(m => {
          const a = cleanAnalysis(results.find(r => r && String(r.id) === m.i), people, earlier, m.s);
          if (a && a.follow_up_of === m.i) a.follow_up_of = null;
          raw.analysis[m.i] = a || raw.analysis[m.i] || fallback(m);
        });
      } catch (e) {
        if (e && e.code === 'not_granted') live.sampleDenied = true;
        todo.slice(i).forEach(m => { if (!raw.analysis[m.i]) raw.analysis[m.i] = fallback(m); });
        break;
      }
    }
    live.analyzing = 0;
    await judgeReplies(raw, people, bosses, nameOf);
  }

  // Claude reads each plain reply once (swipe-replies and reactions are already
  // certain) to say which request it answers and whether the sender took on the
  // work. Until it has, and for anything older than a week, the rules decide.
  async function judgeReplies(raw, people, bosses, nameOf) {
    if (!cap.sample || live.sampleDenied || Date.now() - (live.judgeFailAt || 0) < 5 * MIN) return;
    raw.replies = raw.replies || {};
    const S1 = buildFromRaw(raw, Date.now());
    const todo = S1.unjudged.slice(0, 60);
    if (!todo.length) return;
    const reqs = new Map(S1.messages.map(m => [m.id, m]));
    const needs = m => m.anyone ? 'one answer from anyone' : m.everyone ? 'a reply from everyone' : `a reply from ${m.required.map(nameOf).join(', ')}`;
    live.analyzing = todo.length; renderFrame();
    for (let i = 0; i < todo.length; i += 20) {
      const batch = todo.slice(i, i + 20);
      const ids = [...new Set(batch.flatMap(b => b.requests))].filter(id => reqs.has(id));
      const requests = ids.map(id => { const m = reqs.get(id); return { id, from: m.senderName, sent: localStamp(m.at), text: m.text, needs: needs(m) }; });
      const items = batch.map(b => ({ id: b.m.i, from: nameOf(b.m.s), sent: localStamp(b.m.t), text: replyText(b.m, nameOf), could_answer: b.requests.filter(id => reqs.has(id)) }));
      try {
        const out = await cap.sample.json(replyPrompt(requests, items, people, bosses), { modelTier: 'default' });
        const results = out && Array.isArray(out.results) ? out.results : [];
        batch.forEach(b => {
          // left out of Claude's answer: keep the rules for it rather than asking again every update
          raw.replies[b.m.i] = cleanReply(results.find(x => x && String(x.id) === b.m.i), b.requests)
            || { answers: null, task: null, why: '', by: 'claude', v: REPLY_VERSION };
        });
      } catch (e) {
        if (e && e.code === 'not_granted') live.sampleDenied = true;
        live.judgeFailAt = Date.now(); // try again in a few minutes, not every update
        break;
      }
    }
    live.analyzing = 0;
  }

  // Save what was read into the page so the same numbers show on every device.
  async function persist(raw) {
    const db = cap.db;
    if (!db || cap.canEdit === false) return;
    const gid = raw.group.id;
    const k = gkey(gid);
    const box = saved.groups[gid] || { days: {}, analysis: null };
    let changed = false;
    try {
      const byDay = {};
      raw.messages.forEach(m => { (byDay[dayKey(m.t)] ||= []).push(m); });
      for (const [day, list] of Object.entries(byDay)) {
        let body = { day, messages: list };
        let json = JSON.stringify(body);
        if (json.length > 240000) { body = { day, trimmed: true, messages: list.map(m => m.x && m.x.length > 160 ? { ...m, x: m.x.slice(0, 160) } : m) }; json = JSON.stringify(body); }
        const key = `${gid}|${day}`;
        const prev = live.written[key] ?? (box.days[day] ? JSON.stringify(box.days[day]) : null);
        if (prev === json) continue;
        await db.doc(`sync/${k}/days/${day}`).set(body);
        live.written[key] = json; changed = true;
      }
      for (const day of Object.keys(box.days || {})) {
        if (!byDay[day]) { await db.doc(`sync/${k}/days/${day}`).delete(); delete live.written[`${gid}|${day}`]; changed = true; }
      }
      const byId = {}, replies = {};
      raw.messages.forEach(m => {
        if (raw.analysis[m.i]) byId[m.i] = raw.analysis[m.i];
        if (raw.replies && raw.replies[m.i]) replies[m.i] = raw.replies[m.i];
      });
      const aJson = JSON.stringify({ byId, replies });
      if (aJson !== (live.writtenAnalysis[gid] ?? JSON.stringify({ byId: box.analysis, replies: box.replies || {} }))) {
        await db.doc(`sync/${k}/extra/analysis`).set({ byId, replies });
        live.writtenAnalysis[gid] = aJson; changed = true;
      }
      const meta = { group: raw.group, participants: raw.participants, members: raw.members, names: raw.names, bossIds: raw.bossIds, me: raw.me };
      const mJson = JSON.stringify(meta);
      if (changed || mJson !== live.writtenMeta[gid] || Date.now() - (live.lastMetaWrite[gid] || 0) > 5 * MIN) {
        await db.doc(`sync/${k}`).set({ ...meta, syncedAt: raw.syncedAt, messageCount: raw.messages.length });
        live.writtenMeta[gid] = mJson; live.lastMetaWrite[gid] = Date.now();
      }
    } catch (e) {
      if (e && e.code === 'invalid_argument') cap.canEdit = false;
      if (e && e.code === 'quota_exceeded') live.error = { message: 'this page’s storage is full, so updates aren’t being saved for other devices.' };
      renderFrame();
    }
  }

  // Once the single-group copy has been saved in the new layout, remove it,
  // and record the tracked groups in the new place too.
  async function clearLegacy() {
    const db = cap.db;
    if (!db || cap.canEdit === false || live.legacyCleared) return;
    if (!saved.tracking && saved.legacySource && trackedGroups().length) {
      try {
        const tracking = { groups: trackedGroups(), me: live.status && live.status.phone, savedAt: Date.now() };
        await db.doc('settings/tracking').set(tracking);
        saved.tracking = tracking;
        await db.doc('settings/source').delete();
      } catch (_) { return; }
    }
    const L = saved.legacy;
    if (!L.meta) { live.legacyCleared = true; return; }
    const gid = L.meta.group && L.meta.group.id;
    const moved = gid && (live.writtenMeta[gid] || (saved.groups[gid] && saved.groups[gid].meta));
    const dropped = gid && !trackedGroups().some(t => t.groupId === gid);
    if (!moved && !dropped) return;
    try {
      for (const day of Object.keys(L.days || {})) await db.doc(`sync/meta/days/${day}`).delete();
      await db.doc('sync/analysis').delete();
      await db.doc('sync/meta').delete();
      live.legacyCleared = true;
    } catch (_) { /* try again on the next update */ }
  }

  // keep waiting times current while the page is open
  setInterval(() => { if (src.mode === 'live' && !live.busy) { src.now = Date.now(); render(); } }, 60000);

  async function boot() {
    const claude = window.claude;
    if (!claude || typeof claude.use !== 'function') return;
    const use = name => claude.use(name).catch(() => null);
    const [db, mcp, sample, user, perms] = await Promise.all([use('db'), use('mcp'), use('sample'), use('user'), use('permissions')]);
    cap.db = db; cap.mcp = mcp; cap.sample = sample; cap.user = user; cap.perms = perms;
    if (user) {
      try { cap.canEdit = await user.canEdit(); } catch (_) { cap.canEdit = null; }
      try { cap.isOwner = await user.isOwner(); } catch (_) { cap.isOwner = null; }
      try { cap.canWrite = await user.can('data.write'); } catch (_) { cap.canWrite = null; }
      try { cap.me = await user.id(); } catch (_) { cap.me = null; }
    }
    if (db) { subscribeSaved(db); subscribeEmail(db); } else { email.confLoaded = true; }
    if (mcp) startLive(); else { live.diag = { code: 'no-mcp' }; render(); }
  }

  state.view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
  render();
  boot();
})();
