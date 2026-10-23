// Send the agent-outreach text to a contact, filling the blanks from the
// contact's own record rather than from arguments:
//   [Agent Name]       <- the contact's Name (first name only)
//   [Property Address] <- the contact's Property Address (street + city; the
//                         zip and ", UNITED STATES" are dropped, they read as
//                         noise in an SMS)
//   [Name]             <- us, passed in as the sender
//
//   node outreach.js <contactId> "<From label>" "<sender>" --dom <days> [--text 1|2|3|4]
//
// --dom is the listing's days on market and is REQUIRED, because the guide
// picks the opening question from it. --cut or --bom stand in for a price cut
// or a back-on-market listing. --text picks one of the guide's four texts
// (default 1, the control plus the review count). --dry prints and sends
// nothing.
//
// Prints the captured fields and the exact message before sending, so a bad
// capture is visible rather than silently texted to a real agent.
const { chromium } = require("playwright");
const fs = require("fs");
const PROFILE = process.env.REI_PROFILE || __dirname + "/profile";
const ID = process.argv[2];
const FROM = process.argv[3] || "Realtor";
const SENDER = process.argv[4] || "Bryan";
const DRY = process.argv.includes("--dry");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
// Every send is appended here as one JSON object per line. Nothing else
// records a Chat-tab send, so this file is the sent side of the KPI.
const SENTLOG = arg("--log", __dirname + "/sent.jsonl");

// Which text, and which opening question. Both come from the Realtor Outreach
// Guide; this script only picks between them, it does not invent wording.
//
// Text 3 is the control. Texts 1, 2 and 4 each add exactly ONE sentence to it,
// so a test can tell which sentence moved the number. Each carries a condition
// the guide sets, which this script cannot check for you — it prints it.
const EXTRA = {
  "1": { add: " We have 120 Google reviews.", needs: "the review count re-confirmed by Bryan before this round" },
  "2": { add: " We can send proof of funds.", needs: "a current proof-of-funds letter ready to send today" },
  "3": { add: "", needs: "" },
  "4": { add: " We're comfortable with homes that need work.", needs: "real condition evidence on this listing — never send it blind on a renovated house" }
};
const TEXT = String(arg("--text", "1"));
// --tplfile points at a template saved on the board (Text Templates in the
// left menu). Its wording wins over --text entirely: the board is where the
// team edits what we say, so a template that exists is the one that goes out.
// The placeholders are filled from the SAME captured values as the built-in
// texts, so switching wording cannot quietly change what gets captured.
const TPLFILE = arg("--tplfile", ""), TPLID = arg("--tplid", "");
// --tplpick is the rotation. The file may hold ONE template or a SET of them
// (a bare array, or {templates:[...]}). With a set, --tplpick <n> names which
// one — blast.js deals them out so a batch spreads evenly — and without it
// one is drawn at random, so a single hand-run still varies.
const TPLPICK = arg("--tplpick", "");
let TPL = null;
if (TPLFILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(TPLFILE, "utf8"));
    const set = Array.isArray(raw) ? raw : Array.isArray(raw.templates) ? raw.templates : null;
    let t = raw;
    if (set) {
      const usable = set.filter(function (x) { return x && typeof x.body === "string" && x.body.trim(); });
      if (usable.length) {
        const n = TPLPICK === "" ? Math.floor(Math.random() * usable.length)
                                 : Math.abs(parseInt(TPLPICK, 10) || 0) % usable.length;
        t = usable[n];
      } else { t = {}; }
    }
    if (typeof t.body === "string" && t.body.trim()) TPL = { id: t.id || TPLID, name: t.name || "", body: t.body };
  } catch (e) {
    console.log(JSON.stringify({ ok: false, err: "could not read the template at " + TPLFILE + ": " + String(e.message || e).slice(0, 120) }));
    process.exit(0);
  }
  if (!TPL) {
    console.log(JSON.stringify({ ok: false, err: "the template at " + TPLFILE + " has no wording in its `body`" }));
    process.exit(0);
  }
}
// The question turns on the listing's age. A house that went up this week is
// obviously still available, so asking shows we did not look; after a week, a
// price cut or a fall-through, it is a real question answered in one word.
const DOM = arg("--dom", "");
const STALE = process.argv.includes("--cut") || process.argv.includes("--bom");
// null means nobody said how old the listing is, and this script will not guess.
const FRESH = STALE ? false : (DOM === "" ? null : Number(DOM) <= 7);
const QUESTION = (f) => (f ? "When are you reviewing offers?" : "Is it still available?");

