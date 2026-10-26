// ---- turning the real group's messages into what the dashboard shows ----
const WINDOW_DAYS = 30;
const DONE_RE = /\b(done|finished|complete|completed|sent|uploaded|submitted|fixed|listo|terminado|hecho)\b|✅|✔/i;
const KIND_LABEL = { image: 'Photo', video: 'Video', document: 'Document', audio: 'Voice note', sticker: 'Sticker', location: 'Location', contact: 'Contact', poll: 'Poll' };

// A reader message in the short form saved to the page's storage.
function compactMessage(m) {
  const c = { i: m.id, t: m.at, s: m.sender_id };
  if (m.kind && m.kind !== 'text') c.k = m.kind;
  if (m.text) c.x = m.text.length > 1000 ? m.text.slice(0, 1000) : m.text;
  if (m.quoted_id) c.q = m.quoted_id;
  if (m.reaction_to) c.r = m.reaction_to;
  if (m.mentions && m.mentions.length) c.m = m.mentions;
  if (m.deleted) c.d = 1;
  return c;
}

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], m[4] != null ? +m[4] : 23, m[5] != null ? +m[5] : 59).getTime();
  return Number.isFinite(t) ? t : null;
}

function localStamp(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())} (${d.toLocaleDateString('en-US', { weekday: 'long' })})`;
}

function nameIndex(raw) {
  const names = { ...(raw.names || {}) };
  (raw.participants || []).forEach(p => { if (p.name) names[p.id] = p.name; });
  // names typed in on the dashboard win over what WhatsApp shows
  Object.entries(raw.overrides || {}).forEach(([id, n]) => { if (n) names[id] = n; });
  return id => names[id] || (String(id).endsWith('@lid') ? 'Unknown member' : '+' + id);
}

// "@15551234567" in WhatsApp text becomes "@Name" when we know who it is.
function readableText(m, nameOf) {
  let x = m.x || '';
  (m.m || []).forEach(id => {
    const digits = String(id).replace('@lid', '');
    x = x.split('@' + digits).join('@' + nameOf(id));
  });
  return x;
}

function replyText(m, nameOf) {
  if (m.k === 'reaction') return m.x || '';
  const label = KIND_LABEL[m.k];
  const text = readableText(m, nameOf);
  if (label) return text ? `${label}: ${text}` : label;
  return text;
}

// Used when Claude isn't available to read a message.
function fallbackAnalysis(m, people) {
  const text = (m.x || '').trim();
  const ids = new Set(people.map(p => p.id));
  const named = (m.m || []).filter(id => ids.has(id));
  const chatter = /^(thanks|thank you|thx|ok|okay|good morning|good night|gracias|buenos dias)\b[\s!.]*$/i.test(text) || /^\p{Extended_Pictographic}+$/u.test(text);
  return {
    title: text.split('\n')[0].slice(0, 48) || 'Message',
    type: text.includes('?') ? 'Question' : 'Instruction',
    needs_reply: !chatter && text.length > 0,
    required: named.length ? named : 'all',
    priority: /\b(urgent|asap|important|now|today)\b/i.test(text) ? 'High' : 'Normal',
    task: null,
    by: 'rules',
  };
}

function analysisPrompt(batch, people, bossNames, nameOf) {
  const members = people.map(p => `${p.id}: ${p.name}`).join('\n');
  const msgs = batch.map(m => ({ id: m.i, sent: localStamp(m.t), text: readableText(m, nameOf) }));
  return `You read messages a manager posted in a WhatsApp work group, so a dashboard can track who has to reply.

Manager: ${bossNames.join(', ')}
Group members who may need to reply (id: name):
${members}

For each message return JSON in exactly this shape:
{"results":[{"id":"<message id>","title":"<3 to 6 word summary>","type":"Instruction" or "Question" or "Info","needs_reply":true or false,"required":"all" or ["<member id>"],"priority":"High" or "Normal","task":null or {"title":"<short task name>","owner_id":"<member id>","due":"YYYY-MM-DDTHH:MM" or null}}]}

Rules:
- needs_reply is true when the message asks people to do, confirm or answer something. Greetings, thanks and plain announcements are "Info" with needs_reply false.
- required is "all" when the message is meant for the whole group. Otherwise list the ids of the people it addresses by name or @mention. Use only ids from the member list.
- task is set only when a specific member is asked to complete a piece of work. owner_id is that member. due is the deadline written in the same local time as "sent", or null when no deadline is given.
- priority is "High" only when the message says it is urgent or important, or the work is due the same day.

