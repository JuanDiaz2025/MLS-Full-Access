(function () {
  const DEFAULTS = { first: 15, second: 30, escalate: 60 };
  const READER = 'host:whatsapp-reader';
  const DAY_MS = 24 * 60 * MIN;
  const SAMPLE_NOW = sampleNow();
  const SAMPLE = buildSample(SAMPLE_NOW);

  let cfg = { ...DEFAULTS };
  let D = null, S = SAMPLE, NOW = SAMPLE_NOW, N = SAMPLE.people.length;
  const state = { view: 'dashboard', sel: null, taskFilter: 'open', setup: false, setupGroup: null, setupBoss: null };
  // where the numbers come from: 'sample', 'live' (WhatsApp Reader on this computer) or 'saved' (last copy kept in the page)
  const src = { mode: 'sample', raw: null, S: SAMPLE, now: SAMPLE_NOW, group: { name: 'THB Construction Team' }, updatedAt: null };
  const cap = { db: null, mcp: null, sample: null, canEdit: null };
  const saved = { source: null, meta: null, analysis: {}, days: {}, names: {}, loaded: { source: false, analysis: false, meta: false } };
  const live = { on: false, status: null, groups: null, groupInfo: null, busy: false, again: false, lastSig: '', lastSync: 0,
    unwatch: null, diag: null, written: {}, writtenAnalysis: null, writtenMeta: null, lastMetaWrite: 0, sampleDenied: false, analyzing: 0, error: null, offCode: null };

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
  const emptyCard = (title, body) => `<div class="card"><div class="empty"><b>${esc(title)}</b><br>${esc(body)}</div></div>`;

  // ---------------- Dashboard ----------------
  function viewDashboard() {
    const pp = D.pendingPeople;
    const peopleRows = pp.map(p => {
      const top = p.pending[0];
      const extra = p.pending.length - 1;
      return `<tr><td>${who(p.name)}</td>
        <td>${msgLink(top.msg)}${extra ? ` <span class="more">+${extra} more</span>` : ''}<span class="sub">Sent ${esc(fmtWhen(top.msg.at))}</span></td>
        <td class="num">${fmtDur(top.waiting)}</td>
        <td>${stageChip(top.stage, top.msg)}</td></tr>`;
    }).join('');
    const unresolvedRows = D.unresolved.map(m => `<tr>
        <td>${msgLink(m)}<span class="sub">${esc(m.kind)}${m.priority === 'High' ? ' · High priority' : ''}${(m.chases || []).length ? ` · you followed up ${m.chases.length}×` : ''}</span></td>
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
        : `Messages from ${bossNames().join(' or ')} that ask people to do or answer something will show here.`);
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
        <span class="m-s">${esc(fmtClock(m.at))} · ${m.responded}/${m.req.length} replied${(m.chases || []).length ? ` · followed up ${m.chases.length}×` : ''}</span></button>`;
    }).join('');

    const m = D.messages.find(x => x.id === state.sel);
    const task = m.task ? D.tasks.find(t => t.id === m.task) : null;
    const nameById = id => (D.people.find(p => p.id === id) || {}).name || id;
    const reqLabel = m.required === 'all' || m.everyone ? `Everyone (${m.req.length})` : m.req.map(nameById).join(', ');
    const chases = m.chases || [];
    const chaseHtml = chases.length ? `<div class="chases"><div class="chases-h">${ic('repeat')}You followed up ${chases.length === 1 ? 'once' : chases.length + ' times'}</div>
        ${chases.map(c => `<div class="chase"><span>${esc(c.text)}</span><time>${esc(fmtClock(c.at))}</time></div>`).join('')}</div>` : '';
    const rows = m.rows.slice().sort((a, b) => (a.replied - b.replied) || (a.replied ? a.delay - b.delay : a.name.localeCompare(b.name))).map(r => `<tr>
        <td>${who(r.name)}</td>
        <td>${r.replied ? chip('c-good', 'Replied', 'check') : chip('c-crit', 'No response')}</td>
        <td class="num">${r.replied ? fmtDur(r.delay) : `<span class="plain">${fmtDur(r.waiting)} so far</span>`}</td>
        <td>${r.replied ? esc(r.text) : '<span class="plain">None</span>'}</td>
        <td>${r.replied ? `<span class="plain">${replyNote(r.stage)}</span>` : stageChip(r.stage, m)}</td></tr>`).join('');

    return `<div class="msgs">
      <div class="card"><div class="card-h"><h2>Sent to the group</h2><span class="hint">${plural(D.messages.length, 'message')}, last 30 days</span></div>
        <div class="mlist" id="mlist">${items}</div></div>
      <div class="card"><div class="card-b">
        <div class="mhead"><div><h2>${esc(m.title)}</h2><p>${esc(fmtWhen(m.at))} · Sent by ${esc(m.senderName || 'Juan')}</p></div>
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
        <td class="from">${msgLink(t.from, '“' + snippet(t.from.text) + '”')}<span class="sub">${esc(fmtWhen(t.from.at))}</span></td>
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
      <div class="bar-row" tabindex="0" data-tip-t="${esc(p.name)}" data-tip="${esc(`You had to follow up ${p.chased === 1 ? 'once' : p.chased + ' times'} before ${p.name} answered, in the last 30 days.`)}">
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
      <div class="card"><div class="card-h"><h2>Times you had to chase</h2><span class="hint">Last 30 days</span></div>
        <div class="card-b">${chaseBars ? `<div class="bars">${chaseBars}</div>
          <p class="legend">Each follow-up counts against the people who still hadn’t answered when it was sent.</p>`
          : '<div class="empty">You didn’t have to chase anyone.</div>'}</div></div>
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

  // ---------------- connecting a group (owner, on the computer running WhatsApp Reader) ----------------
  const sourceKnown = () => !cap.db || saved.loaded.source;
  const needsSetup = () => live.on && (!live.status || !live.status.linked || (!saved.source && sourceKnown()) || state.setup);

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
    const groups = (live.groups || []).slice().sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
    const g = live.groupInfo;
    const pickGroup = live.groups == null ? '<p class="plain">Loading your groups…</p>'
      : !groups.length ? '<p class="plain">No groups found on the linked phone yet. Send a message in the group, then check again.</p>'
      : `<div class="choices" role="radiogroup" aria-label="Group">${groups.map(x => `
          <label class="choice"><input type="radio" name="setup-group" id="g-${esc(x.id)}" value="${esc(x.id)}"${state.setupGroup === x.id ? ' checked' : ''}>
            <span><b>${esc(x.name || 'Unnamed group')}</b><span class="sub">${plural(x.members, 'member')} · ${plural(x.message_count, 'message')} saved${x.last_message_at ? ` · last ${esc(fmtWhen(x.last_message_at))}` : ''}</span></span></label>`).join('')}</div>`;
    let pickBoss = '';
    if (state.setupGroup) {
      pickBoss = !g || g.id !== state.setupGroup ? '<p class="plain">Loading members…</p>'
        : `<div class="choices">${g.participants.map(p => `
            <label class="choice"><input type="checkbox" name="setup-boss" id="b-${esc(p.id)}" value="${esc(p.id)}"${state.setupBoss && state.setupBoss.has(p.id) ? ' checked' : ''}>
              <span><b>${esc(p.name)}${p.id === g.me ? ' (this phone)' : ''}</b><span class="sub">${esc(p.phone || 'Phone number hidden by WhatsApp')}</span></span></label>`).join('')}</div>`;
    }
    const ready = state.setupGroup && state.setupBoss && state.setupBoss.size && g && g.id === state.setupGroup;
    const looksLikeNumber = n => !n || /^\+?[\d\s()-]+$/.test(n);
    const nameValue = p => (state.setupNames && p.id in state.setupNames) ? state.setupNames[p.id]
      : saved.names[p.id] || (looksLikeNumber(p.name) ? '' : p.name);
    const nameRows = g && g.id === state.setupGroup ? g.participants.map(p => `
        <label class="name-row" for="n-${esc(p.id)}"><span class="sub">${esc(p.phone || 'Phone number hidden by WhatsApp')}${p.id === g.me ? ' (this phone)' : ''}</span>
          <input class="name-in" type="text" id="n-${esc(p.id)}" data-name-for="${esc(p.id)}" value="${esc(nameValue(p))}" placeholder="Name" maxlength="60" autocomplete="off"></label>`).join('') : '';
    return `<div class="card setup"><div class="card-b">
      <h2>${ic('link')}Choose the group to track</h2>
      <p>WhatsApp Reader is linked to +${esc(st.phone)}. It only reads; nothing is ever sent.</p>
      <h3>1. Group</h3>${pickGroup}
      ${state.setupGroup ? `<h3>2. Whose messages are the instructions?</h3><p class="plain">Everyone else in the group is tracked for replies.</p>${pickBoss}` : ''}
      ${nameRows ? `<h3>3. Names</h3><p class="plain">Optional. Shown on the dashboard instead of phone numbers.</p><div class="names">${nameRows}</div>` : ''}
      <p class="dlg-msg err" id="setup-msg" role="status">${esc(live.setupError || '')}</p>
      <div class="dlg-f" style="padding:0">
        ${saved.source ? '<button class="btn" type="button" data-action="cancel-setup">Cancel</button>' : ''}
        <button class="btn primary" type="button" data-action="save-source"${ready ? '' : ' disabled'}>${saved.source ? 'Save' : 'Start tracking'}</button>
      </div>
    </div></div>`;
  }

  // ---------------- frame ----------------
  function bossNames() {
    const raw = src.raw;
    if (!raw) return ['Juan'];
    const nameOf = nameIndex(raw);
    return (raw.bossIds || []).map(nameOf);
  }

  function renderNav() {
    const badge = { dashboard: D.pendingPeople.length, messages: D.unresolved.length, tasks: D.overdue.length, reports: null };
    document.getElementById('nav').innerHTML = Object.entries(VIEWS).map(([k, v]) =>
      `<a href="#${k}"${state.view === k ? ' aria-current="page"' : ''}>${ic(v.icon)}${v.label}${badge[k] ? `<span class="count" aria-label="${badge[k]} need attention">${badge[k]}</span>` : ''}</a>`).join('');
    document.getElementById('timing-sum').textContent = `Flags at ${cfg.first} and ${cfg.second} min, escalate at ${cfg.escalate}`;
  }

  function renderFrame() {
    const groupName = src.group && src.group.name ? src.group.name : 'WhatsApp group';
    document.getElementById('brand-sub').textContent = groupName;
    document.getElementById('group-pill').innerHTML = `${ic('users')}${esc(groupName)} · ${plural(N, 'person', 'people')}`;
    const pill = document.getElementById('snap');
    const note = document.getElementById('side-note');
    const foot = document.getElementById('foot');
    const change = document.getElementById('change-group');
    change.hidden = !(live.on && live.status && live.status.linked && saved.source);
    if (src.mode === 'live') {
      pill.className = 'pill live';
      pill.innerHTML = `<i class="dot"></i>Live · updated ${esc(fmtClock(src.updatedAt))}${live.analyzing ? ' · reading new messages…' : ''}`;
      note.textContent = 'Reading the group on this computer. Nothing is sent to WhatsApp.';
      foot.textContent = `Reading “${groupName}” through WhatsApp Reader on this computer. Nothing is ever sent to WhatsApp. Each update is saved into this page, so anyone with the link sees the same numbers on any device.`;
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
    conn.hidden = live.on || !live.diag;
    if (!conn.hidden) {
      const d = live.diag;
      document.getElementById('conn-text').textContent = connMessage(d);
      document.getElementById('conn-code').textContent = d.code === 'connecting' ? '' : `Code: ${d.code}`;
      document.getElementById('conn-btn').disabled = d.code === 'connecting';
    }
    const err = document.getElementById('live-error');
    const msg = live.error ? (live.error.message || String(live.error)) : '';
    err.hidden = !(live.on && msg);
    err.textContent = msg ? `WhatsApp Reader couldn’t read the group: ${msg}` : '';
  }

  // Why this window isn't reading WhatsApp Reader, in words that say what to do.
  function connMessage(d) {
    switch (d.code) {
      case 'connecting': return 'Connecting to WhatsApp Reader\u2026';
      case 'no-mcp': return 'This window can\u2019t reach programs on your computer. Open this page in the Claude desktop app.';
      case 'server_not_connected': return 'The Claude app showing this page didn\u2019t connect it to WhatsApp Reader. Check that Settings \u2192 Developer lists whatsapp-reader as running. If this page is open in a side panel, open it in its own window and press Connect.';
      case 'not_in_manifest': case 'not_granted': case 'approval_required': case 'cancelled': case 'consent_required':
        return 'Access to WhatsApp Reader wasn\u2019t allowed. Press Connect and choose Allow.';
      case 'blocked_by_policy': return 'Your organization\u2019s settings block this page from using WhatsApp Reader.';
      case 'tool_error': return `WhatsApp Reader answered with an error: ${d.message || 'no details'}`;
      default: return `Couldn\u2019t reach WhatsApp Reader${d.message ? ': ' + d.message : '.'}`;
    }
  }

  function render() {
    S = src.S;
    NOW = src.mode === 'live' ? Date.now() : src.now;
    N = S.people.filter(p => !p.former).length;
    D = derive(S, cfg, NOW);
    renderNav();
    renderFrame();
    const setup = needsSetup();
    const v = VIEWS[state.view];
    document.getElementById('v-title').textContent = setup ? 'Connect WhatsApp' : v.title;
    document.getElementById('v-sub').textContent = setup ? 'One-time setup on this computer.' : v.sub;
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
    if (act) onAction(act.dataset.action);
  });
  document.addEventListener('input', e => {
    const id = e.target.dataset && e.target.dataset.nameFor;
    if (id) { state.setupNames = state.setupNames || {}; state.setupNames[id] = e.target.value; }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'task-filter') { state.taskFilter = e.target.value; render(); }
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
  function applyRaw(raw, mode) {
    src.mode = mode; src.raw = raw;
    src.group = raw.group || { name: 'WhatsApp group' };
    src.updatedAt = raw.syncedAt || Date.now();
    src.now = mode === 'live' ? Date.now() : src.updatedAt;
    src.S = buildFromRaw(raw, src.now);
    render();
  }

  function applySaved() {
    if (src.mode === 'live' || !saved.meta || !saved.meta.group) { render(); return; }
    const messages = Object.values(saved.days).flatMap(d => (d && d.messages) || []);
    applyRaw({ ...saved.meta, analysis: saved.analysis || {}, messages, overrides: saved.names }, 'saved');
  }

  function subscribeSaved(db) {
    const fail = () => {};
    db.doc('settings/followup').onSnapshot(snap => {
      if (!snap.exists) return;
      const d = snap.data();
      const v = { first: d.first, second: d.second, escalate: d.escalate };
      if (valid(v) && (v.first !== cfg.first || v.second !== cfg.second || v.escalate !== cfg.escalate)) { cfg = v; render(); }
    }, fail);
    db.doc('settings/source').onSnapshot(snap => {
      saved.source = snap.exists ? snap.data() : null;
      saved.loaded.source = true;
      if (live.on && live.status && live.status.linked) { if (saved.source) syncNow(); else loadGroups(); }
      render();
    }, fail);
    db.doc('settings/names').onSnapshot(snap => {
      saved.names = snap.exists ? (snap.data().byId || {}) : {};
      if (src.raw) applyRaw({ ...src.raw, overrides: saved.names }, src.mode); else render();
    }, fail);
    db.doc('sync/meta').onSnapshot(snap => { saved.meta = snap.exists ? snap.data() : null; saved.loaded.meta = true; applySaved(); }, fail);
    db.doc('sync/analysis').onSnapshot(snap => {
      saved.analysis = snap.exists ? (snap.data().byId || {}) : {};
      saved.loaded.analysis = true;
      applySaved();
    }, fail);
    db.collection('sync/meta/days').onSnapshot(q => {
      const days = {};
      q.docs.forEach(d => { days[d.id] = d.data(); });
      saved.days = days;
      applySaved();
    }, fail);
  }

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
    live.unwatch = cap.mcp.watchTool(READER, 'status', null, ev => {
      if (ev.type === 'data') { onStatus(ev.result.payload); return; }
      const code = ev.error && ev.error.code;
      if (['server_not_connected', 'not_in_manifest', 'blocked_by_policy', 'approval_required', 'not_granted'].includes(code)) {
        live.on = false; live.offCode = code; live.diag = { code, message: ev.error.message };
        if (src.mode === 'live') { src.mode = 'sample'; src.S = SAMPLE; src.now = SAMPLE_NOW; applySaved(); } else render();
      }
    }, { refetchInterval: 30000 });
    onStatus(st);
  }

  function onStatus(st) {
    if (!st) return;
    const wasLinked = live.status && live.status.linked;
    live.status = st;
    if (!st.linked) { render(); return; }
    if (!saved.source) {
      if (sourceKnown() && (!live.groups || !wasLinked)) loadGroups(); // otherwise the saved choice is still loading
      render(); return;
    }
    const sig = `${st.messages_stored}|${st.last_message_at}|${st.groups_known}`;
    if (sig !== live.lastSig || Date.now() - live.lastSync > 10 * MIN) { live.lastSig = sig; syncNow(); }
    else if (src.mode === 'live') { src.now = Date.now(); render(); }
  }

  async function loadGroups() {
    try { live.groups = ((await callReader('list_groups')) || {}).groups || []; live.setupError = ''; }
    catch (e) { live.groups = []; live.setupError = e.message || 'Couldn’t list the groups.'; }
    if (!state.setupGroup && saved.source) state.setupGroup = saved.source.groupId;
    if (state.setupGroup) pickGroup(state.setupGroup, true);
    render();
  }

  async function pickGroup(id, keepBoss) {
    state.setupGroup = id;
    if (!keepBoss) state.setupBoss = null;
    render();
    try {
      const g = await callReader('get_group', { group_id: id });
      if (state.setupGroup !== id) return;
      live.groupInfo = g;
      if (!state.setupBoss) {
        const prev = saved.source && saved.source.groupId === id ? saved.source.bossIds : null;
        state.setupBoss = new Set(prev && prev.length ? prev : (g.me ? [g.me] : []));
      }
      live.setupError = '';
    } catch (e) { live.setupError = e.message || 'Couldn’t read that group.'; }
    render();
  }

  async function onAction(action) {
    if (action === 'connect') {
      startLive();
    } else if (action === 'recheck') {
      try { onStatus(await callReader('status')); } catch (e) { live.on = false; render(); }
    } else if (action === 'change-group') {
      state.setup = true; state.setupGroup = saved.source ? saved.source.groupId : null; state.setupBoss = null; state.setupNames = null;
      loadGroups();
    } else if (action === 'cancel-setup') {
      state.setup = false; render();
    } else if (action === 'save-source') {
      const g = live.groupInfo;
      if (!g || !state.setupBoss || !state.setupBoss.size) return;
      const source = { groupId: g.id, groupName: g.name, bossIds: [...state.setupBoss], me: g.me, savedAt: Date.now() };
      const names = { ...saved.names };
      g.participants.forEach(p => {
        if (!state.setupNames || !(p.id in state.setupNames)) return;
        const v = state.setupNames[p.id].trim();
        if (v) names[p.id] = v; else delete names[p.id];
      });
      saved.source = source; saved.names = names; state.setup = false; state.setupNames = null;
      if (cap.db) {
        try {
          await cap.db.doc('settings/source').set(source);
          await cap.db.doc('settings/names').set({ byId: names });
        } catch (e) { live.setupError = 'Couldn’t save the choice on this page.'; }
      }
      if (src.raw) applyRaw({ ...src.raw, overrides: names }, src.mode);
      live.lastSig = ''; render(); syncNow();
    }
  }

  const waitFor = (test, ms) => new Promise(resolve => {
    const start = Date.now();
    const tick = () => (test() || Date.now() - start > ms) ? resolve() : setTimeout(tick, 200);
    tick();
  });

  async function syncNow() {
    if (live.busy) { live.again = true; return; }
    if (!live.on || !saved.source) return;
    live.busy = true; live.again = false;
    try {
      if (cap.db) await waitFor(() => saved.loaded.analysis && saved.loaded.source && saved.loaded.meta, 6000);
      const source = saved.source;
      const g = await callReader('get_group', { group_id: source.groupId });
      let since = Date.now() - (WINDOW_DAYS + 1) * DAY_MS;
      const seen = new Map();
      for (let i = 0; i < 25; i++) {
        const page = await callReader('get_messages', { group_id: source.groupId, since, limit: 2000 });
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
      const sameGroup = saved.meta && saved.meta.group && saved.meta.group.id === g.id;
      const now = Date.now();
      const members = updateMembers(sameGroup ? saved.meta.members : null, participants,
        live.lastMembersRead || (sameGroup ? saved.meta.syncedAt : 0), now);
      live.lastMembersRead = now;
      const raw = {
        group: { id: g.id, name: g.name || source.groupName }, participants, members, names, bossIds: source.bossIds, me: g.me,
        messages: all.map(compactMessage).sort((a, b) => a.t - b.t),
        analysis: { ...(saved.meta && saved.meta.group && saved.meta.group.id === g.id ? saved.analysis : {}) },
        overrides: saved.names,
        syncedAt: Date.now(),
      };
      await analyze(raw);
      applyRaw(raw, 'live');
      live.lastSync = Date.now(); live.error = null;
      await persist(raw);
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
    const bossIdSet = new Set(S0.bossMessages.map(m => m.i));
    const fallback = m => fallbackAnalysis(m, people, bossIdSet);
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
      // the manager's ten messages before this batch, from the last day
      const context = S0.bossMessages.filter(m => m.t < batch[0].t && m.t > batch[0].t - DAY_MS).slice(-10);
      const earlier = new Set([...context, ...batch].map(m => m.i));
      try {
        const out = await cap.sample.json(analysisPrompt(batch, context, people, bosses, nameOf), { modelTier: 'default' });
        const results = out && Array.isArray(out.results) ? out.results : [];
        batch.forEach(m => {
          const a = cleanAnalysis(results.find(r => r && String(r.id) === m.i), people, earlier);
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
    const sameGroup = saved.meta && saved.meta.group && saved.meta.group.id === raw.group.id;
    let changed = false;
    try {
      const byDay = {};
      raw.messages.forEach(m => { (byDay[dayKey(m.t)] ||= []).push(m); });
      for (const [day, list] of Object.entries(byDay)) {
        let body = { day, messages: list };
        let json = JSON.stringify(body);
        if (json.length > 240000) { body = { day, trimmed: true, messages: list.map(m => m.x && m.x.length > 160 ? { ...m, x: m.x.slice(0, 160) } : m) }; json = JSON.stringify(body); }
        const prev = live.written[day] ?? (sameGroup && saved.days[day] ? JSON.stringify(saved.days[day]) : null);
        if (prev === json) continue;
        await db.doc(`sync/meta/days/${day}`).set(body);
        live.written[day] = json; changed = true;
      }
      for (const day of Object.keys(saved.days)) {
        if (!byDay[day]) { await db.doc(`sync/meta/days/${day}`).delete(); delete live.written[day]; changed = true; }
      }
      const byId = {};
      raw.messages.forEach(m => { if (raw.analysis[m.i]) byId[m.i] = raw.analysis[m.i]; });
      const aJson = JSON.stringify(byId);
      if (aJson !== (live.writtenAnalysis ?? JSON.stringify(sameGroup ? saved.analysis : null))) {
        await db.doc('sync/analysis').set({ byId });
        live.writtenAnalysis = aJson; changed = true;
      }
      const meta = { group: raw.group, participants: raw.participants, members: raw.members, names: raw.names, bossIds: raw.bossIds, me: raw.me };
      const mJson = JSON.stringify(meta);
      if (changed || mJson !== live.writtenMeta || Date.now() - live.lastMetaWrite > 5 * MIN) {
        await db.doc('sync/meta').set({ ...meta, syncedAt: raw.syncedAt, messageCount: raw.messages.length });
        live.writtenMeta = mJson; live.lastMetaWrite = Date.now();
      }
    } catch (e) {
      if (e && e.code === 'invalid_argument') cap.canEdit = false;
      if (e && e.code === 'quota_exceeded') live.error = { message: 'this page’s storage is full, so updates aren’t being saved for other devices.' };
      renderFrame();
    }
  }

  // keep waiting times current while the page is open
  setInterval(() => { if (src.mode === 'live' && !document.hidden && !live.busy) { src.now = Date.now(); render(); } }, 60000);

  async function boot() {
    const claude = window.claude;
    if (!claude || typeof claude.use !== 'function') return;
    const use = name => claude.use(name).catch(() => null);
    const [db, mcp, sample, user] = await Promise.all([use('db'), use('mcp'), use('sample'), use('user')]);
    cap.db = db; cap.mcp = mcp; cap.sample = sample;
    if (user) { try { cap.canEdit = await user.canEdit(); } catch (_) { cap.canEdit = null; } }
    if (db) subscribeSaved(db);
    if (mcp) startLive(); else { live.diag = { code: 'no-mcp' }; render(); }
  }

  state.view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
  render();
  boot();
})();
