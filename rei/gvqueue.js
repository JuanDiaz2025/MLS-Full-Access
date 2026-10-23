// Drain the Twin Network queue through Google Voice, on Bryan's machine.
//
//   node gvqueue.js            # watch, dry — prints what it would send
//   node gvqueue.js --go       # watch, and actually send
//
// WHAT THIS IS FOR. The board queues a blast, and the words get written and
// checked elsewhere; the one thing that can only happen on this machine is the
// sending, because Google Voice needs the browser Bryan is signed in to. This
// watches a folder for prepared batches and sends them as they land, so the
// queue drains with nobody pasting anything. Start it once and leave it.
//
// WHAT IT NEEDS, and this is the whole setup:
//   1. Chrome started with --remote-debugging-port=9222, signed in to
//      voice.google.com. Nothing here ever sees a password or a code.
//   2. A folder for the queue files. Default ./queue beside this script; point
//      --dir at a synced folder (Drive, Dropbox) and files dropped anywhere
//      arrive here on their own.
// It does NOT need an REI login: a queue file carries finished messages.
//
// A QUEUE FILE is what gvblast --prepared takes — a JSON array of
// {phone, text, name?, mls?, template?} — named anything ending .json.
//
// THE BRAKES, because this runs unattended:
//   - Dry until --go, like everything else here. The dry run prints each
//     message in full and sends nothing.
//   - `touch STOP` beside the queue folder: the current file finishes, then it
//     stops. Deleting STOP does not restart it; that is deliberate.
//   - Nobody is texted twice. gvblast checks both run logs before every send,
//     and a file is moved to done/ the moment it finishes, so a restart cannot
//     replay it.
//   - A file that fails is moved to failed/ with the reason beside it, and the
//     watcher carries on. One bad batch does not stop the queue.
//   - Files are only picked up once they have stopped growing (two equal size
//     readings a second apart), so a half-synced file is never sent.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const GO = process.argv.includes("--go");
const DIR = path.resolve(arg("--dir", path.join(__dirname, "queue")));
const EVERY = Number(arg("--every", "20"));        // seconds between looks
const PORT = arg("--port", "9222");
const DELAY = arg("--delay", "45");                // seconds between texts
const ONCE = process.argv.includes("--once");      // one pass, then exit
const STOP = path.join(DIR, "STOP");
const DONE = path.join(DIR, "done");
const FAILED = path.join(DIR, "failed");

const now = () => new Date().toISOString();
const say = (o) => console.log(JSON.stringify({ at: now(), ...o }));

for (const d of [DIR, DONE, FAILED]) {
  try { fs.mkdirSync(d, { recursive: true }); }
  catch (e) { say({ ok: false, err: "could not make " + d + ": " + String(e.message || e) }); process.exit(1); }
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// A file still being written — copied in, or syncing down from Drive — would
// be sent half-finished. Two equal sizes a second apart is enough to tell.
async function settled(f) {
  let a; try { a = fs.statSync(f).size; } catch (e) { return false; }
  await sleep(1);
  let b; try { b = fs.statSync(f).size; } catch (e) { return false; }
  return a === b && a > 0;
}

function moveTo(dir, f, note) {
  const dest = path.join(dir, path.basename(f));
  try {
    fs.renameSync(f, dest);
    if (note) fs.writeFileSync(dest.replace(/\.json$/i, "") + ".txt", note + "\n");
    return dest;
  } catch (e) {
    say({ warn: "could not move " + path.basename(f) + ": " + String(e.message || e) });
    return "";
  }
}

// gvblast's closing summary says the RUN finished, not that every text went.
// A batch where Chrome was dead ends ok:true with failed:2, so reading `ok`
// alone would file a batch nobody received under done/ and lose it.
function summarise(out) {
  const i = out.lastIndexOf('{\n  "ok"');
  const tail = i < 0 ? out.slice(out.lastIndexOf("{")) : out.slice(i);
  const num = (k) => { const m = tail.match(new RegExp('"' + k + '":\\s*(\\d+)')); return m ? Number(m[1]) : null; };
  return { attempted: num("attempted"), succeeded: num("succeeded"), failed: num("failed") };
}

function runOne(f) {
  const args = [path.join(__dirname, "gvblast.js"), "--prepared", f, "--port", PORT, "--delay", DELAY];
  if (GO) args.push("--go");
  let out, threw = false;
  try {
    out = execFileSync("node", args, { cwd: __dirname, encoding: "utf8", timeout: 3600000 });
  } catch (e) {
    out = String((e.stdout || "") + (e.stderr || "") || e.message || e);
    threw = true;
  }
  console.log(out);
  const s = summarise(out);
  // Every text landed, and there was at least one. Anything else is a failure
  // worth looking at, even when the run itself ended tidily.
  const ok = !threw && s.attempted > 0 && s.failed === 0 && s.succeeded === s.attempted;
  return { ok, out, ...s };
}

(async () => {
  say({
    watching: DIR,
    mode: GO ? "SENDING FOR REAL as files arrive" : "dry run — prints every message, sends nothing",
    every: EVERY + "s", chrome: "port " + PORT, between: DELAY + "s",
    stopFile: STOP + "  (create it to stop after the file in flight)",
    needsREI: "no — queue files carry finished messages",
    drop: "a JSON array of {phone, text, name?, mls?, template?} into " + DIR
  });

  let idle = 0;
  const previewed = new Set();   // dry-run previews, so the same file is not reprinted every pass
  for (;;) {
    if (fs.existsSync(STOP)) { say({ stopped: "STOP file found" }); break; }

    let files = [];
    try {
      files = fs.readdirSync(DIR)
        .filter((n) => /\.json$/i.test(n))
        .map((n) => path.join(DIR, n))
        .filter((f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } })
        .sort();                                   // oldest name first, so a batch keeps its order
    } catch (e) {
      say({ warn: "could not read " + DIR + ": " + String(e.message || e) });
    }

    for (const f of files) {
      if (fs.existsSync(STOP)) { say({ stopped: "STOP file found" }); return; }
      if (!(await settled(f))) { say({ waiting: path.basename(f) + " is still being written" }); continue; }

      // A dry run is a preview, not a turn in the queue. Moving the file would
      // mean the batch vanished before --go ever saw it, so it stays put and is
      // simply not previewed twice.
      if (!GO) {
        if (previewed.has(f)) continue;
        say({ previewing: path.basename(f) });
        const res = runOne(f);
        previewed.add(f);
        say({ previewed: path.basename(f), wouldSend: res.attempted, leftInQueue: true,
              note: "nothing was sent — run again with --go to send these" });
        idle = 0;
        continue;
      }

      say({ picked: path.basename(f) });
      const res = runOne(f);
      if (res.ok) {
        moveTo(DONE, f, "sent " + now() + "  (" + res.succeeded + " of " + res.attempted + ")");
        say({ finished: path.basename(f), sent: res.succeeded });
      } else {
        moveTo(FAILED, f, "failed " + now() + "\n\n" + res.out.slice(-4000));
        say({ failed: path.basename(f), sent: res.succeeded, of: res.attempted,
              why: "see the .txt beside it in " + FAILED + " — anyone already texted is in the run log and will not be texted again" });
      }
      idle = 0;
    }

    if (ONCE) { say({ done: "one pass finished" }); break; }
    if (!files.length && ++idle % 15 === 0) say({ idle: "nothing in the queue", minutes: Math.round(idle * EVERY / 60) });
    await sleep(EVERY);
  }
})();
