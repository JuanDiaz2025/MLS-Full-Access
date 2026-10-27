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
// When WhatsApp tags someone by their hidden id, the text holds that hidden
// number instead of the phone number the reader saved; the tags are listed in
// the order they appear, so the @numbers left over are those people, in order.
function readableText(m, nameOf) {
  let x = m.x || '';
  const left = [];
  (m.m || []).forEach(id => {
    const digits = String(id).replace('@lid', '');
    if (x.includes('@' + digits)) x = x.split('@' + digits).join('@' + nameOf(id));
    else left.push(id);
  });
  let k = 0;
  if (left.length) x = x.replace(/@\d{6,}/g, tag => k < left.length ? '@' + nameOf(left[k++]) : tag);
  return x;
}

function replyText(m, nameOf) {
  if (m.k === 'reaction') return m.x || '';
  const label = KIND_LABEL[m.k];
  const text = readableText(m, nameOf);
  if (label) return text ? `${label}: ${text}` : label;
  return text;
}

const ANALYSIS_VERSION = 6; // 2: also spots messages that chase an earlier request. 3: givers can ask each other. 4: questions anyone can answer. 5: sees what everyone said around it. 6: told who was tagged

// Whether Claude should read an instruction again. Version 6 only changed
// messages that tag someone, so the others read at version 5 are kept.
function needsReading(a, m) {
  if (!a || a.by === 'rules') return true;
  if ((a.v || 0) < 5) return true;
  return (a.v || 0) < ANALYSIS_VERSION && !!(m.m && m.m.length);
}

