// Turn the Google Voice feed in Bryan's Gmail into board writes and an alert.
//
// Voice forwards every text to bryan@twinhomebuyer.com, and three different
// kinds of thing arrive down that pipe. They are NOT the same and must not be
// logged the same way:
//
//  1. REI BlackBook's own notification line, (855) 250-5241, saying
//       "Text Received on Profit Dial # (510) 800-1607 from (925) 997-1493"
//     This is REI telling us somebody replied. It carries no words, only the
//     fact and the two numbers — but it arrives in SECONDS and needs no
//     browser. That matters: until now the only way to know an agent had
//     written back was a signed-in REI page in this container. This is a
//     second, independent nerve.
//  2. The same line saying "Please CALL the PPC Lead asap!!" with a REI
//     contact link. A new PPC lead, not an agent reply.
//  3. A REAL conversation on Bryan's own Voice number — actual words from an
//     actual person. These are the only ones with text worth logging.
//
// Why a script and not a one-liner: the loop reads Gmail through a connector
// and pastes the JSON here. Parsing is the part that must be identical every
// time, so it lives in a file with tests rather than in a prompt.
//
//   node gvparse.js --file <gmail-threads.json> [--since <ISO>]
//
// Prints {kinds, alerts, writes, advanceTo}. Writes nothing itself — the
// caller applies `writes`, exactly like replywatch.
const fs = require("fs");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const pretty = (d) => d.length === 10 ? "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6) : d;

// The From address is the whole routing table:
//   1<Bryan's Voice number>.1<the other party>.<token>@txt.voice.google.com
// HIS NUMBER COMES FIRST. I had these the other way round and every REI
// notification was mis-read as an ordinary text from himself — caught only by
// running it against real mail, where all 13 threads start 15103945339.
// Reading this address is how we know which conversation a message belongs
// to without trusting the subject line.
const VOICE_FROM = /^1?(\d{10,11})\.1?(\d{10,11})\.([A-Za-z0-9]+)@txt\.voice\.google\.com$/;
const REI_LINE = "8552505241";

// REI's two notification shapes. Anchored on REI's own wording; if REI changes
// it, these stop matching and the message falls through to kind "other"
// rather than being silently mis-parsed as something it is not.
const RE_INBOUND = /Text Received on Profit Dial #\s*([\d()\s-]{10,16})\s*from\s*([\d()\s-]{10,16})/i;
// Anything that smells like a one-time code or a password is dropped on the
// floor rather than logged. Deliberately broad: a false positive costs one
// uninteresting text, a false negative publishes a credential.
const SECRET = /\b(verification|security|one[- ]?time|login|auth(?:entication)?)\s+code\b|\bOTP\b|\bpassword\b|\b2FA\b|\bG-\d{6}\b/i;
const RE_PPCLEAD = /Please CALL the PPC Lead asap!!\s*([^\n]*?)\s*(?:Here is the REI Link:\s*(\S+))?$/im;

function classify(msg) {
  const m = VOICE_FROM.exec(String(msg.sender || "").trim());
  if (!m) return { kind: "not-voice" };
  const mine = digits(m[1]), other = digits(m[2]);
  // Google's own footer is on every one of these and is not content.
  const body = String(msg.snippet || msg.plaintextBody || "")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/^\s*Google Voice\s*/i, "")
    .replace(/\s*(YOUR ACCOUNT|To respond to this text message)[\s\S]*$/i, "")
    .trim();

  if (other === REI_LINE) {
    const inb = RE_INBOUND.exec(body);
    if (inb) return { kind: "rei-inbound", line: digits(inb[1]), from: digits(inb[2]), at: msg.date, body };
    const ppc = RE_PPCLEAD.exec(body);
    if (ppc) return { kind: "rei-ppc", who: (ppc[1] || "").trim(), link: ppc[2] || "", at: msg.date, body };
    return { kind: "rei-other", at: msg.date, body };
  }
  return { kind: "text", other, mine, at: msg.date, body };
}

const raw = JSON.parse(fs.readFileSync(arg("--file", ""), "utf8"));
const since = arg("--since", "");
const msgs = [];
(raw.threads || []).forEach((t) => (t.messages || []).forEach((m) => msgs.push(m)));

const out = { scanned: msgs.length, kinds: {}, alerts: [], writes: [], advanceTo: since };
let newest = since;

msgs.forEach((msg) => {
  // A message Bryan sent is our own outbound; never treat it as a reply.
  if ((msg.labelIds || []).includes("SENT")) { out.kinds.sent = (out.kinds.sent || 0) + 1; return; }
  const c = classify(msg);
  out.kinds[c.kind] = (out.kinds[c.kind] || 0) + 1;
  if (c.kind === "not-voice") return;
  if (since && !(String(msg.date) > since)) return;
  if (String(msg.date) > String(newest || "")) newest = String(msg.date);

  if (c.kind === "rei-inbound") {
    out.alerts.push(pretty(c.from) + " texted our " + pretty(c.line) + " line");
    // No words in this notification, so log the FACT and say where the words
    // are. A log entry that invents content would be worse than none.
    out.writes.push({ collection: "agents", doc_id: "p-" + c.from, data: { log: {
      ["text-" + String(c.at).replace(/[^0-9]/g, "").slice(0, 14)]: {
        k: "text", dir: "in", by: "Google Voice", at: c.at,
        t: "Replied to our " + pretty(c.line) + " line (via Voice→Gmail; words are in REI)" } } } });
  } else if (c.kind === "rei-ppc") {
    out.alerts.push("New PPC lead" + (c.who ? ": " + c.who : "") + (c.link ? " " + c.link : ""));
  } else if (c.kind === "text" && SECRET.test(c.body)) {
    // A one-time code landed in the feed during testing — JustCall's, forwarded
    // to his Voice number like everything else. The board log is shared with
    // the whole team, so a code written there is a credential published. Count
    // it, never log it, never put it in an alert, never echo the digits.
    out.kinds.secret = (out.kinds.secret || 0) + 1;
  } else if (c.kind === "text" && c.body) {
    out.alerts.push(pretty(c.other) + ": " + c.body.slice(0, 120));
    out.writes.push({ collection: "agents", doc_id: "p-" + c.other, data: { log: {
      ["text-" + String(c.at).replace(/[^0-9]/g, "").slice(0, 14)]: {
        k: "text", dir: "in", by: "Google Voice " + pretty(c.mine), at: c.at, t: c.body.slice(0, 300) } } } });
  }
});

out.advanceTo = newest || since;
console.log(JSON.stringify(out, null, 2));
