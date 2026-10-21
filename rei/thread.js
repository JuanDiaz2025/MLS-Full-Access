// Read a contact's whole SMS conversation, in order, with direction.
//
//   node thread.js <contactId> [--json]
//
// Read-only. This is what a reply has to be written against: the inbox feed
// gives one message out of context, and answering an agent from that alone is
// how you promise something that was already discussed, or repeat a question
// they answered an hour ago.
//
// Direction comes from REI's own wording in the thread, not from guessing:
// an outbound bubble carries "Sent to:", an inbound one "Received from:".
const { chromium } = require("playwright");
const PROFILE = process.env.REI_PROFILE || __dirname + "/profile";
const ID = process.argv[2];
const JSON_OUT = process.argv.includes("--json");

if (!ID) { console.error("usage: node thread.js <contactId> [--json]"); process.exit(1); }

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath: "/opt/pw-browsers/chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1600, height: 1400 }
  });
  const pg = ctx.pages()[0] || (await ctx.newPage());
  await pg.goto("https://my.reiblackbook.com/contacts/" + ID + "?activeTab=chat",
    { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForTimeout(15000);
  if (/\/login/.test(pg.url())) {
    console.log(JSON.stringify({ ok: false, err: "login page — check REI_PROFILE" }));
    await ctx.close(); return;
  }
  await pg.evaluate(() => {
    document.querySelectorAll("*").forEach(e => { if (e.scrollHeight > e.clientHeight + 50) e.scrollTop = e.scrollHeight; });
  });
  await pg.waitForTimeout(2500);

  // Cut to the conversation itself. The page's left rail and right panels are
  // in the same innerText, and without this the first message comes back with
  // "Cold Primary Details (925) …" glued to the front of it.
  const text = await pg.evaluate(() => {
    const t = (document.body.innerText || "").replace(/\r/g, "");
    const a = t.indexOf("Filter by:");
    const head = a < 0 ? t : t.slice(t.indexOf("\n", a) + 1);
    const b = head.search(/\n\s*(Personalize|Write Your Reply)/);
    return b < 0 ? head : head.slice(0, b);
  });
  const lines = text.split("\n").map(s => s.trim());

  // Walk the thread as REI lays it out: the message body sits above its own
  // "PD #: … / Sent to: … / <time>" footer, so collect lines until a footer
  // appears and treat what came before as the message.
  const msgs = [];
  let buf = [];
  const timeRe = /^\d{1,2}:\d{2}\s*(AM|PM)$/i;
  const dayRe = /^(Today|Yesterday|[A-Z][a-z]{2} \d{1,2}, \d{4}|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
  let day = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (dayRe.test(l)) { day = l; buf = []; continue; }
    const out = /^Sent to:/.test(l), inb = /^Received from:/.test(l);
    if (out || inb) {
      // the footer block: skip its own lines, grab the time
      let when = "";
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        if (timeRe.test(lines[j])) { when = lines[j]; break; }
      }
      const body = buf.filter(b => !/^PD #:/.test(b) && !timeRe.test(b) && !/^Processing/i.test(b)).join(" ").trim();
      if (body) msgs.push({ dir: out ? "out" : "in", day, when, body });
      buf = [];
      continue;
    }
    if (/^PD #:/.test(l) || timeRe.test(l)) continue;
    // stop collecting once we are past the thread and into the side panels
    if (/^(Personalize|From:|Message Length|Associated Deals|Notes \(|Current Workflows|Upcoming Tasks)/.test(l)) { buf = []; continue; }
    buf.push(l);
    if (buf.length > 40) buf.shift();
  }

  if (JSON_OUT) { console.log(JSON.stringify({ ok: true, contactId: ID, messages: msgs }, null, 2)); }
  else {
    console.log("Thread for contact " + ID + " — " + msgs.length + " messages\n");
    msgs.forEach(m => {
      console.log((m.dir === "in" ? "<<< THEM" : ">>> US  ") + "  " + (m.day ? m.day + " " : "") + m.when);
      console.log("    " + m.body + "\n");
    });
  }
  await ctx.close();
})();
