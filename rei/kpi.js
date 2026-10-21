// Outreach KPI: what we sent, what came back, and how fast.
//
//   node kpi.js [--sent sent.jsonl] [--replies replies.json] [--line "Realtor"]
//               [--days 30] [--board <dir of agents/*.json>]
//
// Sources, and why each one:
//   --sent     the send log outreach.js appends to. REI's Outbox holds only
//              scheduled and broadcast texts, so this is the ONLY record that
//              a Chat-tab text was sent at all.
//   --replies  the JSON replies.js prints (or a saved copy of it).
//   --board    optional: documents from the board's `agents` collection, dumped
//              with ArtifactData query --out_dir. Counts what the team logged
//              by hand too, so the number matches the board rather than only
//              what this machine did.
//
// A reply is matched to a send by phone number, and only counts if it arrived
// AFTER that send — an inbound text that predates our outreach is somebody
// else's conversation, not a response to us.
//
// Reply rate is per CONTACT, not per message: texting one agent four times and
// getting one answer is one conversation that replied, not a 25% rate.
const fs = require("fs");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

const SENT = arg("--sent", __dirname + "/sent.jsonl");
const REPL = arg("--replies", "");
const BOARD = arg("--board", "");
const LINE = arg("--line", "");
const DAYS = +arg("--days", "30");
const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString();

const readJsonl = (p) => { try {
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
} catch (e) { return []; } };

let sends = readJsonl(SENT);

// The board's own agent log, if dumped. k:"text" entries the team typed by
// hand are sends too; without them the KPI only describes this machine.
if (BOARD) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(d + "/" + e.name) : e.name.endsWith(".json") ? [d + "/" + e.name] : []);
  let files = []; try { files = walk(BOARD); } catch (e) {}
  files.forEach(f => {
    let doc; try { doc = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return; }
    const d = doc.data || doc, id = doc.id || "";
    const phone = /^p-(\d+)$/.test(id) ? id.slice(2) : "";
    Object.values(d.log || {}).forEach(x => {
      if (!x || x.del || x.k !== "text" || !x.at) return;
      if (sends.some(s => s.at === x.at && digits(s.phone) === phone)) return; // already ours
      sends.push({ at: x.at, phone, name: d.name || "", by: x.by || "", body: x.t || "", line: "", fromBoard: true });
    });
  });
}

let replies = [];
if (REPL) { try {
  const j = JSON.parse(fs.readFileSync(REPL, "utf8"));
  replies = Array.isArray(j) ? j : (j.replies || []);
} catch (e) { console.error("could not read --replies " + REPL); } }

if (LINE) sends = sends.filter(s => !s.line || s.line.toLowerCase().includes(LINE.toLowerCase()));
if (LINE) replies = replies.filter(r => (r.line || "").toLowerCase().includes(LINE.toLowerCase()));
sends = sends.filter(s => s.at >= cutoff);

// group by the person we texted
const people = {};
sends.forEach(s => {
  const k = digits(s.phone); if (!k) return;
  (people[k] = people[k] || { phone: k, name: s.name || "", sends: [], replies: [] }).sends.push(s);
});
replies.forEach(r => {
  const k = digits(r.from); if (!people[k]) return;
  people[k].replies.push(r);
  if (!people[k].name && r.name) people[k].name = r.name;
});

const rows = Object.values(people).map(p => {
  p.sends.sort((a, b) => (a.at < b.at ? -1 : 1));
  const first = p.sends[0].at;
  // only replies after our first text to them count as a response to us
  const after = p.replies.filter(r => r.at > first).sort((a, b) => (a.at < b.at ? -1 : 1));
  const hrs = after.length ? (new Date(after[0].at) - new Date(first)) / 3600000 : null;
  return { phone: p.phone, name: p.name, sent: p.sends.length, replied: after.length > 0,
           replies: after.length, hoursToFirstReply: hrs === null ? null : Math.round(hrs * 10) / 10,
           lastSent: p.sends[p.sends.length - 1].at, firstReply: after.length ? after[0].at : null };
});

const replied = rows.filter(r => r.replied);
const waits = replied.map(r => r.hoursToFirstReply).filter(h => h !== null).sort((a, b) => a - b);
const median = waits.length ? (waits.length % 2 ? waits[(waits.length - 1) / 2]
                : Math.round(((waits[waits.length / 2 - 1] + waits[waits.length / 2]) / 2) * 10) / 10) : null;

// replies on a line we never texted from: someone answering a different campaign
const unmatched = replies.filter(r => !people[digits(r.from)]).length;

console.log(JSON.stringify({
  window: DAYS + " days", line: LINE || "(all)",
  contacts: rows.length,
  textsSent: sends.length,
  contactsReplied: replied.length,
  replyRatePct: rows.length ? Math.round((replied.length / rows.length) * 1000) / 10 : null,
  medianHoursToReply: median,
  repliesNotMatchedToASend: unmatched,
  awaitingReply: rows.filter(r => !r.replied).length,
  detail: rows.sort((a, b) => (a.lastSent < b.lastSent ? 1 : -1))
}, null, 2));