const ANYONE_RE = /^\s*(who|who's|whos|sino|anyone|anybody|does anyone|did anyone|has anyone|is anyone|can anyone|may nakakaalam)\b/i;

// Used when Claude isn't available to read a message.
// senderOf: instruction id -> who sent it, for spotting a nudge on your own request.
function fallbackAnalysis(m, people, senderOf) {
  const text = (m.x || '').trim();
  const ids = new Set(people.map(p => p.id));
  const named = (m.m || []).filter(id => ids.has(id) && id !== m.s);
  const chatter = /^(thanks|thank you|thx|ok|okay|good morning|good night|gracias|buenos dias)\b[\s!.]*$/i.test(text) || /^\p{Extended_Pictographic}+$/u.test(text);
  return {
    title: text.split('\n')[0].slice(0, 48) || 'Message',
    type: text.includes('?') ? 'Question' : 'Instruction',
    needs_reply: !chatter && text.length > 0,
    // "who is tracking this?" needs one answer, not one from everybody
    required: named.length ? named : ANYONE_RE.test(text) ? 'any' : 'all',
    priority: /\b(urgent|asap|important|now|today)\b/i.test(text) ? 'High' : 'Normal',
    task: null,
    // quoting your own earlier message is a nudge on it
    follow_up_of: m.q && senderOf && senderOf.get(m.q) === m.s ? m.q : null,
    by: 'rules', v: ANALYSIS_VERSION,
  };
}

// context: the managers' earlier messages (oldest first), so Claude can tell
// a nudge on an earlier request from a new one. batch: the ones to read now.
// around: what anyone else said just before and between them, so "what is
// this?" after Cherry sent something is read as a question for Cherry.
// byId: every message by id, to show the text of a quoted message.
function analysisPrompt(batch, context, people, bossNames, nameOf, around, byId) {
  const members = people.map(p => `${p.id}: ${p.name}${p.giver ? ' (manager)' : ''}`).join('\n');
  const show = m => {
    const o = { id: m.i, from: nameOf(m.s), sent: localStamp(m.t), text: readableText(m, nameOf) };
    // who was tagged, by member id
    if (m.m && m.m.length) o.tagged = m.m.map(String);
    if (m.q) {
      o.replying_to = m.q;
      const q = byId && byId.get(m.q);
      if (q) o.replying_to_message = { from: nameOf(q.s), text: replyText(q, nameOf).slice(0, 300) };
    }
    return o;
  };
  const near = (around || []).map(m => ({ id: m.i, from: nameOf(m.s), sent: localStamp(m.t), text: replyText(m, nameOf).slice(0, 300) }));
  return `You read messages the managers posted in a WhatsApp work group, so a dashboard can track who has to reply.

Managers: ${bossNames.join(', ')}
Group members who may need to reply (id: name):
${members}

For each message under "Messages to read", return JSON in exactly this shape:
{"results":[{"id":"<message id>","title":"<3 to 6 word summary>","type":"Instruction" or "Question" or "Info","needs_reply":true or false,"required":"all" or "any" or ["<member id>"],"priority":"High" or "Normal","task":null or {"title":"<short task name>","owner_id":"<member id>","due":"YYYY-MM-DDTHH:MM" or null},"follow_up_of":null or "<id of an earlier manager message>"}]}

Rules:
- needs_reply is true when the message asks people to do, confirm or answer something. Greetings, thanks and plain announcements are "Info" with needs_reply false.
- "tagged" lists the member ids the message @mentions. A message that tags people is for them: list those ids, unless it plainly asks the whole group.
- Read each message in its place in the conversation. When it reacts to something a member just said or sent ("what is this?", "what does that mean?", "send it again", "which one?"), or quotes a member's message, it is for that member: list their id, even with no name or @mention.
- required is "all" when every member of the group has to respond, for example "everyone confirm you saw the schedule". It is "any" when one answer from anyone settles it, for example "who is tracking this order?", "who has the key?", "anyone know where the ladder is?", "who can cover Saturday?". Otherwise list the ids of the people it addresses by name or @mention, which can include another manager (for example the COO asking the CEO). Never list the person who sent it ("from"). Use only ids from the member list.
- task is set only when a specific member is asked to complete a piece of work. owner_id is that member. due is the deadline written in the same local time as "sent", or null when no deadline is given.
- priority is "High" only when the message says it is urgent or important, or the work is due the same day.
- follow_up_of is set when the sender is chasing or repeating their OWN earlier request because nobody answered ("can you confirm this???", "hello?", "what's happening?", "can anyone see this?") and the message asks for nothing new. Give the id of that earlier request (same "from"), from either list. If the message also asks for something new, it is a new request: follow_up_of is null. A manager answering or quoting another manager's message is never a follow-up. "replying_to" means the sender quoted that earlier message.

${near.length ? `What everyone said around these, in order, for context only:\n${JSON.stringify(near)}\n\n` : ''}Earlier messages from the managers, for context only:
${JSON.stringify(context.map(show))}

Messages to read:
${JSON.stringify(batch.map(show))}`;
}

// earlier: earlier instruction id -> who sent it. sender: who sent this one.
function cleanAnalysis(a, people, earlier, sender) {
  const ids = new Set(people.map(p => p.id));
  ids.delete(sender);
  if (!a || typeof a !== 'object') return null;
  const out = {
    title: String(a.title || '').slice(0, 60),
    type: ['Instruction', 'Question', 'Info'].includes(a.type) ? a.type : 'Instruction',
    needs_reply: a.needs_reply !== false,
    required: Array.isArray(a.required) ? a.required.map(String).filter(id => ids.has(id)) : a.required === 'any' ? 'any' : 'all',
    priority: a.priority === 'High' ? 'High' : 'Normal',
    task: null,
    follow_up_of: a.follow_up_of && earlier && earlier.get(String(a.follow_up_of)) === sender ? String(a.follow_up_of) : null,
    by: 'claude', v: ANALYSIS_VERSION,
  };
  if (Array.isArray(out.required) && !out.required.length) out.required = 'all';
  if (a.task && ids.has(String(a.task.owner_id))) {
    out.task = { title: String(a.task.title || out.title).slice(0, 60), owner_id: String(a.task.owner_id), due: typeof a.task.due === 'string' ? a.task.due : null };
  }
  return out;
}

const NOT_A_REPLY = new Set(['reaction', 'joined', 'left']);

// Claude reads plain replies (not swipe-replies or reactions) from the last
// week to say which request each one answers, and whether the sender took on
// the work. Older ones, or any Claude hasn't read yet, use the simple rules.
const REPLY_VERSION = 1;
const JUDGE_DAYS = 7;
const JUDGE_LOOKBACK = 3 * 24 * 60 * 60000; // only requests from the 3 days before a reply

function replyPrompt(requests, items, people, bossNames) {
  const members = people.map(p => `${p.id}: ${p.name}${p.giver ? ' (manager)' : ''}`).join('\n');
  return `You read replies in a WhatsApp work group, so a dashboard can tell who actually answered which request.

Managers: ${bossNames.join(', ')}
Group members (id: name):
${members}

Open requests from the managers:
${JSON.stringify(requests)}

Messages sent after them, in order. "could_answer" lists the requests each one might be answering:
${JSON.stringify(items)}

For every message, return JSON in exactly this shape:
{"results":[{"id":"<message id>","answers":["<request id>"],"takes_task":null or {"request":"<request id>","title":"<short task name>"},"why":"<6 to 12 words>"}]}

Rules:
- answers lists the requests this message actually responds to, chosen only from its "could_answer". A short acknowledgement ("noted", "noted po", "copy", "ok", "on it", a thumbs up) answers the latest of them that asked the sender for something. A message about something else answers nothing, even if it comes right after a request.
- takes_task is set when the sender says they own or will do the work ("I'm the one tracking it", "ako na po", "I'll handle it"). request is the request it belongs to, from "could_answer". title is the work in a few words.
- The messages may be in English, Tagalog or Taglish.
- why says in plain words why you decided, for a manager reading the dashboard.
- Return JSON only.`;
}

// allowed: message id -> the request ids it could answer
function cleanReply(r, allowed) {
  if (!r || typeof r !== 'object' || !allowed) return null;
  const ok = new Set(allowed);
  const answers = (Array.isArray(r.answers) ? r.answers : []).map(String).filter(id => ok.has(id));
  const t = r.takes_task;
  const task = t && typeof t === 'object' && ok.has(String(t.request)) && String(t.title || '').trim()
    ? { request: String(t.request), title: String(t.title).trim().slice(0, 60) } : null;
  return { answers: [...new Set(answers)], task, why: String(r.why || '').slice(0, 120), by: 'claude', v: REPLY_VERSION };
}

// raw: { participants, members, names, bossIds, messages (compact), analysis, overrides, group, fixes, removed }
// removed: request id -> who deleted it from the dashboard
// fixes: replies linked by hand on the dashboard, "<request id>~<person id>" -> { msg, at, text, by, on, group }
// members: { id: { firstSeen, leftAt } } kept by the dashboard. Someone is only
// expected to answer messages sent while they were in the group.
function buildFromRaw(raw, now) {
  const nameOf = nameIndex(raw);
  const boss = new Set(raw.bossIds || []);
  const members = raw.members || {};
  const current = new Set((raw.participants || []).map(p => p.id));
  // Instruction-givers are people too: "everyone" leaves them out, but one
  // giver can ask another by name and is then waited on like anyone else.
  const ids = new Set([...current, ...Object.keys(members)]);
  const people = [...ids].map(id => ({ id, name: nameOf(id), former: !current.has(id), giver: boss.has(id) }));
  const pset = new Set(people.map(p => p.id));
  const team = people.filter(p => !p.giver).map(p => p.id);
  const inGroup = (id, t) => {
    const m = members[id];
    if (!m) return current.has(id);
    return (m.firstSeen || 0) <= t && !(m.leftAt && m.leftAt <= t);
  };
  const since = now - WINDOW_DAYS * 24 * 60 * 60000;
  const msgs = (raw.messages || []).filter(m => m.t <= now).sort((a, b) => a.t - b.t);
  const bossMessages = msgs.filter(m => boss.has(m.s) && !NOT_A_REPLY.has(m.k) && !m.d && m.t >= since);
  const senderOf = new Map(bossMessages.map(m => [m.i, m.s]));
  const analysisOf = m => (raw.analysis || {})[m.i] || fallbackAnalysis(m, people, senderOf);

  // Requests, and the nudges that chase them
  const tracked = [];
  const trackedById = new Map();
  const rootOf = new Map(); // message id (request or nudge) -> request
  bossMessages.forEach(m => {
    const a = analysisOf(m);
    const root = a.follow_up_of && rootOf.get(a.follow_up_of);
    if (root && m.t > root.m.t && root.m.s === m.s) {
      root.chases.push({ id: m.i, at: m.t, text: readableText(m, nameOf) });
      rootOf.set(m.i, root);
      return;
    }
    if (!a.needs_reply) return;
    let req = a.required === 'all' || a.required === 'any' ? team : a.required.filter(id => pset.has(id));
    if (a.task && pset.has(a.task.owner_id) && !req.includes(a.task.owner_id)) req = req.concat(a.task.owner_id);
    req = req.filter(id => id !== m.s && inGroup(id, m.t));
    if (!req.length) return;
    const x = { m, a, req: new Set(req), chases: [], replies: {}, sure: new Set(), anyone: a.required === 'any' };
    tracked.push(x); trackedById.set(m.i, x); rootOf.set(m.i, x);
  });
  const setReply = (x, pid, at, text, extra) => { if (!x.replies[pid]) x.replies[pid] = { at, text, ...extra }; };
  // a quote, a reaction or Claude's reading is sure; the plain-message rule is a guess
  const setSure = (x, pid, at, text, extra) => { setReply(x, pid, at, text, extra); x.sure.add(pid); };
  const judged = raw.replies || {};
  const judgeSince = now - JUDGE_DAYS * 24 * 60 * 60000;
  const unjudged = []; // plain replies Claude should read: { m, requests: [request ids] }
  const claims = []; // someone said the work is theirs: { x, pid, msg, title }

  // Who acknowledged what: a quoted reply or a reaction answers that request
  // (a nudge counts as its request); any other message answers everything
  // still open before it. A question anyone can answer is stricter: a plain
  // message only answers it while it is still the latest request, since one
  // answer closes it for everybody.
  const newerRequest = (x, t) => tracked.some(y => y !== x && y.m.t > x.m.t && y.m.t < t);
  msgs.forEach(msg => {
    const pid = msg.s;
    if (!pset.has(pid) || msg.k === 'joined' || msg.k === 'left') return;
    if (msg.k === 'reaction') {
      const x = rootOf.get(msg.r);
      if (x && x.req.has(pid) && msg.t >= x.m.t) setSure(x, pid, msg.t, msg.x || '');
      return;
    }
    const text = replyText(msg, nameOf);
    const quoted = msg.q && rootOf.get(msg.q);
    if (quoted) { if (quoted.req.has(pid) && msg.t >= quoted.m.t) setSure(quoted, pid, msg.t, text); return; }
    const fallback = () => tracked.forEach(x => { if (x.m.t < msg.t && x.req.has(pid) && !(x.anyone && newerRequest(x, msg.t))) setReply(x, pid, msg.t, text); });
    if (rootOf.has(msg.i)) { fallback(); return; } // a request or nudge of its own: not something Claude reads as a reply
    const j = judged[msg.i] && judged[msg.i].v === REPLY_VERSION ? judged[msg.i] : null;
    if (j && !Array.isArray(j.answers)) { fallback(); return; } // Claude couldn't tell
    if (j) {
      (j.answers || []).forEach(id => { const x = rootOf.get(id); if (x && x.m.t < msg.t && x.req.has(pid)) setSure(x, pid, msg.t, text, { why: j.why }); });
      const x = j.task && rootOf.get(j.task.request);
      if (x && x.m.t < msg.t) claims.push({ x, pid, msg, title: j.task.title });
      return;
    }
    // not read by Claude: queue it if it could answer something recent, and use the rules meanwhile
    const could = tracked.filter(x => x.m.t < msg.t && x.m.t >= msg.t - JUDGE_LOOKBACK && x.req.has(pid) && !x.sure.has(pid) && !(x.anyone && x.sure.size));
    if (could.length && msg.t >= judgeSince && msg.k !== 'sticker') unjudged.push({ m: msg, requests: could.slice(-6).map(x => x.m.i) });
    fallback();
  });

  // A reply someone linked by hand: one of the person's own messages that the
  // rules above counted somewhere else. It counts from when it was sent.
  const fixes = raw.fixes || {};
  const byId = new Map(msgs.map(x => [x.i, x]));
  tracked.forEach(x => x.req.forEach(pid => {
    const f = fixes[`${x.m.i}~${pid}`];
    if (!f || !Number.isFinite(f.at)) return;
    const own = byId.get(f.msg);
    if (own && own.s !== pid) return; // only the person's own message can answer for them
    const at = Math.max(f.at, x.m.t);
    const r = x.replies[pid];
    // on a question anyone can answer, a hand-picked answer always wins
    if (!r || at < r.at || x.anyone) x.replies[pid] = { at, text: f.text || '', linked: { by: f.by || null, on: f.on || null, msg: f.msg, group: f.group || null } };
  }));

  // A question anyone can answer is settled by the first answer, or by the
  // one someone linked by hand. Only that person counts; nobody else owes a
  // reply, before or after.
  tracked.forEach(x => {
    if (!x.anyone) return;
    const all = Object.entries(x.replies);
    const byHand = all.filter(([, r]) => r.linked).sort((a, b) => (b[1].linked.on || 0) - (a[1].linked.on || 0))[0];
    const first = byHand || all.sort((a, b) => a[1].at - b[1].at)[0];
    x.replies = first ? { [first[0]]: first[1] } : {};
    x.req = new Set(first ? [first[0]] : []);
  });

  // Someone who left without answering is no longer waited on; it counts as
  // a late answer at the moment they left.
  tracked.forEach(x => x.req.forEach(pid => {
    const left = members[pid] && members[pid].leftAt;
    if (left && left > x.m.t && !x.replies[pid]) setReply(x, pid, left, 'Left the group', { left: true });
  }));

  // Requests an editor deleted from the dashboard drop out here, with their
  // nudges, replies and task.
  const removed = raw.removed || {};
  const shown = tracked.filter(x => !removed[x.m.i]);

  // How often each person had to be chased: every nudge counts against the
  // people who still hadn't answered when it was sent.
  const chased = {};
  shown.forEach(x => x.chases.forEach(c => x.req.forEach(pid => {
    const r = x.replies[pid];
    if (!r || r.at > c.at) chased[pid] = (chased[pid] || 0) + 1;
  })));
  people.forEach(p => { p.chased = chased[p.id] || 0; });

  // When the owner delivered: a photo, video or document, or a "done" message,
  // that isn't about a different request.
  const delivered = (x, owner, after) => {
    let doneAt = null, photos = 0, doc = null, doneText = '';
    for (const msg of msgs) {
      if (msg.s !== owner || msg.t <= after || NOT_A_REPLY.has(msg.k)) continue;
      const about = msg.q && rootOf.get(msg.q);
      if (about && about !== x) continue;
      if (msg.k === 'image' || msg.k === 'video') photos++;
      if (msg.k === 'document' && !doc) doc = (msg.x || 'Document').split('\n')[0];
      if (msg.k === 'image' || msg.k === 'video' || msg.k === 'document' || DONE_RE.test(msg.x || '')) { doneAt = msg.t; doneText = msg.x || ''; break; }
    }
    return { doneAt, evidence: photos ? { photos } : doc ? { doc } : doneAt ? { reply: doneText } : null };
  };

  const tasks = [];
  const messages = shown.map(x => {
    const { m, a } = x;
    let taskId = null;
    if (a.task && pset.has(a.task.owner_id) && x.req.has(a.task.owner_id)) {
      const owner = a.task.owner_id;
      const d = delivered(x, owner, m.t);
      taskId = 'k' + m.i;
      tasks.push({ id: taskId, title: a.task.title || a.title, msg: m.i, owner, due: parseLocal(a.task.due), ackAt: (x.replies[owner] || {}).at || null, ...d });
    }
    // work someone took on in a reply ("I'm the one tracking it"), unless it is already theirs
    claims.filter(c => c.x === x && !(a.task && a.task.owner_id === c.pid)).forEach(c => {
      if (tasks.some(t => t.msg === m.i && t.owner === c.pid)) return;
      const id = 'c' + c.msg.i;
      tasks.push({ id, title: c.title, msg: m.i, owner: c.pid, due: null, ackAt: c.msg.t, claimed: true, ...delivered(x, c.pid, c.msg.t) });
      if (!taskId) taskId = id;
    });
    return {
      id: m.i, at: m.t, title: a.title || (m.x || '').split('\n')[0].slice(0, 48) || 'Message',
      text: readableText(m, nameOf), kind: a.type === 'Question' ? 'Question' : 'Instruction',
      required: [...x.req], everyone: a.required === 'all', anyone: x.anyone, priority: a.priority || 'Normal',
      task: taskId, replies: x.replies, senderId: m.s, senderName: nameOf(m.s), by: a.by || 'claude', chases: x.chases,
    };
  }).sort((a, b) => b.at - a.at);

  return { people, messages, tasks, bossMessages, unjudged };
}

// Keeps track of who has been in the group and when, from one read of the
// member list to the next. A new face is assumed to have joined just after
// the previous read; someone missing is assumed to have left just after it.
function updateMembers(prev, participants, lastRead, now) {
  const out = {};
  const first = !prev || !Object.keys(prev).length;
  const seen = new Set(participants.map(p => p.id));
  Object.entries(prev || {}).forEach(([id, m]) => { out[id] = { ...m }; });
  participants.forEach(p => {
    const m = out[p.id];
    if (!m) out[p.id] = { firstSeen: first ? 0 : (lastRead || now) };
    else if (m.leftAt) out[p.id] = { firstSeen: lastRead || now };
  });
  Object.entries(out).forEach(([id, m]) => {
    if (!seen.has(id) && !m.leftAt) m.leftAt = lastRead || now;
  });
  return out;
}

if (typeof module !== 'undefined') module.exports = { compactMessage, buildFromRaw, fallbackAnalysis, cleanAnalysis, analysisPrompt, needsReading, replyPrompt, cleanReply, parseLocal, dayKey, nameIndex, updateMembers, localStamp, readableText, replyText, ANALYSIS_VERSION, REPLY_VERSION };