Messages:
${JSON.stringify(msgs)}`;
}

function cleanAnalysis(a, people) {
  const ids = new Set(people.map(p => p.id));
  if (!a || typeof a !== 'object') return null;
  const out = {
    title: String(a.title || '').slice(0, 60),
    type: ['Instruction', 'Question', 'Info'].includes(a.type) ? a.type : 'Instruction',
    needs_reply: a.needs_reply !== false,
    required: Array.isArray(a.required) ? a.required.map(String).filter(id => ids.has(id)) : 'all',
    priority: a.priority === 'High' ? 'High' : 'Normal',
    task: null,
    by: 'claude',
  };
  if (Array.isArray(out.required) && !out.required.length) out.required = 'all';
  if (a.task && ids.has(String(a.task.owner_id))) {
    out.task = { title: String(a.task.title || out.title).slice(0, 60), owner_id: String(a.task.owner_id), due: typeof a.task.due === 'string' ? a.task.due : null };
  }
  return out;
}

// raw: { participants, names, bossIds, messages (compact), analysis, group }
function buildFromRaw(raw, now) {
  const nameOf = nameIndex(raw);
  const boss = new Set(raw.bossIds || []);
  const people = (raw.participants || []).filter(p => !boss.has(p.id)).map(p => ({ id: p.id, name: nameOf(p.id) }));
  const pset = new Set(people.map(p => p.id));
  const since = now - WINDOW_DAYS * 24 * 60 * 60000;
  const msgs = (raw.messages || []).filter(m => m.t <= now).sort((a, b) => a.t - b.t);
  const byId = new Map(msgs.map(m => [m.i, m]));

  const tracked = [];
  msgs.forEach(m => {
    if (!boss.has(m.s) || m.k === 'reaction' || m.d || m.t < since) return;
    const a = (raw.analysis || {})[m.i] || fallbackAnalysis(m, people);
    if (!a.needs_reply) return;
    let req = a.required === 'all' ? [...pset] : a.required.filter(id => pset.has(id));
    if (a.task && pset.has(a.task.owner_id) && !req.includes(a.task.owner_id)) req = req.concat(a.task.owner_id);
    if (req.length) tracked.push({ m, a, req: new Set(req) });
  });
  const trackedById = new Map(tracked.map(x => [x.m.i, x]));
  const replies = new Map(tracked.map(x => [x.m.i, {}]));
  const setReply = (id, pid, at, text) => { const r = replies.get(id); if (!r[pid]) r[pid] = { at, text }; };

  // Who acknowledged what: a quoted reply or a reaction answers that one
  // message; any other message answers everything still open before it.
  msgs.forEach(msg => {
    const pid = msg.s;
    if (!pset.has(pid)) return;
    if (msg.k === 'reaction') {
      const x = trackedById.get(msg.r);
      if (x && x.req.has(pid) && msg.t >= x.m.t) setReply(x.m.i, pid, msg.t, msg.x || '');
      return;
    }
    const text = replyText(msg, nameOf);
    const quoted = msg.q && trackedById.get(msg.q);
    if (quoted) { if (quoted.req.has(pid)) setReply(quoted.m.i, pid, msg.t, text); return; }
    tracked.forEach(x => { if (x.m.t < msg.t && x.req.has(pid)) setReply(x.m.i, pid, msg.t, text); });
  });

  const tasks = [];
  const messages = tracked.map(x => {
    const { m, a } = x;
    let taskId = null;
    if (a.task && pset.has(a.task.owner_id)) {
      const owner = a.task.owner_id;
      let doneAt = null, photos = 0, doc = null, doneText = '';
      for (const msg of msgs) {
        if (msg.s !== owner || msg.t <= m.t || msg.k === 'reaction') continue;
        if (msg.q && msg.q !== m.i && trackedById.has(msg.q)) continue; // about a different instruction
        if (msg.k === 'image' || msg.k === 'video') photos++;
        if (msg.k === 'document' && !doc) doc = (msg.x || 'Document').split('\n')[0];
        if (msg.k === 'image' || msg.k === 'video' || msg.k === 'document' || DONE_RE.test(msg.x || '')) { doneAt = msg.t; doneText = msg.x || ''; break; }
      }
      taskId = 'k' + m.i;
      tasks.push({
        id: taskId, title: a.task.title || a.title, msg: m.i, owner,
        due: parseLocal(a.task.due), ackAt: (replies.get(m.i)[owner] || {}).at || null, doneAt,
        evidence: photos ? { photos } : doc ? { doc } : doneAt ? { reply: doneText } : null,
      });
    }
    return {
      id: m.i, at: m.t, title: a.title || (m.x || '').split('\n')[0].slice(0, 48) || 'Message',
      text: readableText(m, nameOf), kind: a.type === 'Question' ? 'Question' : 'Instruction',
      required: a.required === 'all' ? 'all' : [...x.req], priority: a.priority || 'Normal',
      task: taskId, replies: replies.get(m.i), senderName: nameOf(m.s), by: a.by || 'claude',
    };
  }).sort((a, b) => b.at - a.at);

  // 'all' must mean the people in the group now
  messages.forEach(m => { if (m.required === 'all') m.required = 'all'; });
  return { people, messages, tasks, bossMessages: msgs.filter(m => boss.has(m.s) && m.k !== 'reaction' && !m.d && m.t >= since) };
}

if (typeof module !== 'undefined') module.exports = { compactMessage, buildFromRaw, fallbackAnalysis, cleanAnalysis, analysisPrompt, parseLocal, dayKey, nameIndex };
