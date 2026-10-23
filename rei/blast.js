// Text a batch of listing agents, one at a time, from our own lines.
//
//   node blast.js --list agents.json [--go] [--max N] [--delay S] [--lines "A,B"]
//
// Without --go it is a DRY RUN: it prints every message it would send, in
// order, with the line and template each would use, and sends nothing. Read
// that list before you ever pass --go. A blast is the one thing here that
// cannot be taken back.
//
// agents.json is a JSON array of {contactId, name?, mls?, notes?}. contactId
// is the REI contact — the same id push-quick.js prints. Everything else the
// message needs (the agent's first name, the property address) is read back
// OUT of REI at send time by outreach.js, so a contact created wrong shows up
// instead of being papered over.
//
// WHY THIS AND NOT GOOGLE VOICE. Google bans bulk messaging on Voice and
// enforces it by taking the number, so a blast there ends with the line dead
// mid-campaign. These are our own ProfitDial lines on an account meant for
// this. --lines spreads the sending across several of them, which is the
// thing that actually keeps messages delivering: 200 texts from one number
// looks like a spammer to a carrier, 200 across ten looks like ten people.
//
// WHAT IT WILL NOT DO
//   - It will not text the same contact twice. Every send is appended to the
//     run log and a contact already in there is skipped, so re-running after
//     a stop picks up where it left off instead of starting again.
//   - It stops the moment a file named STOP appears beside the run log. No
//     signal to find, no process to kill: `touch STOP` and the current
//     message finishes and nothing else goes.
//   - It stops on the first failure rather than ploughing on, because a
//     failure usually means the session died and the rest would be silent
//     no-ops counted as sends.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const LIST = arg("--list", "");
const GO = process.argv.includes("--go");
const MAX = Number(arg("--max", "25"));
// 45 seconds is not politeness, it is deliverability: a burst from one line
// is the shape carriers filter on.
const DELAY = Number(arg("--delay", "45"));
const LINES = String(arg("--lines", "Realtor")).split(",").map((s) => s.trim()).filter(Boolean);
const TPLSET = arg("--templates", "");
const MAXCHARS = Number(arg("--maxchars", "300"));   // longer than this is a 3-segment SMS, and Voice refuses it
const RUNLOG = arg("--log", path.join(__dirname, "blast-sent.jsonl"));
const STOP = path.join(path.dirname(RUNLOG), "STOP");

const die = (err, extra) => { console.log(JSON.stringify({ ok: false, err, ...(extra || {}) }, null, 2)); process.exit(1); };
if (!LIST) die("need --list <agents.json>");
if (!Number.isFinite(MAX) || MAX < 1) die("--max must be a positive number");
if (!Number.isFinite(DELAY) || DELAY < 0) die("--delay must be a number of seconds");

let agents;
try { agents = JSON.parse(fs.readFileSync(LIST, "utf8")); }
catch (e) { die("could not read " + LIST + ": " + String(e.message || e).slice(0, 160)); }
if (!Array.isArray(agents) || !agents.length) die("--list must be a non-empty JSON array of {contactId, ...}");

// Who has already had one. The run log is the record; losing it would mean
// texting people twice, which is worse than not sending at all.
const already = new Set();
try {
  fs.readFileSync(RUNLOG, "utf8").split("\n").filter(Boolean).forEach((line) => {
    try { const r = JSON.parse(line); if (r.contactId) already.add(String(r.contactId)); } catch (e) {}
  });
} catch (e) { /* no log yet: nobody has had one */ }

const queue = agents
  .filter((a) => a && a.contactId)
  .filter((a) => !already.has(String(a.contactId)))
  .slice(0, MAX);

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Template rotation. Random per message would, by chance, leave one wording
// with twice the volume of another over a batch — the same reason the lines
// round-robin rather than draw. So the templates are DEALT: a shuffled order,
// handed out one each, reshuffled when the deck runs out. Random in order,
// even in volume, which is what makes the reply rates on the board comparable.
function tplCount(file) {
  if (!file) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const set = Array.isArray(raw) ? raw : Array.isArray(raw.templates) ? raw.templates : null;
    if (!set) return 0;
    return set.filter(function (x) { return x && typeof x.body === "string" && x.body.trim(); }).length;
  } catch (e) { return 0; }
}
function tplDeal(n, total) {
  const order = [];
  for (let i = 0; i < total; i += n || 1) {
    const deck = [];
    for (let j = 0; j < n; j++) deck.push(j);
    for (let j = deck.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      const t = deck[j]; deck[j] = deck[k]; deck[k] = t;
    }
    deck.forEach(function (d) { order.push(d); });
  }
  return order;
}

const TPLN = tplCount(TPLSET);
const TPLORDER = TPLN > 1 ? tplDeal(TPLN, queue.length) : [];

