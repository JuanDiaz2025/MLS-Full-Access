// Send a batch of outreach texts from Bryan's Google Voice number.
//
// This is blast.js's twin. Same shape, same brakes, one difference: the
// message leaves through Google Voice on Bryan's own machine instead of an
// REI ProfitDial line.
//
//   node gvblast.js --list agents.json [--go] [--max N] [--delay S]
//
// WHERE IT RUNS: on Bryan's machine, not in a container. gvsend.js attaches
// over CDP to a Chrome he started himself with --remote-debugging-port=9222
// and signed in to voice.google.com by hand. Nothing here ever sees a
// password, a code or a cookie, and this script never launches a browser.
//
// It CAN start a conversation with someone we have never texted: Voice's own
// deep link (?itemId=t.+1<number>) opens a new thread. That is the Voice web
// app, not the email bridge — the email bridge is the half that can only
// reply, because its token belongs to a thread that already exists.
//
// THE WORDS come from outreach.js --dry, exactly as the REI blast composes
// them: same guide, same templates, same opening question off days on market.
// Nothing about the wording changes because the pipe changed.
//
// THE BRAKES, all of them the same as blast.js:
//   - Dry run unless --go. The dry run prints every message in full.
//   - Nobody is texted twice, ON EITHER CHANNEL: the skip list is the union
//     of blast-sent.jsonl (REI) and gv-blast-sent.jsonl (Voice). An agent who
//     had an REI text does not then get a Voice one.
//   - `touch STOP` beside the run log stops it after the message in flight.
//   - The FIRST failure stops the batch. A dead Chrome or a signed-out Voice
//     would otherwise look like a hundred quiet successes.
//   - If the run log cannot be written, it stops: an unrecorded send is the
//     one that gets made twice.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const LIST = arg("--list", "");
const GO = process.argv.includes("--go");
const MAX = Number(arg("--max", "25"));
const DELAY = Number(arg("--delay", "45"));
const PORT = arg("--port", "9222");
const TPLSET = arg("--templates", "");
const RUNLOG = arg("--log", path.join(__dirname, "gv-blast-sent.jsonl"));
const REILOG = arg("--reilog", path.join(__dirname, "blast-sent.jsonl"));
const STOP = path.join(path.dirname(RUNLOG), "STOP");

const die = (err, extra) => { console.log(JSON.stringify({ ok: false, err, ...(extra || {}) }, null, 2)); process.exit(1); };

if (!LIST) die("--list is required: a JSON array of {contactId, phone, …}");
if (!Number.isFinite(MAX) || MAX < 1) die("--max must be a positive number");
if (!Number.isFinite(DELAY) || DELAY < 0) die("--delay must be a number of seconds");

let agents;
try { agents = JSON.parse(fs.readFileSync(LIST, "utf8")); }
catch (e) { die("could not read " + LIST + ": " + String(e.message || e).slice(0, 160)); }
if (!Array.isArray(agents) || !agents.length) die("--list must be a non-empty JSON array of {contactId, phone, …}");

const tenDigit = (v) => String(v == null ? "" : v).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

// Who has already had one, from BOTH channels. Losing this would mean texting
// people twice, which is worse than not sending at all.
const already = new Set();
[REILOG, RUNLOG].forEach((f) => {
  try {
    fs.readFileSync(f, "utf8").split("\n").filter(Boolean).forEach((line) => {
      try {
        const r = JSON.parse(line);
        if (r.contactId) already.add("c:" + String(r.contactId));
        const p = tenDigit(r.phone || r.to);
        if (p.length === 10) already.add("p:" + p);
      } catch (e) {}
    });
  } catch (e) { /* no log yet: nobody has had one */ }
});

const seen = (a) => already.has("c:" + String(a.contactId)) || already.has("p:" + tenDigit(a.phone));

const queue = agents
  .filter((a) => a && a.contactId)
  .filter((a) => !seen(a))
  .slice(0, MAX);

// A number we cannot dial is not a send we can make. Say which ones before
// starting rather than failing one at a time halfway down the batch.
const noPhone = queue.filter((a) => tenDigit(a.phone).length !== 10)
  .map((a) => ({ contactId: a.contactId, name: a.name || "", phone: a.phone || "(none)" }));

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

