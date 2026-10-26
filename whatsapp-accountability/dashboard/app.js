(function () {
  const DEFAULTS = { first: 15, second: 30, escalate: 60 };
  const READER = 'host:whatsapp-reader';
  const DAY_MS = 24 * 60 * MIN;
  const SAMPLE_NOW = sampleNow();
  const SAMPLE = buildSample(SAMPLE_NOW);

  let cfg = { ...DEFAULTS };
  let D = null, S = SAMPLE, NOW = SAMPLE_NOW, N = SAMPLE.people.length;
  const state = { view: 'dashboard', sel: null, taskFilter: 'open', groupFilter: 'all', senderFilter: 'all',
    setup: false, editGroup: null, setupGroup: null, setupBoss: null, setupNames: null, confirmRemove: null };
  // where the numbers come from: 'sample', 'live' (WhatsApp Reader on this computer) or 'saved' (last copy kept in the page)
  const src = { mode: 'sample', S: SAMPLE, now: SAMPLE_NOW, updatedAt: null, groups: [] };
  const cap = { db: null, mcp: null, sample: null, user: null, canEdit: null, isOwner: null, canWrite: null, me: null };
  // tracking: the groups being tracked, each with whose messages are instructions
  const saved = { tracking: null, legacySource: null, names: {}, groups: {}, legacy: { meta: null, analysis: {}, days: {} },
    loaded: { tracking: false, source: false, legacyMeta: false, legacyAnalysis: false } };
  const subs = {};
  const live = { on: false, status: null, groups: null, groupInfo: null, busy: false, again: false, lastSig: '', lastSync: 0,
    unwatch: null, diag: null, raws: {}, written: {}, writtenAnalysis: {}, writtenMeta: {}, lastMetaWrite: {}, lastMembersRead: {},
    legacyCleared: false, sampleDenied: false, analyzing: 0, error: null, offCode: null };

  const VIEWS = {
    dashboard: { label: 'Dashboard', icon: 'grid', title: 'Dashboard', sub: 'Who hasn’t replied, what’s still open, and who needs a follow-up.' },
    messages: { label: 'Messages', icon: 'chat', title: 'Messages', sub: 'Every instruction and question sent to the group, with who replied and how fast.' },
    tasks: { label: 'Tasks', icon: 'tasks', title: 'Tasks', sub: 'Work the AI found in messages: who owns it, when it’s due, and whether it got done.' },
    reports: { label: 'Reports', icon: 'chart', title: 'Reports', sub: 'Patterns over the last 30 days, so accountability decisions rest on the record.' },
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
        <td>${meter(m.responded, m.req.length)}</td>
        <td>${chip('c-warn', `${m.pending.length} pending`)}</td></tr>`).join('');
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
        : 'Messages from the people giving instructions that ask others to do or answer something will show here.');
    }
    if (!state.sel || !D.messages.find(m => m.id === state.sel)) {
      state.sel = (D.unresolved.slice().sort((a, b) => b.pending.length - a.pending.length)[0] || D.messages[0]).id;
    }
    let lastDay = null;
    const items = D.messages.map(m => {
      const day = dayLabel(m.at);
      const head = day !== lastDay ? `<div class="mday">${esc(day)}</div>` : '';
      lastDay = day;
      const open = m.pending.length > 0;
      return head + `<button class="mitem${open ? ' open' : ''}" type="button" data-sel="${esc(m.id)}" aria-current="${m.id === state.sel}">
        <span class="m-ic">${ic(open ? 'clock' : 'check')}</span>
        <span class="m-t">${esc(m.title)}</span>
        ${open ? chip('c-warn', `${m.pending.length} pending`) : chip('c-good', 'All replied')}
        <span class="m-s">${groupTag(m)}${esc(fmtClock(m.at))} · ${m.responded}/${m.req.length} replied${(m.chases || []).length ? ` · followed up ${m.chases.length}×` : ''}</span></button>`;
    }).join('');

    const m = D.messages.find(x => x.id === state.sel);
    const task = m.task ? D.tasks.find(t => t.id === m.task) : null;
    const nameById = id => (D.people.find(p => p.id === id) || {}).name || id;
    const reqLabel = m.required === 'all' || m.everyone ? `Everyone (${m.req.length})` : m.req.map(nameById).join(', ');
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
        <td>${r.replied ? esc(r.text) + linkedNote(r)
          : canLink ? `<button class="btn small" type="button" data-action="open-link" data-msg="${esc(m.id)}" data-pid="${esc(r.pid)}">Mark as replied</button>`
          : '<span class="plain">None</span>'}</td>
        <td>${r.replied ? `<span class="plain">${replyNote(r.stage)}</span>` : stageChip(r.stage, m)}</td></tr>`).join('');

    return `<div class="msgs">
      <div class="card"><div class="card-h"><h2>Sent to the group</h2><span class="hint">${plural(D.messages.length, 'message')}, last 30 days</span></div>
        <div class="mlist" id="mlist">${items}</div></div>
      <div class="card"><div class="card-b">
        <div class="mhead"><div><h2>${esc(m.title)}</h2><p>${esc(fmtWhen(m.at))} · ${groupTag(m)}Sent by ${esc(m.senderName || 'Juan')}</p></div>
          ${m.pending.length ? chip('c-warn', `${m.pending.length} pending`) : chip('c-good', 'All replied', 'check')}</div>
        <div class="bubble">${esc(m.text)}<span class="b-time">${esc(fmtClock(m.at))}</span></div>
        ${chaseHtml}
        <div class="read"><div class="read-cap">${ic('spark')}${m.by === 'rules' ? 'Read with simple rules, because Claude wasn’t available' : 'What the AI picked out of this message'}</div><dl class="read-grid">
          <div><dt>Type</dt><dd>${esc(m.kind)}</dd></div>
          <div><dt>Needs a reply from</dt><dd>${esc(reqLabel)}</dd></div>
          <div><dt>Task</dt><dd>${task ? `${esc(task.title)}<span>Owner ${esc(task.ownerName)} · ${task.due != null ? 'due ' + esc(fmtWhen(task.due)) : 'no deadline given'}</span>` : 'None'}</dd></div>
          <div><dt>Priority</dt><dd>${esc(m.priority)}</dd></div>
        </dl></div>
        <div class="subh"><h3>Replies (${m.req.length} required)</h3>
          <span class="tally"><span class="ok">${m.responded} replied</span><span class="no">${m.pending.length} pending</span></span></div>
        <div class="inset tw"><table class="t"><thead><tr><th>Name</th><th>Status</th><th>Response time</th><th>Reply</th><th>Follow-up</th></tr></thead><tbody>${rows}</tbody></table></div>
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
        <td class="from">${msgLink(t.from, '“' + snippet(t.from.text) + '”')}<span class="sub">${groupTag(t.from)}${esc(fmtWhen(t.from.at))} · from ${esc(t.from.senderName || '')}</span></td>
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
          : '<div class="empty">No tasks yet.</div>'}</div>`;
  }

  // ---------------- choosing groups (owner, on the computer running WhatsApp Reader) ----------------
  // The groups being tracked. Older pages saved a single group as settings/source.
  const trackedGroups = () => saved.tracking ? (saved.tracking.groups || [])
    : saved.legacySource ? [{ groupId: saved.legacySource.groupId, groupName: saved.legacySource.groupName, bossIds: saved.legacySource.bossIds || [] }] : [];
  const trackingKnown = () => !cap.db || (saved.loaded.tracking && saved.loaded.source);
  const needsSetup = () => live.on && (!live.status || !live.status.linked || (!trackedGroups().length && trackingKnown()) || state.setup);
  const looksLikeNumber = n => !n || /^\+?[\d\s()-]+$/.test(n);
  const nameFor = (id, fallback) => saved.names[id] || (looksLikeNumber(fallback) ? (fallback || '+' + id) : fallback);

  // The form for one group: whose messages are instructions, and names.
  function groupForm(g, action, label) {
    const givers = `<div class="choices">${g.participants.map(p => `
        <label class="choice"><input type="checkbox" name="setup-boss" id="b-${esc(p.id)}" value="${esc(p.id)}"${state.setupBoss && state.setupBoss.has(p.id) ? ' checked' : ''}>
          <span><b>${esc(nameFor(p.id, p.name))}${p.id === g.me ? ' (this phone)' : ''}</b><span class="sub">${esc(p.phone || 'Phone number hidden by WhatsApp')}</span></span></label>`).join('')}</div>`;
    const nameValue = p => (state.setupNames && p.id in state.setupNames) ? state.setupNames[p.id]
      : saved.names[p.id] || (looksLikeNumber(p.name) ? '' : p.name);
    const nameRows = g.participants.map(p => `
        <label class="name-row" for="n-${esc(p.id)}"><span class="sub">${esc(p.phone || 'Phone number hidden by WhatsApp')}${p.id === g.me ? ' (this phone)' : ''}</span>
          <input class="name-in" type="text" id="n-${esc(p.id)}" data-name-for="${esc(p.id)}" value="${esc(nameValue(p))}" placeholder="Name" maxlength="60" autocomplete="off"></label>`).join('');
    const boss = state.setupBoss || new Set();
    const left = g.participants.filter(p => !boss.has(p.id));
    // a group where everyone gives instructions has nobody to track
    const who = !boss.size ? '<p class="plain">Tick at least one person who gives instructions.</p>'
      : !left.length ? '<p class="warn">Everyone is ticked. Messages to everyone won\u2019t be tracked, only what one instruction-giver asks another by name. Untick the people who should reply.</p>'
      : `<p class="plain">Tracked for replies: ${esc(left.map(p => nameFor(p.id, p.name)).join(', '))} (${plural(left.length, 'person', 'people')})${boss.size > 1 ? '. The ticked people are tracked too when one of them asks another by name.' : ''}</p>`;
    const ready = boss.size;
    return `<h3>Who gives the instructions in “${esc(g.name || 'this group')}”?</h3>
      <p class="plain">Tick only the people who give instructions, for example the CEO and the COO. Leave everyone who should reply unticked: they are the ones tracked.</p>${givers}${who}
      <h3>Names</h3><p class="plain">Optional. Shown on the dashboard instead of phone numbers, in every group.</p><div class="names">${nameRows}</div>
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
    return n ? ` \u00B7 tracking ${plural(n, 'person', 'people')}` : ' \u00B7 everyone here gives instructions, so only what they ask each other by name is tracked';
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

    const trackedIds = new Set(tracked.map(t => t.groupId));
    const others = (live.groups || []).filter(x => !trackedIds.has(x.id)).sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
    const adding = !state.editGroup;
    const pick = live.groups == null ? '<p class="plain">Loading your groups…</p>'
      : !others.length ? '<p class="plain">Every group on the linked phone is already tracked.</p>'
      : `<div class="choices" role="radiogroup" aria-label="Group">${others.map(x => `
          <label class="choice"><input type="radio" name="setup-group" id="g-${esc(x.id)}" value="${esc(x.id)}"${state.setupGroup === x.id ? ' checked' : ''}>
            <span><b>${esc(x.name || 'Unnamed group')}</b><span class="sub">${plural(x.members, 'member')} · ${plural(x.message_count, 'message')} saved${x.last_message_at ? ` · last ${esc(fmtWhen(x.last_message_at))}` : ''}</span></span></label>`).join('')}</div>`;
    const addForm = adding && state.setupGroup ? (loaded(state.setupGroup) ? groupForm(g, 'add-group', tracked.length ? 'Add group' : 'Start tracking') : '<p class="plain">Loading members…</p>') : '';

    return `<div class="card setup"><div class="card-b">
      <h2>${ic('link')}Groups to track</h2>
      <p>WhatsApp Reader is linked to +${esc(st.phone)}. It only reads; nothing is ever sent.</p>
      ${tracked.length ? `<div class="tracked-list">${trackedRows}</div>` : ''}
      ${adding ? `<h3>${tracked.length ? 'Add another group' : 'Pick a group'}</h3>${pick}${addForm}` : ''}
      <p class="dlg-msg err" id="setup-msg" role="status">${esc(live.setupError || '')}</p>
      ${tracked.length && !state.editGroup && !state.setupGroup ? '<div class="dlg-f" style="padding:0"><button class="btn primary" type="button" data-action="done-setup">Done</button></div>' : ''}
    </div></div>`;
  }

  // ---------------- frame ----------------
  function renderNav() {
    const badge = { dashboard: D.pendingPeople.length, messages: D.unresolved.length, tasks: D.overdue.length, reports: null };
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
      gSel.hidden = true; fSel.hidden = true; pill.hidden = false;
      pill.innerHTML = `${ic('users')}THB Construction Team · ${plural(N, 'person', 'people')}`;
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
    const label = src.mode === 'sample' ? 'THB Construction Team' : current ? current.name : groups.length === 1 ? groups[0].name : plural(groups.length, 'group');
    const named = groups.length === 1 ? `“${groups[0].name}”` : plural(groups.length, 'group');
    document.getElementById('brand-sub').textContent = label;
    const pill = document.getElementById('snap');
    const note = document.getElementById('side-note');
    const foot = document.getElementById('foot');
    document.getElementById('change-group').hidden = !(live.on && live.status && live.status.linked && trackedGroups().length);
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
      foot.textContent = `Reading ${named} through WhatsApp Reader on this computer. Nothing is ever sent to WhatsApp. Each update is saved into this page, so anyone with the link sees the same numbers on any device.`;
    } else if (src.mode === 'saved') {
      pill.className = 'pill';
      pill.innerHTML = `${ic('clock')}Saved · as of ${esc(fmtDate(src.updatedAt))}, ${esc(fmtClock(src.updatedAt))}`;
      note.textContent = 'Showing the last saved copy. Nothing is sent to WhatsApp.';
      foot.textContent = `These numbers were saved at ${fmtClock(src.updatedAt)} on ${fmtDate(src.updatedAt)}, the last time this page was open in the Claude desktop app on the computer running WhatsApp Reader. Response times are counted up to that moment. Nothing is ever sent to WhatsApp.`;
    } else {
      pill.className = 'pill sample';
      pill.innerHTML = `${ic('clock')}Sample data · as of ${esc(fmtClock(SAMPLE_NOW))} today`;
      note.textContent = 'Sample data. Not connected to WhatsApp yet.';
      foot.textContent = 'Everything on this page is sample data for 18 example team members. Real numbers appear once this page is opened in the Claude desktop app on the computer running WhatsApp Reader. Nothing is ever sent to WhatsApp.';
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
    const msg = live.error ? (live.error.message || String(live.error)) : '';
    err.hidden = !(live.on && msg);
    err.textContent = msg ? `WhatsApp Reader couldn’t read a group: ${msg}` : '';
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
    // instruction-givers count only when someone asked them for something
    N = D.people.filter(p => !p.former && (!p.giver || p.required)).length;
    renderNav();
    renderFilters();
    renderFrame();
    const setup = needsSetup();
    const v = VIEWS[state.view];
    document.getElementById('v-title').textContent = setup ? 'Groups to track' : v.title;
    document.getElementById('v-sub').textContent = setup ? 'Set up on this computer. Change it any time from the sidebar.' : v.sub;
    const setupEl = document.getElementById('v-setup');
    setupEl.hidden = !setup;
    const typing = document.activeElement && setupEl.contains(document.activeElement) && document.activeElement.matches('input[type="text"]');
    if (setup && !typing) setupEl.innerHTML = viewSetup();
    const list = document.getElementById('mlist');
    const keepScroll = list ? list.scrollTop : 0;
    const builders = { dashboard: viewDashboard, messages: viewMessages, tasks: viewTasks, reports: viewReports };
    for (const k of Object.keys(VIEWS)) {
      const el = document.getElementById('v-' + k);
      el.hidden = setup || k !== state.view;
      if (!el.hidden) el.innerHTML = builders[k]();
    }
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
    if (sel) { state.sel = sel.dataset.sel; render(); return; }
    const act = e.target.closest('[data-action]');
    if (act) onAction(act.dataset.action, act.dataset.gid, act.dataset);
  });
  document.addEventListener('input', e => {
    const id = e.target.dataset && e.target.dataset.nameFor;
    if (id) { state.setupNames = state.setupNames || {}; state.setupNames[id] = e.target.value; }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'task-filter') { state.taskFilter = e.target.value; render(); }
    if (e.target.id === 'group-filter') { state.groupFilter = e.target.value; state.sel = null; render(); }
    if (e.target.id === 'sender-filter') { state.senderFilter = e.target.value; state.sel = null; render(); }
    if (e.target.name === 'setup-group') pickGroup(e.target.value);
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

  // ---------------- saved copy (any device) ----------------
  // where a group's copy is kept in the page's storage
  const gkey = gid => String(gid).replace(/[^A-Za-z0-9_.@+:~-]/g, '_');

  // Several groups' messages, people and tasks put together. People are
  // matched by phone number, so someone in two groups has one record.
  function combine(parts, now) {
    const people = new Map(), messages = [], tasks = [];
    parts.forEach(({ id, name, raw }) => {
      const Sg = buildFromRaw(raw, now);
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
    if (L.meta && L.meta.group && L.meta.group.id === gid) return { meta: L.meta, analysis: L.analysis || {}, days: L.days, legacy: true };
    return null;
  }

  function rawFromSaved(gid) {
    const d = savedGroupData(gid);
    if (!d) return null;
    const messages = Object.values(d.days || {}).flatMap(x => (x && x.messages) || []);
    return { ...d.meta, analysis: d.analysis || {}, messages, overrides: saved.names, fixes: fixesFor(gid) };
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

  function applyLive() {
    const parts = trackedGroups().filter(t => live.raws[t.groupId]).map(t => {
      const raw = { ...live.raws[t.groupId], overrides: saved.names, fixes: fixesFor(t.groupId) };
      return { id: t.groupId, name: raw.group.name || t.groupName, raw };
    });
    if (!parts.length) { if (!trackedGroups().length) showSample(); return; }
    show(parts, 'live', Math.max(...parts.map(p => p.raw.syncedAt || 0)));
  }

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
      const box = saved.groups[gid] = { meta: null, analysis: {}, days: {}, fixes: {}, loaded: { meta: false, analysis: false } };
      const fail = () => {};
      const k = gkey(gid);
      subs[gid] = [
        db.doc(`sync/${k}`).onSnapshot(snap => { box.meta = snap.exists ? snap.data() : null; box.loaded.meta = true; applySaved(); }, fail),
        db.doc(`sync/${k}/extra/analysis`).onSnapshot(snap => { box.analysis = snap.exists ? (snap.data().byId || {}) : {}; box.loaded.analysis = true; applySaved(); }, fail),
        db.collection(`sync/${k}/days`).onSnapshot(q => { const days = {}; q.docs.forEach(d => { days[d.id] = d.data(); }); box.days = days; applySaved(); }, fail),
        // replies people linked by hand, written by anyone in the company who can use the page
        db.collection(`fixes/${k}/links`).onSnapshot(q => {
          const fixes = {};
          q.docs.forEach(d => { const v = d.data(); if (v && v.request && v.person) fixes[`${v.request}~${v.person}`] = { ...v, docId: d.id }; });
          box.fixes = fixes; refreshShown();
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
  function linkCandidates(m, pid) {
    const out = [];
    trackedGroups().forEach(t => {
      const raw = src.mode === 'live' ? live.raws[t.groupId] : rawFromSaved(t.groupId);
      if (!raw) return;
      const nameOf = nameIndex({ ...raw, overrides: saved.names });
      (raw.messages || []).forEach(c => {
        if (c.s !== pid || c.d || c.k === 'joined' || c.k === 'left' || c.i === m.id) return;
        if (c.t < m.at || c.t > m.at + LINK_WINDOW) return;
        const text = c.k === 'reaction' ? `Reacted ${c.x || ''}` : replyText(c, nameOf);
        out.push({ id: c.i, at: c.t, group: t.groupId, groupName: (raw.group && raw.group.name) || t.groupName, text: (text || 'Message').slice(0, 300) });
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
          <span><b>${esc(c.text)}</b><span class="sub">${multi ? esc(c.groupName) + ' \u00B7 ' : ''}${esc(fmtWhen(c.at))} \u00B7 ${fmtDur(c.at - L.at)} after the message</span></span></label>`).join('')}</div>`
      : `<p class="plain">${esc(L.name)} didn\u2019t send anything in the 30 minutes after this message. If they answered later or somewhere else, they can react \u{1F44D} to the message in WhatsApp and it will count.</p>`;
    linkBox.innerHTML = `<div class="dlg-h"><div><h2 id="link-h">Mark ${esc(L.name)} as replied</h2>
        <p>Pick the message ${esc(L.name)} sent that answers \u201C${esc(L.title)}\u201D. Only their own messages from the 30 minutes after it was sent are listed. Everyone can see who linked it.</p></div>
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
    state.link = { msgId, pid, groupId: m.groupId, at: m.at, title: m.title, name: (person && person.name) || 'this person',
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
    const doc = { request: L.msgId, person: L.pid, msg: c.id, group: c.group, at: c.at, text: c.text, by: cap.me || null, on: Date.now() };
    try {
      await cap.db.doc(`fixes/${gkey(L.groupId)}/links/${gkey(`${L.msgId}~${L.pid}`)}`).set(doc);
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
    catch (e) { live.error = { message: linkError(e) }; renderFrame(); }
  }

  linkDlg.addEventListener('click', e => { if (e.target === linkDlg) closeLink(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.link) closeLink(); });
  document.addEventListener('change', e => { if (e.target.name === 'link-pick' && state.link) { state.link.pick = e.target.value; renderLink(); } });

  // ---------------- live reading (Claude desktop app on the computer running WhatsApp Reader) ----------------
  const callReader = async (tool, input) => (await cap.mcp.callTool(READER, tool, input || {}, { cache: false })).payload;

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
      if (state.setupGroup !== id && state.editGroup !== id) return null;
      live.groupInfo = g; live.setupError = '';
      return g;
    } catch (e) { live.setupError = e.message || 'Couldn’t read that group.'; return null; }
    finally { render(); }
  }

  async function pickGroup(id) {
    state.setupGroup = id; state.editGroup = null; state.setupBoss = null; state.setupNames = null;
    render();
    const g = await loadGroupInfo(id);
    if (g && state.setupGroup === id && !state.setupBoss) { state.setupBoss = new Set(g.me ? [g.me] : []); render(); }
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
      await db.doc(`sync/${k}/extra/analysis`).delete();
      await db.doc(`sync/${k}`).delete();
    } catch (_) { /* nothing else to do; it is no longer shown */ }
  }

  async function onAction(action, gid, data) {
    const tracked = trackedGroups();
    if (action === 'open-link') openLink(data.msg, data.pid);
    else if (action === 'link-cancel') closeLink();
    else if (action === 'link-save') saveLink();
    else if (action === 'unlink') unlink(data.msg, data.pid);
    else if (action === 'refresh') refreshNow();
    else if (action === 'connect') {
      startLive();
    } else if (action === 'recheck') {
      try { onStatus(await callReader('status')); } catch (e) { live.on = false; render(); }
    } else if (action === 'change-group') {
      state.setup = true; state.editGroup = null; state.setupGroup = null; state.setupBoss = null; state.setupNames = null; state.confirmRemove = null;
      render(); loadGroups();
    } else if (action === 'done-setup') {
      state.setup = false; state.setupGroup = null; state.editGroup = null; render();
    } else if (action === 'cancel-edit') {
      state.editGroup = null; state.setupGroup = null; state.setupBoss = null; state.setupNames = null; render();
    } else if (action === 'edit-group') {
      const t = tracked.find(x => x.groupId === gid);
      if (!t) return;
      state.editGroup = gid; state.setupGroup = null; state.setupNames = null; state.confirmRemove = null;
      state.setupBoss = new Set(t.bossIds || []);
      render(); loadGroupInfo(gid);
    } else if (action === 'save-group') {
      const g = live.groupInfo;
      if (!g || g.id !== state.editGroup || !state.setupBoss || !state.setupBoss.size) return;
      const groups = tracked.map(t => t.groupId === g.id ? { groupId: g.id, groupName: g.name || t.groupName, bossIds: [...state.setupBoss] } : t);
      const names = namesFromForm(g);
      state.editGroup = null; state.setupBoss = null; state.setupNames = null;
      live.lastSig = '';
      await saveTracking(groups, names);
    } else if (action === 'add-group') {
      const g = live.groupInfo;
      if (!g || g.id !== state.setupGroup || !state.setupBoss || !state.setupBoss.size) return;
      const groups = tracked.concat({ groupId: g.id, groupName: g.name, bossIds: [...state.setupBoss] });
      const names = namesFromForm(g);
      state.setupGroup = null; state.setupBoss = null; state.setupNames = null; state.setup = false;
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
  async function readGroup(t) {
    const gid = t.groupId;
    const g = await callReader('get_group', { group_id: gid });
    let since = Date.now() - (WINDOW_DAYS + 1) * DAY_MS;
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
    const members = updateMembers(prevRaw ? prevRaw.members : prev ? prev.meta.members : null, participants,
      live.lastMembersRead[gid] || (prev ? prev.meta.syncedAt : 0), now);
    live.lastMembersRead[gid] = now;
    return {
      group: { id: g.id, name: g.name || t.groupName }, participants, members, names, bossIds: t.bossIds || [], me: g.me,
      messages: all.map(compactMessage).sort((a, b) => a.t - b.t),
      analysis: { ...(prevRaw ? prevRaw.analysis : prev ? prev.analysis : {}) },
      overrides: saved.names,
      syncedAt: now,
    };
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
      const errors = [];
      for (const t of trackedGroups()) {
        try {
          const raw = await readGroup(t);
          await analyze(raw);
          live.raws[t.groupId] = raw;
        } catch (e) { errors.push(`${t.groupName || 'a group'}: ${e.message || e.code || e}`); }
      }
      live.error = errors.length ? { message: errors.join('; ') } : null;
      live.lastSync = Date.now();
      applyLive();
      for (const t of trackedGroups()) if (live.raws[t.groupId]) await persist(live.raws[t.groupId]);
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
      return !a || (canAsk && (a.by === 'rules' || a.v !== ANALYSIS_VERSION));
    });
    if (!todo.length) return;
    if (!canAsk) { todo.forEach(m => { if (!raw.analysis[m.i]) raw.analysis[m.i] = fallback(m); }); return; }
    live.analyzing = todo.length; renderFrame();
    const bosses = (raw.bossIds || []).map(nameOf);
    for (let i = 0; i < todo.length; i += 12) {
      const batch = todo.slice(i, i + 12);
      // the ten instruction-giver messages before this batch, from the last day
      const context = S0.bossMessages.filter(m => m.t < batch[0].t && m.t > batch[0].t - DAY_MS).slice(-10);
      const earlier = new Map([...context, ...batch].map(m => [m.i, m.s]));
      try {
        const out = await cap.sample.json(analysisPrompt(batch, context, people, bosses, nameOf), { modelTier: 'default' });
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
      const byId = {};
      raw.messages.forEach(m => { if (raw.analysis[m.i]) byId[m.i] = raw.analysis[m.i]; });
      const aJson = JSON.stringify(byId);
      if (aJson !== (live.writtenAnalysis[gid] ?? JSON.stringify(box.analysis))) {
        await db.doc(`sync/${k}/extra/analysis`).set({ byId });
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
    const [db, mcp, sample, user] = await Promise.all([use('db'), use('mcp'), use('sample'), use('user')]);
    cap.db = db; cap.mcp = mcp; cap.sample = sample; cap.user = user;
    if (user) {
      try { cap.canEdit = await user.canEdit(); } catch (_) { cap.canEdit = null; }
      try { cap.isOwner = await user.isOwner(); } catch (_) { cap.isOwner = null; }
      try { cap.canWrite = await user.can('data.write'); } catch (_) { cap.canWrite = null; }
      try { cap.me = await user.id(); } catch (_) { cap.me = null; }
    }
    if (db) subscribeSaved(db);
    if (mcp) startLive(); else { live.diag = { code: 'no-mcp' }; render(); }
  }

  state.view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
  render();
  boot();
})();
