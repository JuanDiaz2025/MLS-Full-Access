// ---- sample data + derivation (shared by the page and the node check) ----
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample snapshot: today at 10:15 AM in the viewer's time zone.
function sampleNow() { const d = new Date(); d.setHours(10, 15, 0, 0); return d.getTime(); }

function buildSample(now) {
  const rnd = mulberry32(20261024);
  const at = (daysAgo, h, m) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime(); };

  // id, name, typical minutes to reply, chance of replying only after escalation
  const roster = [
    ['john', 'John', 3, 0], ['maria', 'Maria', 5, 0], ['carlos', 'Carlos', 14, .04], ['bryan', 'Bryan', 11, 0],
    ['david', 'David', 38, .10], ['james', 'James', 24, .07], ['robert', 'Robert', 30, .08], ['jose', 'Jose', 16, .03],
    ['luis', 'Luis', 9, 0], ['ana', 'Ana', 6, 0], ['miguel', 'Miguel', 8, 0], ['sofia', 'Sofia', 4, 0],
    ['kevin', 'Kevin', 13, .02], ['daniel', 'Daniel', 10, 0], ['elena', 'Elena', 7, 0], ['marcus', 'Marcus', 19, .03],
    ['tony', 'Tony', 21, .04], ['rosa', 'Rosa', 12, .02],
  ];
  const people = roster.map(([id, name]) => ({ id, name }));
  const prof = Object.fromEntries(roster.map(([id, , med, late]) => [id, { med, late }]));
  const ALL = people.map(p => p.id);
  const ACKS = ['👍', 'OK', 'Got it', 'Confirmed', 'Seen, thanks', 'Will do', 'Copy that', 'Yes', 'OK, reviewed.', 'All good.'];
  const ack = () => ACKS[Math.floor(rnd() * ACKS.length)];
  const delayFor = id => {
    const p = prof[id];
    if (rnd() < p.late) return Math.round(65 + rnd() * 170) * MIN;
    return Math.max(1, Math.round(p.med * (0.45 + rnd() * 1.3))) * MIN;
  };

  const messages = [], tasks = [];
  const msg = (o) => { messages.push({ replies: {}, priority: 'Normal', ...o }); return messages[messages.length - 1]; };
  const autoReplies = (m, except = []) => {
    const req = m.required === 'all' ? ALL : m.required;
    req.forEach(id => { if (!except.includes(id) && !m.replies[id]) m.replies[id] = { at: m.at + delayFor(id), text: ack() }; });
  };

  // History: one all-hands message most working days, days 2 to 29.
  const GROUP = [
    ['Read the updated site schedule', 'Everyone, read the updated site schedule for this week and reply to confirm.', 'Instruction'],
    ['PPE for the inspection', 'City inspection tomorrow at Site A. Confirm you have your hard hat, vest and boots.', 'Instruction'],
    ['Confirm timesheet hours', 'Confirm your hours for this week’s timesheet by end of day.', 'Instruction'],
    ['New gate code at Site B', 'The gate code at Site B changed. It’s posted in the office. Reply once you have it.', 'Instruction'],
    ['Harness rule on the roof', 'Reminder: nobody goes on the roof without a harness. Reply to confirm.', 'Instruction'],
    ['Staying late Thursday?', 'Who can stay late Thursday for the drywall delivery? Everyone reply yes or no.', 'Question'],
    ['Site C closed Monday', 'Site C is closed Monday morning for the electrical inspection. Reply so I know you saw this.', 'Instruction'],
    ['Parking at Site A', 'Don’t park on the street at Site A anymore, the neighbours complained. Use the lot. Confirm.', 'Instruction'],
  ];
  let g = 0;
  for (let d = 29; d >= 2; d--) {
    const day = new Date(at(d, 12, 0));
    if (day.getDay() === 0) continue;
    const [title, text, kind] = GROUP[g++ % GROUP.length];
    const m = msg({ id: 'g' + d, at: at(d, 7 + Math.floor(rnd() * 3), Math.floor(rnd() * 4) * 15), title, text, kind, required: 'all' });
    autoReplies(m);
  }

  // History: tasks given to one person. outcome: ontime | late | overdue
  const TASKS = [
    [29, 8, 10, 'kevin', 'Order replacement saw blades', 'Kevin, order the replacement saw blades today and tell me when they’re ordered.', [0, 17], 'ontime', { reply: 'Ordered, arriving Wed' }],
    [27, 7, 40, 'bryan', 'Framing photos, Site A', 'Bryan, send me photos of the framing at Site A by 3 PM.', [0, 15], 'ontime', { photos: 4 }],
    [25, 9, 15, 'david', 'Clean dumpster area, Site B', 'David, clean out the dumpster area at Site B before Friday.', [3, 17], 'late', { photos: 2 }],
    [23, 13, 5, 'maria', 'Safety checklist, Site B', 'Maria, upload the safety checklist for Site B by 5 PM.', [0, 17], 'ontime', { doc: 'Site B safety checklist.pdf' }],
    [21, 8, 30, 'robert', 'Submit fuel receipts', 'Robert, submit last week’s fuel receipts by Thursday.', [2, 17], 'overdue', null],
    [20, 10, 0, 'luis', 'Book the plumber for Monday', 'Luis, confirm the plumber is booked for Monday.', [0, 16], 'ontime', { reply: 'Booked for 8 AM' }],
    [18, 7, 50, 'james', 'Check generator, Site C', 'James, check the generator at Site C and tell me if it needs service.', [0, 12], 'late', { reply: 'Needs an oil change' }],
    [16, 9, 40, 'ana', 'Send material list to supplier', 'Ana, send the updated material list to the supplier today.', [0, 17], 'ontime', { doc: 'Material list rev 3.xlsx' }],
    [14, 8, 20, 'carlos', 'Window install photos, Site A', 'Carlos, get me photos of the window install at Site A by noon.', [0, 12], 'ontime', { photos: 5 }],
    [11, 14, 0, 'david', 'Return the rented compactor', 'David, return the rented compactor by Wednesday noon.', [2, 12], 'late', { reply: 'Dropped it off' }],
    [9, 7, 30, 'miguel', 'Schedule porta-potty pickup', 'Miguel, schedule the porta-potty pickup at Site C.', [0, 15], 'ontime', { reply: 'Pickup Friday AM' }],
    [7, 9, 0, 'james', 'Daily log, Site B', 'James, send me the daily log for Site B by 5 PM.', [0, 17], 'overdue', null],
    [5, 8, 45, 'elena', 'Permit card photo, Site C', 'Elena, send a photo of the permit card at Site C.', [0, 12], 'ontime', { photos: 1 }],
    [4, 10, 20, 'tony', 'Drywall delivery count', 'Tony, confirm the drywall count when the delivery lands.', [0, 16], 'late', { reply: '112 sheets, 4 damaged' }],
    [3, 8, 0, 'bryan', 'Punch list, Site A', 'Bryan, upload the punch list for Site A by tomorrow noon.', [1, 12], 'ontime', { doc: 'Site A punch list.pdf' }],
    [2, 9, 30, 'sofia', 'Bathroom tile photos, Site C', 'Sofia, send photos of the finished bathroom tile at Site C.', [0, 17], 'ontime', { photos: 3 }],
  ];
  TASKS.forEach(([d, h, mi, owner, title, text, [dd, dh], outcome, ev], i) => {
    const m = msg({ id: 't' + i, at: at(d, h, mi), title, text, kind: 'Instruction', required: [owner], task: 'k' + i });
    autoReplies(m);
    const due = at(d - dd, dh, 0);
    const t = { id: 'k' + i, title, msg: m.id, owner, due, ackAt: m.replies[owner].at };
    if (outcome === 'ontime') t.doneAt = due - Math.round((1 + rnd() * 4) * HOUR);
    if (outcome === 'late') t.doneAt = due + Math.round((3 + rnd() * 20) * HOUR);
    if (t.doneAt && t.doneAt < t.ackAt) t.doneAt = t.ackAt + 40 * MIN;
    if (ev) t.evidence = ev;
    tasks.push(t);
  });

  // Yesterday
  const y1 = msg({ id: 'y1', at: at(1, 11, 30), title: 'Inspect the concrete pour', kind: 'Instruction', required: ['carlos'], task: 'ky1',
    text: 'Carlos, inspect the concrete pour at Site B tomorrow and send me photos by 3 PM.' });
  y1.replies.carlos = { at: at(1, 11, 52), text: 'OK' };
  tasks.push({ id: 'ky1', title: 'Inspect concrete pour, Site B', msg: 'y1', owner: 'carlos', due: at(0, 15, 0), ackAt: at(1, 11, 52) });

  const y2 = msg({ id: 'y2', at: at(1, 14, 10), title: 'Safety checklist, Site A', kind: 'Instruction', required: ['maria'], task: 'ky2',
    text: 'Maria, send me the completed safety checklist for Site A by 5 PM.' });
  y2.replies.maria = { at: at(1, 14, 13), text: 'Will do' };
  tasks.push({ id: 'ky2', title: 'Safety checklist, Site A', msg: 'y2', owner: 'maria', due: at(1, 17, 0), ackAt: at(1, 14, 13), doneAt: at(1, 16, 40), evidence: { doc: 'Site A safety checklist.pdf' } });

  const y3 = msg({ id: 'y3', at: at(1, 15, 20), title: 'Confirm timesheet hours', kind: 'Instruction', required: 'all', priority: 'High',
    text: 'Everyone, confirm your hours for this week’s timesheet by end of day. Payroll goes in tomorrow.' });
  autoReplies(y3, ['david', 'robert']);

  // Today
  const m1 = msg({ id: 'm1', at: at(0, 9, 0), title: 'Confirm today’s site priorities', kind: 'Instruction', required: 'all', priority: 'High', task: 'kt1',
    text: 'Everyone, please confirm you have reviewed today’s site priorities. Bryan, submit site photos by 4 PM.\n\nThanks!' });
  [['john', 2, '👍'], ['sofia', 4, 'Seen'], ['maria', 5, 'OK, reviewed.'], ['ana', 6, 'Got it'], ['carlos', 8, 'All good.'], ['elena', 9, 'Confirmed'],
   ['miguel', 10, '👍'], ['luis', 11, 'Reviewed'], ['bryan', 12, 'Done. Photos coming this afternoon'], ['daniel', 14, 'OK'],
   ['kevin', 26, 'Sorry, was driving. Confirmed'], ['marcus', 33, 'Got it']]
    .forEach(([id, mins, text]) => { m1.replies[id] = { at: m1.at + mins * MIN, text }; });
  tasks.push({ id: 'kt1', title: 'Submit site photos', msg: 'm1', owner: 'bryan', due: at(0, 16, 0), ackAt: at(0, 9, 12), progressAt: at(0, 10, 5), evidence: { photos: 2 } });

  const m2 = msg({ id: 'm2', at: at(0, 9, 40), title: 'Check equipment at Site A', kind: 'Instruction', required: ['carlos', 'miguel'], priority: 'High', task: 'kt2',
    text: 'Carlos and Miguel, check the equipment at Site A before the concrete crew gets there at 10. Carlos, confirm when it’s done.' });
  m2.replies.miguel = { at: at(0, 9, 46), text: 'Heading there now' };
  tasks.push({ id: 'kt2', title: 'Check equipment at Site A', msg: 'm2', owner: 'carlos', due: at(0, 10, 0) });

  const m3 = msg({ id: 'm3', at: at(0, 9, 55), title: 'Lumber delivery time?', kind: 'Question', required: ['luis', 'ana', 'tony', 'marcus'],
    text: 'Site B crew: what time is the lumber delivery now? The yard said it might slip.' });
  m3.replies.ana = { at: at(0, 10, 2), text: 'Truck is about 30 min out' };
  m3.replies.luis = { at: at(0, 10, 12), text: 'Yard confirmed 10:45' };
  m3.replies.marcus = { at: at(0, 10, 14), text: 'Same, 10:45' };

  const m4 = msg({ id: 'm4', at: at(0, 10, 5), title: 'Extra ladder to Site C', kind: 'Question', required: ['jose'],
    text: 'Jose, can you bring the extra ladder to Site C before lunch?' });

  // Nothing in the sample can be later than the snapshot.
  messages.forEach(m => Object.keys(m.replies).forEach(id => { if (m.replies[id].at > now) delete m.replies[id]; }));
  messages.sort((a, b) => b.at - a.at);
  return { people, messages, tasks };
}

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
      const row = { pid, name: P.name, replied: !!r, at: r ? r.at : null, delay: r ? r.at - m.at : null, text: r ? r.text : '', linked: r && r.linked || null, stage, missed, waiting: r ? null : elapsed };
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

if (typeof module !== 'undefined') module.exports = { buildSample, derive, sampleNow, MIN };
