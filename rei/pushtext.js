// Send the outreach text straight after a Push to REI, with no human step.
//
//   node pushtext.js --file <q-MLS.json> --id <contactId> --by "<pusher>" [--dry]
//
// Everything the text needs is already somewhere; this script's whole job is
// to get it from there to outreach.js without a person retyping it:
//
//   [Agent Name]       outreach.js reads it off the REI contact (first name)
//   [Property Address] outreach.js reads it off the REI contact too
//   [Name]             --by, the person who pressed Push to REI, first name
//   the question       from the listing's age, parsed out of the queue notes
//
// Reading the name and address back OUT of REI rather than passing them in is
// deliberate: if the contact was created wrong, the text says so out loud
// instead of quietly papering over it.
//
// The queue document's notes line looks like
//   "$875,000 · $468/sqft · 1,870 sqft · 4 bd · built 1931 · 26 DOM"
// so the days on market are in there when the scan recorded them — about two
// thirds of the time. See NO DOM below for the third where they are not.
const { execFileSync } = require("child_process");
const fs = require("fs");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const FILE = arg("--file", ""), ID = arg("--id", ""), BY = arg("--by", "");
const DRY = process.argv.includes("--dry");
const LINE = arg("--line", "Realtor");
const TEXT = arg("--text", "1");
const TPLFILE = arg("--template", "");
// --templates is the whole set from the board, and one is picked at RANDOM
// per lead. That is what makes the reply rates on the Text Templates screen
// mean anything: if a person chose the wording each time they would hand the
// better leads to their favourite, and the winner would be the chooser, not
// the sentence. Random assignment is the only way the comparison is fair.
const TPLSET = arg("--templates", "");

const die = (err, extra) => { console.log(JSON.stringify({ ok: false, err, ...(extra || {}) })); process.exit(0); };
if (!FILE || !ID) die("need --file <queue json> and --id <contactId>");

let q;
try { q = JSON.parse(fs.readFileSync(FILE, "utf8")); }
catch (e) { die("could not read " + FILE + ": " + String(e.message || e)); }

const notes = String(q.notes || "");
// "Gen" from "Gen", "Bryan" from "Bryan Cadahing" — the text says a person's
// name, not a full legal one.
// push-quick's queue file has no `by` field of its own — the pusher's name is
// written into the notes as "Pushed by Gen", so read it from there when --by
// is not given, and the file alone is enough.
const sender = String(BY || q.by || (notes.match(/Pushed by\s+(.+)/) || [])[1] || "")
  .replace(/^Pushed by\s+/i, "").trim().split(/\s+/)[0];
if (!sender) die("no sender name — pass --by", { file: FILE });

// A contact with only an email cannot be texted. Say so rather than driving
// the Chat tab at a contact with no number and calling the silence a send.
if (!String(q.phone || "").trim()) {
  die("no phone on this lead — email only, so there is nothing to text", {
    mls: q.mls || "", contactId: ID, skipped: true
  });
}

// The guide: 0-7 days asks "When are you reviewing offers?"; 8+ days, a price
// cut or back on market asks "Is it still available?".
const dom = (notes.match(/(\d+)\s*DOM\b/) || [])[1];
const cut = /price cut/i.test(notes);
const bom = /back on market/i.test(notes);

// NO DOM: the scan did not record the listing's age on roughly a third of
// leads. outreach.js refuses to guess, which is right for a person at a
// keyboard and wrong here — refusing means the lead silently gets no text at
// all. So fall back to "Is it still available?", the question that is never
// embarrassing: on a listing a week old or more it is exactly right, and on a
// brand-new one it is merely redundant. The other way round — asking a
// 90-day-old listing when they are reviewing offers — is the mistake an agent
// actually notices. The fallback is recorded in `ageSource` and reported, so
// it is a stated assumption rather than a quiet one.
// --template is the board's live wording, written out by whoever read it from
// the Text Templates screen. When one is given it replaces the built-in texts
// entirely, so the team edits what we say on the board rather than in here.
const args = [__dirname + "/outreach.js", ID, LINE, sender, "--text", TEXT];