(async () => {
  const head = {
    mode: GO ? "SENDING FOR REAL" : "dry run — nothing will be sent",
    inList: agents.length, alreadyTexted: already.size, willSend: queue.length,
    cap: MAX, secondsBetween: DELAY, lines: LINES,
    templates: TPLN > 1 ? TPLN + " in rotation, dealt evenly" : TPLN === 1 ? "1 (no rotation — only one in the set)" : "none (built-in wording)",
    stopFile: STOP + "  (create it to stop after the current message)"
  };
  if (GO) {
    const mins = Math.round(queue.length * (DELAY + 75) / 60);
    head.estimatedMinutes = mins;
  }
  console.log(JSON.stringify(head, null, 2));
  if (!queue.length) { console.log(JSON.stringify({ ok: true, done: "nobody left to text" })); return; }

  const results = [];
  for (let i = 0; i < queue.length; i++) {
    if (fs.existsSync(STOP)) {
      console.log(JSON.stringify({ stopped: "STOP file found", after: i, remaining: queue.length - i }));
      break;
    }
    const a = queue[i];
    // Round-robin, not random: over a batch this spreads evenly, where random
    // would leave one line with twice the volume by chance.
    const line = LINES[i % LINES.length];
    // The address goes inside the wording, so a template that fits one agent
    // can be over the limit for the next. outreach.js refuses an over-long one
    // BEFORE it sends anything, so falling through to the next template in the
    // rotation costs a read and loses nobody. Bryan's words are never trimmed.
    const attempt = (pick) => {
      const args = [path.join(__dirname, "outreach.js"), String(a.contactId), line, String(a.by || "Bryan"),
                    "--max", String(MAXCHARS)];
      if (TPLSET) {
        args.push("--tplfile", TPLSET);
        if (TPLN > 1) args.push("--tplpick", String(pick));
      }
      if (a.dom !== undefined && a.dom !== null && a.dom !== "") args.push("--dom", String(a.dom));
      else args.push("--bom");          // unknown age asks the safe question
      if (!GO) args.push("--dry");
      try {
        const raw = execFileSync("node", args, {
          cwd: __dirname, encoding: "utf8", timeout: 240000,
          env: { ...process.env, REI_PROFILE: process.env.REI_PROFILE || path.join(__dirname, "profile") }
        });
        const j = raw.indexOf("{");
        return JSON.parse(j < 0 ? raw : raw.slice(j));
      } catch (e) {
        return { ok: false, err: String(e.message || e).slice(0, 200) };
      }
    };

    const dealt = TPLN > 1 ? TPLORDER[i] : 0;
    const picks = TPLN > 1 ? Array.from({ length: TPLN }, (_, k) => (dealt + k) % TPLN) : [0];
    let res = { ok: false, err: "nothing attempted" }, tried = [];
    for (const p of picks) {
      res = attempt(p);
      if (res.ok && !res.tooLong) break;
      if (res.tooLong) { tried.push((res.templateId || "#" + p) + " " + res.chars + " chars"); continue; }
      break;                              // a real failure, not a length one
    }

    if (res.tooLong) {
      // Too long is this agent's problem, not the batch's: skip and carry on.
      const row = { n: i + 1, of: queue.length, contactId: a.contactId, line, ok: false, skipped: true,
                    err: "every template is over " + MAXCHARS + " characters for this address (" + tried.join(", ") + ") — not sent" };
      results.push(row);
      console.log(JSON.stringify(row, null, 2));
      continue;
    }
    if (tried.length) res.switchedTemplate = "the dealt template was too long (" + tried.join(", ") + ")";

    const row = {
      n: i + 1, of: queue.length, contactId: a.contactId, line,
      name: res.capturedName, address: res.addressUsed,
      question: res.question, chars: res.chars, message: res.message,
      template: res.templateId || "", ok: !!res.ok, err: res.err
    };
    results.push(row);
    console.log(JSON.stringify(row, null, 2));

    if (!res.ok) {
      // One failure usually means the REI session is gone, and every send
      // after it would be a silent no-op recorded as a success.
      console.log(JSON.stringify({ stopped: "a send failed — stopping rather than carrying on blind", after: i + 1, remaining: queue.length - i - 1 }));
      break;
    }
    if (GO) {
      try {
        fs.appendFileSync(RUNLOG, JSON.stringify({
          at: new Date().toISOString(), contactId: a.contactId, line,
          name: res.capturedName, address: res.addressUsed, mls: a.mls || "",
          tpl: res.templateId || "", body: res.message
        }) + "\n");
      } catch (e) { console.log(JSON.stringify({ warn: "could not append to the run log — STOP NOW, a re-run would text these people twice", err: String(e.message || e).slice(0, 160) })); break; }
    }
    if (i < queue.length - 1) await sleep(GO ? DELAY : 0);
  }

  const sent = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({
    ok: true, mode: GO ? "sent" : "dry run", attempted: results.length,
    succeeded: sent, failed: results.length - sent,
    runLog: GO ? RUNLOG : "(nothing written — dry run)"
  }, null, 2));
})();