(async () => {
  const head = {
    mode: GO ? "SENDING FOR REAL" : "dry run — nothing will be sent",
    from: "Google Voice, via Chrome on this machine (port " + PORT + ")",
    inList: agents.length, alreadyTexted: already.size, willSend: queue.length - noPhone.length,
    cap: MAX, secondsBetween: DELAY,
    stopFile: STOP + "  (create it to stop after the current message)"
  };
  if (noPhone.length) head.skippedNoPhone = noPhone;
  if (GO) head.estimatedMinutes = Math.round((queue.length - noPhone.length) * (DELAY + 40) / 60);
  console.log(JSON.stringify(head, null, 2));
  if (!queue.length) { console.log(JSON.stringify({ ok: true, done: "nobody left to text" })); return; }

  const results = [];
  for (let i = 0; i < queue.length; i++) {
    if (fs.existsSync(STOP)) {
      console.log(JSON.stringify({ stopped: "STOP file found", after: i, remaining: queue.length - i }));
      break;
    }
    const a = queue[i];
    const phone = tenDigit(a.phone);
    if (phone.length !== 10) continue;   // already reported in skippedNoPhone

    // 1. The words. outreach.js composes them and sends nothing: --dry.
    const oArgs = [path.join(__dirname, "outreach.js"), String(a.contactId),
                   "Google Voice", String(a.by || "Bryan"), "--dry"];
    if (TPLSET) oArgs.push("--tplfile", TPLSET);
    if (a.dom !== undefined && a.dom !== null && a.dom !== "") oArgs.push("--dom", String(a.dom));
    else oArgs.push("--bom");            // unknown age asks the safe question

    let msg;
    try {
      const raw = execFileSync("node", oArgs, {
        cwd: __dirname, encoding: "utf8", timeout: 240000,
        env: { ...process.env, REI_PROFILE: process.env.REI_PROFILE || path.join(__dirname, "profile") }
      });
      const j = raw.indexOf("{");
      msg = JSON.parse(j < 0 ? raw : raw.slice(j));
    } catch (e) {
      msg = { ok: false, err: String(e.message || e).slice(0, 200) };
    }
    if (!msg.ok || !msg.message) {
      const row = { n: i + 1, of: queue.length, contactId: a.contactId, phone, ok: false,
                    err: "could not compose the message: " + (msg.err || "no text came back") };
      results.push(row);
      console.log(JSON.stringify(row, null, 2));
      console.log(JSON.stringify({ stopped: "could not compose — stopping rather than carrying on blind", after: i + 1, remaining: queue.length - i - 1 }));
      break;
    }

    // 2. The pipe. gvsend.js is the proven one: it attaches, opens the
    //    thread by deep link, types, and confirms the words landed.
    const sArgs = [path.join(__dirname, "gvsend.js"), "--to", phone, "--text", msg.message, "--port", PORT];
    if (GO) sArgs.push("--go");

    let res;
    try {
      const raw = execFileSync("node", sArgs, { cwd: __dirname, encoding: "utf8", timeout: 240000 });
      const j = raw.indexOf("{");
      res = JSON.parse(j < 0 ? raw : raw.slice(j));
      if (res.ok === undefined) res.ok = true;   // gvsend prints its report on success
    } catch (e) {
      res = { ok: false, err: String(e.message || e).slice(0, 300) };
    }

    const row = {
      n: i + 1, of: queue.length, contactId: a.contactId, phone,
      name: msg.capturedName, address: msg.addressUsed, question: msg.question,
      chars: msg.chars, message: msg.message, ok: !!res.ok, err: res.err
    };
    results.push(row);
    console.log(JSON.stringify(row, null, 2));

    if (!res.ok) {
      // One failure usually means Chrome died or Voice signed out, and every
      // send after it would be a silent no-op recorded as a success.
      console.log(JSON.stringify({ stopped: "a send failed — stopping rather than carrying on blind", after: i + 1, remaining: queue.length - i - 1 }));
      break;
    }
    if (GO) {
      try {
        fs.appendFileSync(RUNLOG, JSON.stringify({
          at: new Date().toISOString(), contactId: a.contactId, phone, line: "Google Voice",
          name: msg.capturedName, address: msg.addressUsed, mls: a.mls || "",
          tpl: msg.templateId || "", body: msg.message
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