const until = async (fn, ms, step) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, step)); }
  return false;
};

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, executablePath: "/opt/pw-browsers/chromium",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1600, height: 1200 }
  });
  const pg = ctx.pages()[0] || (await ctx.newPage());
  const out = {};
  await pg.goto("https://my.reiblackbook.com/contacts/" + ID, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForTimeout(13000);

  // --- capture from the About panel ---
  // The About panel is a flat caption/value list. Walking up from the
  // "Contacts (N)" heading only finds it once that panel has been opened for
  // editing, so read the page text and start at that heading instead.
  const readPanel = () => pg.evaluate(() => {
    const t = (document.body.innerText || "");
    const i = t.search(/Contacts \(\d+\)/);
    return (i < 0 ? t : t.slice(i)).trim();
  });
  const valueOf = (block, cap) => {
    const lines = block.split("\n").map((x) => x.trim()).filter(Boolean);
    const i = lines.indexOf(cap);
    if (i < 0 || i + 1 >= lines.length) return "";
    const v = lines[i + 1];
    return v === "-" ? "" : v;
  };
  let panel = "";
  await until(async () => { panel = await readPanel(); return !!valueOf(panel, "Name"); }, 20000, 800);
  const fullName = valueOf(panel, "Name");
  const rawAddr = valueOf(panel, "Property Address");
  const toPhone = valueOf(panel, "Phone (Mobile)") || valueOf(panel, "Phone (Home)");
  out.capturedName = fullName || "(empty)";
  out.capturedAddress = rawAddr || "(empty)";
  out.capturedPhone = toPhone || "(empty)";
  if (!fullName || !rawAddr) {
    console.log(JSON.stringify({ ok: false, err: "could not capture name or property address", ...out }));
    await ctx.close(); return;
  }
  const first = fullName.split(/\s+/)[0];
  // "100 Palm Ave, San Carlos, CA, 94070, UNITED STATES" -> "100 Palm Ave, San Carlos"
  const parts = rawAddr.split(",").map(s => s.trim()).filter(Boolean)
    .filter(s => !/^united states$/i.test(s));
  const shortAddr = parts.slice(0, 2).join(", ");
  out.addressUsed = shortAddr;

  // --text only picks between the four built-in texts, so it is only worth
  // checking when no board template is standing in for all of them.
  if (!TPL && !EXTRA[TEXT]) {
    console.log(JSON.stringify({ ok: false, err: "--text must be 1, 2, 3 or 4", ...out }));
    await ctx.close(); return;
  }
  // A board template fills the same four blanks; the built-in texts hard-code
  // everything but the question. Either way the name and address come from
  // what was just read off the contact, never from an argument.
  const fillTpl = (f) => String(TPL.body)
    .replace(/\[Agent Name\]/g, first)
    .replace(/\[Name\]/g, SENDER)
    .replace(/\[Property Address\]/g, shortAddr)
    .replace(/\[Question\]/g, QUESTION(f));
  const build = (f) => TPL ? fillTpl(f) :
    `Hi ${first}, ${SENDER} with Twin Home Buyer. We're interested in ${shortAddr}. ` +
    `${QUESTION(f)}${EXTRA[TEXT].add} We're also looking to build long-term relationships ` +
    `with local agents. Can I ask you a couple quick questions about the property?`;
  if (TPL) {
    out.text = "Board template" + (TPL.name ? ' "' + TPL.name + '"' : "");
    out.templateId = TPL.id || "";
    // Worth saying out loud: a template with no [Question] never asks one, and
    // the listing-age rule then has nothing to switch.
    if (!/\[Question\]/.test(TPL.body)) out.beforeSending = "this template has no [Question] placeholder, so it asks nothing about the listing";
  } else {
    out.text = "Text " + TEXT;
    if (EXTRA[TEXT].needs) out.beforeSending = "Text " + TEXT + " needs " + EXTRA[TEXT].needs;
  }
  out.daysOnMarket = DOM === "" ? (STALE ? "(flagged older)" : "(not given)") : Number(DOM);
  out.question = FRESH === null ? "(unknown)" : QUESTION(FRESH);

  // Refuse rather than guess: the guide says check the days on market BEFORE
  // texting, and the wrong question is the one mistake an agent notices.
  if (FRESH === null) {
    out.ifNewListing = build(true);
    out.ifOlderListing = build(false);
    const err = "days on market not given, so the opening question is unknown — pass --dom <n>, or --cut / --bom for a price cut or back on market";
    console.log(JSON.stringify(DRY ? { ok: true, dryRun: true, wouldNotSend: err, ...out }
                                   : { ok: false, err, ...out }));
    await ctx.close(); return;
  }

  const MSG = build(FRESH);
  out.message = MSG;
  out.chars = MSG.length;
  if (DRY) { console.log(JSON.stringify({ ok: true, dryRun: true, ...out })); await ctx.close(); return; }

  // --- Chat tab ---
  const chat = await pg.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(
      (e) => !e.children.length && (e.textContent || "").trim() === "Chat" && e.offsetParent !== null);
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!chat) { console.log(JSON.stringify({ ok: false, err: "no Chat tab", ...out })); await ctx.close(); return; }
  await pg.mouse.click(chat.x, chat.y);
  await pg.waitForTimeout(8000);

  // --- From: number ---
  const fromRow = await pg.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(
      (e) => !e.children.length && /^From:/.test((e.textContent || "").trim()) && e.offsetParent !== null);
    if (!el) return null;
    const p = el.parentElement, r = p.getBoundingClientRect();
    return { was: (p.textContent || "").trim().slice(0, 90), x: r.x + r.width - 14, y: r.y + r.height / 2 };
  });
  if (!fromRow) { console.log(JSON.stringify({ ok: false, err: "no From: row", ...out })); await ctx.close(); return; }
  out.fromWas = fromRow.was;
  await pg.mouse.click(fromRow.x, fromRow.y);
  await pg.waitForTimeout(1500);
  await pg.keyboard.type(FROM, { delay: 40 });
  const listed = await until(async () => pg.evaluate((t) =>
    Array.from(document.querySelectorAll('[id^="react-select"][id*="option"],[role="option"]'))
      .filter(e => e.offsetParent !== null)
      .some(e => (e.textContent || "").trim().toLowerCase().startsWith(t.toLowerCase())), FROM), 9000, 250);
  if (!listed) { console.log(JSON.stringify({ ok: false, err: "From option never appeared", ...out })); await ctx.close(); return; }
  const pick = await pg.evaluate((t) => {
    const e = Array.from(document.querySelectorAll('[id^="react-select"][id*="option"],[role="option"]'))
      .filter(x => x.offsetParent !== null)
      .find(x => (x.textContent || "").trim().toLowerCase().startsWith(t.toLowerCase()));
    if (!e) return null; const r = e.getBoundingClientRect();
    return { t: (e.textContent || "").trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, FROM);
  out.fromPicked = pick && pick.t;
  await pg.mouse.click(pick.x, pick.y);
  await pg.waitForTimeout(2500);
  out.fromNow = await pg.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(
      (e) => !e.children.length && /^From:/.test((e.textContent || "").trim()) && e.offsetParent !== null);
    return el ? (el.parentElement.textContent || "").trim().slice(0, 90) : "";
  });

  // --- message (TinyMCE inside a srcdoc iframe, see README) ---
  const box = await pg.evaluate(() => {
    const f = Array.from(document.querySelectorAll("iframe"))
      .filter(x => x.getAttribute("srcdoc") !== null && x.getBoundingClientRect().height > 20)[0];
    if (!f) return null; const r = f.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) { console.log(JSON.stringify({ ok: false, err: "no reply editor iframe", ...out })); await ctx.close(); return; }
  await pg.mouse.click(box.x, box.y);
  await pg.waitForTimeout(600);
  await pg.keyboard.type(MSG, { delay: 8 });
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: __dirname + "/outreach-before-send.png" });
  const ed = pg.frames().find(f => f.url() === "about:srcdoc");
  out.typed = ed ? await ed.evaluate(() => (document.body.innerText || "").trim()) : "";

  // --- send ---
  const send = await pg.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button,[role=button]"))
      .filter(x => x.offsetParent !== null)
      .find(x => (x.getAttribute("aria-label") || "") === "Send Text");
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!send) { console.log(JSON.stringify({ ok: false, err: "no Send Text button", ...out })); await ctx.close(); return; }
  await pg.mouse.click(send.x, send.y);
  await pg.waitForTimeout(12000);
  await pg.evaluate(() => { document.querySelectorAll("*").forEach(e => { if (e.scrollHeight > e.clientHeight + 50) e.scrollTop = e.scrollHeight; }); });
  await pg.waitForTimeout(2000);
  out.threadTail = await pg.evaluate((m) => {
    const t = (document.body.innerText || "").replace(/\n{2,}/g, "\n");
    const i = t.indexOf(m.slice(0, 40));
    return i < 0 ? "(not found in thread)" : t.slice(i, i + 220).trim();
  }, MSG);

  // The send is the only record of itself: REI's Outbox holds scheduled and
  // broadcast texts only, so a Chat-tab send appears nowhere we can query
  // later. Append it here, before anything else can fail.
  const sent = {
    at: new Date().toISOString(), kind: "text", dir: "out",
    contactId: ID, name: fullName, phone: toPhone, line: out.fromPicked || FROM,
    address: shortAddr, by: SENDER, body: MSG,
    text: out.text, tpl: out.templateId || "", daysOnMarket: out.daysOnMarket, question: out.question
  };
  try { fs.appendFileSync(SENTLOG, JSON.stringify(sent) + "\n"); out.loggedTo = SENTLOG; }
  catch (e) { out.logErr = String(e.message || e).slice(0, 120); }
  await pg.screenshot({ path: __dirname + "/outreach-proof.png" });
  console.log(JSON.stringify({ ok: true, ...out }));
  await ctx.close();
})();