// Which wording this lead gets. A pinned template (--template) always wins;
// otherwise one of the set is drawn at random and written to a file of its
// own, so the result says exactly what was sent and nothing is reconstructed
// afterwards from a guess.
let picked = "", pickedFrom = 0, tplArg = TPLFILE;
if (!tplArg && TPLSET) {
  let set;
  try { set = JSON.parse(fs.readFileSync(TPLSET, "utf8")); }
  catch (e) { die("could not read the template set at " + TPLSET + ": " + String(e.message || e).slice(0, 120)); }
  if (!Array.isArray(set)) die("--templates must be a JSON array of templates");
  set = set.filter((t) => t && typeof t.body === "string" && t.body.trim());
  if (!set.length) die("no usable templates in " + TPLSET + " — every one needs a `body`");
  const one = set[Math.floor(Math.random() * set.length)];
  pickedFrom = set.length; picked = one.id || "";
  tplArg = require("path").join(require("os").tmpdir(), "pushtext-" + process.pid + ".json");
  fs.writeFileSync(tplArg, JSON.stringify(one));
}
if (tplArg) args.push("--tplfile", tplArg);
let ageSource;
if (cut || bom) { args.push(cut ? "--cut" : "--bom"); ageSource = cut ? "price cut in the notes" : "back on market in the notes"; }
else if (dom !== undefined) { args.push("--dom", dom); ageSource = dom + " DOM from the notes"; }
else { args.push("--bom"); ageSource = "NOT RECORDED — fell back to \"Is it still available?\""; }
if (DRY) args.push("--dry");

let res;
try {
  const raw = execFileSync("node", args, {
    cwd: __dirname, encoding: "utf8", timeout: 240000,
    env: { ...process.env, REI_PROFILE: process.env.REI_PROFILE || __dirname + "/profile" }
  });
  // outreach.js prints one JSON object; anything before it is noise.
  const i = raw.indexOf("{");
  res = JSON.parse(i < 0 ? raw : raw.slice(i));
} catch (e) {
  die("outreach.js failed: " + String(e.message || e).slice(0, 200), { mls: q.mls || "", contactId: ID });
}

// The Email & SMS Log reads the agent log, and the log's Property column is
// only right when the writer names the listing — so name it.
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const at = new Date().toISOString();
const boardLog = res.ok && !res.dryRun ? {
  collection: "agents",
  doc_id: "p-" + digits(q.phone),
  entry: "text-" + at.replace(/[^0-9]/g, "").slice(0, 14),
  data: { name: [q.first, q.last].filter(Boolean).join(" ") || undefined,
          log: { ["text-" + at.replace(/[^0-9]/g, "").slice(0, 14)]: {
            k: "text", t: String(res.message || "").slice(0, 300), by: "Claude (auto, pushed by " + sender + ")",
            // `tpl` is what the board's Text Templates screen counts to work
            // out each template's reply rate. Without it a send is invisible
            // to the comparison, so the wording can never be judged.
            at, dir: "out", mls: q.mls || undefined, tpl: res.templateId || undefined } } }
} : null;

console.log(JSON.stringify({
  ok: !!res.ok, dryRun: !!res.dryRun, mls: q.mls || "", contactId: ID, sentBy: sender,
  wording: res.text, templateId: res.templateId || "",
  pickedAtRandom: pickedFrom ? "1 of " + pickedFrom + " in rotation" : (TPLFILE ? "pinned" : ""),
  ageSource, question: res.question, capturedName: res.capturedName,
  capturedAddress: res.capturedAddress, addressUsed: res.addressUsed,
  message: res.message || res.ifOlderListing, chars: res.chars,
  fromPicked: res.fromPicked, threadTail: res.threadTail, err: res.err,
  boardLog
}, null, 2));
