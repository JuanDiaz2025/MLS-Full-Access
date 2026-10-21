// One pass of the reply watch: find replies we have not seen, and say what
// should happen about each one.
//
//   node replywatch.js --state <file> [--line "Realtor"] [--days 14]
//
// Prints a single JSON object:
//   { newReplies: [...], writes: [...], alert: "<one line for a person>" }
//
// It does NOT write anything itself. The caller makes the writes — the board's
// database is reached with the Artifact tools, not from node — so this stays a
// pure read and can be run safely at any time to see what is waiting.
//
// `writes` are documents for the board's agent log (agents/<id>.log), the same
// shape rei/logtoboard.js prints. A reply whose number matches no agent on the
// board still gets a write keyed by phone: agDoc walks every id an agent has
// gone by, so the entry attaches itself the moment that agent's listing
// reaches the board. Until then it is inert rather than lost.
//
// The state file is only advanced by the CALLER, after the writes land. If
// this process dies between detecting and writing, the next run finds the same
// replies again — which is the right way round: a reply reported twice is a
// nuisance, a reply dropped is a lost deal.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const STATE = arg("--state", "");
const LINE = arg("--line", "");
const DAYS = +arg("--days", "14");
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

let since = "";
if (STATE && fs.existsSync(STATE)) {
  try { since = JSON.parse(fs.readFileSync(STATE, "utf8")).lastSeen || ""; } catch (e) {}
}

// replies.js owns the scraping and the account-timezone parsing; don't repeat
// either here. Run it WITHOUT --state so it never advances the mark itself.
const argv = [path.join(__dirname, "replies.js")];
if (LINE) argv.push("--line", LINE);
let feed;
try {
  feed = JSON.parse(execFileSync("node", argv, { encoding: "utf8", maxBuffer: 8 << 20 }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, err: "replies.js failed: " + String(e.message || e).slice(0, 200) }));
  process.exit(1);
}
if (!feed.ok) { console.log(JSON.stringify(feed)); process.exit(1); }

const floor = new Date(Date.now() - DAYS * 864e5).toISOString();
const fresh = (feed.replies || [])
  .filter(r => r.at > floor)
  .filter(r => !since || r.at > since)
  .sort((a, b) => (a.at < b.at ? 1 : -1));

// "Smith, Barton" is how the inbox prints a name; a person reads "Barton Smith".
// Either side can be empty — a contact saved with no surname comes back as
// ", Mr TEST" — so flip only when both halves have something in them.
const human = (n) => {
  const s = String(n || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^([^,]*),\s*(.*)$/);
  if (!m) return s;
  const last = m[1].trim(), first = m[2].trim();
  return (last && first ? first + " " + last : last || first);
};

const writes = fresh.map(r => ({
  collection: "agents",
  doc_id: "p-" + digits(r.from),
  entry: "text-in-" + r.at.replace(/[^0-9]/g, "").slice(0, 14),
  data: {
    name: human(r.name) || undefined,
    log: { ["text-in-" + r.at.replace(/[^0-9]/g, "").slice(0, 14)]: {
      k: "text",
      // The board shows this line as-is on the agent card, so mark the
      // direction in the text: its log has no inbound/outbound field.
      t: "Reply on " + r.line + ": " + String(r.body || "").slice(0, 240),
      by: "REI inbox",
      at: r.at
    } }
  }
}));

let alert = "";
if (fresh.length === 1) {
  const r = fresh[0];
  alert = human(r.name) + " replied on " + r.line + ": " +
          String(r.body || "").replace(/\s+/g, " ").slice(0, 110);
} else if (fresh.length > 1) {
  alert = fresh.length + " agents replied: " +
          fresh.slice(0, 3).map(r => human(r.name)).join(", ") +
          (fresh.length > 3 ? " and " + (fresh.length - 3) + " more" : "");
}

console.log(JSON.stringify({
  ok: true,
  since: since || "(no mark yet — first run)",
  scanned: feed.scanned,
  newReplies: fresh,
  writes,
  alert,
  // The caller writes this to the state file ONLY after the writes land.
  advanceTo: fresh.length ? fresh[0].at : since
}, null, 2));
