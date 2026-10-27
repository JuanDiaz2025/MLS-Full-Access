// ---- turning messages and replies into the numbers on the dashboard ----
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function derive(S, cfg, now) {
  const esc = cfg.escalate * MIN, marks = [cfg.first, cfg.second, cfg.escalate].map(x => x * MIN);
  const people = {};
  S.people.forEach(p => { people[p.id] = { ...p, required: 0, replied: 0, delays: [], missed: 0, lastMissed: null, pending: [], chased: 0 }; });

  const messages = S.messages.map(m => {
    const req = m.required === 'all' ? S.people.map(p => p.id) : m.required;
    const elapsed = now - m.at;
    const rows = req.map(pid => {
      const r = m.replies[pid];
      const window = r ? r.at - m.at : elapsed;
      const stage = marks.filter(t => window >= t).length; // 0 waiting, 1, 2 reminders, 3 escalated
      const missed = window >= esc;
      const P = people[pid];
      P.required++;
      if (r) { P.replied++; P.delays.push(r.at - m.at); }
      if (missed) { P.missed++; P.lastMissed = Math.max(P.lastMissed || 0, m.at + esc); }
      const row = { pid, name: P.name, replied: !!r, at: r ? r.at : null, delay: r ? r.at - m.at : null, text: r ? r.text : '', why: r && r.why || '', linked: r && r.linked || null, stage, missed, waiting: r ? null : elapsed };
      if (!r) P.pending.push({ msg: m, waiting: elapsed, stage });
      // each nudge counts against whoever still hadn't answered when it was sent
      (m.chases || []).forEach(c => { if (!r || r.at > c.at) P.chased++; });
      return row;
    });
    const pending = rows.filter(r => !r.replied);
    // a question anyone can answer, with no answer yet: open, but no one person is behind on it
    const waitingAny = !!m.anyone && !rows.length;
    const stage = waitingAny ? marks.filter(t => elapsed >= t).length : null;
    return { ...m, req, rows, pending, responded: rows.length - pending.length, resolved: !pending.length && !waitingAny, waitingAny, stage };
  });

  const tasks = S.tasks.map(t => {
    let status;
    if (t.doneAt && t.doneAt <= now) status = t.due != null && t.doneAt > t.due ? 'Completed late' : 'Completed';
    else if (t.due != null && t.due < now) status = 'Overdue';
    else if (t.progressAt) status = 'In progress';
    else if (t.ackAt) status = 'Acknowledged';
    else status = 'Not acknowledged';
    return { ...t, status, ownerName: people[t.owner].name, from: S.messages.find(m => m.id === t.msg) };
  });

  const list = Object.values(people).map(p => ({ ...p, avg: p.delays.length ? p.delays.reduce((a, b) => a + b, 0) / p.delays.length : null }));
  const allDelays = list.flatMap(p => p.delays);
  const due = tasks.filter(t => (t.due != null && t.due <= now) || t.status.startsWith('Completed'));
  const done = due.filter(t => t.status.startsWith('Completed'));

  const weeks = [3, 2, 1, 0].map(i => {
    const end = now - i * 7 * DAY, start = end - 7 * DAY;
    let ok = 0, n = 0;
    messages.filter(m => m.at >= start && m.at < end).forEach(m => m.rows.forEach(r => {
      if (r.replied || r.missed) { n++; if (!r.missed) ok++; }
    }));
    return { start, end, ok, n, rate: n ? ok / n : null };
  });

  const owners = {};
  tasks.forEach(t => {
    const o = owners[t.owner] ||= { id: t.owner, name: t.ownerName, total: 0, ontime: 0, late: 0, overdue: 0, open: 0 };
    o.total++;
    if (t.status === 'Completed') o.ontime++; else if (t.status === 'Completed late') o.late++; else if (t.status === 'Overdue') o.overdue++; else o.open++;
  });

  return {
    messages, tasks, people: list,
    pendingPeople: list.filter(p => p.pending.length).map(p => ({ ...p, pending: p.pending.sort((a, b) => b.waiting - a.waiting) })).sort((a, b) => b.pending[0].waiting - a.pending[0].waiting),
    unresolved: messages.filter(m => !m.resolved),
    overdue: tasks.filter(t => t.status === 'Overdue'),
    // nothing is sent anywhere: these count people the dashboard flags right now
    followUp: list.filter(p => p.pending.some(x => x.stage >= 1)).length,
    toEscalate: list.filter(p => p.pending.some(x => x.stage >= 3)).length,
    avgAck: allDelays.length ? allDelays.reduce((a, b) => a + b, 0) / allDelays.length : null,
    repeat: list.filter(p => p.missed >= 2).sort((a, b) => b.missed - a.missed || b.lastMissed - a.lastMissed),
    completion: { done: done.length, due: due.length, late: done.filter(t => t.status === 'Completed late').length },
    weeks, owners: Object.values(owners),
  };
}

if (typeof module !== 'undefined') module.exports = { derive, MIN };
